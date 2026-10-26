#!/usr/bin/env python3
"""Stream Shard Atlas checkpoints in an ephemeral cloud executor, never a sync folder.

The coordinator uses native Drive tools for upload/readback. Credentials arrive
only on stdin and are never included in saved manifests or command arguments.
"""
from __future__ import annotations

import argparse
import datetime as dt
import gzip
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import urllib.parse
import urllib.request

MAX_BYTES = 256 * 1024 * 1024
MAX_ORIGINAL_BYTES = 512 * 1024 * 1024
CHUNK_BYTES = 4 * 1024 * 1024
DIGEST = re.compile(r"[a-f0-9]{64}\Z")
IDENTIFIER = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}\Z")


class BackupError(ValueError):
    pass


def _pairs(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            raise BackupError("Duplicate JSON keys are not supported.")
        value[key] = item
    return value


def strict_json(value):
    def reject(_):
        raise BackupError("Non-finite JSON values are not supported.")
    return json.loads(value, object_pairs_hook=_pairs, parse_constant=reject)


def validate_manifest(value):
    if not isinstance(value, dict) or not DIGEST.fullmatch(value.get("sha256", "")):
        raise BackupError("The checkpoint manifest has no valid content hash.")
    size, chunks = value.get("bytes"), value.get("chunks")
    if type(size) is not int or not 0 < size <= MAX_BYTES or not isinstance(chunks, list) or not chunks or len(chunks) > 64:
        raise BackupError("The checkpoint exceeds the supported size or chunk count.")
    total = 0
    for chunk in chunks:
        if not isinstance(chunk, dict) or not DIGEST.fullmatch(chunk.get("sha256", "")) or type(chunk.get("bytes")) is not int or not 0 < chunk["bytes"] <= CHUNK_BYTES:
            raise BackupError("A checkpoint chunk is invalid.")
        total += chunk["bytes"]
    if total != size:
        raise BackupError("Checkpoint chunk sizes do not match the manifest.")
    return value


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def site_origin(value):
    parsed = urllib.parse.urlsplit(value)
    local = parsed.hostname in ("127.0.0.1", "localhost", "::1")
    if parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path not in ("", "/") or not parsed.netloc or (parsed.scheme != "https" and not (local and parsed.scheme == "http")):
        raise BackupError("Use the exact HTTPS Site origin without credentials or a path.")
    return urllib.parse.urlunsplit((parsed.scheme, parsed.netloc, "", "", ""))


def _sha_file(path):
    digest = hashlib.sha256()
    with open(path, "rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def inspect_gzip(path, *, maximum=MAX_ORIGINAL_BYTES):
    digest, count, prefix = hashlib.sha256(), 0, b""
    try:
        with gzip.open(path, "rb") as stream:
            for block in iter(lambda: stream.read(1024 * 1024), b""):
                count += len(block)
                if count > maximum:
                    raise BackupError("The expanded checkpoint exceeds its size limit.")
                digest.update(block)
                if len(prefix) < 16:
                    prefix += block[:16-len(prefix)]
    except (OSError, EOFError) as error:
        raise BackupError("The compressed checkpoint is damaged.") from error
    return {"sha256": digest.hexdigest(), "bytes": count, "prefix": prefix}


def verify_file(path, metadata):
    path = Path(path)
    if not path.is_file() or path.stat().st_size != metadata.get("compressedBytes") or _sha_file(path) != metadata.get("compressedSha256"):
        raise BackupError("The downloaded Drive file does not match the uploaded checkpoint.")
    checkpoint = metadata["checkpoint"]
    manifest = validate_manifest(checkpoint["manifest"])
    compressed_device = manifest.get("format", "").startswith("shard-atlas-device-") and manifest["format"].endswith("-gzip")
    if compressed_device and (type(manifest.get("originalBytes")) is not int or not 0 < manifest["originalBytes"] <= MAX_ORIGINAL_BYTES or not DIGEST.fullmatch(manifest.get("originalSha256", ""))):
        raise BackupError("The device checkpoint has invalid expanded size or hash metadata.")
    expanded = inspect_gzip(path, maximum=manifest["originalBytes"] if compressed_device else MAX_BYTES)
    expected_hash = manifest.get("originalSha256") if compressed_device else manifest["sha256"]
    expected_bytes = manifest.get("originalBytes") if compressed_device else manifest["bytes"]
    if expanded["sha256"] != expected_hash or expanded["bytes"] != expected_bytes:
        raise BackupError("The expanded checkpoint does not match the original library.")
    if manifest.get("format") == "shard-atlas-device-sqlite-gzip" and expanded["prefix"] != b"SQLite format 3\x00":
        raise BackupError("The device checkpoint is not a SQLite database.")
    return {"checkpointId": checkpoint["id"], "sourceSha256": manifest["sha256"],
            "compressedSha256": metadata["compressedSha256"], "compressedBytes": metadata["compressedBytes"],
            "verifiedAt": dt.datetime.now(dt.timezone.utc).isoformat(), "verification": "download-sha256"}


def download_checkpoint(descriptor, output_dir):
    checkpoint, transfer = descriptor["checkpoint"], descriptor["transfer"]
    checkpoint_id = checkpoint.get("id", "")
    if not IDENTIFIER.fullmatch(checkpoint_id):
        raise BackupError("The checkpoint ID is invalid.")
    manifest = validate_manifest(checkpoint["manifest"])
    origin = site_origin(descriptor["siteUrl"])
    token, ticket = descriptor.get("siteBearer"), transfer.get("ticket")
    if not isinstance(token, str) or not token or not isinstance(ticket, str) or not ticket:
        raise BackupError("Fresh Site access and a scoped transfer ticket are required.")
    expected_path = f"/api/cloud-backups/transfers/{checkpoint_id}/blobs/{{sha256}}"
    if transfer.get("chunkPath") != expected_path:
        raise BackupError("The transfer descriptor does not match this checkpoint.")
    output_dir = Path(output_dir)
    output_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    try:
        created = dt.datetime.fromisoformat(checkpoint.get("createdAt", "").replace("Z", "+00:00"))
        stamp = created.astimezone(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    except (ValueError, TypeError):
        stamp = "undated"
    portable_id = re.sub(r"[^A-Za-z0-9_.-]", "_", checkpoint_id)
    suffix = "sqlite3.gz" if manifest.get("format") == "shard-atlas-device-sqlite-gzip" else "json.gz"
    filename = f"{checkpoint.get('kind', 'library')}-{stamp}-{portable_id}.{suffix}"
    final, partial = output_dir / filename, output_dir / (filename + ".partial")
    metadata_path = output_dir / (filename + ".manifest.json")
    opener = urllib.request.build_opener(NoRedirect())
    source_hash, received = hashlib.sha256(), 0
    try:
        with open(partial, "wb") as destination:
            os.chmod(partial, 0o600)
            compressed_device = manifest.get("format", "").startswith("shard-atlas-device-") and manifest["format"].endswith("-gzip")
            stream = destination if compressed_device else gzip.GzipFile(filename="", mode="wb", fileobj=destination, mtime=0)
            try:
                for chunk in manifest["chunks"]:
                    request = urllib.request.Request(origin + expected_path.replace("{sha256}", chunk["sha256"]),
                        headers={"OAI-Sites-Authorization": "Bearer " + token, "X-Shard-Atlas-Backup-Ticket": ticket})
                    chunk_hash, count = hashlib.sha256(), 0
                    with opener.open(request, timeout=60) as response:
                        if response.status != 200:
                            raise BackupError("The checkpoint transfer did not succeed.")
                        for block in iter(lambda: response.read(1024 * 1024), b""):
                            count += len(block)
                            if count > chunk["bytes"]:
                                raise BackupError("A transferred chunk exceeds its declared size.")
                            chunk_hash.update(block)
                            source_hash.update(block)
                            stream.write(block)
                            received += len(block)
                    if count != chunk["bytes"] or chunk_hash.hexdigest() != chunk["sha256"]:
                        raise BackupError("A transferred checkpoint chunk failed verification.")
            finally:
                if stream is not destination:
                    stream.close()
            destination.flush()
            os.fsync(destination.fileno())
        if received != manifest["bytes"] or source_hash.hexdigest() != manifest["sha256"]:
            raise BackupError("The complete checkpoint failed verification.")
        metadata = {"version": 1, "checkpoint": checkpoint, "compression": "gzip",
                    "compressedSha256": _sha_file(partial), "compressedBytes": partial.stat().st_size}
        verify_file(partial, metadata)
        os.replace(partial, final)
        metadata_path.write_text(json.dumps(metadata, ensure_ascii=False, sort_keys=True) + "\n", encoding="utf-8")
        os.chmod(metadata_path, 0o600)
        return {"file": str(final.resolve()), "manifestFile": str(metadata_path.resolve()),
                "receiptArguments": verify_file(final, metadata)}
    except BaseException:
        partial.unlink(missing_ok=True)
        raise


def merge_restore_capsule(saved, current):
    """Keep saved knowledge exact and retain immutable newer capture receipts."""
    for capsule in (saved, current):
        if not isinstance(capsule, dict) or capsule.get("format") != "shard-atlas-library" or type(capsule.get("version")) is not int or capsule["version"] != 1 or not isinstance(capsule.get("archive"), dict):
            raise BackupError("A complete supported library capsule is required.")
    merged = {}
    for capsule in (saved, current):
        items = capsule.get("contributionReceipts", [])
        if not isinstance(items, list):
            raise BackupError("Invalid contribution history.")
        for item in items:
            if not isinstance(item, dict) or not isinstance(item.get("receipt"), dict):
                raise BackupError("Invalid contribution receipt.")
            identifier = item.get("requestId") or item["receipt"].get("requestId")
            if not isinstance(identifier, str) or len(identifier) > 100 or not IDENTIFIER.fullmatch(identifier) or item["receipt"].get("requestId") != identifier or not DIGEST.fullmatch(item.get("fingerprint", "")):
                raise BackupError("Invalid immutable contribution receipt.")
            previous = merged.get(identifier)
            if not isinstance(item["receipt"].get("shards"), list) or not isinstance(item["receipt"].get("links"), list):
                raise BackupError("Invalid contribution record lists.")
            if previous and previous["fingerprint"] != item["fingerprint"]:
                raise BackupError("Conflicting immutable contribution history requires review.")
            merged[identifier] = {**(previous or {}), **item, "requestId": identifier}
    receipts = list(merged.values())
    if len(receipts) > 10_000 or len(json.dumps(receipts, ensure_ascii=False).encode()) > 8 * 1024 * 1024:
        raise BackupError("Merged contribution history exceeds its safe limit.")
    return {**saved, "contributionReceipts": receipts}


def prepare_restoration(saved_path, saved_metadata, current_path, current_metadata, request_id, output_dir):
    if not IDENTIFIER.fullmatch(request_id):
        raise BackupError("The restoration request ID is invalid.")
    for path, metadata in ((saved_path, saved_metadata), (current_path, current_metadata)):
        if metadata["checkpoint"]["manifest"].get("format") != "shard-atlas-library-json":
            raise BackupError("Choose a complete library checkpoint for cloud restoration.")
        verify_file(path, metadata)
    def read(path):
        with gzip.open(path, "rb") as stream:
            data = stream.read(MAX_BYTES + 1)
        if len(data) > MAX_BYTES:
            raise BackupError("The library exceeds the supported restoration size.")
        return strict_json(data)
    saved, current = read(saved_path), read(current_path)
    restored = merge_restore_capsule(saved, current)
    archive = restored["archive"]
    if type(archive.get("schemaVersion")) is not int or archive["schemaVersion"] != 1 or not isinstance(archive.get("shards"), list) or not isinstance(archive.get("links"), list):
        raise BackupError("The checkpoint contains an unsupported library archive.")
    counts = {name: len(archive.get(name, [])) for name in ("shards", "links", "assets", "revisions", "trash", "boards", "reviews") if isinstance(archive.get(name, []), list)}
    data = json.dumps(restored, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode("utf-8")
    if len(data) > MAX_BYTES:
        raise BackupError("The restored library and retained receipts exceed the supported size.")
    manifest = {"protocolVersion": 1, "archiveVersion": 1, "format": "shard-atlas-library-json", "sha256": digest_bytes(data), "bytes": len(data),
                "chunks": [{"sha256": digest_bytes(data[start:start+CHUNK_BYTES]), "bytes": len(data[start:start+CHUNK_BYTES])} for start in range(0, len(data), CHUNK_BYTES)]}
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    path = output_dir / (request_id + ".restore.json")
    path.write_bytes(data)
    os.chmod(path, 0o600)
    return {"file": str(path.resolve()), "prepareArguments": {"requestId": request_id, "sourceSha256": saved_metadata["checkpoint"]["manifest"]["sha256"],
            "manifest": manifest, "validated": True, "receiptsPreserved": True, "counts": counts}}


def digest_bytes(value):
    return hashlib.sha256(value).hexdigest()


def upload_restoration(descriptor, path):
    origin = site_origin(descriptor["siteUrl"])
    restore = descriptor.get("restore", descriptor)
    request_id = restore["requestId"]
    if not IDENTIFIER.fullmatch(request_id):
        raise BackupError("The restoration request ID is invalid.")
    manifest = validate_manifest(restore["manifest"])
    transfer = descriptor["uploadTransfer"]
    expected_path = f"/api/cloud-backups/restores/{request_id}/blobs/{{sha256}}"
    if transfer.get("chunkPath") != expected_path or not descriptor.get("siteBearer") or not transfer.get("ticket"):
        raise BackupError("Use fresh access scoped to the prepared restoration.")
    path = Path(path)
    if path.stat().st_size != manifest["bytes"] or _sha_file(path) != manifest["sha256"]:
        raise BackupError("The prepared restoration file changed before upload.")
    opener = urllib.request.build_opener(NoRedirect())
    with path.open("rb") as stream:
        for chunk in manifest["chunks"]:
            data = stream.read(chunk["bytes"])
            if len(data) != chunk["bytes"] or digest_bytes(data) != chunk["sha256"]:
                raise BackupError("The prepared restoration chunk changed before upload.")
            request = urllib.request.Request(origin + expected_path.replace("{sha256}", chunk["sha256"]), data=data, method="PUT", headers={
                "OAI-Sites-Authorization": "Bearer " + descriptor["siteBearer"], "X-Shard-Atlas-Backup-Ticket": transfer["ticket"], "Content-Type": "application/octet-stream"})
            with opener.open(request, timeout=60) as response:
                if response.status != 200:
                    raise BackupError("The prepared restoration upload failed.")
                response.read(16384)
    return {"requestId": request_id, "uploaded": True, "sha256": manifest["sha256"], "bytes": manifest["bytes"], "confirmRequired": True}


def retention_plan(items):
    """Select cloud archive moves only. No recovery point is ever deleted."""
    if not isinstance(items, list):
        raise BackupError("A complete checkpoint catalog is required.")
    groups = {}
    for item in items:
        if not isinstance(item, dict) or item.get("status") not in ("verified", "archived") or not item.get("driveVerified") or not item.get("driveFileId"):
            continue
        try:
            created = dt.datetime.fromisoformat(item["createdAt"].replace("Z", "+00:00"))
            if created.tzinfo is None:
                raise ValueError("missing timezone")
        except (KeyError, ValueError, TypeError):
            raise BackupError("A verified checkpoint has an invalid date. No archive moves were selected.")
        group = (item.get("kind"), item.get("deviceId") if item.get("kind") == "device" else "library")
        groups.setdefault(group, []).append((created.astimezone(dt.timezone.utc), item))
    keep, archive = set(), []
    for entries in groups.values():
        entries.sort(key=lambda value: (value[0], value[1]["id"]), reverse=True)
        for pattern, maximum in (("%Y-%m-%dT%H", 24), ("%Y-%m-%d", 30), ("%Y-%m", 12)):
            slots = set()
            for created, item in entries:
                slot = created.strftime(pattern)
                if slot not in slots and len(slots) < maximum:
                    slots.add(slot)
                    keep.add(item["id"])
        for _, item in entries:
            if item["id"] not in keep and item["status"] == "verified":
                archive.append({"checkpointId": item["id"], "driveFileId": item["driveFileId"]})
    return {"keepIds": sorted(keep), "archive": archive, "permanentDeletion": False,
            "policy": {"hourly": 24, "daily": 30, "monthly": 12, "groupedByDevice": True}}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    download = commands.add_parser("download")
    download.add_argument("--output-dir", required=True)
    verify = commands.add_parser("verify")
    verify.add_argument("--file", required=True)
    verify.add_argument("--manifest", required=True)
    restore = commands.add_parser("prepare-restore")
    restore.add_argument("--saved", required=True)
    restore.add_argument("--saved-manifest", required=True)
    restore.add_argument("--current", required=True)
    restore.add_argument("--current-manifest", required=True)
    restore.add_argument("--request-id", required=True)
    restore.add_argument("--output-dir", required=True)
    upload = commands.add_parser("upload-restore")
    upload.add_argument("--file", required=True)
    commands.add_parser("retention-plan")
    args = parser.parse_args()
    try:
        if args.command == "download":
            result = download_checkpoint(strict_json(sys.stdin.read()), args.output_dir)
        elif args.command == "verify":
            result = verify_file(args.file, strict_json(Path(args.manifest).read_text(encoding="utf-8")))
        elif args.command == "prepare-restore":
            result = prepare_restoration(args.saved, strict_json(Path(args.saved_manifest).read_text(encoding="utf-8")),
                args.current, strict_json(Path(args.current_manifest).read_text(encoding="utf-8")), args.request_id, args.output_dir)
        elif args.command == "upload-restore":
            result = upload_restoration(strict_json(sys.stdin.read()), args.file)
        else:
            value = strict_json(sys.stdin.read())
            result = retention_plan(value["items"] if isinstance(value, dict) else value)
        print(json.dumps(result, ensure_ascii=False))
    except (BackupError, OSError, ValueError, KeyError) as error:
        print(json.dumps({"error": str(error)}), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
