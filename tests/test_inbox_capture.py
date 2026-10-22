"""Capture packaging is offline, immutable, and accepted by the inbox transport."""

import copy
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))
import shard_atlas_client as client


class InboxCaptureTests(unittest.TestCase):
    def setUp(self):
        self.batch = {"requestId": "qa-capture-request", "shards": [
            {"id": "qa-note-a", "title": "A scalar input", "content": "For a real scalar x, twice its value is 2x.", "subjects": ["Mathematics"]},
            {"id": "qa-note-b", "title": "A fixed scalar multiplier", "content": "A fixed scalar c maps x to cx."}],
            "links": [{"id": "qa-example-link", "fromId": "qa-note-a", "toId": "qa-note-b", "type": "example_of", "note": "Doubling fixes c at 2."}]}
        self.temporary = tempfile.TemporaryDirectory()
        self.folder = Path(self.temporary.name)
        self.addCleanup(self.temporary.cleanup)

    def test_packaging_preserves_exact_batch_and_never_contacts_collection(self):
        original = copy.deepcopy(self.batch)
        with mock.patch.object(client, "request_json", side_effect=AssertionError("Must remain offline")), mock.patch.object(client, "start_backend", side_effect=AssertionError("Must not start app")):
            envelope = client.inbox_envelope(self.batch)
            output = self.folder / "capture.json"
            result = client.write_inbox_envelope(envelope, output)
        self.assertEqual(self.batch, original)
        self.assertEqual(json.loads(output.read_text()), {"format": "shard-atlas-inbox", "version": 1, "batch": original})
        self.assertFalse(result["savedToCollection"])
        self.assertFalse(result["uploadVerified"])
        self.assertFalse(result["reusedFile"])
        self.assertEqual(list(self.folder.iterdir()), [output])

    def test_same_file_retry_reuses_identical_bytes_and_rejects_changed_batch(self):
        output = self.folder / "capture.json"
        client.write_inbox_envelope(client.inbox_envelope(self.batch), output)
        before = output.read_bytes()
        receipt = client.write_inbox_envelope(client.inbox_envelope(copy.deepcopy(self.batch)), output)
        self.assertTrue(receipt["reusedFile"])
        self.assertEqual(output.read_bytes(), before)
        changed = copy.deepcopy(self.batch)
        changed["shards"][0]["content"] = "A changed proposal."
        with self.assertRaises(client.ClientError):
            client.write_inbox_envelope(client.inbox_envelope(changed), output)
        self.assertEqual(output.read_bytes(), before)
        self.assertEqual(list(self.folder.iterdir()), [output])

    def test_prepared_file_imports_independently_into_two_collections(self):
        from server import DriveInbox, Store
        inbox = self.folder / "Inbox"
        inbox.mkdir()
        output = inbox / "capture.json"
        client.write_inbox_envelope(client.inbox_envelope(self.batch), output)
        original = output.read_bytes()
        for name in ("mac", "browser-copy"):
            store = Store(self.folder / f"{name}.sqlite3", root=ROOT, seed=False, backup_on_start=False, automatic_backups=False)
            importer = DriveInbox(store, inbox)
            first = importer.sync()
            self.assertEqual(first["counts"]["imported"], 1)
            self.assertEqual(importer.sync()["counts"]["replayed"], 1)
            state = store.state()
            self.assertEqual({item["id"] for item in state["shards"]}, {"qa-note-a", "qa-note-b"})
            self.assertEqual([item["id"] for item in state["links"]], ["qa-example-link"])
        self.assertEqual(output.read_bytes(), original)

    def test_existing_symlink_is_never_followed_or_replaced(self):
        target = self.folder / "target.json"
        envelope = client.inbox_envelope(self.batch)
        client.write_inbox_envelope(envelope, target)
        output = self.folder / "capture.json"
        output.symlink_to(target)
        before = target.read_bytes()
        with self.assertRaises(client.ClientError):
            client.write_inbox_envelope(envelope, output)
        self.assertTrue(output.is_symlink())
        self.assertEqual(target.read_bytes(), before)

    def test_validation_requires_explicit_link_ids_and_additions_only(self):
        for change in (lambda b: b["links"][0].pop("id"), lambda b: b.update(delete=["qa-note-a"]), lambda b: b["shards"][0].update(createdAt="2026-10-01T00:00:00Z")):
            batch = copy.deepcopy(self.batch)
            change(batch)
            with self.assertRaises(client.ClientError):
                client.inbox_envelope(batch)

    def test_cli_emits_envelope_or_an_atomic_file_without_local_url(self):
        source = self.folder / "batch.json"
        source.write_text(json.dumps(self.batch))
        arguments = [sys.executable, str(ROOT / "tools/shard_atlas_client.py"), "inbox", "--file", str(source)]
        result = subprocess.run(arguments, capture_output=True, text=True, timeout=15)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["batch"], self.batch)
        output = self.folder / "ready.json"
        result = subprocess.run([*arguments, "--output", str(output)], capture_output=True, text=True, timeout=15)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(json.loads(result.stdout)["savedToCollection"])
        self.assertEqual(json.loads(output.read_text())["batch"], self.batch)
        invalid = subprocess.run([*arguments, "--output", str(self.folder / "ready.txt")], capture_output=True, text=True, timeout=15)
        self.assertNotEqual(invalid.returncode, 0)
        self.assertFalse((self.folder / "ready.txt").exists())


if __name__ == "__main__":
    unittest.main()
