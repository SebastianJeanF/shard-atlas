"""Shared-library safety checks; every database and credential is temporary."""

import copy
import http.client
import json
from pathlib import Path
import sqlite3
import sys
import tempfile
import threading
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from library_sync import (CHUNK_BYTES, LibraryClient, LibrarySync, NoRedirect, SITE_URL,
                          SyncError, atomic_write, canonical, digest, fingerprint,
                          validate_capsule, validate_manifest)
from server import LocalServer, Store

PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jR7sAAAAASUVORK5CYII="


class FakeCloud:
    def __init__(self):
        self.revision = ""
        self.commits = {}
        self.receipts = {}
        self.publishes = []
        self.fail_next_publish = False
        self.lose_next_receipt = False
        self.on_download = None

    def __call__(self, config):
        return self

    def head(self):
        return {"protocolVersion": 1, "revision": self.revision,
                "commit": copy.deepcopy(self.commits.get(self.revision))}

    def download(self, commit):
        result = copy.deepcopy(self.commits[commit["id"]]["capsule"])
        if self.on_download:
            callback, self.on_download = self.on_download, None
            callback()
        return result

    def publish(self, pending, data):
        self.publishes.append(copy.deepcopy(pending))
        if self.fail_next_publish:
            self.fail_next_publish = False
            raise SyncError("Offline; your pending change is retained.", "offline")
        identity = pending["mutationId"]
        if identity not in self.receipts:
            revision = "revision-" + str(len(self.receipts) + 1)
            accepted = pending["baseRevision"] == self.revision
            receipt = {"id": revision, "mutationId": identity, "baseRevision": pending["baseRevision"],
                       "status": "accepted" if accepted else "conflict", "observedRevision": self.revision,
                       "manifest": copy.deepcopy(pending["manifest"])}
            self.receipts[identity] = receipt
            self.commits[revision] = {**copy.deepcopy(receipt), "capsule": json.loads(data)}
            if accepted:
                self.revision = revision
        if self.lose_next_receipt:
            self.lose_next_receipt = False
            raise SyncError("The reply was interrupted. Your pending change is retained.", "offline")
        return {**copy.deepcopy(self.receipts[identity]), "revision": self.revision}

    def seed(self, capsule):
        data = canonical(capsule)
        pending = {"mutationId": "external-" + str(len(self.receipts) + 1), "baseRevision": self.revision,
                   "manifest": {"protocolVersion": 1, "archiveVersion": 1, "format": "shard-atlas-library-json",
                                "sha256": digest(data), "bytes": len(data),
                                "chunks": [{"sha256": digest(data[offset:offset + CHUNK_BYTES]), "bytes": len(data[offset:offset + CHUNK_BYTES])} for offset in range(0, len(data), CHUNK_BYTES)]}}
        return self.publish(pending, data)


class LibrarySyncTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.store = self.new_store("local")
        self.config = self.root / "private" / "library-sync.json"
        atomic_write(self.config, canonical({"siteUrl": SITE_URL, "serviceToken": "temporary-test-token",
                                            "serviceSecret": "temporary-test-service-secret", "pollSeconds": 30}))
        self.cloud = FakeCloud()
        self.sync = LibrarySync(self.store, config_path=self.config, client_factory=self.cloud)

    def tearDown(self):
        self.sync.stop()
        self.temporary.cleanup()

    def new_store(self, name):
        return Store(self.root / name / "shards.sqlite3", root=self.root / name, seed=False,
                     backup_on_start=False, automatic_backups=False)

    def add(self, store=None, title="Integer reversal", **fields):
        store = store or self.store
        state = store.create_shard({"title": title, **fields})
        return next(item for item in state["shards"] if item["title"] == title)

    def remote_capsule(self, **fields):
        other = self.new_store("remote-" + str(len(list(self.root.glob('remote-*')))))
        self.add(other, **fields)
        return LibrarySync(other, config_path=self.root / "unconfigured").capsule()

    def test_unconfigured_service_does_not_start_or_mutate(self):
        sync = LibrarySync(self.store, config_path=self.root / "absent.json")
        before = self.store.export_data()
        sync.start()
        self.assertIsNone(sync.thread)
        self.assertEqual(sync.run()["status"], "not_configured")
        self.assertEqual(self.store.export_data(), before)

    def test_config_permissions_and_site_are_restricted(self):
        self.config.chmod(0o644)
        self.assertEqual(self.sync.run()["status"], "configuration_error")
        self.config.chmod(0o600)
        value = json.loads(self.config.read_text())
        value["siteUrl"] = "https://other.example"
        atomic_write(self.config, canonical(value))
        self.assertEqual(self.sync.run()["status"], "configuration_error")
        self.assertFalse(self.cloud.publishes)

    def test_first_publish_is_exact_and_source_remains_unchanged(self):
        self.add(codeSolution={"role": "snippet", "code": "  int x = 1;\n\t// exact whitespace\n"})
        before = self.store.export_data()
        result = self.sync.run()
        self.assertEqual(result["status"], "synced")
        self.assertEqual(self.cloud.download(self.cloud.head()["commit"]), self.sync.capsule())
        self.assertEqual(self.store.export_data(), before)
        self.assertFalse(self.sync.pending_path.exists())
        self.assertEqual(self.sync._state()["baseRevision"], self.cloud.revision)
        self.assertEqual(self.sync.view_revision(), "")

    def test_same_initial_collection_adopts_without_replacement(self):
        self.add()
        self.cloud.seed(self.sync.capsule())
        self.assertEqual(self.sync.run()["status"], "synced")
        self.assertFalse(self.store.backup_dir.exists())
        self.assertEqual(len(self.cloud.receipts), 1)

    def test_nonempty_first_connection_requires_review(self):
        self.add(title="Local")
        self.cloud.seed(self.remote_capsule(title="Cloud"))
        before = self.store.export_data()
        result = self.sync.run()
        self.assertEqual(result["status"], "migration_required")
        self.assertEqual(result["localCounts"]["shards"], 1)
        self.assertEqual(result["remoteCounts"]["shards"], 1)
        self.assertEqual(self.store.export_data(), before)
        self.sync.run()
        self.assertEqual(len(self.cloud.receipts), 1)

    def test_initial_empty_collection_downloads_code_assets_trash_and_revisions(self):
        other = self.new_store("remote")
        one = self.add(other, codeSolution={"role": "snippet", "code": "int main() {\n  return 0;\n}\n"})
        image = other.create_asset({"name": "pixel.png", "mimeType": "image/png", "data": PNG})
        other.update_shard(one["id"], {"content": f"![pixel](/assets/{image['id']})"})
        deleted = self.add(other, title="Deleted")
        other.delete_shard(deleted["id"])
        capsule = LibrarySync(other, config_path=self.root / "absent").capsule()
        self.cloud.seed(capsule)
        self.assertEqual(self.sync.run()["status"], "synced")
        self.assertEqual(self.store.export_data(), other.export_data())
        self.assertTrue(list(self.store.backup_dir.glob("*.sqlite3")))

    def test_remote_replace_preserves_local_drafts_imports_and_metadata(self):
        self.add()
        self.sync.run()
        self.store.save_draft("editor", {"draft": {"values": {"title": "Unfinished"}}})
        with self.store.connect() as conn:
            conn.execute("INSERT INTO metadata VALUES('device-setting','preserve')")
            conn.execute("INSERT INTO imports VALUES('local-import','2026-01-01T00:00:00Z','{}')")
        remote = self.sync.capsule()
        remote["archive"]["shards"][0]["title"] = "Remote update"
        self.cloud.seed(remote)
        self.assertEqual(self.sync.run()["status"], "synced")
        self.assertEqual(self.store.state()["shards"][0]["title"], "Remote update")
        self.assertEqual(self.store.drafts()["drafts"]["editor"]["values"]["title"], "Unfinished")
        with self.store.connect() as conn:
            self.assertEqual(conn.execute("SELECT value FROM metadata WHERE key='device-setting'").fetchone()[0], "preserve")
            self.assertEqual(conn.execute("SELECT count(*) FROM imports WHERE id='local-import'").fetchone()[0], 1)

    def legacy_recovery_capsule(self):
        other = self.new_store("legacy-recovery")
        self.add(other, codeSolution={"role": "snippet", "code": "\r\nint f() {\r\n\treturn 3; // α\r\n}\r\n"})
        deleted = self.add(other, title="Legacy deleted")
        other.delete_shard(deleted["id"])
        capsule = LibrarySync(other, config_path=self.root / "absent").capsule()
        for snapshot in [item["snapshot"] for item in capsule["archive"]["revisions"]] + [item["shard"] for item in capsule["archive"]["trash"]]:
            for key in ("experiments", "verification", "learningLog", "comparisons", "perspectives", "walkthroughs", "courses", "notation", "assumptions", "subjects"):
                snapshot.pop(key, None)
            if not snapshot["codeSolution"]["role"]:
                snapshot.pop("codeSolution")
        capsule["archive"]["revisions"][0]["snapshot"]["legacyExtension"] = {"retain": True}
        return capsule

    def simulate_older_normalizing_client(self, capsule):
        self.cloud.seed(capsule)
        self.store.import_data(capsule["archive"])
        self.sync._save({"version": 1, "baseRevision": self.cloud.revision, "viewRevision": self.cloud.revision,
                         "baseLocalFingerprint": fingerprint(self.sync.capsule()), "status": "synced"})

    def test_download_retains_exact_legacy_revisions_and_trash(self):
        capsule = self.legacy_recovery_capsule()
        self.cloud.seed(capsule)
        self.assertEqual(self.sync.run()["status"], "synced")
        self.assertEqual(self.sync.capsule(), capsule)

    def test_clean_older_client_repairs_only_recovery_payloads_without_publishing(self):
        capsule = self.legacy_recovery_capsule()
        self.simulate_older_normalizing_client(capsule)
        self.assertNotEqual(self.sync.capsule(), capsule)
        before = self.store.export_data()
        publishes = len(self.cloud.publishes)
        self.assertEqual(self.sync.run()["status"], "synced")
        self.assertEqual(self.sync.capsule(), capsule)
        for kind in ("shards", "links", "assets", "boards", "reviews"):
            self.assertEqual(self.store.export_data()[kind], before[kind])
        self.assertEqual(len(self.cloud.publishes), publishes)
        self.assertTrue(list(self.store.backup_dir.glob("*.sqlite3")))
        with mock.patch.object(self.cloud, "download", side_effect=AssertionError("Base already checked")):
            self.assertEqual(self.sync.run()["status"], "synced")

    def test_recovery_repair_refuses_semantically_different_history(self):
        capsule = self.legacy_recovery_capsule()
        self.simulate_older_normalizing_client(capsule)
        with self.store.connect() as connection:
            row = connection.execute("SELECT id,snapshot FROM revisions LIMIT 1").fetchone()
            snapshot = json.loads(row[1]); snapshot["content"] = "Distinct local history"
            connection.execute("UPDATE revisions SET snapshot=? WHERE id=?", (json.dumps(snapshot), row[0]))
        before = self.sync.capsule()
        self.assertIsNone(self.sync._repair_recovery_payloads(capsule, fingerprint(before)))
        self.assertEqual(self.sync.capsule(), before)

    def test_local_edit_during_recovery_check_is_retained_and_not_acknowledged(self):
        capsule = self.legacy_recovery_capsule()
        self.simulate_older_normalizing_client(capsule)
        before_base = self.sync._state()["baseLocalFingerprint"]
        self.cloud.on_download = lambda: self.add(title="New during recovery check")
        self.assertEqual(self.sync.run()["status"], "local_changed")
        self.assertEqual(self.sync._state()["baseLocalFingerprint"], before_base)
        self.assertTrue(any(item["title"] == "New during recovery check" for item in self.store.state()["shards"]))
        self.assertEqual(self.sync.run()["status"], "synced")
        self.assertTrue(any(item["title"] == "New during recovery check" for item in self.cloud.download(self.cloud.head()["commit"])["archive"]["shards"]))

    def test_remote_receipts_prevent_deleted_inbox_resurrection(self):
        other = self.new_store("remote")
        batch = {"requestId": "immutable-inbox", "shards": [{"id": "from-inbox", "title": "Imported"}], "links": []}
        other.contribute(batch)
        other.delete_shard("from-inbox")
        self.cloud.seed(LibrarySync(other, config_path=self.root / "absent").capsule())
        self.assertEqual(self.sync.run()["status"], "synced")
        replay = self.store.contribute(batch)
        self.assertTrue(replay["replayed"])
        self.assertEqual(replay["missingShardIds"], ["from-inbox"])
        self.assertEqual(self.store.state()["shards"], [])

    def test_reply_loss_retries_same_mutation_after_restart(self):
        self.add()
        self.cloud.lose_next_receipt = True
        self.assertEqual(self.sync.run()["status"], "offline")
        pending = json.loads(self.sync.pending_path.read_text())
        self.assertEqual(len(self.cloud.receipts), 1)
        restarted = LibrarySync(self.store, config_path=self.config, client_factory=self.cloud)
        self.assertEqual(restarted.run()["status"], "synced")
        self.assertEqual(self.cloud.publishes[-1]["mutationId"], pending["mutationId"])
        self.assertEqual(len(self.cloud.receipts), 1)
        self.assertFalse(restarted.pending_path.exists())

    def test_new_local_change_during_upload_stays_pending(self):
        self.add()
        original = self.cloud.publish
        def publish(pending, data):
            self.add(title="Arrived while uploading")
            return original(pending, data)
        with mock.patch.object(self.cloud, "publish", side_effect=publish):
            self.assertEqual(self.sync.run()["status"], "pending")
        self.assertEqual(len(self.store.state()["shards"]), 2)
        self.assertEqual(self.sync.run()["status"], "synced")

    def prepare_conflict(self):
        self.add()
        self.sync.run()
        remote = self.sync.capsule()
        remote["archive"]["shards"][0]["title"] = "Cloud changed"
        self.cloud.seed(remote)
        self.store.update_shard(self.store.state()["shards"][0]["id"], {"title": "Device changed"})
        self.assertEqual(self.sync.run()["status"], "conflict")

    def test_concurrent_changes_preserve_both_snapshots_and_block(self):
        self.prepare_conflict()
        self.assertEqual(self.store.state()["shards"][0]["title"], "Device changed")
        self.assertEqual(self.cloud.download(self.cloud.head()["commit"])["archive"]["shards"][0]["title"], "Cloud changed")
        calls = len(self.cloud.publishes)
        self.sync.run()
        self.assertEqual(len(self.cloud.publishes), calls)
        self.assertTrue(self.sync.pending_path.exists())
        self.assertTrue(list(self.sync.directory.glob("conflict-*.json")))

    def test_resolve_cloud_keeps_local_backup(self):
        self.prepare_conflict()
        self.assertEqual(self.sync.resolve("cloud")["status"], "synced")
        self.assertEqual(self.store.state()["shards"][0]["title"], "Cloud changed")
        self.assertTrue(list(self.store.backup_dir.glob("*.sqlite3")))
        self.assertTrue(list(self.sync.directory.glob("conflict-*.json")))
        self.assertFalse(self.sync.pending_path.exists())

    def test_resolve_device_keeps_cloud_history(self):
        self.prepare_conflict()
        previous_head = self.cloud.revision
        self.assertEqual(self.sync.resolve("device")["status"], "synced")
        self.assertIn(previous_head, self.cloud.commits)
        self.assertEqual(self.cloud.download(self.cloud.head()["commit"])["archive"]["shards"][0]["title"], "Device changed")

    def test_device_resolution_reply_loss_retries_exact_choice_after_restart(self):
        self.prepare_conflict()
        self.cloud.lose_next_receipt = True
        self.assertEqual(self.sync.resolve("device")["status"], "offline")
        pending = json.loads(self.sync.pending_path.read_text())
        restarted = LibrarySync(self.store, config_path=self.config, client_factory=self.cloud)
        count = len(self.cloud.receipts)
        self.assertEqual(restarted.run()["status"], "synced")
        self.assertEqual(len(self.cloud.receipts), count)
        self.assertEqual(self.cloud.publishes[-1]["mutationId"], pending["mutationId"])

    def test_unique_payload_staging_keeps_previous_outbox_valid_until_manifest_swap(self):
        self.add()
        self.cloud.fail_next_publish = True
        self.sync.run()
        previous = json.loads(self.sync.pending_path.read_text())
        previous_payload = self.sync.payload_path.read_bytes()
        write = atomic_write
        def interrupted(path, data):
            if Path(path) == self.sync.pending_path:
                raise OSError("injected crash before manifest swap")
            return write(path, data)
        with mock.patch("library_sync.atomic_write", side_effect=interrupted):
            with self.assertRaises(OSError):
                self.sync._stage(self.sync.capsule(), "", fingerprint(self.sync.capsule()))
        recovered, data = self.sync._pending()
        self.assertEqual(recovered, previous)
        self.assertEqual(data, previous_payload)

    def test_changed_local_conflict_preview_requires_another_choice(self):
        self.prepare_conflict()
        self.add(title="New after preview")
        self.assertEqual(self.sync.resolve("cloud")["status"], "conflict")
        self.assertEqual(len(self.store.state()["shards"]), 2)
        self.assertEqual(self.sync.resolve("cloud")["status"], "synced")

    def test_changed_remote_conflict_preview_requires_another_choice(self):
        self.prepare_conflict()
        remote = self.cloud.download(self.cloud.head()["commit"])
        remote["archive"]["shards"][0]["title"] = "Cloud changed again"
        self.cloud.seed(remote)
        self.assertEqual(self.sync.resolve("device")["status"], "conflict")
        self.assertEqual(self.store.state()["shards"][0]["title"], "Device changed")
        self.assertEqual(self.sync.resolve("device")["status"], "synced")

    def test_local_write_during_download_prevents_replace(self):
        self.cloud.seed(self.remote_capsule(title="Cloud"))
        self.cloud.on_download = lambda: self.add(title="Just typed")
        self.assertEqual(self.sync.run()["status"], "local_changed")
        self.assertEqual(self.store.state()["shards"][0]["title"], "Just typed")

    def test_unsaved_editor_lease_blocks_run_and_download_apply(self):
        self.cloud.seed(self.remote_capsule(title="Cloud"))
        self.sync.editing(True)
        self.assertEqual(self.sync.run()["status"], "editing")
        self.assertEqual(self.store.state()["shards"], [])
        self.sync.editing(False)
        self.cloud.on_download = lambda: self.sync.editing(True)
        self.assertEqual(self.sync.run()["status"], "editing")
        self.assertEqual(self.store.state()["shards"], [])
        self.sync.editing(False)
        self.assertEqual(self.sync.run()["status"], "synced")

    def test_editor_lease_retains_existing_pending_upload(self):
        self.add()
        self.cloud.fail_next_publish = True
        self.sync.run()
        pending = self.sync.pending_path.read_bytes()
        self.sync.editing(True)
        self.assertEqual(self.sync.run()["status"], "editing")
        self.assertEqual(self.sync.pending_path.read_bytes(), pending)
        self.sync.editing(False)
        self.assertEqual(self.sync.run()["status"], "synced")

    def test_clean_window_cannot_clear_another_windows_editor_lease(self):
        self.cloud.seed(self.remote_capsule(title="Cloud"))
        self.sync.editing(True, "dirty-window")
        self.sync.editing(False, "clean-window")
        self.assertEqual(self.sync.run()["status"], "editing")
        self.sync.editing(False, "dirty-window")
        self.assertEqual(self.sync.run()["status"], "synced")

    def test_expired_editor_leases_do_not_block_reconnection_forever(self):
        self.cloud.seed(self.remote_capsule(title="Cloud"))
        with mock.patch("library_sync.time.monotonic", return_value=100):
            self.sync.editing(True, "closed-window")
        with mock.patch("library_sync.time.monotonic", return_value=131):
            self.assertEqual(self.sync.run()["status"], "synced")

    def test_invalid_remote_archive_cannot_remove_existing_collection(self):
        self.add()
        self.sync.run()
        before = self.store.export_data()
        remote = self.sync.capsule()
        remote["archive"]["links"] = [{"id": "broken", "fromId": "missing", "toId": "other", "type": "uses"}]
        self.cloud.seed(remote)
        self.assertEqual(self.sync.run()["status"], "error")
        self.assertEqual(self.store.export_data(), before)

    def test_replace_failure_rolls_back_all_tables(self):
        self.add()
        before = self.store.export_data()
        capsule = self.remote_capsule(title="Replacement")
        with mock.patch.object(self.store, "_merge", side_effect=sqlite3.OperationalError("injected disk failure")):
            with self.assertRaises(sqlite3.OperationalError):
                self.sync._apply(capsule, fingerprint(self.sync.capsule()))
        self.assertEqual(self.store.export_data(), before)

    def test_pending_snapshot_tampering_blocks_retry(self):
        self.add()
        self.cloud.fail_next_publish = True
        self.sync.run()
        self.sync.payload_path.write_bytes(b"tampered")
        self.assertEqual(self.sync.run()["status"], "invalid_outbox")
        self.assertEqual(len(self.store.state()["shards"]), 1)

    def test_credentials_are_absent_from_status_capsule_and_outbox(self):
        self.add()
        self.cloud.fail_next_publish = True
        self.sync.run()
        visible = json.dumps([self.sync.status(), self.sync.capsule(), json.loads(self.sync.pending_path.read_text())])
        self.assertNotIn("temporary-test-token", visible)
        self.assertNotIn("temporary-test-service-secret", visible)
        self.assertEqual(self.sync.pending_path.stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.sync.payload_path.stat().st_mode & 0o777, 0o600)

    def test_protocol_and_manifest_guards(self):
        with self.assertRaises(SyncError):
            validate_manifest({"protocolVersion": 2})
        with self.assertRaises(SyncError):
            validate_capsule({"format": "shard-atlas-library", "version": 2})
        self.assertIsNone(NoRedirect().redirect_request(None, None, 302, "", {}, "https://other.example"))

    def test_client_download_rejects_wrong_chunk_hash(self):
        client = LibraryClient(json.loads(self.config.read_text()))
        body = b"abc"
        manifest = {"protocolVersion": 1, "archiveVersion": 1, "format": "shard-atlas-library-json", "bytes": 3,
                    "sha256": digest(body), "chunks": [{"bytes": 3, "sha256": digest(body)}]}
        with mock.patch.object(client, "request", return_value=b"bad"):
            with self.assertRaises(SyncError) as caught:
                client.download({"manifest": manifest})
        self.assertEqual(caught.exception.code, "digest_mismatch")


class LibrarySyncHTTPTests(unittest.TestCase):
    def test_own_publication_keeps_view_valid_and_remote_pull_invalidates_it(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            store = Store(root / "test.sqlite3", root=root, seed=False, backup_on_start=False, automatic_backups=False)
            server = LocalServer(("127.0.0.1", 0), store)
            cloud = FakeCloud()
            server.library_sync.client_factory = cloud
            atomic_write(server.library_sync.config_path, canonical({"siteUrl": SITE_URL,
                "serviceToken": "test-token", "serviceSecret": "temporary-test-service-secret"}))
            worker = threading.Thread(target=server.serve_forever, daemon=True)
            worker.start()
            try:
                client = http.client.HTTPConnection("127.0.0.1", server.server_address[1], timeout=5)
                headers = {"Content-Type": "application/json", "X-Shard-Atlas-View-Revision": ""}
                client.request("POST", "/api/shards", body='{"title":"First save"}', headers=headers)
                response = client.getresponse()
                self.assertEqual(response.status, 201)
                response.read()
                self.assertEqual(server.library_sync.run()["status"], "synced")
                self.assertEqual(server.library_sync.view_revision(), "")
                client.request("POST", "/api/shards", body='{"title":"Second save"}', headers=headers)
                response = client.getresponse()
                self.assertEqual(response.status, 201)
                response.read()
                self.assertEqual(server.library_sync.run()["status"], "synced")
                remote = server.library_sync.capsule()
                remote["archive"]["shards"][0]["title"] = "Remote update"
                cloud.seed(remote)
                self.assertEqual(server.library_sync.run()["status"], "synced")
                self.assertEqual(server.library_sync.view_revision(), cloud.revision)
                client.request("POST", "/api/shards", body='{"title":"Stale save"}', headers=headers)
                response = client.getresponse()
                self.assertEqual(response.status, 409)
                response.read()
                self.assertEqual(len(store.state()["shards"]), 2)
                client.close()
            finally:
                server.shutdown()
                server.server_close()
                worker.join(timeout=2)

    def test_status_and_editing_boundaries_without_real_config(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            store = Store(root / "test.sqlite3", root=root, seed=False, backup_on_start=False, automatic_backups=False)
            server = LocalServer(("127.0.0.1", 0), store)
            worker = threading.Thread(target=server.serve_forever, daemon=True)
            worker.start()
            try:
                client = http.client.HTTPConnection("127.0.0.1", server.server_address[1], timeout=5)
                client.request("GET", "/api/library-sync/status")
                response = client.getresponse()
                self.assertEqual(response.status, 200)
                self.assertEqual(response.getheader("X-Shard-Atlas-Library-Revision"), None)
                self.assertEqual(json.loads(response.read())["status"], "not_configured")
                client.request("POST", "/api/library-sync/editing", body='{"editing":true}', headers={"Content-Type": "application/json"})
                response = client.getresponse()
                self.assertEqual(response.status, 200)
                self.assertTrue(json.loads(response.read())["editing"])
                client.request("POST", "/api/library-sync/editing", body='{"editing":"yes"}', headers={"Content-Type": "application/json"})
                response = client.getresponse()
                self.assertEqual(response.status, 400)
                response.read()
                client.request("POST", "/api/library-sync/resolve", body='{"choice":"other"}', headers={"Content-Type": "application/json"})
                response = client.getresponse()
                self.assertEqual(response.status, 400)
                response.read()
                client.close()
            finally:
                server.shutdown()
                server.server_close()
                worker.join(timeout=2)

    def test_sleeping_window_mutation_is_rejected_and_draft_is_retained(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            store = Store(root / "test.sqlite3", root=root, seed=False, backup_on_start=False, automatic_backups=False)
            store.create_shard({"title": "Preserve"})
            server = LocalServer(("127.0.0.1", 0), store)
            worker = threading.Thread(target=server.serve_forever, daemon=True)
            worker.start()
            try:
                client = http.client.HTTPConnection("127.0.0.1", server.server_address[1], timeout=5)
                client.request("GET", "/api/state")
                response = client.getresponse()
                self.assertEqual(response.getheader("X-Shard-Atlas-Library-Revision"), "")
                response.read()
                with store.lock:
                    server.library_sync._save({"version": 1, "baseRevision": "cloud-new", "viewRevision": "cloud-new", "baseLocalFingerprint": None, "status": "ready"})
                headers = {"Content-Type": "application/json", "X-Shard-Atlas-View-Revision": ""}
                client.request("POST", "/api/shards", body='{"title":"Stale write"}', headers=headers)
                response = client.getresponse()
                self.assertEqual(response.status, 409)
                self.assertIn("draft", json.loads(response.read())["error"])
                self.assertEqual([item["title"] for item in store.state()["shards"]], ["Preserve"])
                client.request("PUT", "/api/drafts/editor", body='{"draft":{"values":{"title":"Keep draft"}}}', headers=headers)
                response = client.getresponse()
                self.assertEqual(response.status, 200)
                response.read()
                self.assertEqual(store.drafts()["drafts"]["editor"]["values"]["title"], "Keep draft")
                client.request("GET", "/api/data")
                response = client.getresponse()
                self.assertEqual(response.getheader("X-Shard-Atlas-Library-Revision"), "cloud-new")
                response.read()
                headers["X-Shard-Atlas-View-Revision"] = "cloud-new"
                client.request("POST", "/api/shards", body='{"title":"Fresh write"}', headers=headers)
                response = client.getresponse()
                self.assertEqual(response.status, 201)
                response.read()
                # Local AI clients remain compatible without a view header.
                client.request("POST", "/api/shards", body='{"title":"AI write"}', headers={"Content-Type": "application/json"})
                response = client.getresponse()
                self.assertEqual(response.status, 201)
                response.read()
                client.close()
            finally:
                server.shutdown()
                server.server_close()
                worker.join(timeout=2)


if __name__ == "__main__":
    unittest.main()
