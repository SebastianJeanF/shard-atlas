"""Additive Drive inbox transport, using only temporary folders/databases."""

import http.client
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from platform_fixtures import symlink_or_skip
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from server import AppError, DriveInbox, LocalServer, Store, validate_drive_inbox_envelope


class DriveInboxTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.folder = self.root / "Drive" / "ChatGPT" / "Shard Atlas" / "Inbox"
        self.folder.mkdir(parents=True)
        self.db = self.root / "knowledge.sqlite3"
        self.store = Store(self.db, root=self.root, seed=False, backup_on_start=False, automatic_backups=False)
        self.inbox = DriveInbox(self.store, self.folder)

    def tearDown(self):
        self.temporary.cleanup()

    def envelope(self, request_id="capture-one", shard_id="note-one", title="One concept"):
        return {"format": "shard-atlas-inbox", "version": 1,
                "batch": {"requestId": request_id, "shards": [{"id": shard_id, "title": title, "content": "An explanation."}], "links": []}}

    def write(self, name="capture.json", payload=None):
        path = self.folder / name
        path.write_text(json.dumps(self.envelope() if payload is None else payload), encoding="utf-8")
        return path

    def test_missing_and_empty_folder_status_has_no_knowledge_writes(self):
        status = self.inbox.status()
        self.assertTrue(status["available"])
        self.assertEqual(status["counts"], {"files": 0, "errors": 0})
        self.assertEqual(self.inbox.sync()["counts"], {"files": 0, "errors": 0, "imported": 0, "replayed": 0})
        missing = DriveInbox(self.store, self.root / "not-downloaded").sync()
        self.assertFalse(missing["available"])
        self.assertIn("Google Drive", missing["error"])
        self.assertFalse(self.store.backup_dir.exists())

    def test_configuration_uses_only_explicit_server_path_or_environment(self):
        with mock.patch.dict(os.environ, {"SHARD_ATLAS_DRIVE_INBOX": str(self.folder)}):
            self.assertEqual(DriveInbox(self.store).path, self.folder)
            self.assertEqual(DriveInbox(self.store, self.root / "explicit").path, self.root / "explicit")
        with mock.patch.dict(os.environ, {}, clear=True), mock.patch.object(Path, "home", return_value=self.root):
            self.assertEqual(DriveInbox(self.store).path, Path.home() / "My Drive/ChatGPT/Shard Atlas/Inbox")

    def test_strict_versioned_envelope_rejects_archives_and_mutating_fields(self):
        valid = self.envelope()
        self.assertIs(validate_drive_inbox_envelope(valid), valid["batch"])
        invalid = [valid["batch"], {"schemaVersion": 1, "shards": []}, {**valid, "version": True},
                   {**valid, "version": 2}, {**valid, "extra": "ignored?"}, {**valid, "batch": {**valid["batch"], "trash": []}},
                   {**valid, "batch": {"requestId": "empty", "shards": [], "links": []}},
                   {**valid, "batch": {**valid["batch"], "links": [{"fromId": "note-one", "toId": "other"}]}}]
        for payload in invalid:
            with self.subTest(payload=payload), self.assertRaises(AppError):
                validate_drive_inbox_envelope(payload)
        self.assertEqual(self.store.state()["shards"], [])

    def test_import_and_replay_after_reopening_never_change_source_file(self):
        source = self.write()
        before_bytes = source.read_bytes()
        before_stat = source.stat()
        result = self.inbox.sync()
        self.assertEqual(result["counts"], {"files": 1, "errors": 0, "imported": 1, "replayed": 0})
        receipt = result["files"][0]["receipt"]
        self.assertTrue(receipt["verified"])
        self.assertEqual(receipt["added"], {"shards": 1, "links": 0})
        reopened = Store(self.db, root=self.root, seed=False, backup_on_start=False, automatic_backups=False)
        replay = DriveInbox(reopened, self.folder).sync()
        self.assertEqual(replay["files"][0]["status"], "replayed")
        self.assertEqual(replay["files"][0]["receipt"]["backupFilename"], receipt["backupFilename"])
        self.assertEqual(len(reopened.state()["shards"]), 1)
        self.assertEqual(source.read_bytes(), before_bytes)
        self.assertEqual(source.stat().st_mtime_ns, before_stat.st_mtime_ns)
        self.assertEqual(len(list(reopened.backup_dir.glob("*.sqlite3"))), 1)

    def test_copying_batch_into_two_files_has_one_save_and_later_deletion_stays_deleted(self):
        self.write("b.json")
        self.write("a.json")
        result = self.inbox.sync()
        self.assertEqual([item["name"] for item in result["files"]], ["a.json", "b.json"])
        self.assertEqual(result["counts"]["imported"], 1)
        self.assertEqual(result["counts"]["replayed"], 1)
        self.store.update_shard("note-one", {"content": "User's later explanation."})
        self.inbox.sync()
        self.assertEqual(self.store.state()["shards"][0]["content"], "User's later explanation.")
        self.store.delete_shard("note-one")
        replay = self.inbox.sync()
        self.assertEqual(self.store.state()["shards"], [])
        self.assertTrue(all(item["warnings"] for item in replay["files"]))
        self.assertEqual(replay["files"][0]["receipt"]["missingShardIds"], ["note-one"])

    def test_one_bad_file_or_conflicting_retry_does_not_block_other_files(self):
        self.write("original.json")
        self.inbox.sync()
        changed = self.envelope()
        changed["batch"]["shards"][0]["content"] = "Changed request body."
        self.write("original.json", changed)
        (self.folder / "bad.json").write_text("{unfinished", encoding="utf-8")
        self.write("good.json", self.envelope("capture-two", "note-two", "Second concept"))
        result = self.inbox.sync()
        self.assertEqual(result["counts"], {"files": 3, "errors": 2, "imported": 1, "replayed": 0})
        self.assertEqual(len(self.store.state()["shards"]), 2)
        self.assertIn("already used with different content", next(item for item in result["files"] if item["name"] == "original.json")["error"])
        self.assertEqual(next(item for item in self.store.state()["shards"] if item["id"] == "note-one")["content"], "An explanation.")

    @unittest.skipUnless(hasattr(os, "mkfifo"), "FIFO fixtures require POSIX.")
    def test_symlinks_folders_and_special_files_are_rejected_without_reading_them(self):
        outside = self.root / "outside.json"
        outside.write_text(json.dumps(self.envelope()), encoding="utf-8")
        symlink_or_skip(self, self.folder / "link.json", outside)
        (self.folder / "directory.json").mkdir()
        os.mkfifo(self.folder / "pipe.json")
        (self.folder / "ignored.txt").write_text("not an import", encoding="utf-8")
        result = self.inbox.sync()
        self.assertEqual(result["counts"]["files"], 3)
        self.assertEqual(result["counts"]["errors"], 3)
        self.assertEqual(self.store.state()["shards"], [])
        self.assertFalse(self.store.backup_dir.exists())

    def test_nonfinite_duplicate_fields_and_non_utf8_are_per_file_errors(self):
        for name, raw in [("a.json", b'{"format":"shard-atlas-inbox","version":1,"batch":NaN}'),
                          ("b.json", b'{"format":"shard-atlas-inbox","format":"other","version":1,"batch":{}}'),
                          ("c.json", b'\xff\xfe')]:
            (self.folder / name).write_bytes(raw)
        self.assertEqual(self.inbox.sync()["counts"]["errors"], 3)
        self.assertFalse(self.store.backup_dir.exists())

    def test_file_replaced_by_symlink_after_scan_is_not_imported(self):
        source = self.write()
        outside = self.root / "outside.json"
        outside.write_bytes(source.read_bytes())
        status = self.inbox.status()
        source.unlink()
        symlink_or_skip(self, source, outside)
        with mock.patch.object(self.inbox, "status", return_value=status):
            result = self.inbox.sync()
        self.assertEqual(result["counts"]["errors"], 1)
        self.assertEqual(self.store.state()["shards"], [])
        self.assertTrue(source.is_symlink())

    def test_file_and_folder_bounds_stop_oversized_reads(self):
        self.write()
        with mock.patch("server.MAX_DRIVE_INBOX_FILE_BYTES", 10):
            result = self.inbox.sync()
            self.assertEqual(result["counts"]["errors"], 1)
            self.assertIn("8 MB", result["files"][0]["error"])
        with mock.patch("server.MAX_DRIVE_INBOX_FILES", 0):
            self.assertFalse(self.inbox.sync()["available"])
        with mock.patch("server.MAX_DRIVE_INBOX_ENTRIES", 0):
            self.assertFalse(self.inbox.sync()["available"])
        with mock.patch("server.MAX_DRIVE_INBOX_TOTAL_BYTES", 10):
            result = self.inbox.sync()
            self.assertEqual(result["counts"]["errors"], 1)
            self.assertIn("read limit", result["files"][0]["error"])
        self.assertEqual(self.store.state()["shards"], [])

    def test_malformed_files_count_toward_total_read_budget(self):
        (self.folder / "a.json").write_bytes(b"x" * 10)
        self.write("b.json")
        budget = (self.folder / "b.json").stat().st_size
        with mock.patch("server.MAX_DRIVE_INBOX_TOTAL_BYTES", budget):
            result = self.inbox.sync()
        self.assertIn("read limit", result["files"][1]["error"])
        self.assertEqual(self.store.state()["shards"], [])

    def test_backup_failure_is_independent_and_retryable(self):
        self.write()
        with mock.patch.object(self.store, "backup", side_effect=OSError("disk full")):
            result = self.inbox.sync()
        self.assertEqual(result["counts"]["errors"], 1)
        self.assertEqual(self.store.state()["shards"], [])
        self.assertEqual(self.inbox.sync()["counts"]["imported"], 1)

    def test_http_reads_do_not_import_and_sync_rejects_foreign_origin_and_path_override(self):
        self.write()
        server = LocalServer(("127.0.0.1", 0), self.store, drive_inbox_path=self.folder)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        def request(method, path, body=None, origin=None):
            connection = http.client.HTTPConnection(*server.server_address)
            headers = {} if body is None else {"Content-Type": "application/json"}
            if origin:
                headers["Origin"] = origin
            connection.request(method, path, body=None if body is None else json.dumps(body), headers=headers)
            response = connection.getresponse()
            result = response.status, json.loads(response.read())
            connection.close()
            return result
        try:
            self.assertTrue(request("GET", "/api/drive-inbox")[1]["available"])
            self.assertEqual(self.store.state()["shards"], [])
            self.assertEqual(request("POST", "/api/drive-inbox/sync", {}, "https://foreign.example")[0], 403)
            self.assertEqual(request("POST", "/api/drive-inbox/sync", {"path": str(self.root)})[0], 400)
            status, result = request("POST", "/api/drive-inbox/sync", {})
            self.assertEqual(status, 200)
            self.assertEqual(result["counts"]["imported"], 1)
            self.assertEqual(request("POST", "/api/drive-inbox/sync", {})[1]["counts"]["replayed"], 1)
        finally:
            server.shutdown()
            server.server_close()
            thread.join()


if __name__ == "__main__":
    unittest.main()
