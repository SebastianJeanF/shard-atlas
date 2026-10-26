"""Cloud-managed recovery for the native store, with one bounded upload slot.

The private activation file is deliberately separate from ordinary library
pairing. Pairing alone must never turn off an installation's local protection.
SQLite safety points include device-only drafts and import undo records; they
are not substituted with a portable snapshot of an older accepted cloud base.
"""

from __future__ import annotations

import contextlib
import hashlib
import os
from pathlib import Path
import sqlite3
import stat
import threading
import uuid
import zlib

from library_sync import (CHUNK_BYTES, DIGEST, ID, LibrarySync, SyncError,
                          atomic_write, canonical, read_json, timestamp)

MAX_COMPRESSED_BYTES = 256 * 1024 * 1024
MAX_ORIGINAL_BYTES = 512 * 1024 * 1024
MAX_RESPONSE_BYTES = 2 * 1024 * 1024
DEVICE_FORMAT = "shard-atlas-device-sqlite-gzip"
PREFIX = "/api/cloud-backups"


class CloudBackupError(Exception):
    def __init__(self, message, code="cloud_backup_unavailable", status=503):
        super().__init__(message)
        self.code = code
        self.status = status


def private_file(path, maximum):
    info = path.lstat()
    if (not stat.S_ISREG(info.st_mode) or info.st_size > maximum
            or stat.S_IMODE(info.st_mode) & 0o077
            or hasattr(os, "getuid") and info.st_uid != os.getuid()):
        raise CloudBackupError("A private cloud backup file failed its safety check.", "configuration_error")
    return info


def staging_json(path, maximum):
    private_file(path, maximum)
    try:
        return read_json(path, maximum)
    except SyncError:
        raise CloudBackupError("Temporary cloud recovery metadata is invalid and has been retained.", "invalid_staging") from None


class CloudBackups:
    def __init__(self, store, *, policy_path=None, sync_config_path=None, client_factory=None):
        self.store = store
        self.policy_path = Path(policy_path) if policy_path else store.db_path.parent / "cloud-backups.json"
        self.sync_config_path = sync_config_path
        self.client_factory = client_factory
        self.library_sync = None
        self.directory = store.db_path.parent / (store.db_path.stem + "-cloud-backup-staging")
        self.pending_path = self.directory / "pending.json"
        self.raw_path = self.directory / "snapshot.sqlite3"
        self.payload_path = self.directory / "snapshot.sqlite3.gz"
        self.receipt_path = self.directory / "last-receipt.json"
        self.lock = threading.RLock()

    @property
    def enabled(self):
        # An invalid or symlinked activation file must fail closed, rather than
        # silently falling back to accumulating local snapshots.
        return self.policy_path.exists() or self.policy_path.is_symlink()

    @property
    def has_pending(self):
        return any(path.exists() or path.is_symlink() for path in (self.pending_path, self.raw_path, self.payload_path))

    def _policy(self):
        try:
            private_file(self.policy_path, 16 * 1024)
            value = read_json(self.policy_path, 16 * 1024)
        except (OSError, SyncError):
            raise CloudBackupError("The private cloud backup policy could not be read.", "configuration_error") from None
        if (not isinstance(value, dict) or type(value.get("version")) is not int or value["version"] != 1
                or value.get("mode") != "cloud" or value.get("verified") is not True
                or "deviceId" in value and (not isinstance(value["deviceId"], str) or not ID.fullmatch(value["deviceId"]))):
            raise CloudBackupError("Cloud backup cutover has not been verified for this installation.", "configuration_error")
        return value

    def _client(self):
        sync = self.library_sync or LibrarySync(self.store, config_path=self.sync_config_path)
        try:
            config = sync._config()
            if config is None:
                raise CloudBackupError("Connect this installation to the private library before using cloud backups.", "not_configured")
            return (self.client_factory or sync.client_factory)(config)
        except (OSError, SyncError):
            raise CloudBackupError("The private cloud backup connection is unavailable.", "configuration_error") from None

    @staticmethod
    def _request(client, path, *, method="GET", data=None, binary=False):
        try:
            result = client.request(PREFIX + path, method=method, data=data, binary=binary,
                                    maximum=MAX_RESPONSE_BYTES, success_statuses=(200, 201, 202))
        except (SyncError, OSError):
            raise CloudBackupError("Cloud recovery could not be verified. Your existing data and pending safety copy are retained.") from None
        if not isinstance(result, dict):
            raise CloudBackupError("The cloud backup service returned an invalid result.", "invalid_receipt")
        return result

    def _ready(self, client):
        result = self._request(client, "/status")
        if (result.get("configured") is not True or result.get("managed") is not True
                or result.get("localHistoryAllowed") is not False):
            raise CloudBackupError("The cloud backup service is not ready to replace local recovery history.", "not_ready")
        return result

    def local_status(self):
        files = (self.pending_path, self.raw_path, self.payload_path)
        size = sum(path.lstat().st_size for path in files if path.exists() and not path.is_symlink())
        return {"mode": "cloud" if self.enabled else "local", "retainedLocalHistory": not self.enabled,
                "pendingSafetyUpload": self.has_pending,
                "stagingBytes": size, "maximumStagingBytes": MAX_ORIGINAL_BYTES + MAX_COMPRESSED_BYTES + 64 * 1024}

    def status(self):
        try:
            if self.enabled:
                self._policy()
            result = self._request(self._client(), "/status")
        except CloudBackupError as error:
            result = {"configured": False, "managed": False, "status": error.code, "message": str(error)}
        except OSError:
            result = {"configured": False, "managed": False, "status": "unavailable", "message": "The cloud backup status could not be checked."}
        result["localPolicy"] = self.local_status()
        return result

    def proxy(self, path, *, method="GET", data=None):
        allowed_get = {"/catalog", "/restores"}
        allowed_post = {"/request", "/restore/request", "/restore/preview", "/restore/confirm"}
        route = path.partition("?")[0]
        if (len(path) > 2048 or not (method == "GET" and route in allowed_get
                                   or method == "POST" and path in allowed_post)):
            raise CloudBackupError("Unknown cloud backup operation.", "not_found", 404)
        client = self._client()
        self._ready(client)
        return self._request(client, path, method=method, data=data)

    def request(self, data=None):
        return self.proxy("/request", method="POST", data=data or {})

    def catalog(self):
        result = self.proxy("/catalog")
        if isinstance(result.get("backups"), list):
            return {**result, "mode": "cloud"}
        for key in ("items", "checkpoints"):
            if isinstance(result.get(key), list):
                return {**result, "backups": result[key], "mode": "cloud"}
        raise CloudBackupError("The cloud recovery list is invalid.", "invalid_response")

    def _directory(self):
        self.directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        info = self.directory.lstat()
        if (not stat.S_ISDIR(info.st_mode) or stat.S_IMODE(info.st_mode) & 0o077
                or hasattr(os, "getuid") and info.st_uid != os.getuid()):
            raise CloudBackupError("The temporary cloud backup directory must be private.", "configuration_error")

    def _capture(self):
        # The single slot is never replaced until the prior safety point has a
        # durable receipt. SQLite's backup API also includes committed WAL data.
        if self.raw_path.exists() or self.raw_path.is_symlink():
            raise CloudBackupError("An earlier temporary safety copy still needs verification.", "pending_upload")
        with self.store.connect() as source:
            expected = source.execute("PRAGMA page_count").fetchone()[0] * source.execute("PRAGMA page_size").fetchone()[0]
            if expected > MAX_ORIGINAL_BYTES:
                raise CloudBackupError("This device recovery point exceeds the 512 MiB temporary safety limit.", "snapshot_too_large", 413)
            fd = os.open(self.raw_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            os.close(fd)
            try:
                with contextlib.closing(sqlite3.connect(self.raw_path)) as destination:
                    source.backup(destination)
            except (OSError, sqlite3.Error):
                self.raw_path.unlink(missing_ok=True)
                raise

    def _prepare(self, policy, reason):
        info = private_file(self.raw_path, MAX_ORIGINAL_BYTES)
        if info.st_size <= 0:
            raise CloudBackupError("The temporary recovery database is incomplete.", "invalid_staging")
        with contextlib.closing(sqlite3.connect(self.raw_path.as_uri() + "?mode=ro", uri=True)) as snapshot:
            if any(row[0] != "ok" for row in snapshot.execute("PRAGMA quick_check")):
                raise CloudBackupError("The temporary recovery database failed its integrity check.", "invalid_staging")
        if self.payload_path.exists():
            # A crash during compression leaves the original consistent SQLite
            # file intact. Only its unfinished compressed representation is redone.
            private_file(self.payload_path, MAX_COMPRESSED_BYTES)
            self.payload_path.unlink()
        original_hash, payload_hash = hashlib.sha256(), hashlib.sha256()
        size = 0
        compressor = zlib.compressobj(6, zlib.DEFLATED, 31)
        fd = os.open(self.payload_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        try:
            with os.fdopen(fd, "wb") as output, self.raw_path.open("rb") as original:
                def write(data):
                    nonlocal size
                    if size + len(data) > MAX_COMPRESSED_BYTES:
                        raise CloudBackupError("The compressed device recovery point exceeds 256 MiB.", "snapshot_too_large", 413)
                    output.write(data)
                    payload_hash.update(data)
                    size += len(data)
                while block := original.read(CHUNK_BYTES):
                    original_hash.update(block)
                    write(compressor.compress(block))
                write(compressor.flush())
                output.flush()
                os.fsync(output.fileno())
        except Exception:
            self.payload_path.unlink(missing_ok=True)
            raise
        chunks = []
        with self.payload_path.open("rb") as stream:
            while block := stream.read(CHUNK_BYTES):
                chunks.append({"sha256": hashlib.sha256(block).hexdigest(), "bytes": len(block)})
        request = {"requestId": "device-" + str(uuid.uuid4()), "deviceId": policy.get("deviceId") or "native-" + hashlib.sha256(os.fsencode(self.store.db_path)).hexdigest()[:32],
                   "reason": reason, "createdAt": timestamp(), "format": DEVICE_FORMAT,
                   "sha256": payload_hash.hexdigest(), "bytes": size, "originalSha256": original_hash.hexdigest(),
                   "originalBytes": info.st_size, "chunks": chunks}
        atomic_write(self.pending_path, canonical({"version": 1, "request": request}))
        self.raw_path.unlink()
        return request

    def _pending(self):
        value = staging_json(self.pending_path, 64 * 1024)
        request = value.get("request") if isinstance(value, dict) and value.get("version") == 1 else None
        if (not isinstance(request, dict) or request.get("format") != DEVICE_FORMAT
                or not isinstance(request.get("requestId"), str) or not ID.fullmatch(request["requestId"])
                or not isinstance(request.get("sha256"), str) or not DIGEST.fullmatch(request["sha256"])
                or not isinstance(request.get("originalSha256"), str) or not DIGEST.fullmatch(request["originalSha256"])
                or type(request.get("bytes")) is not int or not 0 < request["bytes"] <= MAX_COMPRESSED_BYTES
                or type(request.get("originalBytes")) is not int or not 0 < request["originalBytes"] <= MAX_ORIGINAL_BYTES
                or not isinstance(request.get("chunks"), list) or not 0 < len(request["chunks"]) <= MAX_COMPRESSED_BYTES // CHUNK_BYTES):
            raise CloudBackupError("The pending cloud recovery point is invalid and has been retained.", "invalid_staging")
        info = private_file(self.payload_path, MAX_COMPRESSED_BYTES)
        checksum, total = hashlib.sha256(), 0
        with self.payload_path.open("rb") as stream:
            for index, chunk in enumerate(request["chunks"]):
                if (not isinstance(chunk, dict) or type(chunk.get("bytes")) is not int or not 0 < chunk["bytes"] <= CHUNK_BYTES
                        or index < len(request["chunks"]) - 1 and chunk["bytes"] != CHUNK_BYTES):
                    raise CloudBackupError("The pending recovery chunk list is invalid.", "invalid_staging")
                block = stream.read(chunk["bytes"])
                if len(block) != chunk["bytes"] or hashlib.sha256(block).hexdigest() != chunk.get("sha256"):
                    raise CloudBackupError("The pending recovery contents changed and have been retained.", "invalid_staging")
                checksum.update(block)
                total += len(block)
            if stream.read(1) or total != info.st_size or total != request["bytes"] or checksum.hexdigest() != request["sha256"]:
                raise CloudBackupError("The pending recovery point failed its integrity check.", "invalid_staging")
        return request

    def _upload(self, client):
        request = self._pending()
        with self.payload_path.open("rb") as stream:
            for chunk in request["chunks"]:
                block = stream.read(chunk["bytes"])
                if hashlib.sha256(block).hexdigest() != chunk["sha256"]:
                    raise CloudBackupError("The temporary recovery copy changed during upload.", "invalid_staging")
                self._request(client, "/device-snapshots/blobs/" + chunk["sha256"], method="PUT", data=block, binary=True)
        receipt = self._request(client, "/device-snapshots/request", method="POST", data=request)
        identity = receipt.get("id")
        if (not isinstance(identity, str) or not ID.fullmatch(identity) or receipt.get("filename") != "cloud:" + identity
                or receipt.get("durable") is not True or receipt.get("verified") is not True
                or receipt.get("sha256") != request["sha256"] or receipt.get("bytes") != request["bytes"]):
            raise CloudBackupError("The remote safety receipt did not verify this recovery point. The temporary copy is retained.", "invalid_receipt")
        if self._pending() != request:
            raise CloudBackupError("The temporary recovery request changed during verification.", "invalid_staging")
        # This receipt establishes durable staging in the independent hosted
        # queue. It deliberately does not assert that Drive transfer is finished.
        saved = {key: receipt.get(key) for key in ("id", "filename", "createdAt", "sha256", "bytes", "durable", "verified", "status", "kind", "driveVerified")}
        saved.update(requestId=request["requestId"], originalSha256=request["originalSha256"], originalBytes=request["originalBytes"])
        atomic_write(self.receipt_path, canonical(saved))
        self.pending_path.unlink()
        self.payload_path.unlink()
        if self.raw_path.exists():
            if not self._matches_file(self.raw_path, request["originalSha256"], request["originalBytes"], MAX_ORIGINAL_BYTES):
                raise CloudBackupError("An additional temporary recovery file was retained for inspection.", "invalid_staging")
            self.raw_path.unlink()
        return saved

    @staticmethod
    def _matches_file(path, checksum, size, maximum):
        info = private_file(path, maximum)
        if info.st_size != size or not isinstance(checksum, str) or not DIGEST.fullmatch(checksum):
            return False
        digest = hashlib.sha256()
        with path.open("rb") as stream:
            while block := stream.read(CHUNK_BYTES):
                digest.update(block)
        return digest.hexdigest() == checksum

    def _finish_cleanup(self):
        # A process can stop after its durable receipt is saved but between the
        # individual unlinks. Reconcile only exact bytes bound to that receipt.
        artifacts = [path for path in (self.pending_path, self.raw_path, self.payload_path) if path.exists() or path.is_symlink()]
        if not artifacts or not self.receipt_path.exists():
            return None
        try:
            receipt = staging_json(self.receipt_path, 64 * 1024)
        except (CloudBackupError, OSError):
            return None
        if (not isinstance(receipt, dict) or receipt.get("verified") is not True or receipt.get("durable") is not True
                or not isinstance(receipt.get("id"), str) or not ID.fullmatch(receipt["id"])
                or receipt.get("filename") != "cloud:" + receipt["id"]):
            return None
        if self.pending_path.exists() or self.pending_path.is_symlink():
            pending = staging_json(self.pending_path, 64 * 1024)
            request = pending.get("request") if isinstance(pending, dict) else None
            if not isinstance(request, dict) or any(request.get(key) != receipt.get(key) for key in ("requestId", "sha256", "bytes", "originalSha256", "originalBytes")):
                return None
        for path, checksum, size, maximum in (
                (self.payload_path, receipt.get("sha256"), receipt.get("bytes"), MAX_COMPRESSED_BYTES),
                (self.raw_path, receipt.get("originalSha256"), receipt.get("originalBytes"), MAX_ORIGINAL_BYTES)):
            if path.exists() or path.is_symlink():
                if not self._matches_file(path, checksum, size, maximum):
                    return None
        for path in artifacts:
            path.unlink()
        return receipt

    def retry_pending(self, client=None):
        with self.lock:
            policy = self._policy()
            self._directory()
            completed = self._finish_cleanup()
            if completed is not None:
                return completed
            if self.pending_path.exists() or self.pending_path.is_symlink():
                return self._upload(client or self._client())
            if self.raw_path.exists() or self.raw_path.is_symlink():
                self._prepare(policy, "interrupted safety capture")
                return self._upload(client or self._client())
            if self.payload_path.exists() or self.payload_path.is_symlink():
                raise CloudBackupError("An unfinished recovery upload needs inspection; its contents were retained.", "invalid_staging")
            return None

    def safety_checkpoint(self, reason="safety"):
        with self.lock:
            policy = self._policy()
            client = self._client()
            self._ready(client)
            self.retry_pending(client)
            self._capture()
            self._prepare(policy, reason)
            return self._upload(client)

    def automatic_check(self):
        with self.lock:
            self._policy()
            client = self._client()
            result = self._ready(client)
            self.retry_pending(client)
            # The cloud schedule owns cadence. Checking a dirty native store
            # must not create minute-by-minute Drive snapshots of an older base.
            return {**result, "localPolicy": self.local_status()}
