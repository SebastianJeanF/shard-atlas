#!/usr/bin/env python3
"""Local, HTTP-only access for AI contributions to Shard Atlas."""

from __future__ import annotations

import argparse
import concurrent.futures
import contextlib
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import re
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from urllib.parse import urlsplit

if os.name == "nt":
    import msvcrt
else:
    import fcntl

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_DB = Path.home() / "Library/Application Support/Shard Atlas/shards.sqlite3"
PORTS = range(48731, 48761)
MAX_BATCH_BYTES = 8 * 1024 * 1024
MAX_RESPONSE_BYTES = 260 * 1024 * 1024
SHARD_FIELDS = {"id", "title", "content", "tags", "kind", "status", "sourceUrl", "languageVersion", "eventDate",
                "evidenceStatus", "sources", "publicationDate", "verifiedDate", "eventType", "entities", "entityType", "inbox", "facts",
                "subjects", "courses", "notation", "assumptions", "perspectives", "walkthroughs", "comparisons", "learningLog", "verification", "experiments", "codeSolution"}
LINK_FIELDS = {"id", "fromId", "toId", "type", "note", "scope", "evidence", "sourceUrl", "sourceLocation", "fromApproachId", "toApproachId"}
ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$")


class ClientError(Exception):
    pass


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def loopback_url(value):
    try:
        parsed = urlsplit(value)
        if (parsed.scheme != "http" or parsed.hostname not in ("127.0.0.1", "localhost")
                or parsed.username or parsed.password or parsed.path not in ("", "/")
                or parsed.query or parsed.fragment or not parsed.port):
            raise ValueError()
        return f"http://{parsed.hostname}:{parsed.port}"
    except (ValueError, AttributeError, TypeError):
        raise ClientError("Use an explicit http://127.0.0.1:PORT loopback URL without credentials, a path, or a query.") from None


def request_json(base_url, path, payload=None, *, timeout=15):
    data = None if payload is None else json.dumps(payload, ensure_ascii=False, allow_nan=False).encode("utf-8")
    headers = {"Accept": "application/json"}
    if data is not None:
        headers["Content-Type"] = "application/json"
    request = urllib.request.Request(base_url + path, data=data, headers=headers)
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    try:
        with opener.open(request, timeout=timeout) as response:
            if response.headers.get_content_type() != "application/json":
                raise ClientError("The local service did not return Shard Atlas JSON.")
            raw = response.read(MAX_RESPONSE_BYTES + 1)
            if len(raw) > MAX_RESPONSE_BYTES:
                raise ClientError("The local service response is too large.")
            return json.loads(raw)
    except urllib.error.HTTPError as error:
        try:
            detail = json.loads(error.read(65536)).get("error", str(error))
        except (ValueError, AttributeError):
            detail = f"Local service returned HTTP {error.code}."
        raise ClientError(str(detail)) from error
    except (urllib.error.URLError, TimeoutError, OSError, ValueError) as error:
        raise ClientError(f"Could not communicate with Shard Atlas: {error}") from error


def valid_health(health, expected_db=None):
    if not isinstance(health, dict) or health.get("app") != "shard-atlas" or health.get("schemaVersion") != 1:
        return False
    try:
        version = tuple(int(piece) for piece in health["backendVersion"].split("."))
        if len(version) != 3 or version[0] not in (2, 3) or version < (2, 9, 0):
            return False
        return bool(health.get("dbPath")) and (expected_db is None or Path(health["dbPath"]).resolve() == Path(expected_db).resolve())
    except (KeyError, ValueError, TypeError, OSError):
        return False


def probe(base_url, expected_db=None, timeout=.18):
    try:
        health = request_json(base_url, "/api/health", timeout=timeout)
        return (base_url, health) if valid_health(health, expected_db) else None
    except ClientError:
        return None


def discover(expected_db=DEFAULT_DB):
    with concurrent.futures.ThreadPoolExecutor(max_workers=len(PORTS)) as pool:
        matches = list(pool.map(lambda port: probe(f"http://127.0.0.1:{port}", expected_db), PORTS))
    return next((result for result in matches if result), None)


@contextlib.contextmanager
def startup_lock(path, timeout=12):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a+b") as handle:
        if os.name == "nt":
            # Windows locks a byte range; keep a stable first byte and seek back
            # before every lock/unlock so independent helpers share that range.
            handle.seek(0, os.SEEK_END)
            if not handle.tell():
                handle.write(b"\0")
                handle.flush()
        deadline = time.monotonic() + timeout
        while True:
            try:
                if os.name == "nt":
                    handle.seek(0)
                    msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
                else:
                    fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except (BlockingIOError, PermissionError):
                if time.monotonic() >= deadline:
                    raise ClientError("Another Shard Atlas helper is still starting. Retry this request shortly.") from None
                time.sleep(.05)
        try:
            yield
        finally:
            if os.name == "nt":
                handle.seek(0)
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(handle, fcntl.LOCK_UN)


def start_backend():
    support = DEFAULT_DB.parent
    with startup_lock(support / "contributor-start.lock"):
        existing = discover(DEFAULT_DB)
        if existing:
            return existing
        log_path = support / "contributor-server.log"
        for port in PORTS:
            with socket.socket() as sock:
                try:
                    sock.bind(("127.0.0.1", port))
                except OSError:
                    continue
            with log_path.open("ab") as log:
                process = subprocess.Popen(
                    [sys.executable, str(ROOT / "server.py"), "--db", str(DEFAULT_DB), "--port", str(port), "--no-seed"],
                    stdin=subprocess.DEVNULL, stdout=log, stderr=log, cwd=ROOT, start_new_session=True,
                )
            deadline = time.monotonic() + 8
            while time.monotonic() < deadline:
                found = probe(f"http://127.0.0.1:{port}", DEFAULT_DB)
                if found:
                    return found
                if process.poll() is not None:
                    break
                time.sleep(.08)
            if process.poll() is None:
                process.terminate()
                with contextlib.suppress(subprocess.TimeoutExpired):
                    process.wait(timeout=2)
                raise ClientError(f"Shard Atlas did not become ready. See {log_path}.")
        raise ClientError(f"Shard Atlas could not start on its local ports. See {log_path}.")


def validate_batch(batch):
    if not isinstance(batch, dict) or set(batch) - {"requestId", "shards", "links"}:
        raise ClientError("A contribution must contain only requestId, shards, and links.")
    request_id = batch.get("requestId")
    if not isinstance(request_id, str) or not ID_RE.fullmatch(request_id):
        raise ClientError("requestId must be a stable identifier of 1–100 letters, numbers, or . _ : -; reuse it unchanged for retries.")
    shards, links = batch.get("shards", []), batch.get("links", [])
    if not isinstance(shards, list) or not isinstance(links, list) or len(shards) > 1000 or len(links) > 2000 or not (shards or links):
        raise ClientError("Provide at least one shard or connection, at most 1,000 shards and 2,000 connections.")
    if len(json.dumps(batch, ensure_ascii=False, allow_nan=False).encode()) > MAX_BATCH_BYTES:
        raise ClientError("Contributions must be at most 8 MB.")
    # Reuse the application's record validation without opening or writing a database.
    if str(ROOT) not in sys.path:
        sys.path.insert(0, str(ROOT))
    from server import AppError, validate_link, validate_shard
    result = {"requestId": request_id, "shards": [], "links": []}
    try:
        for shard in shards:
            if not isinstance(shard, dict) or set(shard) - SHARD_FIELDS:
                raise ClientError("A shard contains an unknown field; use the contribution schema.")
            validate_shard(shard, imported=True)
            result["shards"].append(dict(shard))
        for link in links:
            if not isinstance(link, dict) or set(link) - LINK_FIELDS:
                raise ClientError("A connection contains an unknown field; use the contribution schema.")
            item = dict(link)
            if "id" not in item:
                digest = hashlib.sha256(json.dumps([request_id, item], ensure_ascii=False, sort_keys=True).encode()).hexdigest()
                item["id"] = "ai-link-" + digest[:32]
            validate_link(item, imported=True)
            result["links"].append(item)
    except AppError as error:
        raise ClientError(str(error)) from error
    for kind in ("shards", "links"):
        ids = [item["id"] for item in result[kind]]
        if len(ids) != len(set(ids)):
            raise ClientError(f"Contribution contains duplicate IDs in {kind}.")
    return result


def portable_archive(batch):
    batch = validate_batch(batch)
    from server import validate_link, validate_shard
    stamp = dt.datetime.now(dt.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    return {"schemaVersion": 1,
            "shards": [validate_shard({**item, "createdAt": stamp, "updatedAt": stamp}, imported=True) for item in batch["shards"]],
            "links": [validate_link({**item, "createdAt": stamp}, imported=True) for item in batch["links"]], "reviews": []}


def inbox_envelope(batch):
    """Prepare immutable transport JSON without contacting a collection."""
    if str(ROOT) not in sys.path:
        sys.path.insert(0, str(ROOT))
    from server import AppError, validate_drive_inbox_envelope
    envelope = {"format": "shard-atlas-inbox", "version": 1, "batch": batch}
    try:
        validate_drive_inbox_envelope(envelope)
    except AppError as error:
        raise ClientError(str(error)) from error
    # Link identities must also survive transfer between independent collections.
    if any(not isinstance(item.get("id"), str) or not ID_RE.fullmatch(item["id"]) for item in batch.get("links", [])):
        raise ClientError("Drive inbox connections require explicit stable IDs. Keep those IDs unchanged on retries.")
    return envelope


def write_inbox_envelope(envelope, output_path):
    """Publish a complete file atomically, never replacing an existing batch."""
    output = Path(output_path).expanduser().absolute()
    encoded = (json.dumps(envelope, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False) + "\n").encode("utf-8")
    temporary = None
    reused = False
    try:
        with tempfile.NamedTemporaryFile(mode="wb", prefix=".shard-atlas-", suffix=".tmp", dir=output.parent, delete=False) as handle:
            temporary = Path(handle.name)
            handle.write(encoded)
            handle.flush()
            os.fsync(handle.fileno())
        try:
            os.link(temporary, output)
        except FileExistsError:
            if output.is_symlink() or not output.is_file() or output.read_bytes() != encoded:
                raise ClientError("That output already exists with different content. Preserve the original batch and use a different file for a new request.") from None
            reused = True
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)
    return {"savedToCollection": False, "uploadVerified": False, "envelopePath": str(output),
            "requestId": envelope["batch"]["requestId"], "reusedFile": reused,
            "shardCount": len(envelope["batch"].get("shards", [])), "linkCount": len(envelope["batch"].get("links", [])),
            "nextStep": "Upload this unchanged JSON to the configured ChatGPT/Shard Atlas/Inbox folder, then choose Sync in each Shard Atlas collection. A local file is not proof of a Drive upload or an import."}


class AtlasClient:
    def __init__(self, base_url=None, *, auto_start=True):
        self.base_url = loopback_url(base_url or os.environ["SHARD_ATLAS_URL"]) if base_url or os.environ.get("SHARD_ATLAS_URL") else None
        self.auto_start = auto_start
        self.expected_db = None if self.base_url else DEFAULT_DB
        self.health = None

    def connect(self):
        if self.base_url:
            health = request_json(self.base_url, "/api/health", timeout=10)
            if not valid_health(health, self.expected_db):
                raise ClientError("The selected local service is not a compatible Shard Atlas backend. This helper requires 2.9.0 or newer; reopen the updated app before using code references or contributions.")
            self.health = health
        else:
            found = discover(self.expected_db)
            if not found and self.auto_start:
                found = start_backend()
            if not found:
                raise ClientError("The working Shard Atlas collection is not running.")
            self.base_url, self.health = found
        return self

    def state(self):
        self.connect()
        state = request_json(self.base_url, "/api/state")
        if not isinstance(state, dict) or state.get("schemaVersion") != 1 or not isinstance(state.get("shards"), list) or not isinstance(state.get("links"), list):
            raise ClientError("The local service returned an invalid collection.")
        return state

    def preview_import(self, archive):
        self.connect()
        return request_json(self.base_url, "/api/import/preview", {"data": archive}, timeout=120)

    def import_archive(self, archive):
        self.preview_import(archive)
        self.connect()
        state = request_json(self.base_url, "/api/import", {"data": archive}, timeout=120)
        for collection in ("shards", "links", "boards"):
            expected = {item["id"] for item in archive.get(collection, [])}
            present = {item["id"] for item in state.get(collection, [])}
            if not expected.issubset(present):
                raise ClientError("Import completed but saved " + collection + " could not be verified. Inspect the receipt before retrying.")
        return {"verified": True, "importSummary": state.get("importSummary"),
                "collectionCounts": {key: len(state.get(key, [])) for key in ("shards", "links", "boards")}}

    def status(self):
        self.connect()
        return {"connected": True, "baseUrl": self.base_url, **self.health}

    def search(self, query, limit=12, *, role="", tags=None, tag_match="all"):
        if not isinstance(query, str) or len(query) > 1000:
            raise ClientError("query must be text of at most 1,000 characters.")
        if type(limit) is not int or not 1 <= limit <= 50:
            raise ClientError("limit must be an integer from 1 to 50.")
        if role not in ("", "snippet", "algorithm", "problem") or tag_match not in ("all", "any"):
            raise ClientError("Use a supported code role and tag_match all or any.")
        if tags is not None and (not isinstance(tags, list) or any(not isinstance(tag, str) or not tag.strip() or len(tag) > 80 for tag in tags)):
            raise ClientError("tags must be a list of nonempty names of at most 80 characters.")
        if str(ROOT) not in sys.path:
            sys.path.insert(0, str(ROOT))
        from server import learning_text
        terms = query.casefold().split()
        state = self.state()
        matches = []
        connected = {}
        for link in state.get("links", []):
            context = "\n".join(str(link.get(field, "")) for field in ("scope", "evidence", "sourceUrl", "sourceLocation"))
            for endpoint in (link["fromId"], link["toId"]):
                connected[endpoint] = connected.get(endpoint, "") + "\n" + context
        for shard in state["shards"]:
            title, content, shard_tags = shard["title"], shard["content"], shard.get("tags", [])
            solution = shard.get("codeSolution", {})
            aliases = solution.get("aliases", [])
            if role and solution.get("role") != role:
                continue
            selected = [tag.casefold() in {value.casefold() for value in shard_tags} for tag in (tags or [])]
            if selected and not (all(selected) if tag_match == "all" else any(selected)):
                continue
            academic = [*shard.get("subjects", []), *shard.get("assumptions", [])]
            academic.extend(value for course in shard.get("courses", []) for field, value in course.items() if isinstance(value, str))
            academic.extend(value for entry in shard.get("notation", []) for value in entry.values())
            academic.append(learning_text(shard, include_code=True))
            academic.append(connected.get(shard["id"], ""))
            haystack = "\n".join([title, content, *shard_tags, *aliases, *academic]).casefold()
            if terms and not all(term in haystack for term in terms):
                continue
            names = [title.casefold(), *(alias.casefold() for alias in aliases)]
            score = 100 * (query.casefold().strip() in names) + sum(8 * any(term in name for name in names) + 2 * any(term in tag.casefold() for tag in shard_tags) for term in terms)
            if not content:
                content = solution.get("purpose", "") or next((item.get("summary", "") for item in solution.get("approaches", []) if item.get("summary")), "")
            offset = min((content.casefold().find(term) for term in terms if term in content.casefold()), default=0)
            start = max(0, offset - 70)
            excerpt = ("…" if start else "") + content[start:start + 260] + ("…" if len(content) > start + 260 else "")
            matches.append((score, shard.get("updatedAt", ""), {"id": shard["id"], "title": title, "tags": shard_tags, "role": solution.get("role", ""), "aliases": aliases,
                "subjects": shard.get("subjects", []), "courses": shard.get("courses", []),
                "kind": shard.get("kind"), "status": shard.get("status"), "excerpt": excerpt}))
        matches.sort(key=lambda item: (item[0], item[1]), reverse=True)
        return {"query": query, "total": len(matches), "matches": [item[2] for item in matches[:limit]],
                "availableTags": sorted({tag for shard in state["shards"] for tag in shard.get("tags", [])}, key=str.casefold)}

    def read(self, ids):
        if not isinstance(ids, list) or not 1 <= len(ids) <= 20 or any(not isinstance(value, str) or not ID_RE.fullmatch(value) for value in ids):
            raise ClientError("ids must contain 1–20 stable shard identifiers.")
        state = self.state()
        wanted = set(ids)
        records = {shard["id"]: shard for shard in state["shards"]}
        missing = [value for value in ids if value not in records]
        links = [link for link in state["links"] if link["fromId"] in wanted or link["toId"] in wanted]
        return {"shards": [records[value] for value in ids if value in records], "links": links, "missingIds": missing,
                "connectedTitles": {value: records[value]["title"] for link in links for value in (link["fromId"], link["toId"]) if value in records and value not in wanted}}

    def add(self, batch):
        batch = validate_batch(batch)
        from server import canonical_link, remap_shard_references, validate_knowledge, validate_link_knowledge
        knowledge_defaults = validate_knowledge({})
        self.connect()
        receipt = request_json(self.base_url, "/api/contributions", batch, timeout=60)
        if not isinstance(receipt, dict) or receipt.get("requestId") != batch["requestId"] or not isinstance(receipt.get("shards"), list) or not isinstance(receipt.get("links"), list):
            raise ClientError("The save returned an invalid receipt. Retry the exact same requestId and batch to check its status.")
        state = self.state()
        shards = {item["id"]: item for item in state["shards"]}
        links = {item["id"]: item for item in state["links"]}
        proposed_shards = {item["id"]: item for item in batch["shards"]}
        proposed_links = {item["id"]: item for item in batch["links"]}
        id_map = receipt.get("idMap")
        if (not isinstance(id_map, dict)
                or len(receipt["shards"]) != len(proposed_shards)
                or len(receipt["links"]) != len(proposed_links)):
            raise ClientError("The save returned an incomplete receipt. Do not claim success; inspect the collection before making another contribution.")
        missing_shards, changed_shards, missing_links, changed_links = [], [], [], []
        seen_shards, seen_links = set(), set()
        normalize_title = lambda value: " ".join(value.split()).casefold()
        for entry in receipt["shards"]:
            input_id, saved_id = entry.get("inputId"), entry.get("id")
            if (input_id not in proposed_shards or input_id in seen_shards
                    or id_map.get(input_id) != saved_id or entry.get("outcome") not in ("added", "existing")):
                raise ClientError("The save returned inconsistent note identities. Do not claim success; inspect the collection.")
            seen_shards.add(input_id)
            saved = shards.get(saved_id)
            if saved is None:
                missing_shards.append(saved_id)
                continue
            expected = proposed_shards[input_id]
            if entry["outcome"] == "added":
                expected = remap_shard_references(expected, id_map)
            content = expected.get("content", "")
            matches = (normalize_title(saved["title"]) == normalize_title(expected["title"])
                       and saved["content"] == content
                       and saved.get("codeSolution", knowledge_defaults["codeSolution"]) == validate_knowledge(expected)["codeSolution"])
            if entry["outcome"] == "added":
                expected_tags = {tag.strip().casefold() for tag in expected.get("tags", [])}
                matches = matches and {tag.casefold() for tag in saved.get("tags", [])} == expected_tags
                for field, default in (("kind", "concept"), ("status", "learning"), ("sourceUrl", ""),
                                       ("languageVersion", ""), ("eventDate", "")):
                    matches = matches and saved.get(field, default) == expected.get(field, default)
                knowledge = validate_knowledge(expected)
                matches = matches and all(saved.get(field, knowledge_defaults[field]) == value for field, value in knowledge.items())
            if not matches:
                changed_shards.append(saved_id)
        for entry in receipt["links"]:
            input_id, saved_id = entry.get("inputId"), entry.get("id")
            if input_id not in proposed_links or input_id in seen_links or entry.get("outcome") not in ("added", "existing"):
                raise ClientError("The save returned inconsistent connection identities. Do not claim success; inspect the collection.")
            seen_links.add(input_id)
            saved = links.get(saved_id)
            if saved is None:
                missing_links.append(saved_id)
                continue
            expected = proposed_links[input_id]
            mapped = canonical_link({**expected, "fromId": id_map.get(expected["fromId"], expected["fromId"]),
                      "toId": id_map.get(expected["toId"], expected["toId"]), "type": expected.get("type", "related_to")})
            fields = {key: mapped.get(key, "") for key in ("fromId", "toId", "type", "fromApproachId", "toApproachId")}
            matches = all(saved.get(key, "") == value and entry.get(key, "") == value for key, value in fields.items())
            if entry["outcome"] == "added":
                matches = matches and saved.get("note", "") == expected.get("note", "")
                matches = matches and all(saved.get(key, "") == value for key, value in validate_link_knowledge(expected).items())
            if not matches:
                changed_links.append(saved_id)
        matches = not (missing_shards or changed_shards or missing_links or changed_links)
        if not matches and not receipt.get("replayed"):
            raise ClientError("The contribution receipt was saved, but current note contents or connections do not match the requested addition. Do not claim a verified save or retry blindly; inspect the collection for a concurrent edit.")
        receipt["originalSaveVerified"] = bool(receipt.get("verified"))
        receipt["verified"] = matches
        receipt["currentContentMatches"] = matches
        receipt["verifiedAt"] = dt.datetime.now(dt.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
        receipt["savedShards"] = [{"id": item["id"], "title": shards[item["id"]]["title"], "tags": shards[item["id"]].get("tags", [])} for item in receipt["shards"] if item["id"] in shards]
        if not matches:
            receipt["changedShardIds"] = list(dict.fromkeys(changed_shards))
            receipt["missingShardIds"] = list(dict.fromkeys(missing_shards))
            receipt["changedLinkIds"] = list(dict.fromkeys(changed_links))
            receipt["missingLinkIds"] = list(dict.fromkeys(missing_links))
            receipt["warnings"] = ["This request was saved previously. Some notes or connections were changed or deleted after the original save; those later changes were preserved. Do not report a new addition, restore old content, or repeat retries to repair it. Read the current notes and report the differences."]
        return receipt


def contribution_instructions():
    """Read the canonical authoring guide without contacting the collection."""
    try:
        raw = (ROOT / "static/ai-instructions.md").read_bytes()
        content = raw.decode("utf-8")
    except (OSError, UnicodeError) as error:
        raise ClientError("The contribution guide could not be read. Restore static/ai-instructions.md before preparing or saving knowledge.") from error
    if not content.strip() or len(raw) > 128 * 1024:
        raise ClientError("The contribution guide is empty or too large. Restore static/ai-instructions.md before saving knowledge.")
    return {"version": hashlib.sha256(raw).hexdigest(), "content": content}


def load_json(path, maximum=MAX_BATCH_BYTES):
    try:
        raw = Path(path).read_bytes()
        if len(raw) > maximum:
            raise ClientError("The JSON file exceeds the allowed " + str(maximum // (1024 * 1024)) + " MB size.")
        return json.loads(raw, parse_constant=lambda value: (_ for _ in ()).throw(ValueError(value)))
    except (OSError, ValueError, UnicodeError) as error:
        raise ClientError(f"Could not read contribution JSON: {error}") from error


def main(argv=None):
    parser = argparse.ArgumentParser(description="Read or add knowledge through the local Shard Atlas service.")
    parser.add_argument("--base-url", help="Explicit loopback service URL; only use an isolated URL for tests.")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("status")
    sub.add_parser("instructions", help="Read the current full contribution guide before preparing knowledge.")
    search = sub.add_parser("search")
    search.add_argument("--query", required=True)
    search.add_argument("--limit", type=int, default=12)
    search.add_argument("--role", choices=("snippet", "algorithm", "problem"), default="")
    search.add_argument("--tag", action="append", dest="tags")
    search.add_argument("--tag-match", choices=("all", "any"), default="all")
    read = sub.add_parser("read")
    read.add_argument("--id", action="append", required=True, dest="ids")
    add = sub.add_parser("add")
    add.add_argument("--file", required=True)
    archive = sub.add_parser("archive")
    archive.add_argument("--file", required=True)
    archive.add_argument("--output", required=True)
    inbox = sub.add_parser("inbox", help="Prepare a stable Drive inbox envelope without contacting the Mac collection.")
    inbox.add_argument("--file", required=True, help="Additive batch JSON with a stable requestId and explicit note/connection IDs.")
    inbox.add_argument("--output", help="New .json file, written atomically. Omit to print the envelope to stdout.")
    for command in ("preview-import", "import"):
        importer = sub.add_parser(command)
        importer.add_argument("--file", required=True)
    args = parser.parse_args(argv)
    try:
        if args.command == "instructions":
            result = contribution_instructions()
        elif args.command == "inbox":
            envelope = inbox_envelope(load_json(args.file))
            if args.output and Path(args.output).suffix.lower() != ".json":
                raise ClientError("Use a .json output filename so the Drive inbox can discover it.")
            result = write_inbox_envelope(envelope, args.output) if args.output else envelope
        elif args.command == "archive":
            data = portable_archive(load_json(args.file))
            output = Path(args.output).expanduser().resolve()
            with output.open("x", encoding="utf-8") as handle:
                json.dump(data, handle, ensure_ascii=False, indent=2, allow_nan=False)
                handle.write("\n")
            result = {"savedToCollection": False, "archivePath": str(output), "shardCount": len(data["shards"]), "linkCount": len(data["links"]), "nextStep": "Import this JSON using Shard Atlas → Import JSON. Existing-note connections require those notes to be present in the destination collection."}
        else:
            client = AtlasClient(args.base_url)
            result = {"status": client.status, "search": lambda: client.search(args.query, args.limit, role=args.role, tags=args.tags, tag_match=args.tag_match), "read": lambda: client.read(args.ids), "add": lambda: client.add(load_json(args.file)),
                      "preview-import": lambda: client.preview_import(load_json(args.file, 256 * 1024 * 1024)),
                      "import": lambda: client.import_archive(load_json(args.file, 256 * 1024 * 1024))}[args.command]()
        print(json.dumps(result, allow_nan=False))
        return 0
    except (ClientError, OSError, ValueError) as error:
        print(json.dumps({"error": str(error)}), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
