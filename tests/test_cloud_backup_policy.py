"""Native recovery policy checks using isolated stores and an in-memory cloud."""

import copy
import contextlib
import gzip
import hashlib
import http.client
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import sqlite3
import sys
import tempfile
import threading
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from cloud_backups import CloudBackups, MAX_COMPRESSED_BYTES, MAX_ORIGINAL_BYTES
from library_sync import LibraryClient, SITE_URL, SyncError, atomic_write, canonical
from server import AppError, LocalServer, Store


class RecoveryCloud:
    def __init__(self):
        self.calls = []
        self.blobs = {}
        self.receipts = {}
        self.ready = True
        self.offline = False
        self.fail_commit = False
        self.lose_reply = False
        self.bad_reply = False

    def __call__(self, config):
        return self

    def request(self, path, *, method="GET", data=None, binary=False, maximum=None, success_statuses=None):
        self.calls.append((method, path, copy.deepcopy(data)))
        if self.offline:
            raise SyncError("Offline", "offline")
        prefix = "/api/cloud-backups"
        if path == prefix + "/status":
            return {"configured": True, "managed": self.ready, "mode": "cloud",
                    "localHistoryAllowed": not self.ready, "lastVerified": None}
        if path.startswith(prefix + "/device-snapshots/blobs/"):
            checksum = path.rsplit("/", 1)[1]
            assert hashlib.sha256(data).hexdigest() == checksum
            self.blobs[checksum] = data
            return {"sha256": checksum, "bytes": len(data)}
        if path == prefix + "/device-snapshots/request":
            if self.fail_commit:
                raise SyncError("Interrupted", "offline")
            request_id = data["requestId"]
            if request_id not in self.receipts:
                payload = b"".join(self.blobs[chunk["sha256"]] for chunk in data["chunks"])
                assert len(payload) == data["bytes"]
                assert hashlib.sha256(payload).hexdigest() == data["sha256"]
                raw = gzip.decompress(payload)
                assert len(raw) == data["originalBytes"]
                assert hashlib.sha256(raw).hexdigest() == data["originalSha256"]
                identity = "snapshot-" + str(len(self.receipts) + 1)
                self.receipts[request_id] = {"id": identity, "filename": "cloud:" + identity,
                    "createdAt": data["createdAt"], "sha256": data["sha256"], "bytes": data["bytes"],
                    "durable": True, "verified": True, "driveVerified": False, "status": "staged", "kind": "device",
                    "manifest": copy.deepcopy(data)}
            result = copy.deepcopy(self.receipts[request_id])
            if self.lose_reply:
                self.lose_reply = False
                raise SyncError("Reply lost", "offline")
            if self.bad_reply:
                result["sha256"] = "0" * 64
            return result
        if path.startswith(prefix + "/catalog"):
            return {"items": copy.deepcopy(list(self.receipts.values())), "nextCursor": None}
        if path == prefix + "/request":
            return {"checkpoint": "library-point", "queued": True}
        if path in (prefix + "/restore/request", prefix + "/restore/preview", prefix + "/restore/confirm"):
            return {"received": copy.deepcopy(data), "operation": path.rsplit("/", 1)[1]}
        if path == prefix + "/restores":
            return {"items": []}
        raise AssertionError(path)


class CloudBackupPolicyTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.policy = self.root / "cloud-backups.json"
        self.connection = self.root / "library-sync.json"
        atomic_write(self.connection, canonical({"siteUrl": SITE_URL, "serviceToken": "temporary-service-token",
            "serviceSecret": "temporary-service-secret-for-tests"}))
        self.cloud = RecoveryCloud()
        self.store = self.make_store()

    def tearDown(self):
        self.store.stop_backup_worker()
        self.temporary.cleanup()

    def make_store(self, **extra):
        options = {"root": self.root, "seed": False, "backup_on_start": False, "automatic_backups": False,
                   "cloud_backup_config": self.policy, "cloud_backup_client_factory": self.cloud}
        options.update(extra)
        return Store(self.root / "shards.sqlite3", **options)

    def activate(self):
        atomic_write(self.policy, canonical({"version": 1, "mode": "cloud", "verified": True, "deviceId": "test-device"}))

    def add(self, title="An isolated shard"):
        self.store.create_shard({"title": title, "content": "Exact C++: int x = 1;\n"})
        return next(item for item in self.store.state()["shards"] if item["title"] == title)

    def raw_receipt(self, receipt):
        source = next(item for item in self.cloud.receipts.values() if item["id"] == receipt["id"])
        return gzip.decompress(b"".join(self.cloud.blobs[item["sha256"]] for item in source["manifest"]["chunks"]))

    @contextlib.contextmanager
    def real_http_client(self, transform=None):
        cloud, observed = self.cloud, []
        class CloudHandler(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def dispatch(self):
                authorized = (self.headers.get("X-Shard-Atlas-Sync") == "1"
                    and self.headers.get("OAI-Sites-Authorization") == "Bearer temporary-service-token"
                    and self.headers.get("X-Shard-Atlas-Service") == "temporary-service-secret-for-tests")
                observed.append({"method": self.command, "path": self.path, "authorized": authorized,
                                 "contentType": self.headers.get("Content-Type")})
                if not authorized:
                    body, code = canonical({"error": "Private service access required"}), 403
                else:
                    length = int(self.headers.get("Content-Length", "0"))
                    raw = self.rfile.read(length)
                    binary = self.command == "PUT"
                    data = raw if binary else json.loads(raw) if raw else None
                    result = cloud.request(self.path, method=self.command, data=data, binary=binary)
                    reply = transform(self.path, result) if transform else result
                    body, code = reply if isinstance(reply, bytes) else canonical(reply), 200
                self.send_response(code)
                self.send_header("X-Shard-Atlas-Sync", "1")
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            do_GET = dispatch
            do_POST = dispatch
            do_PUT = dispatch
        server = ThreadingHTTPServer(("127.0.0.1", 0), CloudHandler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        client = LibraryClient({"siteUrl": f"http://127.0.0.1:{server.server_address[1]}",
            "serviceToken": "temporary-service-token", "serviceSecret": "temporary-service-secret-for-tests"})
        try:
            yield client, observed
        finally:
            server.shutdown()
            server.server_close()
            thread.join(2)

    def test_unconnected_local_mode_keeps_existing_backup_contract(self):
        self.add()
        result = self.store.backup()
        self.assertTrue((self.store.backup_dir / result["filename"]).is_file())
        self.assertEqual(self.store.health()["backupMode"], "local")
        self.assertFalse(self.cloud.calls)

    def test_actual_library_client_binary_put_json_acknowledgement_completes_sqlite_recovery(self):
        self.add()
        self.store.save_draft("editor", {"draft": {"content": "device-only draft over real HTTP"}})
        before, drafts = self.store.export_data(), self.store.drafts()
        self.activate()
        with self.real_http_client() as (client, requests):
            self.store.cloud_backups.client_factory = lambda _: client
            # Establish the actual client behavior that the previous dictionary
            # fake hid: a binary PUT returns the JSON response as raw bytes.
            probe = b"isolated-transport-probe"
            probe_hash = hashlib.sha256(probe).hexdigest()
            reply = client.request("/api/cloud-backups/device-snapshots/blobs/" + probe_hash,
                method="PUT", data=probe, binary=True)
            self.assertIsInstance(reply, bytes)
            self.assertEqual(json.loads(reply)["sha256"], probe_hash)
            receipt = self.store.backup()
            self.assertTrue(receipt["durable"])
            self.assertTrue(receipt["verified"])
            self.assertTrue(all(item["authorized"] for item in requests))
            self.assertTrue(any(item["method"] == "PUT" and item["contentType"] == "application/octet-stream" for item in requests))
        recovered = self.root / "real-http-recovered.sqlite3"
        recovered.write_bytes(self.raw_receipt(receipt))
        restored = Store(recovered, root=self.root / "http-restored", seed=False, backup_on_start=False,
                         automatic_backups=False, cloud_backup_config=self.root / "absent-http-policy")
        self.assertEqual(restored.export_data(), before)
        self.assertEqual(restored.drafts(), drafts)
        self.assertFalse(self.store.cloud_backups.has_pending)
        self.assertFalse(self.store.backup_dir.exists())

    def test_real_http_mismatched_chunk_acknowledgement_keeps_prestate_and_blocks_delete(self):
        shard = self.add()
        self.activate()
        def mismatch(path, result):
            return {**result, "sha256": "0" * 64} if "/device-snapshots/blobs/" in path else result
        with self.real_http_client(mismatch) as (client, _):
            self.store.cloud_backups.client_factory = lambda _: client
            with self.assertRaises(AppError):
                self.store.delete_shard(shard["id"])
        self.assertEqual(self.store.state()["shards"][0]["id"], shard["id"])
        self.assertTrue(self.store.cloud_backups.has_pending)
        self.assertFalse(self.cloud.receipts)

    def test_real_http_invalid_utf8_or_nonfinite_upload_acknowledgements_are_rejected(self):
        self.add()
        self.activate()
        for invalid in (b"\xff", b'{"bytes":NaN}'):
            with self.subTest(reply=invalid):
                def bad_json(path, result):
                    return invalid if "/device-snapshots/blobs/" in path else result
                with self.real_http_client(bad_json) as (client, _):
                    self.store.cloud_backups.client_factory = lambda _: client
                    with self.assertRaises(AppError):
                        self.store.backup()
                self.assertTrue(self.store.cloud_backups.has_pending)
                self.assertFalse(self.cloud.receipts)

    def test_verified_device_checkpoint_includes_drafts_and_import_undo_state(self):
        self.add()
        self.store.save_draft("editor", {"draft": {"content": "unfinished exact draft"}})
        self.store.import_data({"schemaVersion": 1, "shards": [{"id": "import-test", "title": "Imported", "content": "preserve import metadata"}], "links": []})
        before = self.store.export_data()
        self.activate()
        receipt = self.store.backup()
        self.assertEqual(receipt["filename"], "cloud:snapshot-1")
        self.assertTrue(receipt["verified"])
        self.assertFalse(receipt["driveVerified"])
        recovered = self.root / "recovered.sqlite3"
        recovered.write_bytes(self.raw_receipt(receipt))
        restored = Store(recovered, root=self.root / "restored", seed=False, backup_on_start=False, automatic_backups=False,
                         cloud_backup_config=self.root / "unused-policy")
        self.assertEqual(restored.export_data(), before)
        self.assertEqual(restored.drafts(), self.store.drafts())
        self.assertEqual(restored.imports(), self.store.imports())
        self.assertFalse(self.store.cloud_backups.pending_path.exists())
        self.assertFalse(self.store.cloud_backups.payload_path.exists())
        self.assertFalse(self.store.cloud_backups.raw_path.exists())
        self.assertEqual(self.store.health()["backupMode"], "cloud")

    def test_startup_and_periodic_checks_do_not_create_device_or_local_history(self):
        self.activate()
        self.store = self.make_store(backup_on_start=True, automatic_backups=True, backup_interval_seconds=0)
        self.add()
        self.assertFalse(self.cloud.calls)
        self.store.backup_tick(background=True)
        self.assertFalse(self.store.backup_dir.exists())
        self.assertFalse(self.cloud.receipts)
        self.assertTrue(self.cloud.calls)
        self.assertTrue(all(method == "GET" and path.endswith("/status") for method, path, _ in self.cloud.calls))
        self.assertFalse(self.store.cloud_backups.local_status()["pendingSafetyUpload"])

    def test_background_network_check_does_not_hold_the_edit_lock(self):
        self.activate()
        self.store = self.make_store(backup_on_start=True, automatic_backups=True, backup_interval_seconds=0)
        started, release = threading.Event(), threading.Event()
        original_request = self.cloud.request
        def blocked_status(path, **kwargs):
            if path.endswith("/status"):
                started.set()
                if not release.wait(2):
                    raise AssertionError("The edit could not run while the status request waited.")
            return original_request(path, **kwargs)
        with mock.patch.object(self.cloud, "request", side_effect=blocked_status):
            self.store.start_backup_worker()
            try:
                self.assertTrue(started.wait(1))
                self.add("Editing remains available during a slow cloud check")
                self.assertEqual(len(self.store.state()["shards"]), 1)
            finally:
                release.set()
                self.store.stop_backup_worker()

    def test_offline_edits_work_but_destructive_change_waits_for_protection(self):
        shard = self.add()
        self.activate()
        self.cloud.offline = True
        self.store.automatic_backups = True
        self.store.backup_interval_seconds = 0
        self.store.update_shard(shard["id"], {"content": "offline saved edit"})
        with self.assertRaises(AppError):
            self.store.delete_shard(shard["id"])
        self.assertEqual(next(item for item in self.store.state()["shards"] if item["id"] == shard["id"])["content"], "offline saved edit")
        self.assertFalse(self.store.backup_dir.exists())
        self.assertFalse(self.store.cloud_backups.payload_path.exists())

    def test_failed_upload_retains_one_prestate_and_does_not_overwrite_it(self):
        shard = self.add()
        self.activate()
        self.cloud.fail_commit = True
        with self.assertRaises(AppError):
            self.store.delete_shard(shard["id"])
        pending = self.store.cloud_backups.payload_path.read_bytes()
        request = self.store.cloud_backups.pending_path.read_bytes()
        self.store.update_shard(shard["id"], {"content": "a later ordinary edit"})
        with self.assertRaises(AppError):
            self.store.delete_shard(shard["id"])
        self.assertEqual(self.store.cloud_backups.payload_path.read_bytes(), pending)
        self.assertEqual(self.store.cloud_backups.pending_path.read_bytes(), request)
        self.assertEqual(len(list(self.store.cloud_backups.directory.glob("*.gz"))), 1)
        self.cloud.fail_commit = False
        self.store.delete_shard(shard["id"])
        self.assertEqual(len(self.cloud.receipts), 2)  # Retained point, then current pre-delete state.
        self.assertFalse(self.store.cloud_backups.payload_path.exists())
        self.assertFalse(self.store.backup_dir.exists())

    def test_lost_reply_retries_the_same_remote_request_before_capturing_again(self):
        self.add()
        self.activate()
        self.cloud.lose_reply = True
        with self.assertRaises(AppError):
            self.store.backup()
        original_id = json.loads(self.store.cloud_backups.pending_path.read_text())["request"]["requestId"]
        self.assertEqual(len(self.cloud.receipts), 1)
        self.store.cloud_backups.retry_pending()
        self.assertEqual(len(self.cloud.receipts), 1)
        posted = [body["requestId"] for method, path, body in self.cloud.calls if path.endswith("/device-snapshots/request")]
        self.assertEqual(posted, [original_id, original_id])
        self.assertFalse(self.store.cloud_backups.payload_path.exists())

    def test_background_retries_pending_safety_point_even_without_a_dirty_edit(self):
        self.add()
        self.activate()
        self.store._dirty = False
        self.cloud.fail_commit = True
        with self.assertRaises(AppError):
            self.store.backup()
        self.assertFalse(self.store._dirty)
        self.cloud.fail_commit = False
        self.store.automatic_backups = True
        self.store.backup_interval_seconds = 0
        self.store.backup_tick(background=True)
        self.assertFalse(self.store.cloud_backups.has_pending)
        self.assertEqual(len(self.cloud.receipts), 1)

    def test_bad_receipt_or_tampered_staging_never_discards_pending_bytes(self):
        self.add()
        self.activate()
        self.cloud.bad_reply = True
        with self.assertRaises(AppError):
            self.store.backup()
        payload = self.store.cloud_backups.payload_path
        original = payload.read_bytes()
        self.assertTrue(self.store.cloud_backups.pending_path.exists())
        payload.write_bytes(original[:-1] + bytes([original[-1] ^ 1]))
        self.cloud.bad_reply = False
        with self.assertRaises(AppError):
            self.store.backup()
        self.assertTrue(payload.exists())
        self.assertEqual(len(self.cloud.receipts), 1)

    def test_cloud_not_ready_or_unverified_policy_does_not_fall_back_to_disk(self):
        self.add()
        self.activate()
        self.cloud.ready = False
        with self.assertRaises(AppError):
            self.store.backup()
        self.assertFalse(self.store.backup_dir.exists())
        self.cloud.ready = True
        atomic_write(self.policy, canonical({"version": 1, "mode": "cloud", "verified": False}))
        with self.assertRaises(AppError):
            self.store.backup()
        self.assertFalse(self.store.backup_dir.exists())

    def test_corrupt_pending_metadata_returns_a_safe_error_and_preserves_data(self):
        shard = self.add()
        self.activate()
        self.cloud.fail_commit = True
        with self.assertRaises(AppError):
            self.store.backup()
        atomic_write(self.store.cloud_backups.pending_path, b"{invalid json")
        self.cloud.fail_commit = False
        with self.assertRaises(AppError):
            self.store.delete_shard(shard["id"])
        self.assertEqual(self.store.state()["shards"][0]["id"], shard["id"])
        self.assertTrue(self.store.cloud_backups.payload_path.exists())

    def test_policy_permissions_and_snapshot_budget_are_enforced(self):
        self.add()
        self.activate()
        self.policy.chmod(0o644)
        with self.assertRaises(AppError):
            self.store.backup()
        self.policy.chmod(0o600)
        with mock.patch("cloud_backups.MAX_ORIGINAL_BYTES", 1), self.assertRaises(AppError) as error:
            self.store.backup()
        self.assertEqual(error.exception.status, 413)
        self.assertFalse(self.store.cloud_backups.raw_path.exists())
        self.assertFalse(self.store.backup_dir.exists())

    def test_link_and_draft_discard_preserve_device_only_prestate(self):
        first = self.add("First endpoint")
        second = self.add("Second endpoint")
        self.store.create_link({"fromId": first["id"], "toId": second["id"], "type": "related_to", "note": "unique offline relationship"})
        relationship = self.store.state()["links"][0]
        self.store.save_draft("editor", {"draft": {"content": "unique offline draft"}})
        self.activate()
        self.cloud.offline = True
        with self.assertRaises(AppError):
            self.store.delete_link(relationship["id"])
        with self.assertRaises(AppError):
            self.store.delete_draft("editor")
        self.assertEqual(self.store.state()["links"][0]["id"], relationship["id"])
        self.assertEqual(self.store.drafts()["drafts"]["editor"]["content"], "unique offline draft")
        self.cloud.offline = False
        self.store.delete_link(relationship["id"])
        self.store.delete_draft("editor")
        self.assertEqual(len(self.cloud.receipts), 2)
        self.assertFalse(self.store.state()["links"])
        self.assertIsNone(self.store.drafts()["drafts"]["editor"])

    def test_interrupted_consistent_capture_is_uploaded_before_new_capture(self):
        self.add()
        self.activate()
        service = self.store.cloud_backups
        service._directory()
        service._capture()
        original_bytes = service.raw_path.read_bytes()
        self.add("A later shard")
        receipt = self.store.backup()
        self.assertEqual(len(self.cloud.receipts), 2)
        first = next(iter(self.cloud.receipts.values()))
        self.assertEqual(self.raw_receipt(first), original_bytes)
        self.assertNotEqual(self.raw_receipt(receipt), original_bytes)
        self.assertFalse(service.raw_path.exists())

    def test_proxy_preserves_restore_request_identity_and_normalizes_catalog(self):
        self.add()
        self.activate()
        self.store.backup()
        catalog = self.store.backups()
        self.assertEqual(catalog["backups"][0]["filename"], "cloud:snapshot-1")
        body = {"requestId": "restore-stable-id", "previewTicket": "test-preview", "confirm": True}
        result = self.store.cloud_backup_request("/restore/confirm", method="POST", data=body)
        self.assertEqual(result["received"], body)
        self.assertFalse(self.store.cloud_backups.local_status()["pendingSafetyUpload"])

    def test_restart_finishes_partial_cleanup_only_for_verified_exact_bytes(self):
        self.add()
        self.activate()
        receipt = self.store.backup()
        remote = next(iter(self.cloud.receipts.values()))
        service = self.store.cloud_backups
        payload = b"".join(self.cloud.blobs[item["sha256"]] for item in remote["manifest"]["chunks"])
        for surviving in ("pending", "compressed", "raw"):
            with self.subTest(surviving=surviving):
                if surviving == "pending":
                    atomic_write(service.pending_path, canonical({"version": 1, "request": remote["manifest"]}))
                elif surviving == "compressed":
                    atomic_write(service.payload_path, payload)
                else:
                    atomic_write(service.raw_path, gzip.decompress(payload))
                result = service.retry_pending()
                self.assertEqual(result["id"], receipt["id"])
                self.assertFalse(service.local_status()["pendingSafetyUpload"])
                self.assertEqual(len(self.cloud.receipts), 1)

    def test_http_status_and_manual_routes_use_the_private_cloud_connection(self):
        self.activate()
        with mock.patch("library_sync.LibrarySync.start"), mock.patch("library_sync.LibrarySync.stop"):
            server = LocalServer(("127.0.0.1", 0), self.store)
            worker = threading.Thread(target=server.serve_forever, daemon=True)
            worker.start()
            try:
                connection = http.client.HTTPConnection("127.0.0.1", server.server_address[1])
                connection.request("GET", "/api/cloud-backups/status")
                response = connection.getresponse()
                status = json.loads(response.read())
                self.assertEqual(response.status, 200)
                self.assertEqual(status["localPolicy"]["mode"], "cloud")
                self.assertNotIn("serviceSecret", json.dumps(status))
                connection.request("POST", "/api/cloud-backups/request", body=b"{}", headers={"Content-Type": "application/json"})
                response = connection.getresponse()
                self.assertTrue(json.loads(response.read())["queued"])
                self.assertEqual(response.status, 200)
                connection.close()
            finally:
                server.shutdown()
                server.server_close()
                worker.join(2)


if __name__ == "__main__":
    unittest.main()
