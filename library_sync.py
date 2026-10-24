"""Private, offline-first shared-library client for the local Mac service.

Transport credentials and durable synchronization bookkeeping never enter the
browser, archives, source checkout, or logs. The cloud stores immutable chunks;
its compare-and-swap commit protects independently edited collections.
"""

from __future__ import annotations

import contextlib
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import stat
import tempfile
import threading
import time
import urllib.error
import urllib.request
import uuid

PROTOCOL_VERSION = 1
CHUNK_BYTES = 4 * 1024 * 1024
MAX_BYTES = 256 * 1024 * 1024
SITE_URL = "https://shard-atlas.deltamaster64.chatgpt.site"
HEADER = "X-Shard-Atlas-Sync"
RECORDS = ("shards", "links", "reviews", "boards", "assets", "revisions", "trash")
RECEIPT_PREFIX = "contribution:"
ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}\Z")
DIGEST = re.compile(r"[a-f0-9]{64}\Z")


class SyncError(Exception):
    def __init__(self, message, code="sync_error"):
        super().__init__(message)
        self.code = code


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("utf-8")


def digest(data):
    return hashlib.sha256(data).hexdigest()


def fingerprint(capsule):
    return digest(canonical(capsule))


def timestamp():
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def atomic_write(path, data):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, name = tempfile.mkstemp(prefix=".library-sync-", dir=path.parent)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(name, path)
        with contextlib.suppress(OSError):
            directory = os.open(path.parent, os.O_RDONLY)
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
    finally:
        with contextlib.suppress(FileNotFoundError):
            os.unlink(name)


def read_json(path, maximum=MAX_BYTES):
    path = Path(path)
    if path.is_symlink() or path.stat().st_size > maximum:
        raise SyncError("A local synchronization file failed its safety check.", "invalid_local_state")
    try:
        def invalid_constant(_):
            raise ValueError("Non-finite JSON")
        return json.loads(path.read_text(encoding="utf-8"), parse_constant=invalid_constant)
    except (UnicodeError, ValueError, RecursionError):
        raise SyncError("A local synchronization file is invalid. Your collection is retained.", "invalid_local_state") from None


def validate_manifest(value):
    if (not isinstance(value, dict) or type(value.get("protocolVersion")) is not int
            or value["protocolVersion"] != 1 or type(value.get("archiveVersion")) is not int or value["archiveVersion"] != 1):
        raise SyncError("Update Shard Atlas before synchronizing this library.", "update_required")
    chunks = value.get("chunks")
    if (value.get("format") != "shard-atlas-library-json" or not isinstance(value.get("sha256"), str)
            or not DIGEST.fullmatch(value["sha256"]) or type(value.get("bytes")) is not int
            or not 0 < value["bytes"] <= MAX_BYTES or not isinstance(chunks, list)
            or not 0 < len(chunks) <= MAX_BYTES // CHUNK_BYTES):
        raise SyncError("The shared snapshot manifest is invalid.", "invalid_snapshot")
    total = 0
    for index, chunk in enumerate(chunks):
        if (not isinstance(chunk, dict) or not isinstance(chunk.get("sha256"), str)
                or not DIGEST.fullmatch(chunk["sha256"]) or type(chunk.get("bytes")) is not int
                or not 0 < chunk["bytes"] <= CHUNK_BYTES
                or index < len(chunks) - 1 and chunk["bytes"] != CHUNK_BYTES):
            raise SyncError("The shared snapshot chunk list is invalid.", "invalid_snapshot")
        total += chunk["bytes"]
    if total != value["bytes"]:
        raise SyncError("The shared snapshot byte count is invalid.", "invalid_snapshot")
    return value


def validate_capsule(capsule):
    if (not isinstance(capsule, dict) or capsule.get("format") != "shard-atlas-library"
            or type(capsule.get("version")) is not int or capsule["version"] != 1
            or not isinstance(capsule.get("archive"), dict) or type(capsule["archive"].get("schemaVersion")) is not int
            or capsule["archive"]["schemaVersion"] != 1):
        raise SyncError("Update Shard Atlas before opening this library snapshot.", "update_required")
    if any(not isinstance(capsule["archive"].get(kind), list) for kind in RECORDS):
        raise SyncError("The shared snapshot is incomplete.", "invalid_snapshot")
    receipts = capsule.get("contributionReceipts", [])
    if not isinstance(receipts, list) or len(receipts) > 10_000 or len(canonical(receipts)) > 8 * 1024 * 1024:
        raise SyncError("The shared inbox receipt list is invalid.", "invalid_snapshot")
    seen = set()
    for item in receipts:
        if (not isinstance(item, dict) or not isinstance(item.get("requestId"), str)
                or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}", item["requestId"])
                or item["requestId"] in seen or not isinstance(item.get("fingerprint"), str)
                or not DIGEST.fullmatch(item["fingerprint"]) or not isinstance(item.get("receipt"), dict)
                or item["receipt"].get("requestId") != item["requestId"]
                or not isinstance(item["receipt"].get("shards"), list)
                or not isinstance(item["receipt"].get("links"), list)):
            raise SyncError("The shared inbox receipt list is invalid.", "invalid_snapshot")
        for record in item["receipt"]["shards"] + item["receipt"]["links"]:
            if not isinstance(record, dict) or not isinstance(record.get("id"), str) or not ID.fullmatch(record["id"]):
                raise SyncError("A shared inbox receipt has an invalid record.", "invalid_snapshot")
        seen.add(item["requestId"])
    return capsule


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, newurl):
        # Authentication must never follow a sign-in redirect or another host.
        return None


class LibraryClient:
    def __init__(self, config):
        self.site_url = config["siteUrl"]
        self.token = config["serviceToken"]
        self.service_secret = config["serviceSecret"]
        self.opener = urllib.request.build_opener(NoRedirect())

    def request(self, path, *, method="GET", data=None, binary=False, maximum=MAX_BYTES):
        headers = {HEADER: "1", "OAI-Sites-Authorization": "Bearer " + self.token,
                   "X-Shard-Atlas-Service": self.service_secret}
        if data is not None:
            headers["Content-Type"] = "application/octet-stream" if binary else "application/json"
            if not binary:
                data = canonical(data)
        request = urllib.request.Request(self.site_url + "/api/library" + path, data=data, headers=headers, method=method)
        try:
            try:
                response = self.opener.open(request, timeout=30)
            except urllib.error.HTTPError as error:
                response = error
            with response:
                if response.headers.get(HEADER) != "1":
                    raise SyncError("Reconnect the Mac to the private shared library.", "sign_in_required")
                body = response.read(maximum + 1)
                if len(body) > maximum:
                    raise SyncError("The shared response exceeds the synchronization limit.", "invalid_snapshot")
                if binary and response.status == 200:
                    return body
                try:
                    result = json.loads(body.decode("utf-8"))
                except (UnicodeError, ValueError):
                    raise SyncError("The shared library returned an invalid response.", "invalid_response") from None
                if response.status == 409 and result.get("status") == "conflict":
                    return result
                if response.status != 200:
                    code = "update_required" if response.status == 426 else "sign_in_required" if response.status in (401, 403) else "offline"
                    raise SyncError("The shared library could not finish this operation. Your local changes are retained.", code)
                return result
        except (urllib.error.URLError, TimeoutError, OSError):
            raise SyncError("Connection unavailable. Your local collection and pending changes are retained.", "offline") from None

    def head(self):
        head = self.request("/head", maximum=64 * 1024)
        if (not isinstance(head, dict) or type(head.get("protocolVersion")) is not int or head["protocolVersion"] != 1
                or not isinstance(head.get("revision"), str)
                or head["revision"] and not ID.fullmatch(head["revision"])):
            raise SyncError("Update Shard Atlas before synchronizing this library.", "update_required")
        return head

    def publish(self, pending, data):
        manifest = validate_manifest(pending["manifest"])
        if len(data) != manifest["bytes"] or digest(data) != manifest["sha256"]:
            raise SyncError("The pending snapshot failed its integrity check. Your collection is retained.", "invalid_outbox")
        offset, uploaded = 0, set()
        for chunk in manifest["chunks"]:
            payload = data[offset:offset + chunk["bytes"]]
            offset += chunk["bytes"]
            if digest(payload) != chunk["sha256"]:
                raise SyncError("A pending snapshot chunk failed its integrity check.", "invalid_outbox")
            if chunk["sha256"] not in uploaded:
                self.request("/blobs/" + chunk["sha256"], method="PUT", data=payload, binary=True, maximum=64 * 1024)
                uploaded.add(chunk["sha256"])
        return self.request("/commits", method="POST", data={key: pending[key] for key in ("mutationId", "baseRevision", "manifest")}, maximum=64 * 1024)

    def download(self, commit):
        if not isinstance(commit, dict):
            raise SyncError("The shared revision is missing its snapshot.", "invalid_snapshot")
        manifest = validate_manifest(commit.get("manifest"))
        parts = []
        for chunk in manifest["chunks"]:
            data = self.request("/blobs/" + chunk["sha256"], binary=True, maximum=CHUNK_BYTES)
            if len(data) != chunk["bytes"] or digest(data) != chunk["sha256"]:
                raise SyncError("Downloaded snapshot failed its integrity check. Your collection is retained.", "digest_mismatch")
            parts.append(data)
        data = b"".join(parts)
        if digest(data) != manifest["sha256"]:
            raise SyncError("Downloaded library failed its integrity check. Your collection is retained.", "digest_mismatch")
        try:
            capsule = json.loads(data.decode("utf-8"))
        except (ValueError, UnicodeError):
            raise SyncError("Downloaded library is not valid JSON. Your collection is retained.", "invalid_snapshot") from None
        return validate_capsule(capsule)


class LibrarySync:
    def __init__(self, store, *, config_path=None, client_factory=LibraryClient):
        self.store = store
        self.config_path = Path(config_path) if config_path else store.db_path.parent / "library-sync.json"
        self.directory = self.config_path.parent / "library-sync"
        self.state_path = self.directory / "state.json"
        self.pending_path = self.directory / "pending.json"
        self.payload_path = self.directory / "pending.bin"
        self.client_factory = client_factory
        self.lock = threading.RLock()
        self.stop_event = threading.Event()
        self.wake_event = threading.Event()
        self.thread = None
        self.running = False
        self.editing_lock = threading.RLock()
        self.editing_leases = {}

    def editing(self, active, client_id="legacy"):
        with self.editing_lock:
            self._editing()
            if active:
                self.editing_leases[client_id] = time.monotonic() + 30
            else:
                self.editing_leases.pop(client_id, None)
        if not active:
            self.changed()
        return {"editing": active, "leaseSeconds": 30}

    def _editing(self):
        with self.editing_lock:
            current = time.monotonic()
            self.editing_leases = {key: expiry for key, expiry in self.editing_leases.items() if expiry > current}
            return bool(self.editing_leases)

    def _config(self):
        if not self.config_path.exists():
            return None
        info = self.config_path.stat()
        if self.config_path.is_symlink() or stat.S_IMODE(info.st_mode) & 0o077 or hasattr(os, "getuid") and info.st_uid != os.getuid():
            raise SyncError("The private library connection file must be owned by you and readable only by you.", "configuration_error")
        config = read_json(self.config_path, 16 * 1024)
        if (not isinstance(config, dict) or config.get("siteUrl") != SITE_URL
                or not isinstance(config.get("serviceToken"), str) or not config["serviceToken"]
                or len(config["serviceToken"]) > 8192 or any(c.isspace() for c in config["serviceToken"])
                or not isinstance(config.get("serviceSecret"), str) or not 16 <= len(config["serviceSecret"]) <= 8192
                or any(c.isspace() for c in config["serviceSecret"])):
            raise SyncError("The private library connection has not been configured correctly.", "configuration_error")
        return config

    def _state(self):
        if not self.state_path.exists():
            return {"version": 1, "baseRevision": "", "viewRevision": "", "baseLocalFingerprint": None, "status": "ready"}
        state = read_json(self.state_path, 256 * 1024)
        if (not isinstance(state, dict) or state.get("version") != 1
                or not isinstance(state.get("baseRevision"), str)
                or state["baseRevision"] and not ID.fullmatch(state["baseRevision"])
                or state.get("baseLocalFingerprint") is not None and not DIGEST.fullmatch(str(state["baseLocalFingerprint"]))):
            raise SyncError("The private synchronization state is invalid. Your collection is retained.", "invalid_local_state")
        state.setdefault("viewRevision", state["baseRevision"])
        if (not isinstance(state["viewRevision"], str)
                or state["viewRevision"] and not ID.fullmatch(state["viewRevision"])):
            raise SyncError("The private view revision is invalid. Your collection is retained.", "invalid_local_state")
        return state

    def _save(self, state):
        atomic_write(self.state_path, canonical(state))

    def view_revision(self):
        """Called under the store lock alongside a view read or knowledge write."""
        try:
            return self._state()["viewRevision"]
        except (SyncError, OSError):
            return "unavailable"

    def _capsule(self, connection):
        receipts = []
        for row in connection.execute("SELECT key,value FROM metadata WHERE key LIKE ? ORDER BY key", (RECEIPT_PREFIX + "%",)):
            value = json.loads(row[1])
            receipts.append({"requestId": row[0][len(RECEIPT_PREFIX):], **value})
        return {"format": "shard-atlas-library", "version": 1, "archive": self.store._archive(connection), "contributionReceipts": receipts}

    def capsule(self):
        with self.store.lock, self.store.connect() as connection:
            connection.execute("BEGIN")
            return self._capsule(connection)

    def status(self):
        try:
            config = self._config()
            state = self._state()
            result = {key: state.get(key) for key in ("status", "message", "baseRevision", "conflict", "lastSyncedAt", "lastAttemptAt")}
            result.update(configured=config is not None, pending=self.pending_path.exists(), syncing=self.running)
            with self.store.lock, self.store.connect() as connection:
                result["localCounts"] = {key: connection.execute(f"SELECT count(*) FROM {key}").fetchone()[0] for key in RECORDS}
            if isinstance(state.get("conflict"), dict):
                result.update(localCounts=state["conflict"].get("localCounts"), remoteCounts=state["conflict"].get("remoteCounts"))
            if config is None:
                result.update(status="not_configured", message="Connect this Mac to your private shared library to synchronize devices.")
            return result
        except (SyncError, OSError) as error:
            return {"configured": self.config_path.exists(), "status": getattr(error, "code", "error"),
                    "message": str(error) if isinstance(error, SyncError) else "The private library connection could not be read.", "pending": self.pending_path.exists(), "syncing": False}

    def _stage(self, capsule, base_revision, local_fingerprint):
        validate_capsule(capsule)
        data = canonical(capsule)
        if len(data) > MAX_BYTES:
            raise SyncError("The shared library snapshot exceeds 256 MiB. Your local collection is retained.", "snapshot_too_large")
        chunks = [{"sha256": digest(data[offset:offset + CHUNK_BYTES]), "bytes": len(data[offset:offset + CHUNK_BYTES])} for offset in range(0, len(data), CHUNK_BYTES)]
        mutation_id = str(uuid.uuid4())
        self.payload_path = self.directory / ("pending-" + mutation_id + ".bin")
        pending = {"version": 1, "mutationId": mutation_id, "baseRevision": base_revision,
                   "payloadFile": self.payload_path.name,
                   "localFingerprint": local_fingerprint, "manifest": {"protocolVersion": 1, "archiveVersion": 1,
                   "format": "shard-atlas-library-json", "sha256": digest(data), "bytes": len(data), "chunks": chunks}}
        # Payload becomes durable first; only the manifest makes it eligible to send.
        atomic_write(self.payload_path, data)
        atomic_write(self.pending_path, canonical(pending))
        return pending, data

    def _pending(self):
        pending = read_json(self.pending_path, 64 * 1024)
        if (not isinstance(pending, dict) or pending.get("version") != 1
                or not isinstance(pending.get("mutationId"), str) or not ID.fullmatch(pending["mutationId"])
                or not isinstance(pending.get("baseRevision"), str)
                or pending["baseRevision"] and not ID.fullmatch(pending["baseRevision"])
                or not isinstance(pending.get("localFingerprint"), str) or not DIGEST.fullmatch(pending["localFingerprint"])):
            raise SyncError("The pending synchronization manifest is invalid. Your collection is retained.", "invalid_outbox")
        manifest = validate_manifest(pending.get("manifest"))
        filename = pending.get("payloadFile", "pending.bin")
        if not isinstance(filename, str) or not re.fullmatch(r"pending(?:-[a-f0-9-]{36})?\.bin", filename):
            raise SyncError("The pending synchronization filename is invalid.", "invalid_outbox")
        self.payload_path = self.directory / filename
        if self.payload_path.is_symlink() or self.payload_path.stat().st_size != manifest["bytes"]:
            raise SyncError("The pending synchronization snapshot is incomplete. Your collection is retained.", "invalid_outbox")
        data = self.payload_path.read_bytes()
        if digest(data) != manifest["sha256"]:
            raise SyncError("The pending synchronization snapshot failed its integrity check.", "invalid_outbox")
        return pending, data

    def _clear_pending(self):
        path = self.payload_path
        if self.pending_path.exists():
            metadata = read_json(self.pending_path, 64 * 1024)
            filename = metadata.get("payloadFile", "pending.bin")
            if isinstance(filename, str) and re.fullmatch(r"pending(?:-[a-f0-9-]{36})?\.bin", filename):
                path = self.directory / filename
        self.pending_path.unlink(missing_ok=True)
        path.unlink(missing_ok=True)

    def _validated_archive(self, capsule):
        validate_capsule(capsule)
        # Import validation must run against an empty collection, rather than
        # merge semantics in which an old local ID silently wins over the cloud.
        with tempfile.TemporaryDirectory(prefix="atlas-sync-validate-") as temporary:
            root = Path(temporary)
            validation = self.store.__class__(root / "validation.sqlite3", root=self.store.root,
                seed=False, backup_on_start=False, automatic_backups=False, backup_dir=root / "backups")
            with validation.connect() as connection:
                normalized = validation._validate_import(capsule["archive"], connection)
        return normalized

    @staticmethod
    def _preserve_recovery_payloads(normalized, archive):
        # Validation supplies safe identities and timestamps. Historical payloads
        # must retain their original optional fields, just as browser sync does.
        revisions = {item["id"]: item for item in archive["revisions"]}
        normalized["revisions"] = [{**item, "snapshot": revisions[item["id"]]["snapshot"]}
                                   for item in normalized["revisions"]]
        trash = {item["id"]: item for item in archive["trash"]}
        normalized["trash"] = [{**item, **{key: trash[item["id"]][key] for key in ("shard", "links", "reviews")
                                                  if key in trash[item["id"]]}}
                               for item in normalized["trash"]]

    def _repair_recovery_payloads(self, remote, expected_fingerprint):
        """Repair older normalization only when no knowledge differs from base."""
        normalized = self._validated_archive(remote)
        def records(archive, kind):
            return {item["id"]: item for item in archive[kind]}
        with self.editing_lock, self.store.lock:
            local = self.capsule()
            if self._editing() or fingerprint(local) != expected_fingerprint:
                raise SyncError("Your collection changed while checking recovery records. Synchronization will retry safely.", "local_changed")
            if local.get("contributionReceipts", []) != remote.get("contributionReceipts", []):
                return None
            for kind in RECORDS:
                current, original = records(local["archive"], kind), records(remote["archive"], kind)
                if current.keys() != original.keys():
                    return None
                validated = records(normalized, kind)
                for identity, item in current.items():
                    if item != original[identity] and (kind not in ("revisions", "trash") or item != validated[identity]):
                        return None
            if all(records(local["archive"], kind) == records(remote["archive"], kind) for kind in ("revisions", "trash")):
                return expected_fingerprint
            self.store.backup()
            with self.store.connect() as connection:
                connection.execute("BEGIN IMMEDIATE")
                if fingerprint(self._capsule(connection)) != expected_fingerprint:
                    raise SyncError("Your collection changed while checking recovery records. Synchronization will retry safely.", "local_changed")
                for item in remote["archive"]["revisions"]:
                    connection.execute("UPDATE revisions SET snapshot=? WHERE id=?", (canonical(item["snapshot"]).decode("utf-8"), item["id"]))
                for item in remote["archive"]["trash"]:
                    payload = {key: item[key] for key in ("shard", "links", "reviews") if key in item}
                    connection.execute("UPDATE trash SET payload=? WHERE id=?", (canonical(payload).decode("utf-8"), item["id"]))
                result = fingerprint(self._capsule(connection))
            self.store._dirty = True
            self.store.backup_tick()
            return result

    def _apply(self, capsule, expected_fingerprint):
        normalized = self._validated_archive(capsule)
        self._preserve_recovery_payloads(normalized, capsule["archive"])
        with self.editing_lock, self.store.lock:
            if self._editing():
                raise SyncError("Finish your current edit before applying shared library changes.", "editing")
            self.store.backup()
            with self.store.connect() as connection:
                connection.execute("BEGIN IMMEDIATE")
                if fingerprint(self._capsule(connection)) != expected_fingerprint:
                    raise SyncError("Your collection changed while downloading. Synchronization will retry safely.", "local_changed")
                incoming = {item["requestId"]: item for item in capsule.get("contributionReceipts", [])}
                for request_id, item in incoming.items():
                    saved = connection.execute("SELECT value FROM metadata WHERE key=?", (RECEIPT_PREFIX + request_id,)).fetchone()
                    if saved and json.loads(saved[0])["fingerprint"] != item["fingerprint"]:
                        raise SyncError("An inbox request ID has conflicting content. Both collections are retained.", "receipt_conflict")
                existing = {row[0][len(RECEIPT_PREFIX):]: json.loads(row[1]) for row in connection.execute("SELECT key,value FROM metadata WHERE key LIKE ?", (RECEIPT_PREFIX + "%",))}
                combined = [{"requestId": key, **value} for key, value in existing.items()]
                combined.extend(item for key, item in incoming.items() if key not in existing)
                validate_capsule({**capsule, "contributionReceipts": combined})
                for table in ("links", "reviews", "revisions", "trash", "boards", "shards", "assets"):
                    connection.execute(f"DELETE FROM {table}")
                self.store._merge(normalized, connection)
                for request_id, item in incoming.items():
                    value = {key: value for key, value in item.items() if key != "requestId"}
                    connection.execute("INSERT OR IGNORE INTO metadata(key,value) VALUES(?,?)", (RECEIPT_PREFIX + request_id, canonical(value).decode("utf-8")))
                result = fingerprint(self._capsule(connection))
            self.store._dirty = True
            self.store.backup_tick()
            return result

    @staticmethod
    def _nonempty(capsule):
        return any(capsule["archive"][kind] for kind in RECORDS)

    def _publish(self, client, state, pending, data):
        receipt = client.publish(pending, data)
        if (not isinstance(receipt, dict) or receipt.get("mutationId") != pending["mutationId"]
                or not isinstance(receipt.get("id"), str) or not ID.fullmatch(receipt["id"])
                or receipt.get("manifest") != pending["manifest"]):
            raise SyncError("The shared library returned an invalid receipt. Your pending change is retained.", "invalid_response")
        if receipt.get("status") == "conflict":
            state.update(status="conflict", message="This Mac and another device changed the library. Both versions are saved; review the conflict before continuing.",
                         conflict={"localRevision": receipt["id"], "remoteRevision": receipt.get("observedRevision", ""), "mutationId": pending["mutationId"]})
            self._save(state)
            self._conflict_preview(client, state)
            return
        if receipt.get("status") != "accepted":
            raise SyncError("The shared library returned an invalid receipt. Your pending change is retained.", "invalid_response")
        state.update(baseRevision=receipt["id"], baseLocalFingerprint=pending["localFingerprint"],
                     status="synced", message="Your library is synchronized.", lastSyncedAt=timestamp(), conflict=None)
        # Persist the accepted base before clearing the exact-retry outbox.
        with self.store.lock:
            self._save(state)
        self._clear_pending()
        if fingerprint(self.capsule()) != state["baseLocalFingerprint"]:
            state.update(status="pending", message="New local changes are waiting to synchronize.")
            self._save(state)

    def _conflict_preview(self, client, state, *, head=None, remote=None):
        local = self.capsule()
        head = head or client.head()
        if head["revision"]:
            remote = remote or client.download(head.get("commit"))
        else:
            remote = {"archive": {key: [] for key in RECORDS}}
        conflict = state.get("conflict") or {}
        conflict.update(remoteRevision=head["revision"], expectedLocalFingerprint=fingerprint(local),
                        localCounts={key: len(local["archive"][key]) for key in RECORDS},
                        remoteCounts={key: len(remote["archive"][key]) for key in RECORDS})
        # A local copy is retained even for a first-connection migration preview.
        path = self.directory / ("conflict-" + str(uuid.uuid4()) + ".json")
        atomic_write(path, canonical(local))
        conflict["localSnapshot"] = path.name
        state["conflict"] = conflict
        self._save(state)

    def resolve(self, choice):
        if choice not in ("cloud", "device"):
            return {"status": "error", "message": "Choose the shared library or this device's version."}
        if not self.lock.acquire(blocking=False):
            return self.status()
        process_lock = None
        try:
            config = self._config()
            if config is None:
                return self.status()
            process_lock = self._process_lock()
            if process_lock is None:
                return self.status()
            state = self._state()
            if state.get("status") not in ("conflict", "migration_required") or not isinstance(state.get("conflict"), dict):
                return self.status()
            if self._editing():
                state.update(message="Finish your current edit before resolving this library conflict.")
                self._save(state)
                return self.status()
            client = self.client_factory(config)
            head = client.head()
            conflict = state["conflict"]
            local = self.capsule()
            local_fingerprint = fingerprint(local)
            if (conflict.get("expectedLocalFingerprint") != local_fingerprint
                    or conflict.get("remoteRevision") != head["revision"]):
                state["message"] = "The local or shared library changed after this preview. Review the updated counts and choose again."
                self._conflict_preview(client, state, head=head)
                return self.status()
            if choice == "cloud":
                if not head["revision"]:
                    raise SyncError("The shared library is empty. Choose this device to publish your collection.", "conflict")
                remote = client.download(head.get("commit"))
                with self.store.lock:
                    after = self._apply(remote, local_fingerprint)
                    state.update(baseRevision=head["revision"], viewRevision=head["revision"], baseLocalFingerprint=after, conflict=None,
                                 status="synced", message="The shared library is now open on this Mac. Your previous local version remains backed up.", lastSyncedAt=timestamp())
                    self._save(state)
                self._clear_pending()
            else:
                # Verify again after the network round-trip, then durably stage a
                # fresh mutation based on the exact head the user reviewed.
                with self.editing_lock, self.store.lock:
                    if self._editing() or fingerprint(self.capsule()) != local_fingerprint:
                        raise SyncError("This Mac changed while resolving the conflict. Review the updated library and choose again.", "local_changed")
                    pending, data = self._stage(local, head["revision"], local_fingerprint)
                state.update(status="pending", conflict=None, message="Your chosen device version is waiting to synchronize.")
                self._save(state)
                self._publish(client, state, pending, data)
            return self.status()
        except Exception as error:
            with contextlib.suppress(Exception):
                state = self._state()
                # Keep the conflict blocking automatic retries until an explicit
                # resolution succeeds; network errors must not erase the preview.
                state.update(message=str(error) if isinstance(error, SyncError) else "The conflict could not be resolved. Both versions are retained.")
                if state.get("status") not in ("conflict", "migration_required"):
                    state["status"] = error.code if isinstance(error, SyncError) else "error"
                self._save(state)
            return self.status()
        finally:
            if process_lock is not None:
                process_lock.close()
            self.lock.release()

    def _process_lock(self):
        self.directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.chmod(self.directory, 0o700)
        import fcntl
        stream = open(self.directory / "sync.lock", "a+b")
        os.chmod(stream.name, 0o600)
        try:
            fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
            return stream
        except BlockingIOError:
            stream.close()
            return None

    def run(self):
        if not self.lock.acquire(blocking=False):
            return self.status()
        process_lock = None
        try:
            config = self._config()
            if config is None:
                return self.status()
            # Multiple local app/service processes must share one durable outbox.
            process_lock = self._process_lock()
            if process_lock is None:
                return self.status()
            self.running = True
            state = self._state()
            state["lastAttemptAt"] = timestamp()
            if state.get("status") in ("conflict", "migration_required"):
                return self.status()
            if self._editing():
                state.update(status="editing", message="Finish your current edit before applying shared library changes.")
                self._save(state)
                return self.status()
            client = self.client_factory(config)
            if self.pending_path.exists():
                pending, data = self._pending()
                self._publish(client, state, pending, data)
                return self.status()
            local = self.capsule()
            local_fingerprint = fingerprint(local)
            head = client.head()
            revision = head["revision"]
            initial = state.get("baseLocalFingerprint") is None
            dirty = initial or local_fingerprint != state["baseLocalFingerprint"]
            if initial and revision:
                remote = client.download(head.get("commit"))
                if remote == local:
                    state.update(baseRevision=revision, baseLocalFingerprint=local_fingerprint,
                                 status="synced", message="Your library is synchronized.", lastSyncedAt=timestamp())
                    with self.store.lock:
                        self._save(state)
                elif not self._nonempty(local):
                    with self.store.lock:
                        after = self._apply(remote, local_fingerprint)
                        state.update(baseRevision=revision, viewRevision=revision, baseLocalFingerprint=after,
                                     status="synced", message="Your library is synchronized.", lastSyncedAt=timestamp())
                        self._save(state)
                else:
                    state.update(status="migration_required", message="This Mac and the shared library both contain knowledge. Review and reconcile them before synchronizing.",
                                 conflict={"remoteRevision": revision, "localCounts": {key: len(local["archive"][key]) for key in RECORDS},
                                           "remoteCounts": {key: len(remote["archive"][key]) for key in RECORDS}})
                    self._save(state)
                    self._conflict_preview(client, state, head=head, remote=remote)
            elif revision != state["baseRevision"] and not dirty:
                if not revision:
                    raise SyncError("The shared library head is unexpectedly missing. Your collection is retained.", "invalid_response")
                remote = client.download(head.get("commit"))
                with self.store.lock:
                    after = self._apply(remote, local_fingerprint)
                    state.update(baseRevision=revision, viewRevision=revision, baseLocalFingerprint=after,
                                 status="synced", message="Your library is synchronized.", lastSyncedAt=timestamp())
                    self._save(state)
            elif dirty:
                pending, data = self._stage(local, state["baseRevision"], local_fingerprint)
                self._publish(client, state, pending, data)
            else:
                # One check per accepted base upgrades older Mac clients without
                # replacing live notes, publishing, or bypassing conflict review.
                if revision and state.get("recoveryCheckedRevision") != revision:
                    repaired = self._repair_recovery_payloads(client.download(head.get("commit")), local_fingerprint)
                    if repaired is not None:
                        state["baseLocalFingerprint"] = repaired
                    state["recoveryCheckedRevision"] = revision
                state.update(status="synced", message="Your library is synchronized.", lastSyncedAt=timestamp())
                self._save(state)
            return self.status()
        except Exception as error:
            with contextlib.suppress(Exception):
                state = self._state()
                state.update(message=str(error) if isinstance(error, SyncError) else "Synchronization could not finish. Your local collection and pending changes are retained.", lastAttemptAt=timestamp())
                if state.get("status") not in ("conflict", "migration_required"):
                    state["status"] = error.code if isinstance(error, SyncError) else "error"
                self._save(state)
            return self.status()
        finally:
            self.running = False
            if process_lock is not None:
                process_lock.close()
            self.lock.release()

    def start(self):
        if self.thread is not None or not self.config_path.exists():
            return
        self.stop_event.clear()
        def worker():
            while not self.stop_event.is_set():
                self.run()
                try:
                    config = self._config() or {}
                    interval = max(10, min(300, int(config.get("pollSeconds", 30))))
                except (SyncError, OSError, ValueError, TypeError):
                    interval = 30
                self.wake_event.wait(interval)
                self.wake_event.clear()
        self.thread = threading.Thread(target=worker, name="shard-atlas-library-sync", daemon=True)
        self.thread.start()

    def changed(self):
        self.wake_event.set()

    def stop(self):
        self.stop_event.set()
        self.wake_event.set()
        if self.thread:
            self.thread.join(timeout=2)
        self.thread = None
