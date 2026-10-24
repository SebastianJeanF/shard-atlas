#!/usr/bin/env python3
"""Shard Atlas: a local, dependency-free HTTP server with SQLite persistence."""

from __future__ import annotations

import argparse
import base64
import binascii
import datetime as dt
import io
import hashlib
import json
import mimetypes
import math
import os
import re
import signal
import sqlite3
import stat
import subprocess
import sys
import tempfile
import threading
import time
import uuid
import zipfile
from contextlib import closing, contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit


SCHEMA_VERSION = 1
DATABASE_VERSION = 5
BACKEND_VERSION = "3.0.0"  # Keep the additive API compatible with already-running contribution clients.
ROOT = Path(__file__).resolve().parent
DEFAULT_DB = Path.home() / "Library/Application Support/Shard Atlas/shards.sqlite3"
KINDS = {"concept", "fact", "example", "mistake", "event", "idea"}
STATUSES = {"learning", "solid", "verify"}
LINK_TYPES = {"depends_on", "explains", "contrasts_with", "example_of", "related_to", "part_of", "supports", "contradicts", "supersedes", "released_by", "uses", "implements", "alternative_to"}
EVIDENCE_STATUSES = {"unverified", "reported", "corroborated", "disputed", "superseded"}
EVENT_TYPES = {"", "event", "announcement", "release", "research", "rumor", "forecast"}
ENTITY_TYPES = {"", "company", "model", "concept", "person"}
VERIFICATION_DEFAULTS = {"status": "unverified", "note": "", "sourceUrl": "", "sourceLocation": "", "checkedAt": ""}
LINK_KNOWLEDGE_DEFAULTS = {"scope": "", "evidence": "", "sourceUrl": "", "sourceLocation": ""}
LINK_APPROACH_FIELDS = ("fromApproachId", "toApproachId")
CODE_SOLUTION_DEFAULTS = {"role": "", "aliases": [], "purpose": "", "code": "", "headers": [],
    "timeComplexity": "", "spaceComplexity": "", "complexityNotes": "", "assumptions": [], "pitfalls": [], "approaches": []}
KNOWLEDGE_DEFAULTS = {"evidenceStatus": "unverified", "sources": [], "publicationDate": "", "verifiedDate": "", "eventType": "", "entities": [], "entityType": "", "inbox": False, "facts": [],
                      "subjects": [], "courses": [], "notation": [], "assumptions": [],
                      "perspectives": [], "walkthroughs": [], "comparisons": [], "learningLog": [], "verification": VERIFICATION_DEFAULTS,
                      "experiments": [], "codeSolution": CODE_SOLUTION_DEFAULTS}
REVIEW_DAYS = {"again": 1, "hard": 3, "good": 7, "easy": 14}
MAX_BODY_BYTES = 260 * 1024 * 1024
MAX_ARCHIVE_BYTES = 256 * 1024 * 1024
MAX_ASSET_BYTES = 8 * 1024 * 1024
MAX_TOTAL_ASSET_BYTES = 96 * 1024 * 1024
MAX_IMPORT_RECORDS = 100_000
MAX_CONTRIBUTION_BYTES = 8 * 1024 * 1024
MAX_CONTRIBUTION_RECEIPTS = 10_000
MAX_CONTRIBUTION_RECEIPT_BYTES = 8 * 1024 * 1024
MAX_DRIVE_INBOX_FILES = 500
MAX_DRIVE_INBOX_ENTRIES = 5000
MAX_DRIVE_INBOX_FILE_BYTES = MAX_CONTRIBUTION_BYTES + 1024
MAX_DRIVE_INBOX_TOTAL_BYTES = 64 * 1024 * 1024
MAX_DRAFT_BYTES = 8 * 1024 * 1024
CONTRIBUTION_PREFIX = "contribution:"
ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$")
MUTABLE_SHARD_FIELDS = {
    "title", "content", "prompt", "tags", "kind", "status", "sourceUrl",
    "languageVersion", "eventDate",
} | set(KNOWLEDGE_DEFAULTS)


def validate_asset(data, *, imported=False):
    if not isinstance(data, dict):
        raise AppError("Each image must be an object.")
    mime = data.get("mimeType")
    if mime not in ("image/png", "image/jpeg", "image/gif", "image/webp"):
        raise AppError("Images must be PNG, JPEG, GIF, or WebP.")
    encoded = data.get("data")
    if not isinstance(encoded, str) or len(encoded) > (MAX_ASSET_BYTES + 2) // 3 * 4:
        raise AppError("Images must be at most 8 MB.")
    try:
        raw = base64.b64decode(encoded, validate=True)
    except (ValueError, binascii.Error):
        raise AppError("Image data must be valid base64.") from None
    valid = False
    if mime == "image/png":
        valid = len(raw) >= 33 and raw.startswith(b"\x89PNG\r\n\x1a\n") and raw[12:16] == b"IHDR"
        if valid:
            width, height = int.from_bytes(raw[16:20], "big"), int.from_bytes(raw[20:24], "big")
            valid = 0 < width <= 16384 and 0 < height <= 16384 and width * height <= 40_000_000
    elif mime == "image/jpeg":
        valid = len(raw) >= 4 and raw.startswith(b"\xff\xd8\xff") and raw.endswith(b"\xff\xd9")
    elif mime == "image/gif":
        valid = len(raw) >= 14 and raw[:6] in (b"GIF87a", b"GIF89a") and raw.endswith(b";")
        if valid:
            width, height = int.from_bytes(raw[6:8], "little"), int.from_bytes(raw[8:10], "little")
            valid = 0 < width <= 16384 and 0 < height <= 16384 and width * height <= 40_000_000
    elif mime == "image/webp":
        valid = len(raw) >= 20 and raw[:4] == b"RIFF" and raw[8:12] == b"WEBP" and int.from_bytes(raw[4:8], "little") + 8 == len(raw)
    if not valid or len(raw) > MAX_ASSET_BYTES:
        raise AppError("The image contents do not match a supported raster image format.")
    return {"id": record_id(data.get("id")) if imported else str(uuid.uuid4()),
            "name": text_field(data.get("name", "Image"), "name", 240, required=True),
            "mimeType": mime, "data": base64.b64encode(raw).decode("ascii"), "size": len(raw),
            "createdAt": timestamp(data.get("createdAt", now()) if imported else now(), "createdAt")}


class AppError(Exception):
    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


def now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def text_field(value, name: str, limit: int, *, required: bool = False) -> str:
    if not isinstance(value, str):
        raise AppError(f"{name} must be text.")
    if len(value) > limit:
        raise AppError(f"{name} must be at most {limit:,} characters.")
    if "\x00" in value:
        raise AppError(f"{name} cannot contain a null character.")
    if required and not value.strip():
        raise AppError(f"{name} is required.")
    return value.strip() if name == "title" else value


def record_id(value, name="id") -> str:
    if not isinstance(value, str) or not ID_PATTERN.fullmatch(value):
        raise AppError(f"{name} must be a stable identifier of 1–100 letters, numbers, or . _ : -.")
    return value


def timestamp(value, name: str, *, optional=False):
    if optional and value in (None, ""):
        return None
    if not isinstance(value, str) or len(value) > 64:
        raise AppError(f"{name} must be an ISO timestamp with a time zone.")
    try:
        parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            raise ValueError()
        return parsed.astimezone(dt.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    except (ValueError, OverflowError):
        raise AppError(f"{name} must be an ISO timestamp with a time zone.") from None


def validate_tags(value) -> list[str]:
    if not isinstance(value, list):
        raise AppError("tags must be a list.")
    tags = [text_field(tag, "tag", 80, required=True).strip() for tag in value]
    if len(set(tags)) != len(tags):
        raise AppError("tags cannot contain duplicates.")
    return tags


def partial_date(value, name):
    value = text_field(value, name, 10)
    if not value:
        return ""
    if not re.fullmatch(r"\d{4}(?:-\d{2}(?:-\d{2})?)?", value):
        raise AppError(f"{name} must use YYYY, YYYY-MM, or YYYY-MM-DD.")
    try:
        dt.date.fromisoformat(value + ("-01-01" if len(value) == 4 else "-01" if len(value) == 7 else ""))
    except ValueError:
        raise AppError(f"{name} must be a valid date.") from None
    return value


def source_url(value, name="sourceUrl"):
    value = text_field(value, name, 2048)
    if value:
        try:
            url = urlsplit(value)
            if url.scheme not in ("http", "https") or not url.hostname or url.username or url.password or any(c.isspace() for c in value):
                raise ValueError()
            _ = url.port
        except ValueError:
            raise AppError(f"{name} must be an http or https URL without embedded credentials.") from None
    return value


def validate_knowledge(data):
    if not isinstance(data, dict):
        raise AppError("Knowledge metadata must be an object.")
    result = {**KNOWLEDGE_DEFAULTS, **{key: data[key] for key in KNOWLEDGE_DEFAULTS if key in data}}
    for field, allowed in (("evidenceStatus", EVIDENCE_STATUSES), ("eventType", EVENT_TYPES), ("entityType", ENTITY_TYPES)):
        if not isinstance(result[field], str) or result[field] not in allowed:
            raise AppError(f"Unknown {field}.")
    for field in ("publicationDate", "verifiedDate"):
        result[field] = partial_date(result[field], field)
    if type(result["inbox"]) is not bool:
        raise AppError("inbox must be true or false.")
    entities = result["entities"]
    if not isinstance(entities, list) or len(entities) > 100:
        raise AppError("entities must be a list of at most 100 names.")
    result["entities"] = list(dict.fromkeys(text_field(value, "entity", 240, required=True).strip() for value in entities))
    for field, maximum in (("sources", 100), ("facts", 200)):
        if not isinstance(result[field], list) or len(result[field]) > maximum:
            raise AppError(f"{field} must be a list of at most {maximum} objects.")
        records = []
        for item in result[field]:
            if not isinstance(item, dict):
                raise AppError(f"Each {field} entry must be an object.")
            if field == "sources":
                records.append({"url": source_url(item.get("url", ""), "source URL"), "title": text_field(item.get("title", ""), "source title", 500),
                    "publishedDate": partial_date(item.get("publishedDate", ""), "publishedDate"), "accessedDate": partial_date(item.get("accessedDate", ""), "accessedDate"), "note": text_field(item.get("note", ""), "source note", 5000)})
            else:
                records.append({"label": text_field(item.get("label", ""), "fact label", 240, required=True), "value": text_field(item.get("value", ""), "fact value", 5000),
                    "unit": text_field(item.get("unit", ""), "fact unit", 100), "sourceUrl": source_url(item.get("sourceUrl", "")), "asOf": partial_date(item.get("asOf", ""), "asOf")})
        result[field] = records
    result.update(validate_academic(data))
    result.update(validate_learning(data))
    result["experiments"] = validate_experiments(data.get("experiments", []))
    result["codeSolution"] = validate_code_solution(data.get("codeSolution", {}))
    return result


def validate_code_solution(data):
    """Code is literal source: never trim it, normalize whitespace, or execute it."""
    if not isinstance(data, dict) or set(data) - set(CODE_SOLUTION_DEFAULTS):
        raise AppError("codeSolution must contain only its supported fields.")
    role = data.get("role", "")
    if not isinstance(role, str) or role not in ("", "snippet", "algorithm", "problem"):
        raise AppError("Code solution role must be snippet, algorithm, problem, or empty.")
    def details(item, label):
        result = {field: text_field(item.get(field, ""), label + " " + field, limit) for field, limit in (
            ("code", 100_000), ("timeComplexity", 500), ("spaceComplexity", 500), ("complexityNotes", 5000))}
        for field, limit in (("headers", 240), ("assumptions", 2000), ("pitfalls", 2000)):
            values = item.get(field, [])
            if not isinstance(values, list) or len(values) > 100:
                raise AppError(label + " " + field + " must be a list of at most 100 text entries.")
            result[field] = list(dict.fromkeys(text_field(value, label + " " + field, limit, required=True).strip() for value in values))
        return result
    aliases = data.get("aliases", [])
    if not isinstance(aliases, list) or len(aliases) > 200:
        raise AppError("Code solution aliases must be a list of at most 200 names.")
    result = {"role": role, "aliases": list(dict.fromkeys(text_field(value, "code alias", 240, required=True).strip() for value in aliases)),
              "purpose": text_field(data.get("purpose", ""), "code purpose", 10_000), **details(data, "Code solution"), "approaches": []}
    approaches = data.get("approaches", [])
    if not isinstance(approaches, list) or len(approaches) > 100:
        raise AppError("Code solution approaches must be a list of at most 100 objects.")
    for index, item in enumerate(approaches):
        allowed = (set(CODE_SOLUTION_DEFAULTS) - {"role", "aliases", "purpose", "approaches"}) | {"id", "title", "summary"}
        if not isinstance(item, dict) or set(item) - allowed:
            raise AppError("Each solution approach must contain only its supported fields.")
        # A deterministic fallback keeps imports and immutable contribution retries
        # stable. Editors should assign IDs immediately and retain them on edits.
        approach = {"title": text_field(item.get("title", ""), "approach title", 240),
            "summary": text_field(item.get("summary", ""), "approach summary", 10_000), **details(item, "Approach")}
        fallback = "approach-" + str(uuid.uuid5(uuid.NAMESPACE_URL, json.dumps([index, approach], sort_keys=True, ensure_ascii=False)))
        result["approaches"].append({"id": record_id(item.get("id", fallback), "approach id"), **approach})
    if len({item["id"] for item in result["approaches"]}) != len(result["approaches"]):
        raise AppError("Solution approaches cannot contain duplicate IDs.")
    return result


def validate_academic(data):
    """Course occurrences and notation belong to a shard, not to a global symbol table."""
    result = {}
    for field, maximum, limit in (("subjects", 20, 80), ("assumptions", 100, 2000)):
        values = data.get(field, [])
        if not isinstance(values, list) or len(values) > maximum:
            raise AppError(f"{field} must be a list of at most {maximum} text entries.")
        result[field] = list(dict.fromkeys(text_field(value, field[:-1], limit, required=True).strip() for value in values))
    courses = data.get("courses", [])
    if not isinstance(courses, list) or len(courses) > 100:
        raise AppError("courses must be a list of at most 100 course occurrences.")
    result["courses"] = []
    course_fields = {"courseCode", "courseTitle", "term", "lecture", "position", "sourceUrl", "sourceLocation", "context"}
    for course in courses:
        if not isinstance(course, dict) or set(course) - course_fields:
            raise AppError("Each course occurrence must be an object containing only course fields.")
        position = course.get("position", 0)
        if type(position) not in (int, float) or not 0 <= position <= 100_000 or not math.isfinite(position):
            raise AppError("Course position must be a finite number between 0 and 100,000.")
        result["courses"].append({
            "courseCode": text_field(course.get("courseCode", ""), "courseCode", 80, required=True).strip(),
            "courseTitle": text_field(course.get("courseTitle", ""), "courseTitle", 240),
            "term": text_field(course.get("term", ""), "term", 80),
            "lecture": text_field(course.get("lecture", ""), "lecture", 240),
            "position": position,
            "sourceUrl": source_url(course.get("sourceUrl", ""), "course source URL"),
            "sourceLocation": text_field(course.get("sourceLocation", ""), "sourceLocation", 240),
            "context": text_field(course.get("context", ""), "course context", 5000),
        })
    notation = data.get("notation", [])
    if not isinstance(notation, list) or len(notation) > 100:
        raise AppError("notation must be a list of at most 100 symbol definitions.")
    result["notation"] = []
    notation_fields = {"symbol", "meaning", "shape", "role", "scope"}
    for entry in notation:
        if not isinstance(entry, dict) or set(entry) - notation_fields:
            raise AppError("Each notation entry must be an object containing only notation fields.")
        result["notation"].append({
            "symbol": text_field(entry.get("symbol", ""), "symbol", 120, required=True),
            "meaning": text_field(entry.get("meaning", ""), "symbol meaning", 2000, required=True),
            "shape": text_field(entry.get("shape", ""), "symbol shape", 120),
            "role": text_field(entry.get("role", ""), "symbol role", 240),
            "scope": text_field(entry.get("scope", ""), "symbol scope", 240),
        })
    return result


def validate_learning(data):
    """Keep explanatory material and content verification separate from personal understanding."""
    def records(value, name, maximum, minimum=0):
        if not isinstance(value, list) or not minimum <= len(value) <= maximum:
            raise AppError(f"{name} must contain between {minimum} and {maximum} objects.")
        if any(not isinstance(item, dict) for item in value):
            raise AppError(f"Each {name} entry must be an object.")
        return value

    def fields(item, allowed, name):
        if not isinstance(item, dict) or set(item) - set(allowed):
            raise AppError(f"{name} must be an object containing only its supported fields.")

    def strings(value, name, maximum):
        if not isinstance(value, list) or len(value) > maximum:
            raise AppError(f"{name} must be a list of at most {maximum} text entries.")
        return [text_field(item, name, 2000, required=True) for item in value]

    def source(item):
        return {"sourceUrl": source_url(item.get("sourceUrl", "")),
                "sourceLocation": text_field(item.get("sourceLocation", ""), "sourceLocation", 240)}

    result = {"perspectives": [], "walkthroughs": [], "comparisons": [], "learningLog": []}
    for item in records(data.get("perspectives", []), "perspectives", 20):
        fields(item, ("title", "viewpoint", "content", "assumptions", "sourceUrl", "sourceLocation"), "Perspective")
        result["perspectives"].append({"title": text_field(item.get("title", ""), "perspective title", 240, required=True),
            "viewpoint": text_field(item.get("viewpoint", ""), "viewpoint", 240),
            "content": text_field(item.get("content", ""), "perspective content", 30_000, required=True),
            "assumptions": strings(item.get("assumptions", []), "perspective assumptions", 20), **source(item)})
    for item in records(data.get("walkthroughs", []), "walkthroughs", 20):
        fields(item, ("title", "kind", "goal", "steps", "conclusion", "sourceUrl", "sourceLocation"), "Walkthrough")
        kind = item.get("kind", "derivation")
        if not isinstance(kind, str) or kind not in ("derivation", "trace"):
            raise AppError("Walkthrough kind must be derivation or trace.")
        steps = []
        for step in records(item.get("steps", []), "walkthrough steps", 100, 1):
            fields(step, ("title", "expression", "explanation", "justification"), "Walkthrough step")
            normalized = {key: text_field(step.get(key, ""), "step " + key, limit)
                          for key, limit in (("title", 240), ("expression", 5000), ("explanation", 10_000), ("justification", 5000))}
            if not normalized["expression"].strip() and not normalized["explanation"].strip():
                raise AppError("Each walkthrough step needs an expression or an explanation.")
            steps.append(normalized)
        result["walkthroughs"].append({"title": text_field(item.get("title", ""), "walkthrough title", 240, required=True),
            "kind": kind, "goal": text_field(item.get("goal", ""), "walkthrough goal", 5000), "steps": steps,
            "conclusion": text_field(item.get("conclusion", ""), "walkthrough conclusion", 5000), **source(item)})
    for item in records(data.get("comparisons", []), "comparisons", 20):
        fields(item, ("title", "question", "alternatives", "conclusion", "sourceUrl", "sourceLocation"), "Comparison")
        alternatives = []
        for alternative in records(item.get("alternatives", []), "comparison alternatives", 10, 2):
            fields(alternative, ("name", "shardId", "summary", "assumptions", "strengths", "limitations", "cost"), "Comparison alternative")
            shard_id = text_field(alternative.get("shardId", ""), "alternative shardId", 120)
            if shard_id and not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}", shard_id):
                raise AppError("An alternative shardId must be an optional stable identifier of at most 120 characters.")
            alternatives.append({"name": text_field(alternative.get("name", ""), "alternative name", 240, required=True),
                "shardId": shard_id, "summary": text_field(alternative.get("summary", ""), "alternative summary", 5000),
                **{key: strings(alternative.get(key, []), "alternative " + key, 30) for key in ("assumptions", "strengths", "limitations")},
                "cost": text_field(alternative.get("cost", ""), "alternative cost", 2000)})
        result["comparisons"].append({"title": text_field(item.get("title", ""), "comparison title", 240, required=True),
            "question": text_field(item.get("question", ""), "comparison question", 5000), "alternatives": alternatives,
            "conclusion": text_field(item.get("conclusion", ""), "comparison conclusion", 5000), **source(item)})
    for item in records(data.get("learningLog", []), "learningLog", 100):
        fields(item, ("kind", "prompt", "status", "resolution", "history", "sourceUrl", "sourceLocation"), "Learning log entry")
        kind, status = item.get("kind", "question"), item.get("status", "open")
        if not isinstance(kind, str) or kind not in ("question", "misconception"):
            raise AppError("Learning log kind must be question or misconception.")
        if not isinstance(status, str) or status not in ("open", "resolved"):
            raise AppError("Learning log status must be open or resolved.")
        history = []
        for entry in records(item.get("history", []), "learning log history", 100):
            fields(entry, ("date", "note"), "Learning log history entry")
            history.append({"date": partial_date(entry.get("date", ""), "history date"),
                            "note": text_field(entry.get("note", ""), "history note", 5000, required=True)})
        result["learningLog"].append({"kind": kind, "prompt": text_field(item.get("prompt", ""), "learning log prompt", 5000, required=True),
            "status": status, "resolution": text_field(item.get("resolution", ""), "resolution", 10_000, required=status == "resolved"),
            "history": history, **source(item)})
    verification = data.get("verification", {})
    fields(verification, VERIFICATION_DEFAULTS, "Verification")
    status = verification.get("status", "unverified")
    if not isinstance(status, str) or status not in ("unverified", "source-checked", "needs-correction"):
        raise AppError("Verification status must be unverified, source-checked, or needs-correction.")
    result["verification"] = {"status": status, "note": text_field(verification.get("note", ""), "verification note", 5000),
        **source(verification), "checkedAt": partial_date(verification.get("checkedAt", ""), "checkedAt")}
    if status == "source-checked" and (not result["verification"]["note"].strip() or not (result["verification"]["sourceUrl"] or result["verification"]["sourceLocation"].strip())):
        raise AppError("Source-checked verification needs a note and a source URL or source location.")
    return result


def validate_link_knowledge(data):
    if not isinstance(data, dict):
        raise AppError("Relationship context must be an object.")
    return {"scope": text_field(data.get("scope", ""), "relationship scope", 5000),
            "evidence": text_field(data.get("evidence", ""), "relationship evidence", 10_000),
            "sourceUrl": source_url(data.get("sourceUrl", ""), "relationship source URL"),
            "sourceLocation": text_field(data.get("sourceLocation", ""), "relationship source location", 240)}


def validate_experiment(data):
    """Validate fixed, reproducible experiment settings; supplied code is never evaluated."""
    def fields(item, allowed, label):
        if not isinstance(item, dict) or set(item) - set(allowed):
            raise AppError(f"{label} must contain only its supported fields.")

    def number(value, label, minimum, maximum, *, open_minimum=False):
        if (type(value) not in (int, float) or not minimum <= value <= maximum
                or (open_minimum and value == minimum) or not math.isfinite(value)):
            interval = f"{'greater than' if open_minimum else 'at least'} {minimum} and at most {maximum}"
            raise AppError(f"{label} must be a finite number {interval}.")
        return value

    def iteration_count(value, label):
        if type(value) is not int or not 1 <= value <= 500:
            raise AppError(f"{label} must be an integer from 1 to 500.")
        return value

    def records(value, label, minimum, maximum):
        if not isinstance(value, list) or not minimum <= len(value) <= maximum or any(not isinstance(item, dict) for item in value):
            raise AppError(f"{label} must contain between {minimum} and {maximum} objects.")
        return value

    def gradient_config(config, label):
        fields(config, ("a", "b", "c", "startX", "startY", "learningRate", "maxIterations", "tolerance"), label)
        result = {"a": number(config.get("a"), label + ": a", .001, 1000),
                  "b": number(config.get("b"), label + ": b", -1000, 1000),
                  "c": number(config.get("c"), label + ": c", .001, 1000),
                  "startX": number(config.get("startX"), label + ": startX", -100, 100),
                  "startY": number(config.get("startY"), label + ": startY", -100, 100),
                  "learningRate": number(config.get("learningRate"), label + ": learningRate", 0, 10, open_minimum=True),
                  "maxIterations": iteration_count(config.get("maxIterations"), label + ": maxIterations"),
                  "tolerance": number(config.get("tolerance"), label + ": tolerance", 1e-12, 1)}
        if result["a"] * result["c"] - result["b"] ** 2 <= 1e-9:
            raise AppError(label + ": a*c - b*b must be greater than 1e-9 (a positive-definite quadratic).")
        return result

    def value_config(config, label):
        fields(config, ("states", "actions", "transitions", "discount", "maxIterations", "tolerance"), label)
        states, actions, transitions = [], [], []
        for index, item in enumerate(records(config.get("states"), label + ": states", 1, 12), 1):
            location = f"{label}: state {index}"
            fields(item, ("id", "label", "terminal", "initialValue"), location)
            terminal = item.get("terminal")
            if type(terminal) is not bool:
                raise AppError(location + ": terminal must be true or false.")
            initial = number(item.get("initialValue"), location + ": initialValue", -10_000, 10_000)
            if terminal and initial != 0:
                raise AppError(location + ": a terminal state's initial value must be zero.")
            states.append({"id": record_id(item.get("id"), "state id"), "label": text_field(item.get("label", ""), location + " label", 120, required=True),
                           "terminal": terminal, "initialValue": initial})
        for index, item in enumerate(records(config.get("actions"), label + ": actions", 1, 4), 1):
            fields(item, ("id", "label"), f"{label}: action {index}")
            actions.append({"id": record_id(item.get("id"), "action id"), "label": text_field(item.get("label", ""), "action label", 120, required=True)})
        state_ids, action_ids = {item["id"] for item in states}, {item["id"] for item in actions}
        if len(state_ids) != len(states) or len(action_ids) != len(actions):
            raise AppError(label + ": state IDs and action IDs must each be unique.")
        terminals = {item["id"] for item in states if item["terminal"]}
        pairs, available = set(), set()
        for index, item in enumerate(records(config.get("transitions"), label + ": transition rows", 0, 48), 1):
            location = f"{label}: transition row {index}"
            fields(item, ("stateId", "actionId", "outcomes"), location)
            state_id, action_id = record_id(item.get("stateId"), "transition stateId"), record_id(item.get("actionId"), "transition actionId")
            if state_id not in state_ids or action_id not in action_ids:
                raise AppError(location + ": stateId and actionId must reference declared states and actions.")
            if state_id in terminals:
                raise AppError(location + ": terminal states cannot have transition rows.")
            if (state_id, action_id) in pairs:
                raise AppError(location + ": duplicate state/action pair.")
            pairs.add((state_id, action_id))
            available.add(state_id)
            outcomes = []
            for outcome_index, outcome in enumerate(records(item.get("outcomes"), location + " outcomes", 1, 12), 1):
                fields(outcome, ("nextStateId", "probability", "reward"), location + f" outcome {outcome_index}")
                next_state = record_id(outcome.get("nextStateId"), "outcome nextStateId")
                if next_state not in state_ids:
                    raise AppError(location + f" outcome {outcome_index}: nextStateId must reference a declared state.")
                outcomes.append({"nextStateId": next_state,
                    "probability": number(outcome.get("probability"), location + f" outcome {outcome_index} probability", 0, 1),
                    "reward": number(outcome.get("reward"), location + f" outcome {outcome_index} reward", -10_000, 10_000)})
            if abs(math.fsum(outcome["probability"] for outcome in outcomes) - 1) > 1e-9:
                raise AppError(location + ": outcome probabilities must sum to one within 1e-9; they are never normalized automatically.")
            transitions.append({"stateId": state_id, "actionId": action_id, "outcomes": outcomes})
        if state_ids - terminals - available:
            raise AppError(label + ": every nonterminal state needs at least one available action.")
        return {"states": states, "actions": actions, "transitions": transitions,
                "discount": number(config.get("discount"), label + ": discount", 0, .999),
                "maxIterations": iteration_count(config.get("maxIterations"), label + ": maxIterations"),
                "tolerance": number(config.get("tolerance"), label + ": tolerance", 1e-12, 1)}

    fields(data, ("id", "type", "title", "description", "sourceUrl", "sourceLocation", "algorithmVersion", "config", "comparisonConfig"), "Experiment")
    kind = data.get("type")
    if not isinstance(kind, str) or kind not in ("gradient-descent", "value-iteration"):
        raise AppError("Experiment type must be gradient-descent or value-iteration.")
    if type(data.get("algorithmVersion")) is not int or data["algorithmVersion"] != 1:
        raise AppError("This app supports experiment algorithmVersion 1 only.")
    validator = gradient_config if kind == "gradient-descent" else value_config
    comparison = data.get("comparisonConfig")
    return {"id": record_id(data.get("id"), "experiment id"), "type": kind,
            "title": text_field(data.get("title", ""), "experiment title", 240, required=True),
            "description": text_field(data.get("description", ""), "experiment description", 5000),
            "sourceUrl": source_url(data.get("sourceUrl", ""), "experiment source URL"),
            "sourceLocation": text_field(data.get("sourceLocation", ""), "experiment source location", 240),
            "algorithmVersion": 1, "config": validator(data.get("config"), "Experiment configuration"),
            "comparisonConfig": None if comparison is None else validator(comparison, "Comparison configuration")}


def validate_experiments(data):
    if not isinstance(data, list) or len(data) > 10:
        raise AppError("experiments must be a list of at most 10 experiments.")
    result = [validate_experiment(item) for item in data]
    if len({item["id"] for item in result}) != len(result):
        raise AppError("Experiment IDs must be unique within a shard.")
    return result


def learning_text(shard, *, include_code=False):
    """Collect prose references; search can additionally opt into literal code."""
    def strings(value):
        if isinstance(value, str):
            yield value
        elif isinstance(value, list):
            for item in value:
                yield from strings(item)
        elif isinstance(value, dict):
            for item in value.values():
                yield from strings(item)
    values = {key: shard.get(key) for key in ("content", "perspectives", "walkthroughs", "comparisons", "learningLog", "verification", "experiments")}
    solution = shard.get("codeSolution", {})
    if isinstance(solution, dict):
        values["codeSolution"] = solution if include_code else {key: value for key, value in solution.items() if key not in ("code", "headers", "id", "approaches")}
        if not include_code:
            approaches = solution.get("approaches", [])
            values["codeSolution"]["approaches"] = [{key: value for key, value in item.items() if key not in ("code", "headers", "id")}
                for item in approaches if isinstance(item, dict)] if isinstance(approaches, list) else []
    return "\n".join(strings(values))


def learning_references(shard):
    references = set(re.findall(r"\[\[id:([A-Za-z0-9][A-Za-z0-9_.:-]{0,99})(?=[|\]])", learning_text(shard)))
    comparisons = shard.get("comparisons", [])
    for comparison in comparisons if isinstance(comparisons, list) else []:
        alternatives = comparison.get("alternatives", []) if isinstance(comparison, dict) else []
        if isinstance(alternatives, list):
            references.update(alternative["shardId"] for alternative in alternatives if isinstance(alternative, dict) and isinstance(alternative.get("shardId"), str))
    return references


def remap_shard_references(shard, aliases):
    """Remap conceptual links in copied explanations while leaving literal code intact."""
    def rewrite(value):
        if isinstance(value, str):
            return "".join(part if index % 2 else re.sub(
                r"(\[\[id:)([A-Za-z0-9][A-Za-z0-9_.:-]{0,99})(?=[|\]])",
                lambda match: match[1] + aliases.get(match[2], match[2]), part)
                for index, part in enumerate(re.split(r"(```[\s\S]*?```|`[^`]+`)", value)))
        if isinstance(value, list):
            return [rewrite(item) for item in value]
        if isinstance(value, dict):
            return {key: aliases.get(item, item) if key == "shardId" and isinstance(item, str) else rewrite(item) for key, item in value.items()}
        return value
    result = dict(shard)
    for key in ("content", "perspectives", "walkthroughs", "comparisons", "learningLog", "verification"):
        if key in shard:
            result[key] = rewrite(shard[key])
    if "codeSolution" in shard:
        # Only prose can contain conceptual references. Source code and headers
        # may contain identical-looking literals that must survive unchanged.
        result["codeSolution"] = dict(shard["codeSolution"])
        for field in ("purpose", "complexityNotes", "assumptions", "pitfalls"):
            if field in shard["codeSolution"]:
                result["codeSolution"][field] = rewrite(shard["codeSolution"][field])
        result["codeSolution"]["approaches"] = [{key: rewrite(value) if key in ("summary", "complexityNotes", "assumptions", "pitfalls") else value
            for key, value in item.items()} for item in shard["codeSolution"].get("approaches", [])]
    return result


def validate_shard(data, *, imported=False, current=None) -> dict:
    if not isinstance(data, dict):
        raise AppError("Each shard must be an object.")
    merged = dict(current or {})
    merged.update(data if imported else {key: value for key, value in data.items() if key in MUTABLE_SHARD_FIELDS})
    stamp = now()
    result = {
        "id": record_id(data.get("id")) if imported else (current["id"] if current else str(uuid.uuid4())),
        "title": text_field(merged.get("title", ""), "title", 240, required=True),
        "content": text_field(merged.get("content", ""), "content", 100_000),
        "prompt": text_field(merged.get("prompt", ""), "prompt", 10_000),
        "tags": validate_tags(merged.get("tags", [])),
        "kind": merged.get("kind", "concept"),
        "status": merged.get("status", "learning"),
        "sourceUrl": text_field(merged.get("sourceUrl", ""), "sourceUrl", 2048),
        "languageVersion": text_field(merged.get("languageVersion", ""), "languageVersion", 100),
        "eventDate": partial_date(merged.get("eventDate", ""), "eventDate"),
        "createdAt": timestamp(merged.get("createdAt", stamp), "createdAt"),
        "updatedAt": timestamp(merged.get("updatedAt", stamp) if imported else stamp, "updatedAt"),
        "reviewCount": merged.get("reviewCount", 0),
        "lastReviewedAt": timestamp(merged.get("lastReviewedAt"), "lastReviewedAt", optional=True),
        "nextReviewAt": timestamp(merged.get("nextReviewAt"), "nextReviewAt", optional=True),
    }
    if not isinstance(result["kind"], str) or result["kind"] not in KINDS:
        raise AppError("Unknown shard kind.")
    if not isinstance(result["status"], str) or result["status"] not in STATUSES:
        raise AppError("Unknown shard status.")
    count = result["reviewCount"]
    if type(count) is not int or count < 0 or count > 1_000_000:
        raise AppError("reviewCount must be a nonnegative integer.")
    result["sourceUrl"] = source_url(result["sourceUrl"])
    result.update(validate_knowledge(merged))
    return result


def coordinate(value, name, *, minimum=-1_000_000, maximum=1_000_000):
    if type(value) not in (int, float) or not math.isfinite(value) or not minimum <= value <= maximum:
        raise AppError(f"{name} must be a finite number between {minimum} and {maximum}.")
    return value


def validate_board(data, *, imported=False, current=None):
    if not isinstance(data, dict):
        raise AppError("Each board must be an object.")
    merged = {**(current or {}), **data}
    stamp = now()
    result = {"id": record_id(data.get("id")) if imported else current["id"] if current else str(uuid.uuid4()),
        "title": text_field(merged.get("title", ""), "title", 240, required=True), "description": text_field(merged.get("description", ""), "description", 20_000),
        "sourceUrl": source_url(merged.get("sourceUrl", "")), "items": [], "sections": [],
        "createdAt": timestamp(merged.get("createdAt", stamp) if imported else current["createdAt"] if current else stamp, "createdAt"), "updatedAt": timestamp(merged.get("updatedAt", stamp) if imported else stamp, "updatedAt")}
    for key, limit in (("items", 20_000), ("sections", 1000)):
        values = merged.get(key, [])
        if not isinstance(values, list) or len(values) > limit:
            raise AppError(f"Board {key} must be a list of at most {limit} records.")
        for value in values:
            if not isinstance(value, dict):
                raise AppError(f"Each board {key} entry must be an object.")
            box = {"x": coordinate(value.get("x", 0), "x"), "y": coordinate(value.get("y", 0), "y"),
                "width": coordinate(value.get("width", 280 if key == "items" else 600), "width", minimum=1, maximum=100_000),
                "height": coordinate(value.get("height", 160 if key == "items" else 400), "height", minimum=1, maximum=100_000)}
            if key == "items":
                section_id = value.get("sectionId", "")
                box.update(shardId=record_id(value.get("shardId"), "shardId"), sectionId=record_id(section_id, "sectionId") if section_id else "")
            else:
                collapsed = value.get("collapsed", False)
                if type(collapsed) is not bool:
                    raise AppError("collapsed must be true or false.")
                shard_id = value.get("shardId", "")
                box.update(id=record_id(value.get("id")), title=text_field(value.get("title", ""), "section title", 240, required=True), collapsed=collapsed,
                    shardId=record_id(shard_id, "section shardId") if shard_id != "" else "")
            result[key].append(box)
        identifier = "shardId" if key == "items" else "id"
        if len({item[identifier] for item in result[key]}) != len(result[key]):
            raise AppError(f"Board {key} cannot contain duplicate IDs.")
    section_ids = {section["id"] for section in result["sections"]}
    if any(item["sectionId"] and item["sectionId"] not in section_ids for item in result["items"]):
        raise AppError("A board item refers to a missing section.")
    viewport = merged.get("viewport", {})
    if not isinstance(viewport, dict):
        raise AppError("viewport must be an object.")
    result["viewport"] = {"x": coordinate(viewport.get("x", 0), "viewport x"), "y": coordinate(viewport.get("y", 0), "viewport y"), "zoom": coordinate(viewport.get("zoom", 1), "zoom", minimum=.005, maximum=10)}
    return result


def validate_link(data, *, imported=False) -> dict:
    if not isinstance(data, dict):
        raise AppError("Each relationship must be an object.")
    result = {
        "id": record_id(data.get("id")) if imported else str(uuid.uuid4()),
        "fromId": record_id(data.get("fromId"), "fromId"),
        "toId": record_id(data.get("toId"), "toId"),
        "type": data.get("type", "related_to"),
        "note": text_field(data.get("note", ""), "note", 2000),
        "createdAt": timestamp(data.get("createdAt", now()) if imported else now(), "createdAt"),
        **{field: record_id(data[field], field) if data.get(field, "") != "" else "" for field in LINK_APPROACH_FIELDS},
    }
    if not isinstance(result["type"], str) or result["type"] not in LINK_TYPES:
        raise AppError("Unknown relationship type.")
    if (result["fromId"] == result["toId"] and not (result["type"] == "alternative_to"
            and result["fromApproachId"] and result["toApproachId"] and result["fromApproachId"] != result["toApproachId"])):
        raise AppError("A relationship must connect two different shards.")
    result.update(validate_link_knowledge(data))
    return canonical_link(result)


def canonical_link(link):
    """Symmetric alternatives are one edge, regardless of creation direction."""
    link = dict(link)
    if link["type"] == "alternative_to" and (link["toId"], link.get("toApproachId", "")) < (link["fromId"], link.get("fromApproachId", "")):
        link["fromId"], link["toId"] = link["toId"], link["fromId"]
        link["fromApproachId"], link["toApproachId"] = link.get("toApproachId", ""), link.get("fromApproachId", "")
    return link


def link_identity(link):
    link = canonical_link(link)
    return (link["fromId"], link["toId"], link["type"], *(link.get(field, "") for field in LINK_APPROACH_FIELDS))


def validate_link_endpoints(link, shards):
    for endpoint, field in (("fromId", "fromApproachId"), ("toId", "toApproachId")):
        shard = shards.get(link[endpoint])
        if shard is None:
            raise AppError("Both relationship endpoints must exist.")
        if link.get(field) and link[field] not in {item["id"] for item in shard.get("codeSolution", {}).get("approaches", [])}:
            raise AppError(f"Relationship {field} refers to a missing solution approach in {shard['title']}. Reopen the connection and choose an existing approach.", 409)


def validate_review(data, *, imported=False) -> dict:
    if not isinstance(data, dict):
        raise AppError("Each review must be an object.")
    grade = data.get("grade")
    if not isinstance(grade, str) or grade not in REVIEW_DAYS:
        raise AppError("grade must be again, hard, good, or easy.")
    reviewed = timestamp(data.get("reviewedAt", now()) if imported else now(), "reviewedAt")
    due = (dt.datetime.fromisoformat(reviewed.replace("Z", "+00:00")) + dt.timedelta(days=REVIEW_DAYS[grade]))
    return {
        "id": record_id(data.get("id")) if imported else str(uuid.uuid4()),
        "shardId": record_id(data.get("shardId"), "shardId"),
        "grade": grade,
        "reviewedAt": reviewed,
        "nextReviewAt": timestamp(data.get("nextReviewAt", due.isoformat()) if imported else due.isoformat(), "nextReviewAt"),
    }


def validate_revision(data, *, imported=False):
    if not isinstance(data, dict):
        raise AppError("Each revision must be an object.")
    shard_id = record_id(data.get("shardId"), "shardId")
    snapshot = validate_shard(data.get("snapshot"), imported=True)
    if snapshot["id"] != shard_id:
        raise AppError("Revision shard ID does not match its snapshot.")
    return {"id": record_id(data.get("id")), "shardId": shard_id,
            "createdAt": timestamp(data.get("createdAt", now()), "createdAt"),
            "reason": text_field(data.get("reason", "imported"), "reason", 100, required=True), "snapshot": snapshot}


def validate_trash(data, *, imported=False):
    if not isinstance(data, dict):
        raise AppError("Each trash item must be an object.")
    shard = validate_shard(data.get("shard"), imported=True)
    result = {"id": record_id(data.get("id")), "deletedAt": timestamp(data.get("deletedAt", now()), "deletedAt"), "shard": shard}
    for key, validator in (("links", validate_link), ("reviews", validate_review)):
        values = data.get(key, [])
        if not isinstance(values, list) or len(values) > MAX_IMPORT_RECORDS:
            raise AppError("Trash relationships and reviews must be bounded lists.")
        result[key] = [validator(item, imported=True) for item in values]
        if len({item["id"] for item in result[key]}) != len(result[key]):
            raise AppError("Trash contains duplicate record IDs.")
    if any(shard["id"] not in (link["fromId"], link["toId"]) for link in result["links"]):
        raise AppError("Trash relationships must belong to the deleted shard.")
    approach_ids = {item["id"] for item in shard["codeSolution"]["approaches"]}
    for link in result["links"]:
        for endpoint, field in (("fromId", "fromApproachId"), ("toId", "toApproachId")):
            if link[endpoint] == shard["id"] and link[field] and link[field] not in approach_ids:
                raise AppError("Trash relationship refers to a missing solution approach in its deleted shard.")
    if any(review["shardId"] != shard["id"] for review in result["reviews"]):
        raise AppError("Trash reviews must belong to the deleted shard.")
    return result


class Store:
    def __init__(self, db_path=DEFAULT_DB, *, root=ROOT, seed=True, seed_path=None, backup_on_start=True, backup_dir=None,
                 automatic_backups=True, backup_interval_seconds=60, backup_poll_seconds=30):
        self.db_path = Path(db_path).expanduser().resolve()
        self.root = Path(root).resolve()
        if backup_dir is not None:
            self.backup_dir = Path(backup_dir).expanduser().resolve()
        elif self.db_path == DEFAULT_DB.expanduser().resolve():
            self.backup_dir = self.root / "backups"
        else:
            self.backup_dir = self.db_path.parent / f"{self.db_path.stem}-backups"
        self.lock = threading.RLock()
        self.backup_error = None
        self.automatic_backups = automatic_backups
        self.backup_interval_seconds = backup_interval_seconds
        self.backup_poll_seconds = backup_poll_seconds
        self._last_backup_time = 0
        self._dirty = False
        self._backup_stop = threading.Event()
        self._backup_thread = None
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        if self.db_path.exists() and self.db_path.stat().st_size:
            with self.connect() as connection:
                previous_version = connection.execute("PRAGMA user_version").fetchone()[0]
            if 0 < previous_version < DATABASE_VERSION:
                try:
                    self.backup()
                except (OSError, sqlite3.Error) as error:
                    raise AppError("Database upgrade was not applied because its safety snapshot could not be created.", 500) from error
        seed_file = Path(seed_path) if seed_path else self.root / "seed.json"
        with self.connect() as connection:
            version = connection.execute("PRAGMA user_version").fetchone()[0]
            if version > DATABASE_VERSION:
                raise AppError("This database was created by a newer Shard Atlas version.", 500)
            connection.executescript("""
                CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS shards (
                    id TEXT PRIMARY KEY,
                    title TEXT NOT NULL CHECK(length(trim(title)) > 0),
                    content TEXT NOT NULL,
                    prompt TEXT NOT NULL,
                    tags TEXT NOT NULL,
                    kind TEXT NOT NULL CHECK(kind IN ('concept','fact','example','mistake','event','idea')),
                    status TEXT NOT NULL CHECK(status IN ('learning','solid','verify')),
                    source_url TEXT NOT NULL,
                    language_version TEXT NOT NULL,
                    event_date TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    review_count INTEGER NOT NULL CHECK(review_count >= 0),
                    last_reviewed_at TEXT,
                    next_review_at TEXT
                );
                CREATE TABLE IF NOT EXISTS links (
                    id TEXT PRIMARY KEY,
                    from_id TEXT NOT NULL REFERENCES shards(id) ON DELETE CASCADE,
                    to_id TEXT NOT NULL REFERENCES shards(id) ON DELETE CASCADE,
                    type TEXT NOT NULL CHECK(type IN ('depends_on','explains','contrasts_with','example_of','related_to')),
                    note TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    CHECK(from_id <> to_id),
                    UNIQUE(from_id, to_id, type)
                );
                CREATE TABLE IF NOT EXISTS reviews (
                    id TEXT PRIMARY KEY,
                    shard_id TEXT NOT NULL REFERENCES shards(id) ON DELETE CASCADE,
                    grade TEXT NOT NULL CHECK(grade IN ('again','hard','good','easy')),
                    reviewed_at TEXT NOT NULL,
                    next_review_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS links_from ON links(from_id);
                CREATE INDEX IF NOT EXISTS links_to ON links(to_id);
                CREATE INDEX IF NOT EXISTS reviews_shard ON reviews(shard_id);
                CREATE INDEX IF NOT EXISTS shards_due ON shards(next_review_at);
                CREATE TABLE IF NOT EXISTS revisions (
                    id TEXT PRIMARY KEY, shard_id TEXT NOT NULL,
                    created_at TEXT NOT NULL, reason TEXT NOT NULL, snapshot TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS revisions_shard ON revisions(shard_id);
                CREATE TABLE IF NOT EXISTS trash (
                    id TEXT PRIMARY KEY, deleted_at TEXT NOT NULL, payload TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS assets (
                    id TEXT PRIMARY KEY, name TEXT NOT NULL, mime_type TEXT NOT NULL,
                    data BLOB NOT NULL, created_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS drafts (kind TEXT PRIMARY KEY, payload TEXT NOT NULL);
            """)
            self._migrate_workspaces(connection)
            first_initialization = connection.execute("SELECT value FROM metadata WHERE key='initialized'").fetchone() is None
            if first_initialization:
                if seed and seed_file.exists():
                    try:
                        payload = json.loads(seed_file.read_text(encoding="utf-8"))
                    except (OSError, ValueError) as error:
                        raise AppError(f"Could not read starter shards: {error}", 500) from error
                    normalized = self._validate_import(payload, connection)
                    self._merge(normalized, connection)
                connection.execute("INSERT INTO metadata(key, value) VALUES('initialized','1')")
            connection.execute("INSERT OR REPLACE INTO metadata(key,value) VALUES('schema_version',?)", (str(SCHEMA_VERSION),))
            connection.execute(f"PRAGMA user_version={DATABASE_VERSION}")
            for shard in self._state(connection)["shards"]:
                if connection.execute("SELECT 1 FROM revisions WHERE shard_id=?", (shard["id"],)).fetchone() is None:
                    self._record_revision(connection, shard, "initial")
        if backup_on_start:
            try:
                today = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%d")
                if not self.backup_dir.exists() or not any(self.backup_dir.glob(f"shards-{today}-*.sqlite3")):
                    self.backup()
            except (OSError, sqlite3.Error) as error:
                self.backup_error = f"Startup backup failed: {error}"

    @contextmanager
    def changing(self):
        with self.lock:
            with self.connect() as connection:
                previous_budget = self._archive_budget(connection)
                yield connection
                next_budget = self._archive_budget(connection)
                limits = (MAX_ARCHIVE_BYTES, MAX_TOTAL_ASSET_BYTES, 2048)
                if any(after > limit and after > before for before, after, limit in zip(previous_budget, next_budget, limits)):
                    raise AppError("This change would exceed the complete archive capacity (256 MB, including images and saved versions). Nothing was saved. Use smaller attachments to keep the collection portable.", 413)
            self._dirty = True
            self.backup_tick()

    @staticmethod
    def _archive_budget(connection):
        # Base64 strings contain no JSON escapes. Count their exact encoded lengths
        # without reading and encoding every image twice for an ordinary note edit.
        archive = Store._archive(connection, include_asset_data=False)
        image_bytes = connection.execute("SELECT coalesce(sum(length(data)),0),count(*),coalesce(sum(4*((length(data)+2)/3)),0) FROM assets").fetchone()
        receipt_bytes = connection.execute("SELECT coalesce(sum(length(CAST(payload AS BLOB))),0) FROM imports").fetchone()[0]
        return len(json.dumps(archive, ensure_ascii=False, indent=2).encode("utf-8")) + image_bytes[2] + receipt_bytes, image_bytes[0], image_bytes[1]

    def backup_tick(self):
        if not self.automatic_backups:
            return
        with self.lock:
            if self._dirty and time.monotonic() - self._last_backup_time >= self.backup_interval_seconds:
                try:
                    self.backup()
                except (OSError, sqlite3.Error):
                    pass

    def start_backup_worker(self):
        if not self.automatic_backups or self._backup_thread is not None:
            return
        self._backup_stop.clear()
        def work():
            while not self._backup_stop.wait(self.backup_poll_seconds):
                self.backup_tick()
        self._backup_thread = threading.Thread(target=work, name="shard-atlas-backups", daemon=True)
        self._backup_thread.start()

    def stop_backup_worker(self):
        self._backup_stop.set()
        if self._backup_thread:
            self._backup_thread.join(timeout=2)
            self._backup_thread = None
        with self.lock:
            if self.automatic_backups and self._dirty:
                try:
                    self.backup()
                except (OSError, sqlite3.Error):
                    pass

    @contextmanager
    def connect(self):
        connection = sqlite3.connect(self.db_path, timeout=15)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys=ON")
        connection.execute("PRAGMA busy_timeout=15000")
        try:
            with connection:
                yield connection
        finally:
            connection.close()

    @staticmethod
    def _state(connection) -> dict:
        tables = {row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        shards = []
        for row in connection.execute("SELECT * FROM shards ORDER BY created_at, id"):
            shards.append({
                "id": row["id"], "title": row["title"], "content": row["content"],
                "prompt": row["prompt"], "tags": json.loads(row["tags"]),
                "kind": row["kind"], "status": row["status"], "sourceUrl": row["source_url"],
                "languageVersion": row["language_version"], "eventDate": row["event_date"],
                "createdAt": row["created_at"], "updatedAt": row["updated_at"],
                "reviewCount": row["review_count"], "lastReviewedAt": row["last_reviewed_at"],
                "nextReviewAt": row["next_review_at"],
                **validate_knowledge(json.loads(row["knowledge"]) if "knowledge" in row.keys() else {}),
            })
        links = [{
            "id": row["id"], "fromId": row["from_id"], "toId": row["to_id"],
            "type": row["type"], "note": row["note"], "createdAt": row["created_at"],
            **validate_link_knowledge(json.loads(row["knowledge"]) if "knowledge" in row.keys() else {}),
            "fromApproachId": row["from_approach_id"] if "from_approach_id" in row.keys() else "",
            "toApproachId": row["to_approach_id"] if "to_approach_id" in row.keys() else "",
        } for row in connection.execute("SELECT * FROM links ORDER BY created_at, id")]
        reviews = [{
            "id": row["id"], "shardId": row["shard_id"], "grade": row["grade"],
            "reviewedAt": row["reviewed_at"], "nextReviewAt": row["next_review_at"],
        } for row in connection.execute("SELECT * FROM reviews ORDER BY reviewed_at, rowid")]
        boards = [json.loads(row[0]) for row in connection.execute("SELECT payload FROM boards ORDER BY rowid")] if "boards" in tables else []
        return {"schemaVersion": SCHEMA_VERSION, "shards": shards, "links": links, "reviews": reviews, "boards": boards}

    @staticmethod
    def _migrate_workspaces(connection):
        """Idempotent migration also used when restoring older safety snapshots."""
        connection.execute("SAVEPOINT workspace_upgrade")
        try:
            columns = {row[1] for row in connection.execute("PRAGMA table_info(shards)")}
            if "knowledge" not in columns:
                connection.execute("ALTER TABLE shards ADD COLUMN knowledge TEXT NOT NULL DEFAULT '{}'")
            sql = connection.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name='links'").fetchone()[0]
            if "alternative_to" not in sql or "from_approach_id" not in sql:
                link_columns = {row[1] for row in connection.execute("PRAGMA table_info(links)")}
                connection.execute("""CREATE TABLE links_workspace_upgrade (
                    id TEXT PRIMARY KEY, from_id TEXT NOT NULL REFERENCES shards(id) ON DELETE CASCADE,
                    to_id TEXT NOT NULL REFERENCES shards(id) ON DELETE CASCADE,
                    type TEXT NOT NULL CHECK(type IN ('depends_on','explains','contrasts_with','example_of','related_to','part_of','supports','contradicts','supersedes','released_by','uses','implements','alternative_to')),
                    note TEXT NOT NULL, created_at TEXT NOT NULL, knowledge TEXT NOT NULL DEFAULT '{}',
                    from_approach_id TEXT NOT NULL DEFAULT '', to_approach_id TEXT NOT NULL DEFAULT '',
                    CHECK(from_id <> to_id OR (type='alternative_to' AND from_approach_id <> '' AND to_approach_id <> '' AND from_approach_id <> to_approach_id)),
                    UNIQUE(from_id,to_id,type,from_approach_id,to_approach_id)
                )""")
                knowledge_sql = "knowledge" if "knowledge" in link_columns else "'{}'"
                approach_sql = ",from_approach_id,to_approach_id" if "from_approach_id" in link_columns else ",'',''"
                connection.execute("INSERT INTO links_workspace_upgrade SELECT id,from_id,to_id,type,note,created_at," + knowledge_sql + approach_sql + " FROM links")
                connection.execute("DROP TABLE links")
                connection.execute("ALTER TABLE links_workspace_upgrade RENAME TO links")
                connection.execute("CREATE INDEX links_from ON links(from_id)")
                connection.execute("CREATE INDEX links_to ON links(to_id)")
            if "knowledge" not in {row[1] for row in connection.execute("PRAGMA table_info(links)")}:
                connection.execute("ALTER TABLE links ADD COLUMN knowledge TEXT NOT NULL DEFAULT '{}'")
            connection.execute("CREATE TABLE IF NOT EXISTS boards (id TEXT PRIMARY KEY,payload TEXT NOT NULL)")
            connection.execute("CREATE TABLE IF NOT EXISTS imports (id TEXT PRIMARY KEY,created_at TEXT NOT NULL,payload TEXT NOT NULL)")
            if connection.execute("PRAGMA foreign_key_check").fetchall():
                raise AppError("Database upgrade detected broken relationships. The existing collection was preserved.", 500)
        except Exception:
            connection.execute("ROLLBACK TO workspace_upgrade")
            connection.execute("RELEASE workspace_upgrade")
            raise
        connection.execute("RELEASE workspace_upgrade")

    def state(self):
        with self.lock, self.connect() as connection:
            connection.execute("BEGIN")
            return self._state(connection)

    @staticmethod
    def _record_revision(connection, shard, reason):
        connection.execute("INSERT INTO revisions VALUES(?,?,?,?,?)", (
            str(uuid.uuid4()), shard["id"], now(), reason, json.dumps(shard, ensure_ascii=False),
        ))

    @staticmethod
    def _archive(connection, *, include_asset_data=True):
        state = Store._state(connection)
        state["assets"] = [{"id": row["id"], "name": row["name"], "mimeType": row["mime_type"],
            "data": base64.b64encode(row["data"]).decode("ascii") if include_asset_data else "", "size": len(row["data"]) if include_asset_data else row["size"], "createdAt": row["created_at"]}
            for row in connection.execute("SELECT * FROM assets ORDER BY created_at,rowid" if include_asset_data else "SELECT id,name,mime_type,length(data) AS size,created_at FROM assets ORDER BY created_at,rowid")]
        state["revisions"] = [{"id": row["id"], "shardId": row["shard_id"], "createdAt": row["created_at"],
            "reason": row["reason"], "snapshot": json.loads(row["snapshot"])}
            for row in connection.execute("SELECT * FROM revisions ORDER BY created_at,rowid")]
        state["trash"] = [{"id": row["id"], "deletedAt": row["deleted_at"], **json.loads(row["payload"])}
            for row in connection.execute("SELECT * FROM trash ORDER BY deleted_at,rowid")]
        return state

    def export_data(self):
        with self.lock, self.connect() as connection:
            connection.execute("BEGIN")
            return self._archive(connection)

    @staticmethod
    def _insert_shard(connection, shard):
        connection.execute("""INSERT INTO shards VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""", (
            shard["id"], shard["title"], shard["content"], shard["prompt"],
            json.dumps(shard["tags"], ensure_ascii=False), shard["kind"], shard["status"],
            shard["sourceUrl"], shard["languageVersion"], shard["eventDate"],
            shard["createdAt"], shard["updatedAt"], shard["reviewCount"],
            shard["lastReviewedAt"], shard["nextReviewAt"],
            json.dumps(validate_knowledge(shard), ensure_ascii=False),
        ))

    @staticmethod
    def _insert_link(connection, link):
        connection.execute("INSERT INTO links(id,from_id,to_id,type,note,created_at,knowledge,from_approach_id,to_approach_id) VALUES(?,?,?,?,?,?,?,?,?)", (
            link["id"], link["fromId"], link["toId"], link["type"], link["note"], link["createdAt"],
            json.dumps(validate_link_knowledge(link), ensure_ascii=False),
            link.get("fromApproachId", ""), link.get("toApproachId", ""),
        ))

    @staticmethod
    def _insert_review(connection, review):
        connection.execute("INSERT INTO reviews VALUES(?,?,?,?,?)", (
            review["id"], review["shardId"], review["grade"], review["reviewedAt"], review["nextReviewAt"],
        ))

    def create_shard(self, data):
        shard = validate_shard(data)
        with self.changing() as connection:
            self._insert_shard(connection, shard)
            self._record_revision(connection, shard, "created")
            connection.execute("DELETE FROM drafts WHERE kind='editor'")
            return self._state(connection)

    @staticmethod
    def _protect_approach_references(connection, shard):
        approach_ids = {item["id"] for item in shard["codeSolution"]["approaches"]}
        links = [{"fromId": row["from_id"], "toId": row["to_id"], "fromApproachId": row["from_approach_id"], "toApproachId": row["to_approach_id"]}
            for row in connection.execute("SELECT from_id,to_id,from_approach_id,to_approach_id FROM links WHERE from_id=? OR to_id=?", (shard["id"], shard["id"]))]
        for row in connection.execute("SELECT payload FROM trash"):
            links.extend(json.loads(row[0]).get("links", []))
        for link in links:
            for endpoint, field in (("fromId", "fromApproachId"), ("toId", "toApproachId")):
                if link[endpoint] == shard["id"] and link.get(field) and link[field] not in approach_ids:
                    raise AppError("This change would remove a solution approach used by a saved connection. Keep the approach, or restore connected shards from Trash and remove those connections before deleting it. Existing knowledge was preserved.", 409)

    def update_shard(self, shard_id, data):
        record_id(shard_id)
        with self.changing() as connection:
            connection.execute("BEGIN IMMEDIATE")
            current = next((shard for shard in self._state(connection)["shards"] if shard["id"] == shard_id), None)
            if current is None:
                raise AppError("Shard not found.", 404)
            shard = validate_shard(data, current=current)
            self._protect_approach_references(connection, shard)
            connection.execute("""UPDATE shards SET title=?,content=?,prompt=?,tags=?,kind=?,status=?,
                source_url=?,language_version=?,event_date=?,updated_at=?,knowledge=? WHERE id=?""", (
                shard["title"], shard["content"], shard["prompt"], json.dumps(shard["tags"], ensure_ascii=False),
                shard["kind"], shard["status"], shard["sourceUrl"], shard["languageVersion"],
                shard["eventDate"], shard["updatedAt"], json.dumps(validate_knowledge(shard), ensure_ascii=False), shard_id,
            ))
            self._record_revision(connection, shard, "edited")
            connection.execute("DELETE FROM drafts WHERE kind='editor'")
            return self._state(connection)

    def update_experiment(self, shard_id, experiment_id, data):
        record_id(shard_id)
        record_id(experiment_id, "experiment id")
        if not isinstance(data, dict) or set(data) != {"experiment"}:
            raise AppError("An experiment update contains only an experiment object.")
        experiment = validate_experiment(data["experiment"])
        if experiment["id"] != experiment_id:
            raise AppError("The experiment ID must match the experiment being updated.")
        with self.changing() as connection:
            # Separate app windows and helper services may use independent Store
            # locks. Acquire the SQLite write lock before reading the latest row.
            connection.execute("BEGIN IMMEDIATE")
            current = next((item for item in self._state(connection)["shards"] if item["id"] == shard_id), None)
            if current is None:
                raise AppError("Shard not found.", 404)
            index = next((index for index, item in enumerate(current["experiments"]) if item["id"] == experiment_id), None)
            if index is None:
                raise AppError("Experiment not found. Reopen the shard before saving this configuration.", 404)
            experiments = list(current["experiments"])
            experiments[index] = experiment
            shard = validate_shard({"experiments": experiments}, current=current)
            snapshots = connection.execute("SELECT snapshot FROM revisions WHERE shard_id=?", (shard_id,)).fetchall()
            if not any(all(snapshot[field] == current[field] for field in MUTABLE_SHARD_FIELDS)
                       for snapshot in (validate_shard(json.loads(row[0]), imported=True) for row in snapshots)):
                self._record_revision(connection, current, "before experiment update")
            connection.execute("UPDATE shards SET updated_at=?,knowledge=? WHERE id=?", (
                shard["updatedAt"], json.dumps(validate_knowledge(shard), ensure_ascii=False), shard_id))
            self._record_revision(connection, shard, "experiment configuration updated")
            return self._state(connection)

    def delete_shard(self, shard_id):
        record_id(shard_id)
        with self.lock:
            with self.connect() as connection:
                if connection.execute("SELECT 1 FROM shards WHERE id=?", (shard_id,)).fetchone() is None:
                    raise AppError("Shard not found.", 404)
            try:
                self.backup()
            except (OSError, sqlite3.Error) as error:
                raise AppError("The shard was not deleted because its safety backup could not be created.", 500) from error
            with self.changing() as connection:
                connection.execute("BEGIN IMMEDIATE")
                state = self._state(connection)
                shard = next((item for item in state["shards"] if item["id"] == shard_id), None)
                if shard is None:
                    raise AppError("Shard not found.", 404)
                payload = {"shard": shard, "links": [item for item in state["links"] if shard_id in (item["fromId"], item["toId"])],
                           "reviews": [item for item in state["reviews"] if item["shardId"] == shard_id]}
                connection.execute("INSERT INTO trash VALUES(?,?,?)", (str(uuid.uuid4()), now(), json.dumps(payload, ensure_ascii=False)))
                connection.execute("DELETE FROM shards WHERE id=?", (shard_id,))
                return self._state(connection)

    def create_link(self, data):
        link = validate_link(data)
        with self.changing() as connection:
            connection.execute("BEGIN IMMEDIATE")
            validate_link_endpoints(link, {item["id"]: item for item in self._state(connection)["shards"]})
            try:
                self._insert_link(connection, link)
            except sqlite3.IntegrityError:
                raise AppError("This relationship already exists.", 409) from None
            connection.execute("DELETE FROM drafts WHERE kind='connection'")
            return self._state(connection)

    def delete_link(self, link_id):
        record_id(link_id)
        with self.changing() as connection:
            if connection.execute("DELETE FROM links WHERE id=?", (link_id,)).rowcount == 0:
                raise AppError("Relationship not found.", 404)
            return self._state(connection)

    def update_link(self, link_id, data):
        record_id(link_id)
        if not isinstance(data, dict):
            raise AppError("Relationship changes must be an object.")
        with self.changing() as connection:
            connection.execute("BEGIN IMMEDIATE")
            current = next((item for item in self._state(connection)["links"] if item["id"] == link_id), None)
            if current is None:
                raise AppError("Relationship not found.", 404)
            link = validate_link({**current, **{key: value for key, value in data.items() if key in {"fromId", "toId", "type", "note"} | set(LINK_KNOWLEDGE_DEFAULTS) | set(LINK_APPROACH_FIELDS)}}, imported=True)
            validate_link_endpoints(link, {item["id"]: item for item in self._state(connection)["shards"]})
            try:
                connection.execute("UPDATE links SET from_id=?,to_id=?,type=?,note=?,knowledge=?,from_approach_id=?,to_approach_id=? WHERE id=?", (link["fromId"], link["toId"], link["type"], link["note"], json.dumps(validate_link_knowledge(link), ensure_ascii=False), link["fromApproachId"], link["toApproachId"], link_id))
            except sqlite3.IntegrityError:
                raise AppError("This relationship already exists.", 409) from None
            connection.execute("DELETE FROM drafts WHERE kind='connection'")
            return self._state(connection)

    def rename_tag(self, data):
        source = text_field(data.get("from", ""), "from", 80, required=True).strip()
        target = text_field(data.get("to", ""), "to", 80, required=True).strip()
        with self.changing() as connection:
            for shard in self._state(connection)["shards"]:
                if source not in shard["tags"] or source == target:
                    continue
                tags = list(dict.fromkeys(target if tag == source else tag for tag in shard["tags"]))
                shard["tags"] = tags
                shard["updatedAt"] = now()
                connection.execute("UPDATE shards SET tags=?,updated_at=? WHERE id=?", (json.dumps(tags, ensure_ascii=False), shard["updatedAt"], shard["id"]))
                self._record_revision(connection, shard, "topic renamed")
            return self._state(connection)

    def revisions(self, shard_id):
        record_id(shard_id)
        with self.lock, self.connect() as connection:
            return {"revisions": [{"id": row["id"], "shardId": row["shard_id"], "createdAt": row["created_at"],
                "reason": row["reason"], "snapshot": json.loads(row["snapshot"])}
                for row in connection.execute("SELECT * FROM revisions WHERE shard_id=? ORDER BY created_at DESC,rowid DESC", (shard_id,))]}

    def restore_revision(self, shard_id, data):
        record_id(shard_id)
        revision_id = record_id(data.get("revisionId"), "revisionId")
        with self.changing() as connection:
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute("SELECT snapshot FROM revisions WHERE id=? AND shard_id=?", (revision_id, shard_id)).fetchone()
            if row is None:
                raise AppError("Revision not found.", 404)
            current = next((item for item in self._state(connection)["shards"] if item["id"] == shard_id), None)
            if current is None:
                raise AppError("Restore the shard from trash before restoring a revision.", 409)
            snapshot = validate_shard(json.loads(row[0]), current=current)
            self._protect_approach_references(connection, snapshot)
            connection.execute("""UPDATE shards SET title=?,content=?,prompt=?,tags=?,kind=?,status=?,source_url=?,
                language_version=?,event_date=?,updated_at=?,knowledge=? WHERE id=?""", (
                snapshot["title"], snapshot["content"], snapshot["prompt"], json.dumps(snapshot["tags"], ensure_ascii=False),
                snapshot["kind"], snapshot["status"], snapshot["sourceUrl"], snapshot["languageVersion"], snapshot["eventDate"], snapshot["updatedAt"], json.dumps(validate_knowledge(snapshot), ensure_ascii=False), shard_id,
            ))
            self._record_revision(connection, snapshot, "revision restored")
            return self._state(connection)

    def trash(self):
        with self.lock, self.connect() as connection:
            return {"trash": [{"id": row["id"], "deletedAt": row["deleted_at"], **json.loads(row["payload"])}
                for row in connection.execute("SELECT * FROM trash ORDER BY deleted_at DESC,rowid DESC")]}

    def restore_trash(self, trash_id):
        record_id(trash_id)
        with self.changing() as connection:
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute("SELECT payload FROM trash WHERE id=?", (trash_id,)).fetchone()
            if row is None:
                raise AppError("Trash item not found.", 404)
            payload = json.loads(row[0])
            shard = validate_shard(payload["shard"], imported=True)
            if connection.execute("SELECT 1 FROM shards WHERE id=?", (shard["id"],)).fetchone():
                raise AppError("A shard with this ID already exists. Existing content was preserved.", 409)
            self._insert_shard(connection, shard)
            shards = {item["id"]: item for item in self._state(connection)["shards"]}
            ids = set(shards)
            existing_links = self._state(connection)["links"]
            restored_links = skipped_links = 0
            for raw_link in payload["links"]:
                link = validate_link(raw_link, imported=True)
                if link["fromId"] in ids and link["toId"] in ids:
                    try:
                        validate_link_endpoints(link, shards)
                    except AppError as error:
                        raise AppError("Restore was not applied; the shard and its connections remain in Trash. " + str(error), 409) from error
                    if not any(item["id"] == link["id"] or link_identity(item) == link_identity(link) for item in existing_links):
                        self._insert_link(connection, link)
                        existing_links.append(link)
                        restored_links += 1
                    else:
                        skipped_links += 1
                else:
                    skipped_links += 1
                    for other in connection.execute("SELECT id,payload FROM trash WHERE id<>?", (trash_id,)).fetchall():
                        other_payload = json.loads(other["payload"])
                        if other_payload["shard"]["id"] in (link["fromId"], link["toId"]) and not any(item["id"] == link["id"] for item in other_payload["links"]):
                            other_payload["links"].append(link)
                            connection.execute("UPDATE trash SET payload=? WHERE id=?", (json.dumps(other_payload, ensure_ascii=False), other["id"]))
            for review in payload["reviews"]:
                if not connection.execute("SELECT 1 FROM reviews WHERE id=?", (review["id"],)).fetchone():
                    self._insert_review(connection, review)
            connection.execute("DELETE FROM trash WHERE id=?", (trash_id,))
            self._record_revision(connection, shard, "restored from trash")
            state = self._state(connection)
            state["restoreSummary"] = {"restoredLinks": restored_links, "skippedLinks": skipped_links}
            return state

    def create_asset(self, data):
        asset = validate_asset(data)
        with self.changing() as connection:
            connection.execute("INSERT INTO assets VALUES(?,?,?,?,?)", (asset["id"], asset["name"], asset["mimeType"], base64.b64decode(asset["data"]), asset["createdAt"]))
        return {key: value for key, value in {**asset, "url": "/assets/" + asset["id"]}.items() if key != "data"}

    def asset(self, asset_id):
        record_id(asset_id)
        with self.lock, self.connect() as connection:
            row = connection.execute("SELECT data,mime_type FROM assets WHERE id=?", (asset_id,)).fetchone()
            if row is None:
                raise AppError("Image not found.", 404)
            return bytes(row["data"]), row["mime_type"]

    def image_text(self, asset_id):
        raw, mime = self.asset(asset_id)
        executable = next((path for path in (self.root / "image-text", self.root / "desktop/.build/image-text", ROOT / "desktop/.build/image-text") if path.is_file()), None)
        source = self.root / "desktop/ImageText.swift"
        if not source.exists():
            source = ROOT / "desktop/ImageText.swift"
        command = [str(executable)] if executable else ["/usr/bin/swift", str(source)] if sys.platform == "darwin" and source.is_file() and Path("/usr/bin/swift").is_file() else None
        if command is None:
            return {"text": "", "available": False, "method": "unavailable", "warnings": ["Local image text recognition is unavailable. You can paste a transcription while retaining the original image."]}
        extension = {"image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif", "image/webp": ".webp"}[mime]
        try:
            with tempfile.TemporaryDirectory(prefix="shard-atlas-image-text-") as directory:
                path = Path(directory) / ("source" + extension)
                path.write_bytes(raw)
                result = subprocess.run([*command, str(path)], capture_output=True, text=True, timeout=30, check=False)
            if result.returncode or len(result.stdout) > 2 * 1024 * 1024:
                raise ValueError("Image text recognition failed")
            parsed = json.loads(result.stdout)
            if not isinstance(parsed, dict) or not isinstance(parsed.get("text"), str):
                raise ValueError("Invalid image text result")
            text = parsed["text"]
            warnings = ["Review recognized text against the original image before saving; names and numbers may need correction."]
            if len(text) > 100_000:
                text = text[:100_000]
                warnings.append("Recognized text exceeds the note limit; the first 100,000 characters are shown and the full original image is retained.")
            return {"text": text, "available": True, "method": "apple-vision", "warnings": warnings}
        except (OSError, ValueError, subprocess.TimeoutExpired):
            return {"text": "", "available": False, "method": "apple-vision", "warnings": ["Local image recognition could not finish. The original image remains saved; paste text manually or try again."]}

    def drafts(self):
        with self.lock, self.connect() as connection:
            drafts = {"editor": None, "connection": None}
            for row in connection.execute("SELECT kind,payload FROM drafts"):
                drafts[row["kind"]] = json.loads(row["payload"])
            return {"drafts": drafts}

    def save_draft(self, kind, data):
        if kind not in ("editor", "connection"):
            raise AppError("Unknown draft kind.")
        draft = data.get("draft")
        if not isinstance(draft, dict):
            raise AppError("Draft must be an object.")
        encoded = json.dumps(draft, ensure_ascii=False, allow_nan=False)
        if len(encoded.encode("utf-8")) > MAX_DRAFT_BYTES:
            raise AppError("Draft is too large (maximum 8 MB).", 413)
        with self.lock, self.connect() as connection:
            connection.execute("INSERT OR REPLACE INTO drafts VALUES(?,?)", (kind, encoded))
        return {"ok": True}

    def delete_draft(self, kind):
        if kind not in ("editor", "connection"):
            raise AppError("Unknown draft kind.")
        with self.lock, self.connect() as connection:
            connection.execute("DELETE FROM drafts WHERE kind=?", (kind,))
        return {"ok": True}

    def create_review(self, data):
        with self.changing() as connection:
            review = validate_review(data)
            if connection.execute("SELECT 1 FROM shards WHERE id=?", (review["shardId"],)).fetchone() is None:
                raise AppError("Shard not found.", 404)
            self._insert_review(connection, review)
            connection.execute("""UPDATE shards SET review_count=review_count+1,last_reviewed_at=?,
                next_review_at=?,updated_at=? WHERE id=?""", (
                review["reviewedAt"], review["nextReviewAt"], review["reviewedAt"], review["shardId"],
            ))
            return self._state(connection)

    def create_board(self, data):
        board = validate_board(data)
        with self.changing() as connection:
            self._check_board_shards(connection, board)
            connection.execute("INSERT INTO boards VALUES(?,?)", (board["id"], json.dumps(board, ensure_ascii=False)))
            state = self._state(connection)
            state["boardId"] = board["id"]
            return state

    @staticmethod
    def _check_board_shards(connection, board, current=None):
        ids = {row[0] for row in connection.execute("SELECT id FROM shards")}
        # Deleted notes stay on existing boards so restoring from Trash recovers their position.
        previous = {item["shardId"] for item in (current or {}).get("items", [])} | {section["shardId"] for section in (current or {}).get("sections", []) if section.get("shardId")}
        references = {item["shardId"] for item in board["items"]} | {section["shardId"] for section in board["sections"] if section.get("shardId")}
        if any(identifier not in ids and identifier not in previous for identifier in references):
            raise AppError("A board item refers to a missing shard. Restore that note from Trash first.")

    def update_board(self, board_id, data):
        record_id(board_id)
        with self.changing() as connection:
            row = connection.execute("SELECT payload FROM boards WHERE id=?", (board_id,)).fetchone()
            if row is None:
                raise AppError("Board not found.", 404)
            current = json.loads(row[0])
            board = validate_board(data, current=current)
            self._check_board_shards(connection, board, current)
            connection.execute("UPDATE boards SET payload=? WHERE id=?", (json.dumps(board, ensure_ascii=False), board_id))
            return self._state(connection)

    def delete_board(self, board_id):
        record_id(board_id)
        with self.lock:
            with self.connect() as connection:
                if not connection.execute("SELECT 1 FROM boards WHERE id=?", (board_id,)).fetchone():
                    raise AppError("Board not found.", 404)
            try:
                self.backup()
            except (OSError, sqlite3.Error) as error:
                raise AppError("The board was not deleted because its safety snapshot could not be created.", 500) from error
            with self.changing() as connection:
                connection.execute("DELETE FROM boards WHERE id=?", (board_id,))
                return self._state(connection)

    def _validate_import(self, payload, connection):
        if not isinstance(payload, dict) or type(payload.get("schemaVersion")) is not int or payload["schemaVersion"] != SCHEMA_VERSION:
            raise AppError("Import must contain schemaVersion: 1.")
        try:
            payload_bytes = len(json.dumps(payload, ensure_ascii=False, allow_nan=False).encode("utf-8"))
        except (TypeError, ValueError, RecursionError):
            raise AppError("Archives must contain valid finite JSON values.") from None
        if payload_bytes > MAX_ARCHIVE_BYTES:
            raise AppError("Archives must be at most 256 MB.", 413)
        normalized = {"schemaVersion": SCHEMA_VERSION}
        validators = {"shards": validate_shard, "links": validate_link, "reviews": validate_review,
                      "assets": validate_asset, "revisions": validate_revision, "trash": validate_trash, "boards": validate_board}
        for key, validator in validators.items():
            items = payload.get(key, [])
            if not isinstance(items, list) or len(items) > MAX_IMPORT_RECORDS:
                raise AppError(f"{key} must be a list of at most {MAX_IMPORT_RECORDS:,} records.")
            normalized[key] = [validator(item, imported=True) for item in items]
            ids = [item["id"] for item in normalized[key]]
            if len(set(ids)) != len(ids):
                raise AppError(f"Import contains duplicate IDs in {key}.")
        if len(normalized["assets"]) > 2048 or sum(asset["size"] for asset in normalized["assets"]) > MAX_TOTAL_ASSET_BYTES:
            raise AppError("An archive can contain at most 2,048 images totaling at most 96 MB.", 413)
        current = self._state(connection)
        # Existing IDs win during merge; validate references against the content
        # that will actually be saved, rather than an ignored incoming snapshot.
        shards = {shard["id"]: shard for shard in normalized["shards"] + current["shards"]}
        shard_ids = set(shards)
        link_ids = {link["id"] for link in current["links"]}
        triples = {link_identity(link) for link in current["links"]}
        for link in normalized["links"]:
            if link["fromId"] not in shard_ids or link["toId"] not in shard_ids:
                raise AppError("Import contains a relationship with a missing shard.")
            validate_link_endpoints(link, shards)
            if link["id"] not in link_ids:
                triple = link_identity(link)
                if triple in triples:
                    raise AppError("Import contains a duplicate relationship with a different ID.", 409)
                triples.add(triple)
        for review in normalized["reviews"]:
            if review["shardId"] not in shard_ids:
                raise AppError("Import contains a review with a missing shard.")
        stored_trash = [json.loads(row[0]) for row in connection.execute("SELECT payload FROM trash")]
        trash_shards = {item["shard"]["id"] for item in stored_trash}
        if any(shard["id"] in trash_shards and shard["id"] not in {item["id"] for item in current["shards"]} for shard in normalized["shards"]):
            raise AppError("An incoming note is already in Trash. Restore it first to avoid unintentionally recreating deleted knowledge.", 409)
        trash_shards.update(item["shard"]["id"] for item in normalized["trash"])
        known_shards = shard_ids | trash_shards
        for revision in normalized["revisions"]:
            if revision["shardId"] not in known_shards:
                raise AppError("Import contains a revision with a missing shard.")
        recovery_shards = {entry["shard"]["id"]: entry["shard"] for entry in stored_trash + normalized["trash"]}
        recovery_shards.update(shards)
        for item in normalized["trash"]:
            if any(link["fromId"] not in known_shards or link["toId"] not in known_shards for link in item["links"]):
                raise AppError("Import contains a trash relationship with a missing shard.")
            preserved_shard = recovery_shards[item["shard"]["id"]]
            recovery_shards[item["shard"]["id"]] = item["shard"]
            for link in item["links"]:
                validate_link_endpoints(link, recovery_shards)
            recovery_shards[item["shard"]["id"]] = preserved_shard
        return normalized

    def _merge(self, payload, connection):
        summary = {"added": {}, "skipped": {}}
        reviewed_shards = set()
        for key, inserter in (("shards", self._insert_shard), ("links", self._insert_link), ("reviews", self._insert_review)):
            ids = {row[0] for row in connection.execute(f"SELECT id FROM {key}")}
            summary["added"][key] = 0
            summary["skipped"][key] = 0
            for item in payload[key]:
                if item["id"] in ids:
                    summary["skipped"][key] += 1
                else:
                    inserter(connection, item)
                    summary["added"][key] += 1
                    if key == "reviews":
                        reviewed_shards.add(item["shardId"])
        for shard_id in reviewed_shards:
            count = connection.execute("SELECT count(*) FROM reviews WHERE shard_id=?", (shard_id,)).fetchone()[0]
            latest = connection.execute("""SELECT reviewed_at,next_review_at FROM reviews WHERE shard_id=?
                ORDER BY reviewed_at DESC,rowid DESC LIMIT 1""", (shard_id,)).fetchone()
            connection.execute("""UPDATE shards SET review_count=?,last_reviewed_at=?,next_review_at=? WHERE id=?""", (
                count, latest["reviewed_at"], latest["next_review_at"], shard_id,
            ))
        for key in ("assets", "revisions", "trash", "boards"):
            ids = {row[0] for row in connection.execute(f"SELECT id FROM {key}")}
            summary["added"][key] = 0
            summary["skipped"][key] = 0
            for item in payload.get(key, []):
                if item["id"] in ids:
                    summary["skipped"][key] += 1
                    continue
                if key == "assets":
                    connection.execute("INSERT INTO assets VALUES(?,?,?,?,?)", (item["id"], item["name"], item["mimeType"], base64.b64decode(item["data"]), item["createdAt"]))
                elif key == "revisions":
                    connection.execute("INSERT INTO revisions VALUES(?,?,?,?,?)", (item["id"], item["shardId"], item["createdAt"], item["reason"], json.dumps(item["snapshot"], ensure_ascii=False)))
                elif key == "boards":
                    connection.execute("INSERT INTO boards VALUES(?,?)", (item["id"], json.dumps(item, ensure_ascii=False)))
                else:
                    connection.execute("INSERT INTO trash VALUES(?,?,?)", (item["id"], item["deletedAt"], json.dumps({key: item[key] for key in ("shard", "links", "reviews")}, ensure_ascii=False)))
                summary["added"][key] += 1
        return summary

    def import_data(self, payload):
        with self.lock:
            with self.connect() as connection:
                normalized = self._validate_import(payload, connection)
            try:
                backup = self.backup()
            except (OSError, sqlite3.Error) as error:
                self.backup_error = f"Import backup failed: {error}"
                raise AppError("Import was not applied because the safety backup could not be created.", 500) from error
            with self.changing() as connection:
                connection.execute("BEGIN IMMEDIATE")
                normalized = self._validate_import(payload, connection)
                keys = ("shards", "links", "reviews", "assets", "revisions", "trash", "boards")
                previous_ids = {key: {row[0] for row in connection.execute(f"SELECT id FROM {key}")} for key in keys}
                before_reviews = {shard["id"]: {key: shard[key] for key in ("reviewCount", "lastReviewedAt", "nextReviewAt")} for shard in self._state(connection)["shards"]}
                summary = self._merge(normalized, connection)
                for shard in self._state(connection)["shards"]:
                    snapshots = connection.execute("SELECT snapshot FROM revisions WHERE shard_id=?", (shard["id"],)).fetchall()
                    # An incoming archive may contain earlier versions while its current
                    # explanation was refined during bulk review. Preserve that version too.
                    # Timestamps and recall bookkeeping do not define a new explanation.
                    current_recorded = True
                    if shard["id"] not in previous_ids["shards"]:
                        current_recorded = False
                        for row in snapshots:
                            snapshot = validate_shard(json.loads(row[0]), imported=True)
                            if all(snapshot[field] == shard[field] for field in MUTABLE_SHARD_FIELDS):
                                current_recorded = True
                                break
                    if not snapshots or not current_recorded:
                        self._record_revision(connection, shard, "imported")
                stamp = now()
                import_id = str(uuid.uuid4())
                records = {key: [{"id": row[0], "fingerprint": self._record_fingerprint(connection, key, row[0])} for row in connection.execute(f"SELECT id FROM {key}") if row[0] not in previous_ids[key]] for key in keys}
                state = self._state(connection)
                review_updates = {shard["id"]: {"before": before_reviews[shard["id"]], "after": {key: shard[key] for key in ("reviewCount", "lastReviewedAt", "nextReviewAt")}} for shard in state["shards"] if shard["id"] in before_reviews and any(shard[key] != before_reviews[shard["id"]][key] for key in before_reviews[shard["id"]])}
                receipt = {"id": import_id, "createdAt": stamp, "undoneAt": None, "sourceUrl": next((board["sourceUrl"] for board in normalized["boards"] if board["sourceUrl"]), ""),
                    "added": dict(summary["added"]), "skipped": dict(summary["skipped"]), "backupFilename": backup["filename"], "records": records, "reviewUpdates": review_updates}
                if connection.execute("SELECT count(*) FROM imports").fetchone()[0] >= 10_000 or len(json.dumps(receipt).encode()) > 16 * 1024 * 1024:
                    raise AppError("Import receipt capacity exceeded. Nothing was imported.", 413)
                connection.execute("INSERT INTO imports VALUES(?,?,?)", (import_id, stamp, json.dumps(receipt, ensure_ascii=False)))
                state["importSummary"] = summary
                state["importSummary"]["backupFilename"] = backup["filename"]
                state["importSummary"]["importId"] = import_id
                return state

    @staticmethod
    def _record_fingerprint(connection, table, record_id_value):
        if table not in ("shards", "links", "reviews", "assets", "revisions", "trash", "boards"):
            raise AppError("Unknown import record kind.")
        row = connection.execute(f"SELECT * FROM {table} WHERE id=?", (record_id_value,)).fetchone()
        if row is None:
            return None
        values = {key: base64.b64encode(row[key]).decode("ascii") if isinstance(row[key], bytes) else row[key] for key in row.keys()}
        # Adding the optional relationship column must not invalidate v1–v3 import
        # receipts. Empty context is logically the same as the old six-column row.
        if table == "links" and "knowledge" in values and not any(validate_link_knowledge(json.loads(values["knowledge"])).values()):
            values.pop("knowledge")
        if table == "links":
            for field in ("from_approach_id", "to_approach_id"):
                if values.get(field) == "":
                    values.pop(field)
        return hashlib.sha256(json.dumps(values, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()

    def imports(self):
        with self.lock, self.connect() as connection:
            return {"imports": [{key: value for key, value in json.loads(row[0]).items() if key not in ("records", "reviewUpdates")} for row in connection.execute("SELECT payload FROM imports ORDER BY created_at DESC,rowid DESC")]}

    def import_preview(self, payload):
        if not isinstance(payload, dict):
            raise AppError("Import must contain a data object.")
        keys = ("shards", "links", "reviews", "assets", "revisions", "trash", "boards")
        with self.lock, self.connect() as connection:
            incoming = {key: payload.get(key, []) if isinstance(payload.get(key, []), list) else [] for key in keys}
            counts = {key: len(values) for key, values in incoming.items()}
            try:
                payload_bytes = len(json.dumps(payload, ensure_ascii=False, allow_nan=False).encode("utf-8"))
            except (TypeError, ValueError, RecursionError):
                raise AppError("Archives must contain valid finite JSON values.") from None
            if any(count > MAX_IMPORT_RECORDS for count in counts.values()) or payload_bytes > MAX_ARCHIVE_BYTES:
                raise AppError("Import preview exceeds the archive limits.", 413)
            current = self._archive(connection)
            existing = {key: {item["id"]: item for item in current.get(key, [])} for key in keys}
            duplicates, conflicts, missing, warnings = [], [], [], []
            added, skipped = {}, {}
            known = set(existing["shards"])
            known.update(item.get("id") for item in incoming["shards"] if isinstance(item, dict) and isinstance(item.get("id"), str))
            asset_ids = set(existing["assets"])
            asset_ids.update(item.get("id") for item in incoming["assets"] if isinstance(item, dict) and isinstance(item.get("id"), str))
            existing_content = {(item["title"].strip().casefold(), item["content"]): item["id"] for item in current["shards"]}
            for key in keys:
                values = incoming[key]
                seen = set()
                added[key] = skipped[key] = 0
                for item in values:
                    if not isinstance(item, dict):
                        continue
                    identifier = item.get("id")
                    if not isinstance(identifier, str):
                        continue
                    if identifier in seen:
                        duplicates.append({"kind": key, "id": identifier, "reason": "duplicate ID in archive"})
                    seen.add(identifier)
                    if identifier in existing[key]:
                        skipped[key] += 1
                        duplicates.append({"kind": key, "id": identifier, "reason": "existing ID will be preserved"})
                        comparable = {field: value for field, value in item.items() if field not in ("createdAt", "updatedAt")}
                        if key == "shards" and isinstance(comparable.get("title"), str):
                            comparable["title"] = comparable["title"].strip()
                        if any(existing[key][identifier].get(field) != value for field, value in comparable.items()):
                            conflicts.append({"kind": key, "id": identifier, "reason": "incoming content differs; existing content will be preserved"})
                    else:
                        added[key] += 1
                        if key == "shards" and isinstance(item.get("content", ""), str):
                            matched = existing_content.get((str(item.get("title", "")).strip().casefold(), item.get("content", "")))
                            if matched:
                                duplicates.append({"kind": key, "id": identifier, "existingId": matched, "reason": "same title and content under a different ID; both records will remain"})
                    if key in ("shards", "links"):
                        # Only relative Markdown references use this collection's asset store.
                        # Remote source metadata may contain unrelated /assets/ URL paths.
                        context = learning_text(item) if key == "shards" else "\n".join(str(item.get(field, "")) for field in ("note", "scope", "evidence"))
                        for asset_id in set(re.findall(r"\]\(/assets/([A-Za-z0-9][A-Za-z0-9_.:-]{0,99})\)", context)):
                            if asset_id not in asset_ids:
                                missing.append({"kind": key, "id": identifier, "assetId": asset_id, "reason": "missing local image"})
                    references = []
                    if key == "links":
                        references = [item.get("fromId"), item.get("toId")]
                    elif key == "reviews":
                        references = [item.get("shardId")]
                    elif key == "boards":
                        references = [value.get("shardId") for value in item.get("items", []) if isinstance(value, dict)] if isinstance(item.get("items", []), list) else []
                        if isinstance(item.get("sections", []), list):
                            references.extend(section.get("shardId") for section in item.get("sections", []) if isinstance(section, dict) and section.get("shardId"))
                    for reference in references:
                        if not isinstance(reference, str) or reference not in known:
                            missing.append({"kind": key, "id": identifier, "shardId": reference, "reason": "missing note"})
            valid = True
            try:
                self._validate_import(payload, connection)
            except AppError as error:
                valid = False
                warnings.append(str(error))
            if any(item["kind"] == "boards" for item in missing):
                warnings.append("Missing notes on boards retain their saved positions and can be restored from Trash.")
            return {"valid": valid, "counts": counts, "added": added, "skipped": skipped, "duplicates": duplicates, "conflicts": conflicts, "missing": missing, "warnings": warnings,
                "coverage": {"shards": counts["shards"], "links": counts["links"], "boards": counts["boards"], "boardItems": sum(len(board.get("items", [])) for board in incoming["boards"] if isinstance(board, dict) and isinstance(board.get("items", []), list)), "assets": counts["assets"]}}

    def undo_import(self, import_id):
        record_id(import_id)
        with self.lock:
            with self.connect() as connection:
                row = connection.execute("SELECT payload FROM imports WHERE id=?", (import_id,)).fetchone()
                if row is None:
                    raise AppError("Import receipt not found.", 404)
                receipt = json.loads(row[0])
                if receipt["undoneAt"]:
                    state = self._state(connection)
                    state["undoSummary"] = {**receipt.get("undoSummary", {}), "replayed": True}
                    return state
            try:
                backup = self.backup()
            except (OSError, sqlite3.Error) as error:
                raise AppError("Import undo was not applied because its safety snapshot could not be created.", 500) from error
            with self.changing() as connection:
                connection.execute("BEGIN IMMEDIATE")
                records = receipt["records"]
                candidates, skipped = {}, []
                for key, values in records.items():
                    candidates[key] = set()
                    for item in values:
                        fingerprint = self._record_fingerprint(connection, key, item["id"])
                        if fingerprint == item["fingerprint"]:
                            candidates[key].add(item["id"])
                        else:
                            skipped.append({"kind": key, "id": item["id"], "reason": "modified after import" if fingerprint else "already absent"})
                # Preserve notes referenced by work outside this import, including modified imported records.
                state = self._state(connection)
                protected = set()
                revisions = [dict(row) for row in connection.execute("SELECT id,shard_id,snapshot FROM revisions")]
                trash = [dict(row) for row in connection.execute("SELECT id,payload FROM trash")]
                draft_rows = [row[0] for row in connection.execute("SELECT payload FROM drafts")]
                for encoded in draft_rows:
                    draft = json.loads(encoded)
                    if not isinstance(draft, dict):
                        continue
                    values = draft.get("values", {})
                    if not isinstance(values, dict):
                        values = {}
                    protected.update(value for value in (draft.get("id"), draft.get("editingId"), draft.get("linkingId"), values.get("fromId"), values.get("toId")) if isinstance(value, str))
                    comparisons = values.get("comparisons", [])
                    if isinstance(comparisons, str):
                        try:
                            comparisons = json.loads(comparisons)
                        except ValueError:
                            comparisons = []
                    protected.update(learning_references({"comparisons": comparisons}))
                    protected.update(re.findall(r"\[\[id:([A-Za-z0-9][A-Za-z0-9_.:-]{0,99})(?=[|\]])", encoded))
                    editing_link = draft.get("editingLinkId")
                    if isinstance(editing_link, str) and editing_link in candidates["links"]:
                        candidates["links"].remove(editing_link)
                        skipped.append({"kind": "links", "id": editing_link, "reason": "used by an unfinished connection draft"})
                for link in state["links"]:
                    if link["id"] not in candidates["links"]:
                        protected.update((link["fromId"], link["toId"]))
                        protected.update(re.findall(r"\[\[id:([A-Za-z0-9][A-Za-z0-9_.:-]{0,99})(?=[|\]])", json.dumps(link)))
                for review in state["reviews"]:
                    if review["id"] not in candidates["reviews"]:
                        protected.add(review["shardId"])
                for board in state["boards"]:
                    if board["id"] not in candidates["boards"]:
                        protected.update(item["shardId"] for item in board["items"])
                        protected.update(section["shardId"] for section in board["sections"] if section.get("shardId"))
                for row in trash:
                    if row["id"] not in candidates["trash"]:
                        payload = json.loads(row["payload"])
                        protected.update(learning_references(payload["shard"]))
                        protected.update(re.findall(r"\[\[id:([A-Za-z0-9][A-Za-z0-9_.:-]{0,99})(?=[|\]])", row["payload"]))
                        for link in payload.get("links", []):
                            protected.update((link["fromId"], link["toId"]))
                # Retaining one explanation can require another. Repeat until its
                # current metadata and every retained historical snapshot remain usable.
                while True:
                    for shard in state["shards"]:
                        if shard["id"] not in candidates["shards"]:
                            protected.update(learning_references(shard))
                    for row in revisions:
                        if row["id"] not in candidates["revisions"]:
                            protected.add(row["shard_id"])
                            protected.update(learning_references(json.loads(row["snapshot"])))
                    retained_shards = candidates["shards"] & protected
                    for shard_id in retained_shards:
                        skipped.append({"kind": "shards", "id": shard_id, "reason": "referenced by work outside the unchanged import"})
                    candidates["shards"] -= retained_shards
                    retained_revisions = {row["id"] for row in revisions if row["id"] in candidates["revisions"] and row["shard_id"] not in candidates["shards"]}
                    for revision_id in retained_revisions:
                        skipped.append({"kind": "revisions", "id": revision_id, "reason": "history belongs to retained knowledge"})
                    candidates["revisions"] -= retained_revisions
                    if not retained_shards and not retained_revisions:
                        break
                # Original images must survive whenever any retained note or saved revision still uses them.
                for asset_id in tuple(candidates["assets"]):
                    token = "/assets/" + asset_id
                    retained = any(shard["id"] not in candidates["shards"] and token in learning_text(shard) for shard in state["shards"])
                    if not retained:
                        retained = any(link["id"] not in candidates["links"] and token in json.dumps(link) for link in state["links"])
                    if not retained:
                        retained = any(row["id"] not in candidates["revisions"] and token in row["snapshot"] for row in revisions)
                    if not retained:
                        retained = any(row["id"] not in candidates["trash"] and token in row["payload"] for row in trash)
                    if not retained:
                        retained = any(token in encoded for encoded in draft_rows)
                    if retained:
                        candidates["assets"].remove(asset_id)
                        skipped.append({"kind": "assets", "id": asset_id, "reason": "used by retained knowledge"})
                affected_reviews = {row["shard_id"] for row in connection.execute("SELECT id,shard_id FROM reviews") if row["id"] in candidates["reviews"]}
                removed = {key: 0 for key in records}
                for key in ("boards", "links", "reviews", "revisions", "trash", "shards", "assets"):
                    for identifier in candidates[key]:
                        removed[key] += connection.execute(f"DELETE FROM {key} WHERE id=?", (identifier,)).rowcount
                for shard_id in affected_reviews - candidates["shards"]:
                    update = receipt.get("reviewUpdates", {}).get(shard_id)
                    current = next((shard for shard in state["shards"] if shard["id"] == shard_id), None)
                    if update and current and all(current[key] == value for key, value in update["after"].items()):
                        before = update["before"]
                        connection.execute("UPDATE shards SET review_count=?,last_reviewed_at=?,next_review_at=? WHERE id=?", (before["reviewCount"], before["lastReviewedAt"], before["nextReviewAt"], shard_id))
                    else:
                        count = connection.execute("SELECT count(*) FROM reviews WHERE shard_id=?", (shard_id,)).fetchone()[0]
                        latest = connection.execute("SELECT reviewed_at,next_review_at FROM reviews WHERE shard_id=? ORDER BY reviewed_at DESC,rowid DESC LIMIT 1", (shard_id,)).fetchone()
                        connection.execute("UPDATE shards SET review_count=?,last_reviewed_at=?,next_review_at=? WHERE id=?", (count, latest[0] if latest else None, latest[1] if latest else None, shard_id))
                summary = {"importId": import_id, "removed": removed, "skipped": skipped, "backupFilename": backup["filename"], "replayed": False}
                receipt.update(undoneAt=now(), undoSummary=summary)
                connection.execute("UPDATE imports SET payload=? WHERE id=?", (json.dumps(receipt, ensure_ascii=False), import_id))
                state = self._state(connection)
                state["undoSummary"] = summary
                return state

    @staticmethod
    def _contribution_payload(payload):
        if not isinstance(payload, dict) or set(payload) - {"requestId", "shards", "links"}:
            raise AppError("A contribution contains only requestId, shards, and links.")
        request_id = record_id(payload.get("requestId"), "requestId")
        try:
            encoded = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("utf-8")
        except (TypeError, ValueError, RecursionError):
            raise AppError("A contribution must contain valid JSON values.") from None
        if len(encoded) > MAX_CONTRIBUTION_BYTES:
            raise AppError("A contribution must be at most 8 MB.", 413)
        shards, links = payload.get("shards", []), payload.get("links", [])
        for name, records, limit in (("shards", shards, 1000), ("links", links, 2000)):
            if not isinstance(records, list) or len(records) > limit:
                raise AppError(f"Contribution {name} must be a list of at most {limit:,} records.")
        if not shards and not links:
            raise AppError("A contribution must contain at least one shard or relationship.")
        normalized = {"shards": [], "links": []}
        tag_names = {}
        for data in shards:
            allowed = (MUTABLE_SHARD_FIELDS - {"prompt"}) | {"id"}
            if not isinstance(data, dict) or set(data) - allowed:
                raise AppError("Contribution shards may contain a stable id and editable knowledge fields, without read-only timestamps or recall prompts.")
            values = dict(data)
            raw_tags = values.get("tags", [])
            if not isinstance(raw_tags, list):
                raise AppError("tags must be a list.")
            values["tags"] = []
            for tag in raw_tags:
                tag = text_field(tag, "tag", 80, required=True).strip()
                key = tag.casefold()
                tag = tag_names.setdefault(key, tag)
                if tag not in values["tags"]:
                    values["tags"].append(tag)
            normalized["shards"].append(validate_shard(values, imported=True))
        for data in links:
            if not isinstance(data, dict) or set(data) - ({"id", "fromId", "toId", "type", "note"} | set(LINK_KNOWLEDGE_DEFAULTS) | set(LINK_APPROACH_FIELDS)):
                raise AppError("Contribution relationships contain only identity, endpoints, type, note, and source context.")
            values = dict(data)
            if "id" not in values:
                identity = json.dumps([request_id, values.get("fromId"), values.get("toId"), values.get("type", "related_to"), *(values.get(field, "") for field in LINK_APPROACH_FIELDS)], ensure_ascii=False)
                values["id"] = "ai-link-" + str(uuid.uuid5(uuid.NAMESPACE_URL, identity))
            normalized["links"].append(validate_link(values, imported=True))
        for key, records in normalized.items():
            if len({item["id"] for item in records}) != len(records):
                raise AppError(f"Contribution contains duplicate IDs in {key}.")
        return request_id, hashlib.sha256(encoded).hexdigest(), normalized

    @staticmethod
    def _contribution_replay(connection, request_id, fingerprint):
        saved = connection.execute("SELECT value FROM metadata WHERE key=?", (CONTRIBUTION_PREFIX + request_id,)).fetchone()
        if saved is None:
            return None
        saved = json.loads(saved[0])
        if saved["fingerprint"] != fingerprint:
            raise AppError("This requestId was already used with different content. Keep the original batch for a retry, or use a new requestId for a new contribution.", 409)
        receipt = dict(saved["receipt"])
        receipt["replayed"] = True
        # A later user edit or deletion must never be undone by an old retry.
        active = {row[0] for row in connection.execute("SELECT id FROM shards")}
        receipt["presentShardIds"] = [item["id"] for item in receipt["shards"] if item["id"] in active]
        receipt["missingShardIds"] = [item["id"] for item in receipt["shards"] if item["id"] not in active]
        return receipt

    @staticmethod
    def _contribution_plan(connection, normalized):
        state = Store._state(connection)
        existing_shards = {item["id"]: item for item in state["shards"]}
        existing_links = {item["id"]: item for item in state["links"]}
        title_content = lambda item: (" ".join(item["title"].split()).casefold(), item["content"], json.dumps(item["codeSolution"], sort_keys=True, ensure_ascii=False))
        duplicates = {}
        tag_names = {}
        for shard in state["shards"]:
            duplicates.setdefault(title_content(shard), shard)
            for tag in shard["tags"]:
                tag_names.setdefault(tag.casefold(), tag)
        trashed_ids = {json.loads(row[0])["shard"]["id"] for row in connection.execute("SELECT payload FROM trash")}
        plan = {"shards": [], "links": [], "shardReceipts": [], "linkReceipts": [], "idMap": {}}
        for shard in normalized["shards"]:
            shard = dict(shard)
            shard["tags"] = [tag_names.setdefault(tag.casefold(), tag) for tag in shard["tags"]]
            current = existing_shards.get(shard["id"])
            reason = None
            if current:
                if (current["title"], current["content"], current["codeSolution"]) != (shard["title"], shard["content"], shard["codeSolution"]):
                    raise AppError(f"Shard ID {shard['id']} already belongs to different content. Existing notes were preserved.", 409)
                reason = "id_exists"
            elif shard["id"] in trashed_ids:
                raise AppError(f"Shard ID {shard['id']} is in Trash. Restore it in Shard Atlas instead of reusing its ID.", 409)
            else:
                current = duplicates.get(title_content(shard))
                if current:
                    reason = "content_duplicate"
            if current is None:
                current = shard
                plan["shards"].append(shard)
                existing_shards[shard["id"]] = shard
                duplicates[title_content(shard)] = shard
            plan["idMap"][shard["id"]] = current["id"]
            entry = {"inputId": shard["id"], "id": current["id"], "title": current["title"], "outcome": "existing" if reason else "added"}
            if reason:
                entry["reason"] = reason
            plan["shardReceipts"].append(entry)
        aliases = {key: value for key, value in plan["idMap"].items() if key != value}
        if aliases:
            plan["shards"] = [remap_shard_references(shard, aliases) for shard in plan["shards"]]
        triples = {link_identity(item): item for item in state["links"]}
        for link in normalized["links"]:
            link = dict(link)
            link["fromId"] = plan["idMap"].get(link["fromId"], link["fromId"])
            link["toId"] = plan["idMap"].get(link["toId"], link["toId"])
            link = canonical_link(link)
            if link["fromId"] not in existing_shards or link["toId"] not in existing_shards:
                raise AppError("Contribution contains a relationship with a missing shard.")
            if link["fromId"] == link["toId"] and not (link["type"] == "alternative_to" and link["fromApproachId"] and link["toApproachId"] and link["fromApproachId"] != link["toApproachId"]):
                raise AppError("A relationship became a self-link after duplicate notes were matched. Remove that relationship and retry.")
            validate_link_endpoints(link, existing_shards)
            current = existing_links.get(link["id"])
            reason = None
            fields = ("fromId", "toId", "type", "note", *LINK_KNOWLEDGE_DEFAULTS, *LINK_APPROACH_FIELDS)
            if current:
                if any(current[key] != link[key] for key in fields):
                    raise AppError(f"Relationship ID {link['id']} already belongs to different content. Existing relationships were preserved.", 409)
                reason = "id_exists"
            else:
                current = triples.get(link_identity(link))
                if current:
                    reason = "relationship_exists"
            if current is None:
                current = link
                plan["links"].append(link)
                existing_links[link["id"]] = link
                triples[link_identity(link)] = link
            entry = {"inputId": link["id"], "id": current["id"], "fromId": current["fromId"], "toId": current["toId"], "type": current["type"], **{field: current.get(field, "") for field in LINK_APPROACH_FIELDS}, "outcome": "existing" if reason else "added"}
            if reason:
                entry["reason"] = reason
            plan["linkReceipts"].append(entry)
        return plan

    def contribute(self, payload):
        request_id, fingerprint, normalized = self._contribution_payload(payload)
        with self.lock:
            with self.connect() as connection:
                replay = self._contribution_replay(connection, request_id, fingerprint)
                if replay is not None:
                    return replay
                self._contribution_plan(connection, normalized)
            try:
                backup = self.backup()
            except (OSError, sqlite3.Error) as error:
                raise AppError("The contribution was not saved because its safety backup could not be created.", 500) from error
            with self.changing() as connection:
                connection.execute("BEGIN IMMEDIATE")
                replay = self._contribution_replay(connection, request_id, fingerprint)
                if replay is not None:
                    return replay
                plan = self._contribution_plan(connection, normalized)
                for shard in plan["shards"]:
                    self._insert_shard(connection, shard)
                    self._record_revision(connection, shard, "ai-contribution")
                for link in plan["links"]:
                    self._insert_link(connection, link)
                saved = self._state(connection)
                saved_shards = {item["id"]: item for item in saved["shards"]}
                saved_links = {item["id"]: item for item in saved["links"]}
                missing = (any(item["id"] not in saved_shards for item in plan["shardReceipts"])
                           or any(item["id"] not in saved_links for item in plan["linkReceipts"]))
                changed = (any(any(saved_shards[item["id"]][field] != item[field] for field in MUTABLE_SHARD_FIELDS)
                               for item in plan["shards"] if item["id"] in saved_shards)
                           or any(any(saved_links[item["id"]][field] != item[field] for field in ("fromId", "toId", "type", "note", *LINK_KNOWLEDGE_DEFAULTS, *LINK_APPROACH_FIELDS))
                                  for item in plan["links"] if item["id"] in saved_links))
                if missing or changed:
                    raise AppError("Contribution verification failed. Nothing was saved.", 500)
                receipt = {"requestId": request_id, "replayed": False, "createdAt": now(), "verified": True,
                    "added": {key: len(plan[key]) for key in ("shards", "links")},
                    "skipped": {"shards": len(normalized["shards"]) - len(plan["shards"]), "links": len(normalized["links"]) - len(plan["links"])},
                    "shards": plan["shardReceipts"], "links": plan["linkReceipts"], "idMap": plan["idMap"],
                    "backupFilename": backup["filename"], "presentShardIds": [item["id"] for item in plan["shardReceipts"]], "missingShardIds": []}
                encoded = json.dumps({"fingerprint": fingerprint, "receipt": receipt}, ensure_ascii=False)
                count, size = connection.execute("SELECT count(*),coalesce(sum(length(CAST(value AS BLOB))),0) FROM metadata WHERE key LIKE ?", (CONTRIBUTION_PREFIX + "%",)).fetchone()
                if count >= MAX_CONTRIBUTION_RECEIPTS or size + len(encoded.encode("utf-8")) > MAX_CONTRIBUTION_RECEIPT_BYTES:
                    raise AppError("The saved contribution receipt capacity is full. Nothing was saved.", 413)
                connection.execute("INSERT INTO metadata(key,value) VALUES(?,?)", (CONTRIBUTION_PREFIX + request_id, encoded))
                return receipt

    def backup(self):
        with self.lock:
            target = None
            try:
                self.backup_dir.mkdir(parents=True, exist_ok=True)
                created = now()
                stamp = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%d-%H%M%S-%f")
                target = self.backup_dir / f"shards-{stamp}.sqlite3"
                with self.connect() as source, closing(sqlite3.connect(target)) as destination:
                    source.backup(destination)
            except (OSError, sqlite3.Error) as error:
                self.backup_error = f"Backup failed: {error}"
                if target is not None:
                    target.unlink(missing_ok=True)
                raise
            self.backup_error = None
            self._last_backup_time = time.monotonic()
            self._dirty = False
            return {"filename": target.name, "createdAt": created}

    def _backup_path(self, filename):
        if not isinstance(filename, str) or not re.fullmatch(r"shards-\d{8}-\d{6}-\d{6}\.sqlite3", filename):
            raise AppError("Choose a snapshot from this app's backup list.")
        target = self.backup_dir / filename
        if target.is_symlink() or not target.is_file() or target.resolve().parent != self.backup_dir.resolve():
            raise AppError("Snapshot not found.", 404)
        return target

    @staticmethod
    def _verify_snapshot(path, *, full=False):
        with closing(sqlite3.connect(path.as_uri() + "?mode=ro", uri=True)) as connection:
            connection.row_factory = sqlite3.Row
            result = connection.execute("PRAGMA integrity_check" if full else "PRAGMA quick_check").fetchall()
            if any(row[0] != "ok" for row in result):
                raise AppError("Snapshot failed its database integrity check.")
            version = connection.execute("PRAGMA user_version").fetchone()[0]
            if version < 1 or version > DATABASE_VERSION:
                raise AppError("Snapshot uses an unsupported database version.")
            tables = {row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            if not {"metadata", "shards", "links", "reviews"}.issubset(tables):
                raise AppError("This file is not a Shard Atlas snapshot.")
            if connection.execute("SELECT 1 FROM sqlite_master WHERE type IN ('trigger','view')").fetchone():
                raise AppError("Snapshot contains unsupported database objects.")
            if connection.execute("PRAGMA foreign_key_check").fetchall():
                raise AppError("Snapshot contains broken relationships.")
            state = Store._state(connection)
            shards_by_id = {shard["id"]: shard for shard in state["shards"]}
            for shard in state["shards"]:
                validate_shard(shard, imported=True)
            for link in state["links"]:
                validate_link(link, imported=True)
                validate_link_endpoints(link, shards_by_id)
            for review in state["reviews"]:
                validate_review(review, imported=True)
            for board in state["boards"]:
                validate_board(board, imported=True)
            if full and "assets" in tables:
                for row in connection.execute("SELECT * FROM assets"):
                    validate_asset({"id": row["id"], "name": row["name"], "mimeType": row["mime_type"], "data": base64.b64encode(row["data"]).decode("ascii"), "createdAt": row["created_at"]}, imported=True)
            if full and "revisions" in tables:
                for row in connection.execute("SELECT * FROM revisions"):
                    validate_revision({"id": row["id"], "shardId": row["shard_id"], "createdAt": row["created_at"], "reason": row["reason"], "snapshot": json.loads(row["snapshot"])})
            if full and "trash" in tables:
                for row in connection.execute("SELECT * FROM trash"):
                    validate_trash({"id": row["id"], "deletedAt": row["deleted_at"], **json.loads(row["payload"])})
            return len(state["shards"])

    def backups(self):
        items = []
        with self.lock:
            for path in sorted(self.backup_dir.glob("shards-*.sqlite3"), reverse=True):
                if path.is_symlink() or not re.fullmatch(r"shards-\d{8}-\d{6}-\d{6}\.sqlite3", path.name):
                    continue
                try:
                    created = dt.datetime.strptime(path.stem.removeprefix("shards-"), "%Y%m%d-%H%M%S-%f").replace(tzinfo=dt.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
                except ValueError:
                    continue
                item = {"filename": path.name, "createdAt": created, "size": path.stat().st_size, "valid": False, "error": None, "shardCount": None}
                try:
                    item["shardCount"] = self._verify_snapshot(path, full=True)
                    item["valid"] = True
                except (AppError, sqlite3.Error, ValueError, KeyError) as error:
                    item["error"] = str(error)
                items.append(item)
        return {"backups": items}

    @staticmethod
    def _upgrade_snapshot(connection):
        connection.executescript("""
            CREATE TABLE IF NOT EXISTS revisions (id TEXT PRIMARY KEY,shard_id TEXT NOT NULL,created_at TEXT NOT NULL,reason TEXT NOT NULL,snapshot TEXT NOT NULL);
            CREATE INDEX IF NOT EXISTS revisions_shard ON revisions(shard_id);
            CREATE TABLE IF NOT EXISTS trash (id TEXT PRIMARY KEY,deleted_at TEXT NOT NULL,payload TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS assets (id TEXT PRIMARY KEY,name TEXT NOT NULL,mime_type TEXT NOT NULL,data BLOB NOT NULL,created_at TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS drafts (kind TEXT PRIMARY KEY,payload TEXT NOT NULL);
        """)
        Store._migrate_workspaces(connection)
        for shard in Store._state(connection)["shards"]:
            if connection.execute("SELECT 1 FROM revisions WHERE shard_id=?", (shard["id"],)).fetchone() is None:
                Store._record_revision(connection, shard, "initial")
        connection.execute("INSERT OR REPLACE INTO metadata VALUES('initialized','1')")
        connection.execute("INSERT OR REPLACE INTO metadata VALUES('schema_version','1')")
        connection.execute(f"PRAGMA user_version={DATABASE_VERSION}")

    def restore_backup(self, filename):
        with self.lock:
            source_path = self._backup_path(filename)
            try:
                self._verify_snapshot(source_path, full=True)
            except (sqlite3.Error, ValueError, KeyError) as error:
                raise AppError("Snapshot is corrupt or is not a supported Shard Atlas database.") from error
            try:
                safety = self.backup()
            except (OSError, sqlite3.Error) as error:
                raise AppError("Restore was not applied because its safety backup could not be created.", 500) from error
            with closing(sqlite3.connect(source_path.as_uri() + "?mode=ro", uri=True)) as source, self.connect() as destination:
                source.backup(destination)
                self._upgrade_snapshot(destination)
            self._dirty = True
            state = self.state()
            state["restoreSummary"] = {"preRestoreBackupFilename": safety["filename"]}
            return state

    def health(self):
        with self.connect() as connection:
            count = connection.execute("SELECT count(*) FROM shards").fetchone()[0]
        return {
            "app": "shard-atlas", "backendVersion": BACKEND_VERSION, "databaseVersion": DATABASE_VERSION,
            "status": "ok" if self.backup_error is None else "backup-warning",
            "schemaVersion": SCHEMA_VERSION, "shardCount": count, "backupError": self.backup_error,
            "dbPath": str(self.db_path), "backupDirectory": str(self.backup_dir),
            "lastBackupError": self.backup_error,
        }

    def markdown_export(self):
        state = self.export_data()
        buffer = io.BytesIO()
        titles = {shard["id"]: shard["title"] for shard in state["shards"]}
        asset_extensions = {asset["id"]: {"image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp"}[asset["mimeType"]] for asset in state["assets"]}
        def readable(value):
            return re.sub(r"(?<=\()/assets/([A-Za-z0-9_.:-]+)(?=\))", lambda match: "../assets/" + match[1] + "." + asset_extensions.get(match[1], "missing"), value)
        with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            archive.writestr("shard-atlas.json", json.dumps(state, ensure_ascii=False, indent=2))
            archive.writestr("relationships.json", json.dumps(state["links"], ensure_ascii=False, indent=2))
            for asset in state["assets"]:
                extension = {"image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp"}[asset["mimeType"]]
                archive.writestr(f"assets/{asset['id']}.{extension}", base64.b64decode(asset["data"]))
            archive.writestr("README.txt", "Shard Atlas export\n\nEach shard has a readable Markdown file.\nshard-atlas.json preserves all stable IDs, relationships, and review history for import.\nrelationships.json is a separate copy of relationship metadata.\nMarkdown contents are plain exported text; interpret embedded markup only in a trusted viewer.\n")
            for shard in state["shards"]:
                slug = re.sub(r"[^a-zA-Z0-9_-]+", "-", shard["title"]).strip("-")[:60] or "shard"
                filename = f"shards/{slug}--{shard['id']}.md"
                lines = [f"# {shard['title']}", "", f"ID: {shard['id']}", f"Kind: {shard['kind']}",
                         f"Status: {shard['status']}", f"Tags: {', '.join(shard['tags']) or '—'}",
                         f"Created: {shard['createdAt']}", f"Updated: {shard['updatedAt']}"]
                for key, label in (("sourceUrl", "Source"), ("languageVersion", "Language version"), ("eventDate", "Event date"), ("eventType", "Event type"), ("evidenceStatus", "Evidence status"), ("publicationDate", "Published"), ("verifiedDate", "Verified"), ("entityType", "Entity type")):
                    if shard[key]:
                        lines.append(f"{label}: {shard[key]}")
                if shard["entities"]:
                    lines.append("Entities: " + ", ".join(shard["entities"]))
                if shard["subjects"]:
                    lines.append("Subjects: " + ", ".join(shard["subjects"]))
                if shard["courses"]:
                    lines.extend(["", "## Course occurrences", ""])
                    for course in shard["courses"]:
                        label = " · ".join(value for value in (course["courseCode"], course["courseTitle"], course["term"], course["lecture"]) if value)
                        lines.append(f"- {label} (position: {course['position']})")
                        if course["sourceUrl"] or course["sourceLocation"]:
                            lines.append("  Source: " + " · ".join(value for value in (course["sourceUrl"], course["sourceLocation"]) if value))
                        if course["context"]:
                            lines.append("  Context: " + course["context"])
                if shard["notation"]:
                    lines.extend(["", "## Notation", ""])
                    for entry in shard["notation"]:
                        lines.append(f"- {entry['symbol']}: {entry['meaning']}")
                        for field in ("shape", "role", "scope"):
                            if entry[field]:
                                lines.append(f"  {field.capitalize()}: {entry[field]}")
                if shard["assumptions"]:
                    lines.extend(["", "## Assumptions", ""])
                    lines.extend("- " + assumption for assumption in shard["assumptions"])
                solution = shard["codeSolution"]
                if solution["role"] or solution["code"] or solution["approaches"] or solution["purpose"]:
                    lines.extend(["", "## Code reference", "", "Role: " + (solution["role"] or "Unspecified")])
                    if solution["aliases"]:
                        lines.append("Aliases: " + ", ".join(solution["aliases"]))
                    if solution["purpose"]:
                        lines.extend(["", readable(solution["purpose"])])
                    for details in [solution, *solution["approaches"]]:
                        if "id" in details:
                            lines.extend(["", "### " + (details["title"] or "Approach"), "", "Approach ID: " + details["id"], readable(details["summary"])])
                        for field, label in (("headers", "Required headers"), ("timeComplexity", "Time"), ("spaceComplexity", "Space"), ("complexityNotes", "Complexity notes"), ("assumptions", "Assumptions"), ("pitfalls", "Pitfalls")):
                            value = details[field]
                            if value:
                                lines.append(label + ": " + ("; ".join(value) if isinstance(value, list) else value))
                        if details["code"]:
                            # Choose a fence longer than any literal run in source.
                            fence = "`" * max(3, 1 + max((len(run) for run in re.findall(r"`+", details["code"])), default=0))
                            lines.extend(["", fence + "cpp", details["code"] + ("" if details["code"].endswith("\n") else "\n") + fence, ""])
                verification = shard["verification"]
                lines.extend(["", "## Content verification", "", "Status: " + verification["status"]])
                for key, label in (("note", "Check note"), ("sourceUrl", "Source"), ("sourceLocation", "Source location"), ("checkedAt", "Checked")):
                    if verification[key]:
                        lines.append(label + ": " + readable(verification[key]))
                def append_source(record):
                    if record["sourceUrl"]:
                        lines.append("Source: " + record["sourceUrl"])
                    if record["sourceLocation"]:
                        lines.append("Source location: " + record["sourceLocation"])
                if shard["perspectives"]:
                    lines.extend(["", "## Perspectives", ""])
                    for perspective in shard["perspectives"]:
                        lines.extend(["### " + perspective["title"], ""])
                        if perspective["viewpoint"]:
                            lines.append("Viewpoint: " + perspective["viewpoint"])
                        lines.extend(["", readable(perspective["content"]), ""])
                        if perspective["assumptions"]:
                            lines.append("Assumptions:")
                            lines.extend("- " + readable(value) for value in perspective["assumptions"])
                        append_source(perspective)
                if shard["walkthroughs"]:
                    lines.extend(["", "## Walkthroughs", ""])
                    for walkthrough in shard["walkthroughs"]:
                        lines.extend(["### " + walkthrough["title"], "", "Kind: " + walkthrough["kind"], ""])
                        if walkthrough["goal"]:
                            lines.extend(["Goal: " + readable(walkthrough["goal"]), ""])
                        for index, step in enumerate(walkthrough["steps"], 1):
                            lines.extend([f"#### Step {index}" + (": " + step["title"] if step["title"] else ""), ""])
                            if step["expression"]:
                                lines.extend(["$$", step["expression"], "$$", ""])
                            if step["explanation"]:
                                lines.extend([readable(step["explanation"]), ""])
                            if step["justification"]:
                                lines.extend(["Justification: " + readable(step["justification"]), ""])
                        if walkthrough["conclusion"]:
                            lines.extend(["Conclusion: " + readable(walkthrough["conclusion"]), ""])
                        append_source(walkthrough)
                if shard["comparisons"]:
                    lines.extend(["", "## Method comparisons", ""])
                    for comparison in shard["comparisons"]:
                        lines.extend(["### " + comparison["title"], "", readable(comparison["question"]), ""])
                        for alternative in comparison["alternatives"]:
                            lines.extend(["#### " + alternative["name"], "", readable(alternative["summary"]), ""])
                            if alternative["shardId"]:
                                lines.append("Linked shard: " + titles.get(alternative["shardId"], alternative["shardId"]) + " (" + alternative["shardId"] + ")")
                            for key in ("assumptions", "strengths", "limitations"):
                                if alternative[key]:
                                    lines.append(key.capitalize() + ":")
                                    lines.extend("- " + readable(value) for value in alternative[key])
                            if alternative["cost"]:
                                lines.append("Cost: " + readable(alternative["cost"]))
                        if comparison["conclusion"]:
                            lines.extend(["", "Conclusion: " + readable(comparison["conclusion"]), ""])
                        append_source(comparison)
                if shard["learningLog"]:
                    lines.extend(["", "## Questions and misconceptions", ""])
                    for entry in shard["learningLog"]:
                        lines.extend(["### " + entry["kind"].capitalize() + " · " + entry["status"], "", readable(entry["prompt"]), ""])
                        if entry["resolution"]:
                            lines.extend(["Resolution: " + readable(entry["resolution"]), ""])
                        for history in entry["history"]:
                            lines.append("- " + (history["date"] + ": " if history["date"] else "") + readable(history["note"]))
                        append_source(entry)
                if shard["experiments"]:
                    lines.extend(["", "## Reproducible experiments", "", "These are saved configurations, not computed results or mathematical guarantees.", ""])
                    for experiment in shard["experiments"]:
                        lines.extend(["### " + experiment["title"], "", "Experiment ID: " + experiment["id"],
                                      "Type: " + experiment["type"], "Algorithm version: " + str(experiment["algorithmVersion"]), ""])
                        if experiment["description"]:
                            lines.extend([readable(experiment["description"]), ""])
                        lines.extend(["Configuration A:", "```json", json.dumps(experiment["config"], ensure_ascii=False, indent=2), "```", ""])
                        if experiment["comparisonConfig"] is not None:
                            lines.extend(["Configuration B:", "```json", json.dumps(experiment["comparisonConfig"], ensure_ascii=False, indent=2), "```", ""])
                        append_source(experiment)
                if shard["sources"]:
                    lines.extend(["", "## Sources", ""])
                    for source in shard["sources"]:
                        lines.append(f"- {source['title'] or 'Source'}: {source['url']} (published: {source['publishedDate'] or 'unknown'}; accessed: {source['accessedDate'] or 'unknown'})")
                        if source["note"]:
                            lines.append("  " + source["note"])
                if shard["facts"]:
                    lines.extend(["", "## Comparison facts", ""])
                    for fact in shard["facts"]:
                        lines.append(f"- {fact['label']}: {fact['value']} {fact['unit']} (as of {fact['asOf'] or 'unknown'}; source: {fact['sourceUrl'] or 'not recorded'})")
                lines.extend(["", "## Explanation", "", readable(shard["content"]) or "(No explanation yet.)"])
                relations = [link for link in state["links"] if shard["id"] in (link["fromId"], link["toId"])]
                if relations:
                    lines.extend(["", "## Relationships", ""])
                    def endpoint_label(link, endpoint, approach_field):
                        label = titles[link[endpoint]] + " (" + link[endpoint] + ")"
                        approach_id = link.get(approach_field)
                        if approach_id:
                            endpoint_shard = next(item for item in state["shards"] if item["id"] == link[endpoint])
                            approach = next((item for item in endpoint_shard["codeSolution"]["approaches"] if item["id"] == approach_id), None)
                            label += " / " + (approach["title"] if approach and approach["title"] else approach_id)
                        return label
                    for link in relations:
                        lines.append(f"- {endpoint_label(link, 'fromId', 'fromApproachId')} → {link['type'].replace('_', ' ')} → {endpoint_label(link, 'toId', 'toApproachId')}")
                        if link["note"]:
                            lines.append("  " + readable(link["note"]))
                        for key, label in (("scope", "Scope"), ("evidence", "Evidence"), ("sourceUrl", "Source"), ("sourceLocation", "Source location")):
                            if link[key]:
                                lines.append("  " + label + ": " + readable(link[key]))
                archive.writestr(filename, "\n".join(lines) + "\n")
        return buffer.getvalue()


def spiral_catalog(static_dir):
    """Overlay an optional, Git-ignored local icon pack without changing public data."""
    static_dir = Path(static_dir).resolve()
    catalog = json.loads((static_dir / "spiral-timeline.json").read_text(encoding="utf-8"))
    pack_dir = (static_dir / "spiral" / "local-emblems").resolve()
    manifest_path = (pack_dir / "manifest.json").resolve()
    try:
        if (not pack_dir.is_relative_to(static_dir) or not manifest_path.is_relative_to(pack_dir)
                or manifest_path.stat().st_size > 128 * 1024):
            return catalog
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        if not isinstance(manifest, dict) or manifest.get("schemaVersion") != 1 or not isinstance(manifest.get("icons"), list):
            return catalog
    except (OSError, ValueError, RecursionError):
        return catalog
    icons = {icon.get("id"): icon for icon in manifest["icons"]
             if isinstance(icon, dict) and isinstance(icon.get("id"), str)}
    for world in catalog.get("releases", {}).values():
        for emblem in world.get("emblems", []):
            icon = icons.get(emblem.get("id"), {})
            filename = icon.get("file", "")
            if not isinstance(filename, str) or not re.fullmatch(r"[a-z0-9-]+\.(?:png|gif|webp|jpe?g)", filename):
                continue
            image_path = (pack_dir / filename).resolve()
            try:
                if not image_path.is_relative_to(pack_dir) or not image_path.is_file() or not 0 < image_path.stat().st_size <= MAX_ASSET_BYTES:
                    continue
            except OSError:
                continue
            emblem.update({"src": f"/spiral/local-emblems/{filename}", "officialArtwork": True,
                           "credit": "Wizard101 game artwork © KingsIsle Entertainment. Installed locally and excluded from the public source.",
                           "license": "Copyrighted game artwork. No open redistribution license established."})
            source = icon.get("sourcePageUrl") or icon.get("sourceUrl")
            if isinstance(source, str) and source.startswith("https://"):
                emblem["sourceUrl"] = source
    return catalog


def validate_drive_inbox_envelope(payload):
    """Validate the immutable transport without changing the batch fingerprint."""
    if (not isinstance(payload, dict) or set(payload) != {"format", "version", "batch"}
            or payload.get("format") != "shard-atlas-inbox"
            or type(payload.get("version")) is not int or payload["version"] != 1):
        raise AppError("Use a shard-atlas-inbox version 1 envelope containing only format, version, and batch.")
    Store._contribution_payload(payload["batch"])
    if any("id" not in item for item in payload["batch"].get("links", [])):
        raise AppError("Inbox relationships require explicit stable IDs so every device imports the same records.")
    return payload["batch"]


class DriveInbox:
    """Read-only transport from a synced folder into one collection's receipts."""

    def __init__(self, store, path=None):
        self.store = store
        configured = path if path is not None else os.environ.get("SHARD_ATLAS_DRIVE_INBOX")
        self.path = Path(configured).expanduser().absolute() if configured else Path.home() / "My Drive/ChatGPT/Shard Atlas/Inbox"
        self.lock = threading.Lock()

    def status(self):
        result = {"source": "local-folder", "path": str(self.path), "available": False,
                  "files": [], "counts": {"files": 0, "errors": 0}, "warnings": [],
                  "limits": {"files": MAX_DRIVE_INBOX_FILES, "fileBytes": MAX_DRIVE_INBOX_FILE_BYTES,
                             "totalBytes": MAX_DRIVE_INBOX_TOTAL_BYTES}}
        try:
            entries = []
            with os.scandir(self.path) as scan:
                for index, entry in enumerate(scan):
                    if index >= MAX_DRIVE_INBOX_ENTRIES:
                        raise AppError("The inbox contains too many entries. Keep at most 5,000 items in this folder.")
                    if not entry.name.lower().endswith(".json"):
                        continue
                    if len(entries) >= MAX_DRIVE_INBOX_FILES:
                        raise AppError(f"The inbox contains too many JSON files. Keep at most {MAX_DRIVE_INBOX_FILES} batches in this folder.")
                    item = {"name": entry.name, "size": None, "status": "pending"}
                    try:
                        details = entry.stat(follow_symlinks=False)
                        item["size"] = details.st_size
                        if not stat.S_ISREG(details.st_mode):
                            item.update(status="error", error="Only regular JSON files are accepted; links and folders are not imported.")
                        elif details.st_size > MAX_DRIVE_INBOX_FILE_BYTES:
                            item.update(status="error", error="This inbox file exceeds the 8 MB batch limit.")
                    except OSError:
                        item.update(status="error", error="This file is not available locally. Finish downloading it in Google Drive and retry.")
                    entries.append(item)
            result["files"] = sorted(entries, key=lambda item: item["name"])
            result["available"] = True
            result["counts"] = {"files": len(entries), "errors": sum(item["status"] == "error" for item in entries)}
        except FileNotFoundError:
            result["error"] = "The Drive inbox is not available on this Mac. Sync ChatGPT/Shard Atlas/Inbox with Google Drive, or set SHARD_ATLAS_DRIVE_INBOX to its local folder."
        except (NotADirectoryError, PermissionError):
            result["error"] = "The Drive inbox folder cannot be opened. Check its local path and Google Drive download permissions."
        except (OSError, AppError) as error:
            result["error"] = str(error)
        return result

    @staticmethod
    def _json_object(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError("JSON contains a repeated object field.")
            result[key] = value
        return result

    def _read(self, name, remaining_bytes):
        flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0)
        path = self.path / name
        if path.is_symlink():
            raise AppError("Symbolic links are not imported.")
        with os.fdopen(os.open(path, flags), "rb") as source:
            before = os.fstat(source.fileno())
            if not stat.S_ISREG(before.st_mode):
                raise AppError("Only regular JSON files are accepted.")
            if before.st_size > MAX_DRIVE_INBOX_FILE_BYTES:
                raise AppError("This inbox file exceeds the 8 MB batch limit.", 413)
            if before.st_size > remaining_bytes:
                raise AppError("This sync exceeds the 64 MB read limit. Move older batches out of Inbox after every device has imported them.", 413)
            raw = source.read(min(MAX_DRIVE_INBOX_FILE_BYTES, remaining_bytes) + 1)
            after = os.fstat(source.fileno())
        if len(raw) > MAX_DRIVE_INBOX_FILE_BYTES:
            raise AppError("This inbox file exceeds the 8 MB batch limit.", 413)
        if len(raw) > remaining_bytes:
            raise AppError("This sync exceeds the 64 MB read limit. Move older batches out of Inbox after every device has imported them.", 413)
        if (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
            raise AppError("This file changed while it was read. Wait for Google Drive to finish syncing and retry.")
        return raw

    def _parse(self, raw):
        try:
            def invalid_constant(_value):
                raise ValueError("JSON must contain finite values.")
            return json.loads(raw.decode("utf-8-sig"), object_pairs_hook=self._json_object, parse_constant=invalid_constant)
        except (UnicodeDecodeError, ValueError, RecursionError):
            raise AppError("This file is not valid UTF-8 JSON. Finish syncing it or replace it with a complete inbox batch.") from None

    def sync(self):
        with self.lock:
            result = self.status()
            result["counts"].update(imported=0, replayed=0)
            if not result["available"]:
                return result
            total_bytes = 0
            for item in result["files"]:
                item["warnings"] = []
                if item["status"] == "error":
                    continue
                try:
                    raw = self._read(item["name"], MAX_DRIVE_INBOX_TOTAL_BYTES - total_bytes)
                    total_bytes += len(raw)
                    batch = validate_drive_inbox_envelope(self._parse(raw))
                    item["requestId"] = batch["requestId"]
                    receipt = self.store.contribute(batch)
                    item["receipt"] = receipt
                    item["status"] = "replayed" if receipt["replayed"] else "imported"
                    result["counts"][item["status"]] += 1
                    if receipt.get("missingShardIds"):
                        item["warnings"].append("Some notes from this previously imported batch were deleted. Those deletions were preserved.")
                except AppError as error:
                    item.update(status="error", error=str(error))
                except (OSError, sqlite3.Error):
                    item.update(status="error", error="This file could not be imported. Check its Google Drive download and local storage, then retry.")
            result["counts"]["errors"] = sum(item["status"] == "error" for item in result["files"])
            return result


class LocalServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, address, store, *, static_dir=None, drive_inbox_path=None, library_sync_config=None):
        if address[0] != "127.0.0.1":
            raise ValueError("Shard Atlas only binds to 127.0.0.1.")
        self.store = store
        self.drive_inbox = DriveInbox(store, drive_inbox_path)
        self.static_dir = Path(static_dir or store.root / "static").resolve()
        from library_sync import LibrarySync
        self.library_sync = LibrarySync(store, config_path=library_sync_config)
        super().__init__(address, Handler)
        store.start_backup_worker()
        self.library_sync.start()

    def server_close(self):
        super().server_close()
        self.library_sync.stop()
        self.store.stop_backup_worker()


class Handler(BaseHTTPRequestHandler):
    server_version = "ShardAtlas/1"

    def log_message(self, format, *args):
        # Local logs show request status but never request bodies or saved shard text.
        sys.stderr.write(f"{self.log_date_time_string()} {format % args}\n")

    def _check_local_request(self):
        port = self.server.server_address[1]
        allowed_hosts = {f"127.0.0.1:{port}", f"localhost:{port}"}
        if port == 80:
            allowed_hosts.update({"127.0.0.1", "localhost"})
        hosts = self.headers.get_all("Host", [])
        if len(hosts) != 1 or hosts[0].lower() not in allowed_hosts:
            raise AppError("This server accepts only local host requests.", 403)
        origins = self.headers.get_all("Origin", [])
        if origins and (len(origins) != 1 or origins[0].lower() != f"http://{hosts[0].lower()}"):
            raise AppError("Requests from another origin are not allowed.", 403)
        entry_navigation = (self.command in ("GET", "HEAD") and not origins
                            and self.headers.get("Sec-Fetch-Mode") == "navigate"
                            and self.headers.get("Sec-Fetch-Dest") == "document"
                            and urlsplit(self.path).path in ("/", "/index.html"))
        if self.headers.get("Sec-Fetch-Site") == "cross-site" and not entry_navigation:
            raise AppError("Cross-site requests are not allowed.", 403)

    def _json_body(self):
        if self.headers.get("Content-Type", "").split(";", 1)[0].strip().lower() != "application/json":
            raise AppError("Use application/json for this request.", 415)
        lengths = self.headers.get_all("Content-Length", [])
        if len(lengths) != 1 or self.headers.get("Transfer-Encoding"):
            raise AppError("A single Content-Length is required.", 411)
        try:
            length = int(lengths[0])
        except ValueError:
            raise AppError("Invalid Content-Length.", 400) from None
        if length < 0 or length > MAX_BODY_BYTES:
            raise AppError("Request body is too large.", 413)
        try:
            def invalid_constant(value):
                raise ValueError(f"Invalid JSON constant: {value}")
            data = json.loads(self.rfile.read(length).decode("utf-8"), parse_constant=invalid_constant)
        except (UnicodeDecodeError, ValueError, RecursionError):
            raise AppError("Request body must contain valid UTF-8 JSON.") from None
        if not isinstance(data, dict):
            raise AppError("Request body must be a JSON object.")
        return data

    def _send(self, status, body, content_type="application/json; charset=utf-8", *, filename=None):
        if (200 <= status < 300 and self.command in ("POST", "PUT", "DELETE")
                and not urlsplit(self.path).path.startswith("/api/library-sync/")):
            self.server.library_sync.changed()
        if isinstance(body, (dict, list)):
            body = json.dumps(body, ensure_ascii=False, allow_nan=False).encode("utf-8")
        elif isinstance(body, str):
            body = body.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        if hasattr(self, "_library_view_revision"):
            self.send_header("X-Shard-Atlas-Library-Revision", self._library_view_revision)
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'")
        if filename:
            self.send_header("Content-Disposition", f'attachment; filename="{filename}"')
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _dispatch(self):
        guarded_store = None
        try:
            self._check_local_request()
            path = unquote(urlsplit(self.path).path)
            store = self.server.store
            local_operation = (path.startswith(("/api/library-sync/", "/api/drafts/"))
                               or path in ("/api/import-preview", "/api/import/preview", "/api/backup")
                               or path.startswith("/api/assets/") and path.endswith("/text"))
            if self.command in ("POST", "PUT", "DELETE") and path.startswith("/api/") and not local_operation:
                # A sleeping local window must not overwrite a library pulled by
                # another window after its editing lease expired. Keep the view
                # check and actual mutation in the same local transaction lock.
                store.lock.acquire()
                guarded_store = store
                expected = self.headers.get_all("X-Shard-Atlas-View-Revision", [])
                if expected and (len(expected) != 1 or expected[0] != self.server.library_sync.view_revision()):
                    raise AppError("Your library changed on another device. Your draft is retained; refresh the library before saving this edit.", 409)
            if self.command in ("GET", "HEAD"):
                if path in ("/api/state", "/api/data", "/api/export"):
                    with store.lock:
                        self._library_view_revision = self.server.library_sync.view_revision()
                        return self._send(200, store.export_data() if path == "/api/export" else store.state(), filename="shard-atlas.json" if path == "/api/export" else None)
                if path == "/api/health":
                    return self._send(200, store.health())
                if path == "/api/library-sync/status":
                    return self._send(200, self.server.library_sync.status())
                if path == "/api/export/markdown":
                    return self._send(200, store.markdown_export(), "application/zip", filename="shard-atlas-markdown.zip")
                if path == "/api/trash":
                    return self._send(200, store.trash())
                if path == "/api/backups":
                    return self._send(200, store.backups())
                if path == "/api/drafts":
                    return self._send(200, store.drafts())
                if path == "/api/imports":
                    return self._send(200, store.imports())
                if path == "/api/drive-inbox":
                    return self._send(200, self.server.drive_inbox.status())
                if path == "/api/boards":
                    return self._send(200, {"boards": store.state()["boards"]})
                if path.startswith("/api/shards/") and path.endswith("/revisions"):
                    return self._send(200, store.revisions(path[len("/api/shards/"):-len("/revisions")]))
                if path.startswith("/assets/"):
                    data, mime = store.asset(path[len("/assets/"):])
                    return self._send(200, data, mime)
                if path.startswith("/api/"):
                    raise AppError("Endpoint not found.", 404)
                if path == "/spiral-timeline.json" and (self.server.static_dir / "spiral-timeline.json").is_file():
                    return self._send(200, spiral_catalog(self.server.static_dir))
                relative = "index.html" if path == "/" else path.lstrip("/")
                target = (self.server.static_dir / relative).resolve()
                if not target.is_relative_to(self.server.static_dir) or not target.is_file():
                    raise AppError("File not found.", 404)
                content_type = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
                if content_type.startswith("text/") or content_type in ("application/javascript", "application/json"):
                    content_type += "; charset=utf-8"
                return self._send(200, target.read_bytes(), content_type)
            if self.command == "POST":
                data = self._json_body()
                if path == "/api/library-sync/run":
                    if data:
                        raise AppError("Library synchronization accepts an empty object.")
                    return self._send(200, self.server.library_sync.run())
                if path == "/api/library-sync/editing":
                    if (set(data) not in ({"editing"}, {"editing", "clientId"}) or type(data["editing"]) is not bool
                            or "clientId" in data and (not isinstance(data["clientId"], str)
                            or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}", data["clientId"]))):
                        raise AppError("Editing status must contain an editing boolean.")
                    return self._send(200, self.server.library_sync.editing(data["editing"], data.get("clientId", "legacy")))
                if path == "/api/library-sync/resolve":
                    if set(data) != {"choice"} or data["choice"] not in ("cloud", "device"):
                        raise AppError("Choose the shared library or this device's version.")
                    return self._send(200, self.server.library_sync.resolve(data["choice"]))
                if path == "/api/shards":
                    return self._send(201, store.create_shard(data))
                if path == "/api/links":
                    return self._send(201, store.create_link(data))
                if path == "/api/reviews":
                    return self._send(201, store.create_review(data))
                if path == "/api/contributions":
                    return self._send(200, store.contribute(data))
                if path == "/api/drive-inbox/sync":
                    if data:
                        raise AppError("Drive inbox sync accepts an empty object; its folder is configured on this Mac.")
                    return self._send(200, self.server.drive_inbox.sync())
                if path == "/api/boards":
                    return self._send(201, store.create_board(data))
                if path.startswith("/api/assets/") and path.endswith("/text"):
                    return self._send(200, store.image_text(path[len("/api/assets/"):-len("/text")]))
                if path in ("/api/import-preview", "/api/import/preview"):
                    if "data" not in data:
                        raise AppError("Import preview must contain a data object.")
                    return self._send(200, store.import_preview(data["data"]))
                if path.startswith("/api/imports/") and path.endswith("/undo"):
                    return self._send(200, store.undo_import(path[len("/api/imports/"):-len("/undo")]))
                if path == "/api/import":
                    if "data" not in data:
                        raise AppError("Import must contain a data object.")
                    return self._send(200, store.import_data(data["data"]))
                if path == "/api/backup":
                    return self._send(201, store.backup())
                if path == "/api/assets":
                    return self._send(201, store.create_asset(data))
                if path == "/api/backups/restore":
                    return self._send(200, store.restore_backup(data.get("filename")))
                if path.startswith("/api/shards/") and path.endswith("/restore"):
                    return self._send(200, store.restore_revision(path[len("/api/shards/"):-len("/restore")], data))
                if path.startswith("/api/trash/") and path.endswith("/restore"):
                    return self._send(200, store.restore_trash(path[len("/api/trash/"):-len("/restore")]))
            if self.command == "PUT" and path == "/api/tags/rename":
                return self._send(200, store.rename_tag(self._json_body()))
            if self.command == "PUT" and path.startswith("/api/links/"):
                return self._send(200, store.update_link(path.removeprefix("/api/links/"), self._json_body()))
            if self.command == "PUT" and path.startswith("/api/drafts/"):
                return self._send(200, store.save_draft(path.removeprefix("/api/drafts/"), self._json_body()))
            if self.command == "PUT" and (experiment_path := re.fullmatch(r"/api/shards/([^/]+)/experiments/([^/]+)", path)):
                return self._send(200, store.update_experiment(experiment_path[1], experiment_path[2], self._json_body()))
            if self.command == "PUT" and path.startswith("/api/shards/"):
                return self._send(200, store.update_shard(path.removeprefix("/api/shards/"), self._json_body()))
            if self.command == "PUT" and path.startswith("/api/boards/"):
                return self._send(200, store.update_board(path.removeprefix("/api/boards/"), self._json_body()))
            if self.command == "DELETE":
                if path.startswith("/api/drafts/"):
                    return self._send(200, store.delete_draft(path.removeprefix("/api/drafts/")))
                if path.startswith("/api/shards/"):
                    return self._send(200, store.delete_shard(path.removeprefix("/api/shards/")))
                if path.startswith("/api/links/"):
                    return self._send(200, store.delete_link(path.removeprefix("/api/links/")))
                if path.startswith("/api/boards/"):
                    return self._send(200, store.delete_board(path.removeprefix("/api/boards/")))
            raise AppError("Endpoint not found.", 404)
        except AppError as error:
            self._send(error.status, {"error": str(error)})
        except (OSError, sqlite3.Error) as error:
            sys.stderr.write(f"Storage error: {error}\n")
            self._send(500, {"error": "The local storage operation failed. Your previous data remains available."})
        finally:
            if guarded_store is not None:
                guarded_store.lock.release()

    do_GET = _dispatch
    do_HEAD = _dispatch
    do_POST = _dispatch
    do_PUT = _dispatch
    do_DELETE = _dispatch


def main(argv=None):
    parser = argparse.ArgumentParser(description="Run Shard Atlas on this Mac with local SQLite storage.")
    parser.add_argument("--db", type=Path, default=DEFAULT_DB, help="SQLite database path (default: local Application Support)")
    parser.add_argument("--backup-dir", type=Path, help="Snapshot directory (default: project/backups for the working database; <database-stem>-backups beside a custom database)")
    parser.add_argument("--port", type=int, default=48731, help="Loopback HTTP port (default: 48731)")
    parser.add_argument("--no-seed", action="store_true", help="Start a new database without starter shards")
    args = parser.parse_args(argv)
    if not 0 <= args.port <= 65535:
        parser.error("--port must be between 0 and 65535")
    try:
        store = Store(args.db, seed=not args.no_seed, backup_dir=args.backup_dir)
        server = LocalServer(("127.0.0.1", args.port), store)
    except (AppError, OSError, sqlite3.Error) as error:
        parser.exit(1, f"Could not start Shard Atlas: {error}\n")
    print(f"Shard Atlas: http://127.0.0.1:{server.server_address[1]}\nDatabase: {store.db_path}", flush=True)
    if store.backup_error:
        print(store.backup_error, file=sys.stderr)
    signal.signal(signal.SIGTERM, lambda _signum, _frame: threading.Thread(target=server.shutdown, daemon=True).start())
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
