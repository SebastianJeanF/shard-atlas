import contextlib
import datetime as dt
import gzip
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import sqlite3
import tempfile
import threading
import unittest

from tools.cloud_backup_runner import BackupError, download_checkpoint, merge_restore_capsule, prepare_restoration, retention_plan, strict_json, upload_restoration, verify_file


def digest(data):
    return hashlib.sha256(data).hexdigest()


@contextlib.contextmanager
def source(data, *, device=False, corrupt=False):
    blocks = [data[:len(data)//2], data[len(data)//2:]]
    chunks = [{"sha256": digest(block), "bytes": len(block)} for block in blocks]
    content = dict(zip((chunk["sha256"] for chunk in chunks), blocks))

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            if self.headers.get("OAI-Sites-Authorization") != "Bearer test-site-access" or self.headers.get("X-Shard-Atlas-Backup-Ticket") != "test-scoped-ticket":
                self.send_error(403)
                return
            block = content[self.path.rsplit("/", 1)[-1]]
            self.send_response(200)
            self.end_headers()
            self.wfile.write(bytes([block[0] ^ 1]) + block[1:] if corrupt else block)

        def log_message(self, *_):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    manifest = {"protocolVersion": 1, "archiveVersion": 1,
                "format": "shard-atlas-device-sqlite-gzip" if device else "shard-atlas-library-json",
                "sha256": digest(data), "bytes": len(data), "chunks": chunks}
    if device:
        original = gzip.decompress(data)
        manifest.update(originalSha256=digest(original), originalBytes=len(original))
    descriptor = {"checkpoint": {"id": "checkpoint-1", "kind": "device" if device else "library", "manifest": manifest},
                  "transfer": {"ticket": "test-scoped-ticket", "chunkPath": "/api/cloud-backups/transfers/checkpoint-1/blobs/{sha256}"},
                  "siteUrl": f"http://127.0.0.1:{server.server_port}", "siteBearer": "test-site-access"}
    try:
        yield descriptor
    finally:
        server.shutdown()
        thread.join(timeout=5)
        server.server_close()


class CloudBackupRunnerTests(unittest.TestCase):
    def test_streamed_library_roundtrip_and_credentials_never_saved(self):
        data = json.dumps({"format": "shard-atlas-library", "version": 1, "archive": {"shards": [{"id": "note", "body": "λ\nexact C++: auto x = \"\\n\";"}], "assets": [{"id": "image", "data": "abc"}]}, "unknown": {"keep": True}}, ensure_ascii=False).encode()
        with source(data) as descriptor, tempfile.TemporaryDirectory() as folder:
            result = download_checkpoint(descriptor, folder)
            self.assertEqual(gzip.decompress(Path(result["file"]).read_bytes()), data)
            text = Path(result["manifestFile"]).read_text()
            self.assertNotIn("test-site-access", text)
            self.assertNotIn("test-scoped-ticket", text)
            metadata = strict_json(text)
            self.assertEqual(verify_file(result["file"], metadata)["sourceSha256"], digest(data))
            self.assertFalse(list(Path(folder).glob("*.partial")))

    def test_corrupt_transfer_never_becomes_a_backup(self):
        with source(b"a complete immutable checkpoint", corrupt=True) as descriptor, tempfile.TemporaryDirectory() as folder:
            with self.assertRaises(BackupError):
                download_checkpoint(descriptor, folder)
            self.assertEqual(list(Path(folder).iterdir()), [])

    def test_drive_readback_tampering_is_refused(self):
        with source(b'{"archive":{"shards":[]}}') as descriptor, tempfile.TemporaryDirectory() as folder:
            result = download_checkpoint(descriptor, folder)
            metadata = strict_json(Path(result["manifestFile"]).read_text())
            Path(result["file"]).write_bytes(b"changed")
            with self.assertRaises(BackupError):
                verify_file(result["file"], metadata)

    def test_sqlite_checkpoint_keeps_original_compression_and_local_state(self):
        with tempfile.TemporaryDirectory() as folder:
            database = Path(folder) / "working.sqlite3"
            with sqlite3.connect(database) as connection:
                connection.execute("CREATE TABLE drafts (id TEXT, body TEXT)")
                connection.execute("INSERT INTO drafts VALUES ('draft', 'unsynced text')")
            compressed = gzip.compress(database.read_bytes(), mtime=0)
            with source(compressed, device=True) as descriptor:
                result = download_checkpoint(descriptor, Path(folder) / "cloud")
                self.assertEqual(Path(result["file"]).read_bytes(), compressed)
                restored = Path(folder) / "restored.sqlite3"
                restored.write_bytes(gzip.decompress(Path(result["file"]).read_bytes()))
                with sqlite3.connect(restored) as connection:
                    self.assertEqual(connection.execute("SELECT body FROM drafts").fetchone()[0], "unsynced text")

    def test_cross_origin_descriptor_is_refused(self):
        with source(b"test immutable contents") as descriptor, tempfile.TemporaryDirectory() as folder:
            descriptor["transfer"]["chunkPath"] = "https://example.com/leak"
            with self.assertRaises(BackupError):
                download_checkpoint(descriptor, folder)

    def test_restore_keeps_exact_saved_archive_and_newer_receipt_protection(self):
        def receipt(identifier, fingerprint="a" * 64):
            return {"requestId": identifier, "fingerprint": fingerprint, "receipt": {"requestId": identifier, "shards": [], "links": []}}
        saved = {"format": "shard-atlas-library", "version": 1, "archive": {"shards": [{"id": "note", "body": "exact\nold content"}]}, "custom": [False, None], "contributionReceipts": [receipt("old")]}
        current = {"format": "shard-atlas-library", "version": 1, "archive": {"shards": []}, "contributionReceipts": [receipt("old"), receipt("new")]}
        restored = merge_restore_capsule(saved, current)
        self.assertEqual(restored["archive"], saved["archive"])
        self.assertEqual(restored["custom"], saved["custom"])
        self.assertEqual([entry["requestId"] for entry in restored["contributionReceipts"]], ["old", "new"])
        current["contributionReceipts"][0] = receipt("old", "b" * 64)
        with self.assertRaises(BackupError):
            merge_restore_capsule(saved, current)

    def test_duplicate_keys_are_not_silently_normalized(self):
        with self.assertRaises(BackupError):
            strict_json('{"archive":1,"archive":2}')

    def test_browser_device_checkpoints_handle_compressed_and_raw_payloads(self):
        original = b'{"format":"shard-atlas-device-browser","drafts":[{"body":"keep"}],"imports":[]}'
        for compressed in (False, True):
            data = gzip.compress(original, mtime=0) if compressed else original
            with source(data, device=compressed) as descriptor, tempfile.TemporaryDirectory() as folder:
                descriptor["checkpoint"]["kind"] = "device"
                descriptor["checkpoint"]["manifest"]["format"] = "shard-atlas-device-browser-json" + ("-gzip" if compressed else "")
                result = download_checkpoint(descriptor, folder)
                self.assertEqual(gzip.decompress(Path(result["file"]).read_bytes()), original)
                if compressed:
                    self.assertEqual(Path(result["file"]).read_bytes(), data)

    def test_restoration_preparation_and_upload_never_confirm_live_replacement(self):
        def capsule(body, receipt_id):
            return json.dumps({"format": "shard-atlas-library", "version": 1,
                "archive": {"schemaVersion": 1, "shards": [{"id": "note", "body": body}], "links": [], "assets": [], "trash": [{"id": "deleted", "payload": {"unchanged": True}}]},
                "contributionReceipts": [{"requestId": receipt_id, "fingerprint": "a" * 64, "receipt": {"requestId": receipt_id, "shards": [], "links": []}}]}).encode()
        with source(capsule("saved exact text", "older")) as saved, source(capsule("later content", "newer")) as current, tempfile.TemporaryDirectory() as folder:
            a = download_checkpoint(saved, Path(folder) / "saved")
            b = download_checkpoint(current, Path(folder) / "current")
            prepared = prepare_restoration(a["file"], strict_json(Path(a["manifestFile"]).read_text()), b["file"], strict_json(Path(b["manifestFile"]).read_text()), "restore-one", folder)
            result = strict_json(Path(prepared["file"]).read_bytes())
            self.assertEqual(result["archive"]["shards"][0]["body"], "saved exact text")
            self.assertEqual([x["requestId"] for x in result["contributionReceipts"]], ["older", "newer"])
            received = []
            class UploadHandler(BaseHTTPRequestHandler):
                def do_PUT(self):
                    received.append((self.path, self.rfile.read(int(self.headers["Content-Length"])), self.headers.get("X-Shard-Atlas-Backup-Ticket")))
                    self.send_response(200)
                    self.end_headers()
                    self.wfile.write(b'{"uploaded":true}')
                def log_message(self, *_): pass
            server = ThreadingHTTPServer(("127.0.0.1", 0), UploadHandler)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                transfer = {"siteUrl": f"http://127.0.0.1:{server.server_port}", "siteBearer": "test-site-access",
                    "restore": {"requestId": "restore-one", "manifest": prepared["prepareArguments"]["manifest"]},
                    "uploadTransfer": {"ticket": "restore-only-ticket", "chunkPath": "/api/cloud-backups/restores/restore-one/blobs/{sha256}"}}
                uploaded = upload_restoration(transfer, prepared["file"])
                self.assertEqual(b"".join(x[1] for x in received), Path(prepared["file"]).read_bytes())
                self.assertTrue(all(x[0].startswith("/api/cloud-backups/restores/restore-one/blobs/") and x[2] == "restore-only-ticket" for x in received))
                self.assertTrue(uploaded["confirmRequired"])
            finally:
                server.shutdown()
                thread.join(timeout=5)
                server.server_close()

    def test_retention_only_archives_verified_copies_and_protects_each_device(self):
        start = dt.datetime(2026, 1, 1, tzinfo=dt.timezone.utc)
        items = [{"id": f"point-{i}", "kind": "library", "createdAt": (start + dt.timedelta(hours=i)).isoformat(), "status": "verified", "driveVerified": True, "driveFileId": f"drive-{i}"} for i in range(100)]
        items += [{"id": "device-old", "kind": "device", "deviceId": "another-device", "createdAt": start.isoformat(), "status": "verified", "driveVerified": True, "driveFileId": "device-file"},
                  {"id": "not-verified", "kind": "library", "createdAt": start.isoformat(), "status": "staged", "driveVerified": False}]
        result = retention_plan(items)
        self.assertFalse(result["permanentDeletion"])
        self.assertIn("point-99", result["keepIds"])
        self.assertIn("device-old", result["keepIds"])
        self.assertTrue(result["archive"])
        self.assertNotIn("not-verified", [x["checkpointId"] for x in result["archive"]])
        self.assertFalse(set(result["keepIds"]) & {x["checkpointId"] for x in result["archive"]})


if __name__ == "__main__":
    unittest.main()
