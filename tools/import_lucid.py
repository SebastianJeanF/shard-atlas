#!/usr/bin/env python3
"""Convert a previously fetched Lucid document into a portable Shard Atlas archive.

This tool never contacts Lucid or opens a working knowledge database. Its inputs
and coverage report can contain private notes and belong outside the checkout.
"""

from __future__ import annotations

import argparse
import base64
import collections
import datetime as dt
import hashlib
import json
import math
import mimetypes
import re
from pathlib import Path
from urllib.parse import quote, urlsplit


RELEASE_RE = re.compile(r"C\+\+\s*(98|03|11|14|17|20|23|26)\b", re.I)
HEADING_RE = re.compile(r"^C\+\+\s*(98|03|11|14|17|20|23|26)$", re.I)
PLACEHOLDERS = {"placeholder", "linenumbers"}
GENERATED_PLACEHOLDERS = {"add code", "type something", "text"}
GENERAL_TOPICS = (
    ("AI", r"\bAI\b|\bartificial intelligence\b|\bAGI\b|\bASI\b|\bLLMs?\b|\bGPT[- ]\w+|\b(?:Claude|Gemini|OpenAI|Anthropic|DeepMind|xAI|Perplexity)\b"),
    ("Career", r"\bcareer\w*\b|\bjobs?\b|\bhiring\b|\brecruit\w*\b|\binterview\w*\b|\bresume\b|\bengineer\w*\b"),
    ("Compensation", r"\bcompensation\b|\bsalar(?:y|ies)\b|\btotal (?:pay|comp)\b|\b[ST]WE TC\b|\b(?:trader|researcher) TC\b"),
    ("Research", r"\bresearch\w*\b|\barxiv\b|\bscientist\w*\b|\bconjecture\b|\bNeurIPS\b|\bICLR\b|\bICML\b"),
    ("AI safety", r"\balignment\b|\bAI safety\b|\bexistential risk\b|\bsuperintelligen\w*\b"),
    ("AI systems", r"\b(?:vLLM|SGLang|inference|GPU|CUDA|compute|pre-training|post-training)\b"),
    ("Education", r"\b(?:Cornell|Stanford|grad school|admission\w*|transcript\w*|MSCS|conferences?)\b"),
)
MONTHS = {name.casefold(): number for number, names in enumerate((
    ("January", "Jan"), ("February", "Feb"), ("March", "Mar"), ("April", "Apr"),
    ("May",), ("June", "Jun"), ("July", "Jul"), ("August", "Aug"),
    ("September", "Sep", "Sept"), ("October", "Oct"), ("November", "Nov"),
    ("December", "Dec")), 1) for name in names}
MONTH_PATTERN = "(?:" + "|".join(sorted(MONTHS, key=len, reverse=True)) + ")"
ENTITY_PATTERNS = (
    ("OpenAI", r"\bOpenAI\b", "company"), ("Anthropic", r"\bAnthropic\b", "company"),
    ("Google DeepMind", r"\b(?:Google DeepMind|DeepMind)\b", "company"),
    ("Google", r"\bGoogle\b", "company"), ("Meta", r"\bMeta\b", "company"),
    ("NVIDIA", r"\bNVIDIA\b", "company"), ("Microsoft", r"\bMicrosoft\b", "company"),
    ("LinkedIn", r"\bLinkedIn\b", "company"), ("Figma", r"\bFigma\b", "company"),
    ("Uber", r"\bUber\b", "company"), ("Roblox", r"\bRoblox\b", "company"),
    ("Netflix", r"\bNetflix\b", "company"), ("Snowflake", r"\bSnowflake\b", "company"),
    ("Broadcom", r"\bBroadcom\b", "company"), ("Databricks", r"\bDatabricks\b", "company"),
    ("Amazon", r"\bAmazon\b", "company"), ("Apple", r"\bApple\b", "company"),
    ("xAI", r"\bxAI\b", "company"), ("Perplexity", r"\bPerplexity\b", "company"),
    ("XTX", r"\bXTX\b", "company"), ("Jane Street", r"\bJane Street\b", "company"),
    ("Cornell", r"\bCornell\b", "concept"), ("Stanford", r"\bStanford\b", "concept"),
    ("vLLM", r"\bvLLM\b", "concept"), ("SGLang", r"\bSGLang\b", "concept"),
    ("ChatGPT", r"\bChatGPT\b", "model"), ("Claude", r"\bClaude\b", "model"),
    ("Gemini", r"\bGemini\b", "model"), ("Grok", r"\bGrok\b", "model"),
    ("Llama", r"\bLlama\b", "model"),
)
TOPICS = (
    ("Namespaces", r"\bnamespace\w*\b"),
    ("Types", r"\btypes?\b|\btypedef\b|\bdecltype\b"),
    ("Classes", r"\bclass(?:es)?\b|\bstruct\b|\bconstructor\w*\b|\bdestructor\w*\b"),
    ("Functions", r"\bfunction\w*\b|\blambda\w*\b|\bcallable\w*\b"),
    ("Variables", r"\bvariable\w*\b"),
    ("Initialization", r"\binitializ\w*\b|\binitialis\w*\b|\binitializer_list\b|\bbrac(?:e|ed)[- ](?:init|list)"),
    ("Templates", r"\btemplate\w*\b|\bmetaprogramming\b"),
    ("Operators", r"\boperator\w*\b|\bprecedence\b|\bassociativity\b"),
    ("Memory", r"\bmemory\b|\ballocat\w*\b|\bdelete\b|\bheap\b|\bRAII\b"),
    ("Lifetime", r"\blifetime\w*\b|\bdestruct\w*\b"),
    ("References", r"\breference\w*\b|\blvalue\w*\b|\brvalue\w*\b"),
    ("Pointers", r"\bpointer\w*\b|\bunique_ptr\b|\bshared_ptr\b|\bweak_ptr\b|\bnullptr\b"),
    ("Preprocessor", r"\bpreprocessor\b|\bmacro\w*\b|#\s*(?:include|define|ifdef)\b"),
    ("Build", r"\bcompil\w*\b|\bCMake\b|\blinker\w*\b|\bbuild\b"),
    ("Exceptions", r"\bexception\w*\b|\btry\b|\bcatch\b|\bnoexcept\b"),
    ("Concurrency", r"\bthread\w*\b|\bmutex\w*\b|\batomic\w*\b|\bconcurren\w*\b|\bexecution policy\b"),
    ("Standard library", r"\bSTL\b|\bstandard library\b|\bstd::"),
    ("Comments", r"\bcomment\w*\b"),
    ("Attributes", r"\battribute\w*\b|\[\[(?:nodiscard|noreturn|deprecated|maybe_unused|fallthrough|no_unique_address)"),
    ("Ranges", r"\branges?\b|\bviews?\b"),
    ("Containers", r"\bcontainers?\b|\bvector\b|\btuple\w*\b|\bmdspan\b|\barray\b"),
)


def stable_id(kind, *parts):
    digest = hashlib.sha256(json.dumps(parts, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()
    return f"lucid-{kind}-{digest[:32]}"


def _stamp(value):
    if not isinstance(value, str) or not value:
        raise ValueError("The source must provide a fetchedAt date or timestamp.")
    try:
        parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as error:
        raise ValueError("fetchedAt must be an ISO date or timestamp.") from error
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=dt.timezone.utc)
    return parsed.astimezone(dt.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _text_fields(shape):
    areas = shape.get("properties", {}).get("TextAreas", [])
    fields = [(str(area.get("key", "Text")), area["text"]) for area in areas
              if isinstance(area, dict) and isinstance(area.get("text"), str)
              and not _generated_field(shape, area)]
    if not fields and isinstance(shape.get("label"), str) and shape["label"].strip():
        fields = [("label", shape["label"])]
    description = shape.get("properties", {}).get("LinkUnfurlDescription")
    if isinstance(description, str) and description.strip() and description not in {text for _, text in fields}:
        fields.append(("LinkUnfurlDescription", description))
    return fields


def _generated_field(shape, area):
    """Exclude known editor hints, never all user text with a reserved field key."""
    name = str(area.get("key", "")).casefold()
    text = str(area.get("text", "")).strip()
    if name == "placeholder" and text.casefold() in GENERATED_PLACEHOLDERS:
        return True
    is_block = shape.get("shapeType") == "Code block" or shape.get("properties", {}).get("BlockClass") == "CodeBlock"
    return bool(name == "linenumbers" and is_block and text
                and re.fullmatch(r"1(?:\s+\d+)*", text)
                and [int(item) for item in text.split()] == list(range(1, len(text.split()) + 1)))


def _display_text(text, enabled=True):
    # Lucid's fetch transport sometimes escapes prose a second time. Decode only
    # when Unicode escape tokens prove that extra transport layer is present.
    # The exact fetched text also remains in the coverage report and metadata.
    if not enabled or not re.search(r"\\u[0-9a-fA-F]{4}", text):
        return text
    value = re.sub(r"\\u([dD][89aAbB][0-9a-fA-F]{2})\\u([dD][cCdDeEfF][0-9a-fA-F]{2})",
                   lambda match: chr(0x10000 + (int(match[1], 16) - 0xD800) * 0x400 + int(match[2], 16) - 0xDC00), text)
    value = re.sub(r"\\u([0-9a-fA-F]{4})", lambda match: chr(int(match[1], 16))
                   if not 0xD800 <= int(match[1], 16) <= 0xDFFF else match[0], value)
    return value.replace("\\n", "\n").replace("\\r", "\r").replace("\\t", "\t")


def _text(shape):
    return "\n".join(text for _, text in _text_fields(shape))


def _short(text, fallback=""):
    return re.sub(r"\s+", " ", text.strip().split("\n")[0])[:220] or fallback


def _is_code(shape):
    if shape.get("shapeType") == "Code block" or shape.get("properties", {}).get("BlockClass") == "CodeBlock":
        return True
    areas = [area for area in shape.get("properties", {}).get("TextAreas", [])
             if isinstance(area, dict) and not _generated_field(shape, area) and area.get("text", "").strip()]
    return bool(areas) and all("mono" in area.get("fontFamily", "").casefold() for area in areas)


def _prose(text):
    # C++ attributes use the same delimiters as the app's internal note links.
    # Preserve their literal spelling by protecting them as inline source code.
    parts = re.split(r"(`[^`]*`)", text)
    return "".join(part if index % 2 else re.sub(r"\[\[[^\]\n]+\]\]", lambda match: "`" + match[0] + "`", part)
                   for index, part in enumerate(parts))


def _urls(shape):
    value = shape.get("properties", {}).get("Link", "")
    if isinstance(value, list):
        values = value
    elif isinstance(value, str):
        # Lucid serializes one or several links inside square brackets.
        values = re.findall(r"https?://[^\s\[\]<>]+", value)
    else:
        values = []
    return list(dict.fromkeys(url for url in values if isinstance(url, str)
                              and urlsplit(url).scheme in ("http", "https") and urlsplit(url).hostname))


def _inventory(source):
    nodes, edges, locations, groups = {}, {}, {}, collections.defaultdict(list)
    duplicates = []

    def visit(value, page, group=""):
        if isinstance(value, list):
            for item in value:
                visit(item, page, group)
        elif isinstance(value, dict):
            group = str(value.get("diagramGroupId", group))
            if "shapeType" in value and isinstance(value.get("id"), str):
                key = (page["pageId"], value["id"])
                if key in nodes and nodes[key] != value:
                    raise ValueError(f"Conflicting duplicate Lucid shape: {key}")
                if key in nodes:
                    duplicates.append({"pageId": key[0], "sourceId": key[1], "kind": "shape"})
                nodes[key] = value
                locations[key] = {"pageId": page["pageId"], "pageTitle": page.get("pageTitle", page["pageId"]),
                                  "diagramGroupId": group}
                if group and key not in groups[(page["pageId"], group)]:
                    groups[(page["pageId"], group)].append(key)
            if "sourceId" in value and "targetId" in value and isinstance(value.get("id"), str):
                key = (page["pageId"], value["id"])
                if key in edges and edges[key] != value:
                    raise ValueError(f"Conflicting duplicate Lucid connection: {key}")
                if key in edges:
                    duplicates.append({"pageId": key[0], "sourceId": key[1], "kind": "edge"})
                edges[key] = value
            for name, item in value.items():
                if name not in ("properties",):
                    visit(item, page, group)

    regions = source.get("regions")
    if not isinstance(regions, list) or not regions:
        raise ValueError("Expected regions containing fetched Lucid pages and requestedChunks.")
    for region in regions:
        for page in region.get("pages", []):
            if not isinstance(page.get("pageId"), str):
                raise ValueError("Each fetched page needs a pageId.")
            for chunk in page.get("requestedChunks", []):
                visit(chunk.get("data", {}), page)
    return nodes, edges, locations, groups, duplicates


def _release_context(nodes, edges):
    headings = {}
    outgoing = collections.defaultdict(list)
    for key, node in nodes.items():
        match = HEADING_RE.fullmatch(_text(node).strip())
        if match:
            headings[key] = "C++" + match[1]
    for (page, _), edge in edges.items():
        origin, target = (page, edge["sourceId"]), (page, edge["targetId"])
        if origin in nodes and target in nodes:
            outgoing[origin].append(target)
            # A feature linked directly into a release heading is still an
            # explicit placement. Do not reverse any other diagram arrow.
            if target in headings and origin not in headings:
                outgoing[target].append(origin)
    candidates = collections.defaultdict(list)
    for heading, version in headings.items():
        pending = collections.deque([(heading, [heading])])
        visited = set()
        while pending:
            key, path = pending.popleft()
            if key in visited:
                continue
            visited.add(key)
            if key != heading and key in headings:
                continue
            candidates[key].append({"version": version, "headingId": heading[1], "path": [part[1] for part in path]})
            for target in outgoing[key]:
                if target not in visited:
                    pending.append((target, path + [target]))
    contexts, conflicts = {}, []
    for key, choices in candidates.items():
        nearest = min(len(item["path"]) for item in choices)
        nearest_choices = [item for item in choices if len(item["path"]) == nearest]
        versions = {item["version"] for item in nearest_choices}
        mentions = {"C++" + match for match in RELEASE_RE.findall(_text(nodes[key]))}
        if len(versions) != 1 or (mentions and mentions != versions):
            conflicts.append({"pageId": key[0], "sourceId": key[1], "candidates": nearest_choices,
                              "mentionedVersions": sorted(mentions)})
        else:
            contexts[key] = min(nearest_choices, key=lambda item: item["path"])
    # Explicit since-version labels are stronger than inferred diagram placement.
    for key, node in nodes.items():
        text = _text(node).strip()
        first = text.split("\n")[0]
        matches = re.findall(r"\(since\s+C\+\+\s*(98|03|11|14|17|20|23|26)\)", first, re.I)
        if len(set(matches)) == 1:
            contexts[key] = {"version": "C++" + matches[0], "headingId": key[1], "path": [key[1]],
                             "basis": "explicit since-version label"}
        elif len(text) <= 120 and len(text.split("\n")) <= 3 and not _is_code(node):
            labels = [HEADING_RE.fullmatch(line.strip()) for line in text.split("\n")]
            versions = {"C++" + match[1] for match in labels if match}
            if len(versions) == 1:
                contexts[key] = {"version": versions.pop(), "headingId": key[1], "path": [key[1]],
                                 "basis": "explicit version label"}
    return contexts, conflicts


def _plain_table(shape, *, decode_prose_escapes=False):
    cells, extra = {}, []
    for name, text in _text_fields(shape):
        text = _display_text(text, decode_prose_escapes)
        match = re.fullmatch(r"Cell_(\d+),(\d+)", name)
        if match:
            cells[tuple(map(int, match.groups()))] = text
        else:
            extra.append(text)
    if not cells:
        return "\n\n".join(extra)
    rows = max(row for row, _ in cells) + 1
    columns = max(column for _, column in cells) + 1
    if rows > 1000 or columns > 100:
        raise ValueError("Lucid table dimensions are too large.")
    widths = [max((len(line) for (row, col), text in cells.items() if col == column
                   for line in text.split("\n")), default=0) for column in range(columns)]
    output = []
    for row in range(rows):
        lines = [cells.get((row, col), "").split("\n") for col in range(columns)]
        for line in range(max(map(len, lines))):
            output.append(" | ".join((values[line] if line < len(values) else "").ljust(widths[col])
                                     for col, values in enumerate(lines)).rstrip())
        if row == 0:
            output.append("-+-".join("-" * width for width in widths))
    return "```text\n" + "\n".join(output) + "\n```" + ("\n\n" + "\n\n".join(extra) if extra else "")


def _image_asset(item, manifest_dir, stamp):
    if isinstance(item, str):
        item = {"path": item}
    if not isinstance(item, dict):
        raise ValueError("Each image manifest entry must be an object or file path.")
    name = str(item.get("name", "LucidChart image"))[:240]
    if "path" in item:
        path = Path(item["path"]).expanduser()
        if not path.is_absolute():
            path = Path(manifest_dir or ".") / path
        raw = path.read_bytes()
        mime = item.get("mimeType") or mimetypes.guess_type(path.name)[0]
        name = str(item.get("name", path.name))[:240]
    else:
        raw = base64.b64decode(item.get("data", ""), validate=True)
        mime = item.get("mimeType")
    if not mime:
        if raw.startswith(b"\x89PNG\r\n\x1a\n"):
            mime = "image/png"
        elif raw.startswith(b"\xff\xd8\xff"):
            mime = "image/jpeg"
        elif raw.startswith((b"GIF87a", b"GIF89a")):
            mime = "image/gif"
        elif raw[:4] == b"RIFF" and raw[8:12] == b"WEBP":
            mime = "image/webp"
    # The server validator is the authoritative format and size boundary.
    from server import validate_asset
    digest = hashlib.sha256(raw).hexdigest()
    asset = {"id": f"lucid-image-{digest[:40]}", "name": name, "mimeType": mime,
             "data": base64.b64encode(raw).decode("ascii"), "createdAt": stamp}
    return validate_asset(asset, imported=True)


def _domain(source, nodes, requested):
    if requested not in ("auto", "cpp", "career-ai", "general"):
        raise ValueError("domain must be auto, cpp, career-ai, or general.")
    if requested != "auto":
        return requested
    title = str(source.get("title", ""))
    if re.search(r"\bcareer\b|\bAI\b", title, re.I):
        return "career-ai"
    text = "\n".join(_text(node) for node in nodes.values())
    if re.search(r"C\+\+|\bstd::|#\s*include\b|\btemplate\s*<", title + "\n" + text):
        return "cpp"
    return "general"


def _bounds(shape):
    value = shape.get("properties", {}).get("BoundingBox", shape.get("bounds", shape.get("boundingBox")))
    if isinstance(value, str):
        fields = dict(re.findall(r"\b(x|y|w|h|width|height)\s*:\s*(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)", value))
    elif isinstance(value, dict):
        fields = value
    else:
        return None
    try:
        output = {name: float(fields.get(name, fields.get(alias)))
                  for name, alias in (("x", "x"), ("y", "y"), ("width", "w"), ("height", "h"))}
    except (ValueError, TypeError):
        return None
    return output if all(math.isfinite(value) for value in output.values()) and output["width"] > 0 and output["height"] > 0 else None


def _date_label(text):
    """Recognize whole explicit date labels without inventing their precision."""
    value = text.strip().removeprefix("Date:").strip()
    if re.fullmatch(r"\d{4}(?:-\d{2})?(?:-\d{2})?", value):
        try:
            dt.date.fromisoformat(value + ("-01-01" if len(value) == 4 else "-01" if len(value) == 7 else ""))
            return value
        except ValueError:
            return ""
    match = re.fullmatch(rf"({MONTH_PATTERN})\.?\s+(?:(\d{{1,2}})(?:st|nd|rd|th)?\s*,?\s+)?(\d{{4}})", value, re.I)
    reverse = re.fullmatch(rf"(\d{{1,2}})(?:st|nd|rd|th)?\s+({MONTH_PATTERN})\.?\s*,?\s+(\d{{4}})", value, re.I)
    if not match and not reverse:
        return ""
    month_name, day, year = (match[1], match[2], match[3]) if match else (reverse[2], reverse[1], reverse[3])
    month = MONTHS[month_name.casefold()]
    try:
        dt.date(int(year), month, int(day or 1))
    except ValueError:
        return ""
    return f"{year}-{month:02d}" + (f"-{int(day):02d}" if day else "")


def _yearless_date(text):
    match = re.fullmatch(rf"({MONTH_PATTERN})\.?\s+(\d{{1,2}})(?:st|nd|rd|th)?(?:\s*,?\s+(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday))?",
                         text.strip(), re.I)
    return (MONTHS[match[1].casefold()], int(match[2]), match[3] or "") if match else None


def _explicit_date(node, display):
    value = _date_label(display)
    if value:
        return value, "explicit date label"
    # A date in a sentence or article title may describe another event. Only
    # dedicated source properties/fields are automatically timeline dates.
    for name, text in _text_fields(node):
        if name.casefold() in ("date", "eventdate", "event date"):
            value = _date_label(_display_text(text))
            if value:
                return value, f"explicit source field {name}"
    for name in ("EventDate", "eventDate"):
        value = _date_label(str(node.get("properties", {}).get(name, "")))
        if value:
            return value, f"explicit source property {name}"
    return "", ""


def _publication_date(node, display):
    for name in ("PublicationDate", "PublishedDate", "publicationDate"):
        value = _date_label(str(node.get("properties", {}).get(name, "")))
        if value:
            return value, f"explicit source property {name}"
    for name, text in _text_fields(node):
        if name.casefold() in ("publicationdate", "publication date", "published date", "date published"):
            value = _date_label(_display_text(text))
            if value:
                return value, f"explicit source field {name}"
    candidates = []
    patterns = (rf"\b\d{{1,2}}:\d{{2}}\s*(?:AM|PM)\s*[·•]\s*({MONTH_PATTERN})\.?\s+(\d{{1,2}})(?:st|nd|rd|th)?\s*,?\s+(\d{{4}})\b",
                rf"\bPublished(?:\s+on)?\s*:?\s*({MONTH_PATTERN})\.?\s+(\d{{1,2}})(?:st|nd|rd|th)?\s*,?\s+(\d{{4}})\b")
    for pattern in patterns:
        for match in re.finditer(pattern, display, re.I):
            value = _date_label(f"{match[1]} {match[2]}, {match[3]}")
            if value:
                candidates.append(value)
    if len(set(candidates)) == 1:
        return candidates[0], "explicit publication timestamp in source text"
    return "", ""


def _source_metadata(node):
    # Keep geometry, styling, field keys, literal fetched text and source identity
    # in the portable note itself, as well as the private coverage report.
    clean = dict(node)
    # The label may concatenate generated editor prompts and line numbers.
    # Authored TextAreas are authoritative, and the unmodified label stays in
    # the sourceRecords coverage copy.
    if _text_fields(node) and node.get("properties", {}).get("TextAreas"):
        clean.pop("label", None)
    clean["properties"] = dict(node.get("properties", {}))
    if "TextAreas" in clean["properties"]:
        clean["properties"]["TextAreas"] = [area for area in clean["properties"]["TextAreas"]
                                               if not _generated_field(node, area)]
    return "\n\nOriginal Lucid shape data:\n```json\n" + json.dumps(clean, ensure_ascii=False, sort_keys=True, indent=2) + "\n```"


def _source_url(document_id, page):
    return f"https://lucid.app/lucidchart/{quote(document_id, safe='')}/edit?page={quote(page, safe='')}"


def _section_candidates(nodes, edges, *, decode_prose_escapes):
    """Identify explicit containers and wide source headers, conservatively."""
    connected = {(page, edge[name]) for (page, _), edge in edges.items() for name in ("sourceId", "targetId")}
    sections = {}
    for key, node in nodes.items():
        bounds = _bounds(node)
        if not bounds:
            continue
        text = _display_text(_text(node), decode_prose_escapes).strip()
        kind = node["shapeType"].casefold()
        props = node.get("properties", {})
        container = ("container" in kind or "swimlane" in kind or "container" in str(props.get("BlockClass", "")).casefold())
        decoration = not text and not _urls(node) and node["shapeType"] not in ("User Image", "YouTube Video")
        # A small fully dated label can annotate one adjacent article. It is
        # still a dated note, but does not define a large timeline region.
        # Yearless day dividers are recognized only with an explicit month
        # heading above them in the same column.
        date_marker = _yearless_date(text)
        header = (node["shapeType"] in ("Process", "Text", "Block", "Rectangle") and bool(text)
                  and len(text) <= 90 and len(text.splitlines()) <= 3 and bounds["width"] >= 700
                  and bounds["height"] <= 220 and not _is_code(node))
        if container or header or decoration or date_marker:
            sections[key] = {"bounds": bounds, "title": _short(text, "Diagram region" if decoration else "Untitled section"),
                             "basis": "explicit container" if container else "decorative source geometry" if decoration else "explicit date heading" if date_marker else "wide source heading",
                             "container": container or decoration, "date": _date_label(text), "connected": key in connected,
                             "dateMarker": bool(date_marker), "dateProvenance": "explicit date label" if _date_label(text) else ""}
    months = {key: candidate for key, candidate in sections.items() if len(candidate["date"]) == 7}
    for key, candidate in sections.items():
        partial = _yearless_date(candidate["title"])
        if not partial:
            continue
        box = candidate["bounds"]
        choices = [(other_key, other) for other_key, other in months.items() if other_key[0] == key[0]
                   and other["bounds"]["y"] < box["y"]
                   and abs((box["x"] + box["width"] / 2) - (other["bounds"]["x"] + other["bounds"]["width"] / 2)) < 1600]
        if not choices:
            continue
        month_key, context = max(choices, key=lambda item: item[1]["bounds"]["y"])
        year, month = map(int, context["date"].split("-"))
        # Allow the next month in the same year while the source column
        # continues. Do not infer a year across a December/January boundary.
        if partial[0] not in (month, month + 1):
            continue
        try:
            date = dt.date(year, partial[0], partial[1])
        except ValueError:
            continue
        if partial[2] and date.strftime("%A").casefold() != partial[2].casefold():
            continue
        candidate["date"] = date.isoformat()
        candidate["dateProvenance"] = f"explicit month/day label, with year inherited from source heading {context['title']} ({month_key[1]})"
    sections = {key: value for key, value in sections.items()
                if value["basis"] != "explicit date heading" or value["date"]}
    return sections


def _layout_boards(source, nodes, ids, titles, section_candidates, stamp, report, board_title):
    boards, section_for = [], {}
    pages = list(dict.fromkeys(key[0] for key in nodes))
    for page in pages:
        page_nodes = {key: node for key, node in nodes.items() if key[0] == page}
        known = [_bounds(node) for node in page_nodes.values() if _bounds(node)]
        left, top = (min(box["x"] for box in known), min(box["y"] for box in known)) if known else (0, 0)
        origin_x, origin_y = left - 80, top - 80
        page_sections = {key: value for key, value in section_candidates.items() if key[0] == page}
        section_bounds = {}
        # Wide headings define sections down to the next aligned heading. The
        # original heading rectangle remains in the fidelity report unchanged.
        for key, candidate in page_sections.items():
            box = dict(candidate["bounds"])
            if not candidate["container"]:
                if candidate["dateMarker"] and candidate["bounds"]["width"] < 700:
                    # Date labels are narrow text shapes at the center of the
                    # source timeline column. Give their section the column's
                    # span, preserving the source label geometry in the report.
                    box["x"] -= (1400 - box["width"]) / 2
                    box["width"] = 1400
                later = [other["bounds"]["y"] for other_key, other in page_sections.items()
                         if other_key != key and not other["container"] and other["bounds"]["y"] > box["y"] + box["height"]
                         and abs((other["bounds"]["x"] + other["bounds"]["width"] / 2) - (box["x"] + box["width"] / 2)) <= max(box["width"], other["bounds"]["width"]) * .65]
                bottom = min(later) - 20 if later else max((item["y"] + item["height"] for item in known
                             if box["x"] - box["width"] * .6 <= item["x"] + item["width"] / 2 <= box["x"] + box["width"] * 1.6
                             and item["y"] >= box["y"]), default=box["y"] + box["height"])
                box["x"] -= box["width"] * .6
                box["width"] *= 2.2
                box["height"] = max(candidate["bounds"]["height"], bottom - box["y"])
            section_bounds[key] = box
        sections = []
        for key, candidate in page_sections.items():
            box = section_bounds[key]
            sections.append({"id": stable_id("section", source["documentId"], *key), "title": candidate["title"],
                             "shardId": ids.get(key, ""),
                             "x": round(box["x"] - origin_x, 3), "y": round(box["y"] - origin_y, 3),
                             "width": round(box["width"], 3), "height": round(box["height"], 3), "collapsed": False})
            report["sectionMapping"].append({"pageId": page, "sourceId": key[1], "sectionId": sections[-1]["id"],
                                             "shardId": sections[-1]["shardId"], "title": candidate["title"],
                                             "basis": candidate["basis"], "originalBounds": candidate["bounds"]})
        items, missing = [], 0
        for key, node in page_nodes.items():
            if key not in ids or key in page_sections:
                continue
            box = _bounds(node)
            if not box:
                box = {"x": left + missing % 4 * 300, "y": top - 300 - missing // 4 * 220, "width": 260, "height": 180}
                missing += 1
                report["warnings"].append(f"Shape {key[1]} has no usable BoundingBox. Its board position is a fallback grid.")
            center_x, center_y = box["x"] + box["width"] / 2, box["y"] + box["height"] / 2
            contained = [(section_key, section_bounds[section_key]) for section_key in page_sections
                         if section_bounds[section_key]["x"] <= center_x <= section_bounds[section_key]["x"] + section_bounds[section_key]["width"]
                         and section_bounds[section_key]["y"] <= center_y <= section_bounds[section_key]["y"] + section_bounds[section_key]["height"]]
            # Smallest containing region is the most specific source placement.
            if contained:
                section_key, _ = min(contained, key=lambda item: (item[1]["width"] * item[1]["height"], item[0]))
                section_for[key] = section_key
            items.append({"shardId": ids[key], "x": round(box["x"] - origin_x, 3), "y": round(box["y"] - origin_y, 3),
                          "width": round(box["width"], 3), "height": round(box["height"], 3),
                          "sectionId": stable_id("section", source["documentId"], *section_for[key]) if key in section_for else ""})
        # A searchable heading remains a shard even though the board displays it
        # as a section title rather than another card.
        width = max((box["x"] + box["width"] for box in known), default=left + 1000) - origin_x
        height = max((box["y"] + box["height"] for box in known), default=top + 700) - origin_y
        title = board_title or source.get("title") or "Imported LucidChart"
        page_title = next((item["pageTitle"] for item in report["mapping"] if item["pageId"] == page), page)
        if len(pages) > 1:
            title += " · " + page_title
        board = {"id": stable_id("board", source["documentId"], page), "title": str(title)[:240],
                 "description": "Imported LucidChart layout. Source coordinates, headings and note identities are preserved.",
                 "sourceUrl": _source_url(source["documentId"], page), "items": items, "sections": sections,
                 "viewport": {"x": 0, "y": 0, "zoom": round(max(.005, min(1, 1200 / max(width, 1), 800 / max(height, 1))), 4)},
                 "createdAt": stamp, "updatedAt": stamp}
        boards.append(board)
        report["boardMapping"].append({"pageId": page, "boardId": board["id"], "sourceOrigin": {"x": origin_x, "y": origin_y},
                                       "itemCount": len(items), "sectionCount": len(sections), "sourceWidth": width, "sourceHeight": height})
    return boards, section_for


def convert_document(source, images=None, *, manifest_dir=None, domain="auto", title=None, decode_prose_escapes=True):
    """Return (archive, coverage report), retaining one shard per meaningful shape."""
    if not isinstance(source, dict) or not isinstance(source.get("documentId"), str) or not source["documentId"]:
        raise ValueError("The source needs a documentId.")
    document_id = source["documentId"]
    stamp = _stamp(source.get("fetchedAt"))
    nodes, edges, locations, groups, duplicates = _inventory(source)
    if not nodes:
        raise ValueError("No Lucid source shapes were found.")
    fetched_chunks, expected_chunks = collections.defaultdict(set), {}
    for region in source["regions"]:
        for page in region.get("pages", []):
            for chunk in page.get("requestedChunks", []):
                if type(chunk.get("chunkIndex")) is int:
                    fetched_chunks[page["pageId"]].add(chunk["chunkIndex"])
            if type(page.get("totalChunks")) is int:
                count = page["totalChunks"]
                if page["pageId"] in expected_chunks and expected_chunks[page["pageId"]] != count:
                    raise ValueError("Conflicting source page chunk counts. Refetch the document consistently.")
                expected_chunks[page["pageId"]] = count
    images = images or {}
    if not isinstance(images, dict):
        raise ValueError("The images manifest must map source shape IDs to image entries.")
    selected_domain = _domain(source, nodes, domain)
    contexts, conflicts = _release_context(nodes, edges) if selected_domain == "cpp" else ({}, [])
    section_candidates = _section_candidates(nodes, edges, decode_prose_escapes=decode_prose_escapes)
    neighbors = collections.defaultdict(list)
    for (page, _), edge in edges.items():
        origin, target = (page, edge["sourceId"]), (page, edge["targetId"])
        if origin in nodes and target in nodes:
            neighbors[origin].append(("to", target))
            neighbors[target].append(("from", origin))
    archive = {"schemaVersion": 1, "shards": [], "links": [], "reviews": [], "assets": [], "boards": []}
    report = {"documentId": document_id, "fetchedAt": stamp, "sourceShapeCount": len(nodes),
              "sourceEdgeCount": len(edges), "shapeTypes": dict(collections.Counter(n["shapeType"] for n in nodes.values())),
              "mapping": [], "skipped": [], "unsupported": [], "missingImages": [], "skippedEdges": [],
              "versionConflicts": conflicts, "duplicateFetchRecords": duplicates, "textFields": [],
              "domain": selected_domain, "title": title or source.get("title", "Imported LucidChart"),
              "sourceRecords": [{"pageId": key[0], "sourceId": key[1], "shape": node} for key, node in nodes.items()],
              "sourceEdgeRecords": [{"pageId": key[0], "sourceId": key[1], "edge": edge} for key, edge in edges.items()],
              "sectionMapping": [], "boardMapping": [], "metadataInferences": [], "warnings": [], "displayTransformations": []}
    report["fetchedRegionCount"] = len(source["regions"])
    report["regionCoverage"] = [{"pageId": page, "expectedChunks": count, "fetchedChunks": sorted(fetched_chunks[page]),
                                 "missingChunks": sorted(set(range(count)) - fetched_chunks[page])}
                                for page, count in expected_chunks.items()]
    report["completeSourceCoverage"] = all(not item["missingChunks"] for item in report["regionCoverage"]) if expected_chunks else None
    for item in report["regionCoverage"]:
        if item["missingChunks"]:
            report["warnings"].append(f"Page {item['pageId']} is missing source chunks {item['missingChunks']}. Coverage applies only to retrieved regions.")
    ids, titles, retained = {}, {}, {}
    assets = {}
    for key, node in nodes.items():
        shape_type = node["shapeType"]
        raw = _text(node)
        urls = _urls(node)
        has_image = key[1] in images
        is_image = shape_type == "User Image"
        if not raw.strip() and not urls and not is_image and not has_image:
            report["skipped" if key in section_candidates or shape_type in ("Freehand Drawing", "Rectangle") else "unsupported"].append(
                {**locations[key], "sourceId": key[1], "shapeType": shape_type,
                 "reason": "No source text, link, or image. Decorative geometry retained as a board section and in the coverage report." if key in section_candidates else
                           "No source text, link, image, or usable geometry. Raw source record retained in the coverage report."})
            continue
        ids[key] = stable_id("shard", document_id, *key)
        retained[key] = node
        report["textFields"].extend({"pageId": key[0], "sourceId": key[1], "key": name, "text": text}
                                    for name, text in _text_fields(node))
        if _is_code(node):
            note_title = "C++ code example" if selected_domain == "cpp" else "Code example"
        elif is_image or has_image:
            note_title = _short(_display_text(raw, decode_prose_escapes), "C++ image note" if selected_domain == "cpp" else "LucidChart image note")
        elif shape_type == "Table":
            note_title = ("C++ table: " if selected_domain == "cpp" else "Table: ") + " / ".join(_short(text) for _, text in _text_fields(node)[:3])
        elif not raw.strip() and urls:
            note_title = "Video reference" if shape_type == "YouTube Video" else "Linked reference"
        else:
            note_title = _short(_display_text(raw, decode_prose_escapes), "C++ note" if selected_domain == "cpp" else "LucidChart note")
        titles[key] = note_title[:240]
    # Add actual connected labels to otherwise anonymous image/code examples.
    for key, node in retained.items():
        if (node["shapeType"] != "User Image" and not _is_code(node)) or (node["shapeType"] == "User Image" and _text(node).strip()):
            continue
        candidates = [other for _, other in neighbors[key] if other in retained and _text(nodes[other]).strip()
                      and not _is_code(nodes[other]) and nodes[other]["shapeType"] != "Table"]
        candidates.sort(key=lambda other: (0 if len(_text(nodes[other])) <= 120 else 1,
                                           1 if nodes[other]["shapeType"] == "Embedded Link Block" else 0,
                                           len(_text(nodes[other])), other))
        if candidates:
            suffix = "image" if node["shapeType"] == "User Image" else "code example"
            titles[key] = (_short(_display_text(_text(nodes[candidates[0]]), decode_prose_escapes)) + " · " + suffix)[:240]
    archive["boards"], section_for = _layout_boards(source, nodes, ids, titles, section_candidates, stamp, report, title)
    for key, node in retained.items():
        raw = _text(node)
        shape_type = node["shapeType"]
        urls = _urls(node)
        is_code = _is_code(node)
        if is_code:
            # Never unescape this string. Real line breaks and C++ '\\n' literals
            # coexist in Lucid TextAreas and must survive independently.
            fields = _text_fields(node)
            code = next((text for name, text in fields if name == "Text"), raw)
            language = "cpp" if selected_domain == "cpp" else "text"
            content = "```" + language + "\n" + code + ("" if code.endswith("\n") else "\n") + "```"
            extras = [text for name, text in fields if name != "Text"]
            if extras:
                content += "\n\n" + "\n\n".join(extras)
        elif shape_type == "Table":
            content = _plain_table(node, decode_prose_escapes=decode_prose_escapes and selected_domain != "cpp")
        else:
            content = "\n\n".join(_prose(_display_text(text, decode_prose_escapes)) if selected_domain == "cpp" else _display_text(text, decode_prose_escapes)
                                    for _, text in _text_fields(node))
        if not is_code:
            for name, text in _text_fields(node):
                display = _display_text(text, decode_prose_escapes)
                if display != text:
                    report["displayTransformations"].append({"pageId": key[0], "sourceId": key[1], "key": name,
                                                              "basis": "decoded Unicode and whitespace from a second prose transport-escape layer",
                                                              "originalText": text, "displayText": display})
        if urls:
            content += ("\n\n" if content else "") + "\n".join(f"[Linked source {i + 1}]({url})" for i, url in enumerate(urls))
        if key[1] in images:
            asset = _image_asset(images[key[1]], manifest_dir, stamp)
            assets.setdefault(asset["id"], asset)
            content += ("\n\n" if content else "") + f"![LucidChart image](/assets/{asset['id']})"
        elif shape_type == "User Image":
            image_url = node.get("properties", {}).get("ImageUrl", "")
            content += ("\n\n" if content else "") + "Image from the original LucidChart note; not yet saved offline."
            if isinstance(image_url, str) and image_url.startswith(("https://", "http://")):
                content += f"\n\n[Original image]({image_url})"
            report["missingImages"].append({"pageId": key[0], "sourceId": key[1], "imageUrl": image_url})
        source_url = _source_url(document_id, key[0])
        context = contexts.get(key)
        if context and len(context["path"]) > 1:
            path_titles = [titles.get((key[0], item), _short(_text(nodes[(key[0], item)]), item))
                           for item in context["path"][:-1]]
            content += "\n\nDiagram release context: " + " → ".join(path_titles) + ". This records the source diagram's placement."
        connected = []
        for direction, other in neighbors[key]:
            if other in ids:
                label = titles[other].replace("|", "∣").replace("]", "］")
                connected.append(f"- {'From' if direction == 'from' else 'To'} [[id:{ids[other]}|{label}]]")
        if connected:
            content += "\n\nDiagram connections:\n" + "\n".join(dict.fromkeys(connected))
        content += f"\n\nImported from [LucidChart · {locations[key]['pageTitle']}]({source_url}). Source shape: `{key[1]}`."
        topic_text = raw + "\n" + "\n".join(_text(nodes[other]) for _, other in neighbors[key]
                                               if not raw.strip() and other in nodes)
        tags = ["LucidChart"] + (["C++"] if selected_domain == "cpp" else [])
        tags += [tag for tag, pattern in (TOPICS if selected_domain == "cpp" else GENERAL_TOPICS) if re.search(pattern, topic_text, re.I)]
        section_key = section_for.get(key)
        section = section_candidates.get(section_key)
        if section and section["basis"] == "wide source heading" and len(section["title"]) <= 80:
            tags.append(section["title"])
        if is_code:
            tags.append("Code examples")
        if shape_type == "User Image" or key[1] in images:
            tags.append("Images")
        if urls:
            tags.append("Links")
        if shape_type == "Table":
            tags.append("Tables")
        display_raw = _display_text(raw, decode_prose_escapes) if not is_code else raw
        publication_date, publication_basis = _publication_date(node, display_raw)
        event_date, date_basis = _explicit_date(node, display_raw)
        if key in section_candidates and section_candidates[key]["date"]:
            event_date = section_candidates[key]["date"]
            date_basis = section_candidates[key]["dateProvenance"]
        elif not event_date and section and section["date"]:
            event_date = section["date"]
            date_basis = f"geometric placement beneath source date heading {section['title']} ({section_key[1]}), {section['dateProvenance']}"
        entities = [label for label, pattern, _ in ENTITY_PATTERNS if re.search(pattern, display_raw, re.I)]
        entities += list(dict.fromkeys(re.findall(r"\bGPT[- ]\d[\w.-]*", display_raw, re.I)))
        entity_type = next((kind for label, pattern, kind in ENTITY_PATTERNS if re.fullmatch(pattern, display_raw.strip(), re.I)), "")
        event_type = ""
        if event_date:
            if re.search(r"\b(?:rumou?r|leaked?|unconfirmed)\b", display_raw, re.I):
                event_type = "rumor"
            elif re.search(r"\b(?:forecast|predict\w*|will achieve|will reach|chance of|probability of)\b", display_raw, re.I):
                event_type = "forecast"
            elif re.search(r"\b(?:released?|launch(?:ed)?)\b", display_raw, re.I):
                event_type = "release"
            elif re.search(r"\b(?:announc\w*)\b", display_raw, re.I):
                event_type = "announcement"
            elif re.search(r"\b(?:paper|research|study|conjecture)\b", display_raw, re.I):
                event_type = "research"
            else:
                event_type = "event"
        if publication_basis:
            content += "\n\nPublication date provenance: " + publication_basis + "."
        if date_basis:
            content += "\n\nTimeline date provenance: " + date_basis + ". The date describes the source placement, with the source's precision."
        content += _source_metadata(node)
        shard = {"id": ids[key], "title": titles[key], "content": content, "tags": list(dict.fromkeys(tags)),
                 "kind": "example" if is_code else "concept", "status": "learning", "sourceUrl": source_url,
                 "languageVersion": context["version"] if context else "", "eventDate": event_date, "createdAt": stamp,
                 "updatedAt": stamp, "prompt": "", "reviewCount": 0, "lastReviewedAt": None, "nextReviewAt": None,
                 "evidenceStatus": "unverified", "sources": [{"url": url, "title": "Linked source" if url != source_url else "Original LucidChart shape",
                     "publishedDate": publication_date if url != source_url else "", "accessedDate": stamp[:10], "note": f"Imported from source shape {key[1]}, page {key[0]}. Source claims have not been independently verified."}
                     for url in list(dict.fromkeys([*urls, source_url]))], "publicationDate": publication_date, "verifiedDate": "",
                 "eventType": event_type, "entities": list(dict.fromkeys(entities)), "entityType": entity_type,
                 "inbox": False, "facts": []}
        archive["shards"].append(shard)
        report["mapping"].append({**locations[key], "sourceId": key[1], "shardId": ids[key], "title": titles[key],
                                  "sourceLabel": node.get("label", ""),
                                  "shapeType": shape_type, "languageVersion": shard["languageVersion"],
                                  "releaseContext": context, "role": "section heading and searchable note" if key in section_candidates else "note card",
                                  "sourceBounds": _bounds(node), "eventDate": event_date, "dateProvenance": date_basis})
        report["mapping"][-1].update({"publicationDate": publication_date, "publicationDateProvenance": publication_basis})
        if entities or date_basis or event_type or publication_basis:
            report["metadataInferences"].append({"pageId": key[0], "sourceId": key[1], "entities": entities,
                                                "entityBasis": "literal entity names in source text", "eventDate": event_date,
                                                "dateBasis": date_basis, "eventType": event_type,
                                                "eventTypeBasis": "source wording, available for review", "publicationDate": publication_date,
                                                "publicationDateBasis": publication_basis})
    # Shard Atlas has one relationship per directional (from, to, type) triple.
    # Parallel source arrows are consolidated with every original edge ID noted.
    triples = {}
    for (page, edge_id), edge in edges.items():
        origin, target = (page, edge["sourceId"]), (page, edge["targetId"])
        if origin not in ids or target not in ids or origin == target:
            report["skippedEdges"].append({"pageId": page, "sourceId": edge_id, "fromId": edge["sourceId"],
                                            "toId": edge["targetId"], "reason": "Endpoint is decorative, missing, or the same shape."})
            continue
        triple = (ids[origin], ids[target])
        entry = triples.setdefault(triple, {"id": stable_id("edge", document_id, page, edge["sourceId"], edge["targetId"]),
                                            "fromId": triple[0], "toId": triple[1], "type": "related_to",
                                            "createdAt": stamp, "note": "", "sourceEdges": []})
        label = _text(edge)
        props = edge.get("properties", {})
        styles = []
        for name in ("Endpoint1", "Endpoint2"):
            match = re.search(r"style:\s*([^,]+)", str(props.get(name, "")))
            if match:
                styles.append(f"{name}: {match[1].strip()}")
        part = f"LucidChart connection `{edge_id}`: source `{edge['sourceId']}` → target `{edge['targetId']}`."
        if styles:
            part += " " + "; ".join(styles) + "."
        if label:
            part += " Label: " + label
        entry["sourceEdges"].append(edge_id)
        entry["note"] += ("\n" if entry["note"] else "") + part
    report["edgeMapping"] = [{"sourceIds": entry["sourceEdges"], "linkId": entry["id"]} for entry in triples.values()]
    archive["links"] = [{name: value for name, value in entry.items() if name != "sourceEdges"} for entry in triples.values()]
    archive["assets"] = list(assets.values())
    report["importedShapeCount"] = len(archive["shards"])
    report["importedLinkCount"] = len(archive["links"])
    report["assetCount"] = len(archive["assets"])
    report["assetBytes"] = sum(asset["size"] for asset in archive["assets"])
    report["versionedShapeCount"] = sum(bool(shard["languageVersion"]) for shard in archive["shards"])
    report["unreferencedImageManifestIds"] = sorted(set(images) - {key[1] for key in retained})
    meaningful = [key for key, node in nodes.items() if _text(node).strip() or _urls(node) or node["shapeType"] == "User Image" or key[1] in images]
    report["meaningfulShapeCount"] = len(meaningful)
    report["transferredMeaningfulShapeCount"] = sum(key in retained for key in meaningful)
    report["transferredImageShapeCount"] = sum(node["shapeType"] == "User Image" and key[1] in images for key, node in retained.items())
    report["sourceImageShapeCount"] = sum(node["shapeType"] == "User Image" for node in nodes.values())
    report["transferredSourceEdgeCount"] = sum(len(item["sourceIds"]) for item in report["edgeMapping"])
    report["boardCount"] = len(archive["boards"])
    report["sectionCount"] = sum(len(board["sections"]) for board in archive["boards"])
    board_ids = {item["shardId"] for board in archive["boards"] for item in board["items"]}
    board_ids.update(section["shardId"] for board in archive["boards"] for section in board["sections"] if section["shardId"])
    note_ids = {shard["id"] for shard in archive["shards"]}
    missing_anchors = [{"sourceEdgeId": edge_id, "pageId": page, "endpoint": endpoint,
                        "sourceShapeId": edge[endpoint], "shardId": ids.get((page, edge[endpoint]), "")}
                       for (page, edge_id), edge in edges.items() for endpoint in ("sourceId", "targetId")
                       if ids.get((page, edge[endpoint]), "") not in board_ids]
    report["boardCoverage"] = {"substantiveNotes": len(note_ids), "representedNotes": len(note_ids & board_ids),
                               "missingNoteIds": sorted(note_ids - board_ids), "sourceArrowEndpoints": len(edges) * 2,
                               "representedArrowEndpoints": len(edges) * 2 - len(missing_anchors), "missingArrowAnchors": missing_anchors}
    report["untransferredSubstantiveText"] = [{"pageId": key[0], "sourceId": key[1], "key": name, "text": text}
                                               for key, node in nodes.items() if key not in retained for name, text in _text_fields(node) if text.strip()]
    report["noLostSubstantiveText"] = not report["untransferredSubstantiveText"]
    report["coverage"] = {"meaningfulShapes": {"source": len(meaningful), "transferred": report["transferredMeaningfulShapeCount"]},
                          "images": {"source": report["sourceImageShapeCount"], "transferred": report["transferredImageShapeCount"], "missing": len(report["missingImages"])},
                          "edges": {"source": len(edges), "transferred": report["transferredSourceEdgeCount"], "skipped": len(report["skippedEdges"])},
                          "noLostSubstantiveText": report["noLostSubstantiveText"]}
    if report["missingImages"]:
        report["warnings"].append(f"{len(report['missingImages'])} source image shapes have not been saved offline. Their source identity and URLs remain in the notes.")
    if report["skippedEdges"]:
        report["warnings"].append(f"{len(report['skippedEdges'])} source arrows could not become note relationships. Original edge records remain in the coverage report.")
    return archive, report


def load_source(path, *, fetched_at=None, title=None):
    """Read an assembled source or a directory of saved Lucid tool responses."""
    path = Path(path)
    paths = sorted(path.glob("region-*.json")) if path.is_dir() else [path]
    if not paths:
        raise ValueError("No region-*.json source files were found.")
    regions, document_ids, source_title, source_stamp = [], set(), "", ""
    for file in paths:
        value = json.loads(file.read_text(encoding="utf-8"))
        if not isinstance(value, dict):
            raise ValueError(f"Lucid input {file.name} must contain an object.")
        identifier = value.get("documentId", value.get("document_id"))
        if identifier:
            document_ids.add(identifier)
        source_title = source_title or value.get("title", "")
        source_stamp = source_stamp or value.get("fetchedAt", "")
        if isinstance(value.get("text"), str):
            value = json.loads(value["text"])
        if isinstance(value.get("regions"), list):
            regions.extend(value["regions"])
        elif isinstance(value.get("pages"), list):
            regions.append(value)
        else:
            raise ValueError(f"Lucid input {file.name} needs pages, regions, or a fetched text response.")
    if len(document_ids) != 1:
        raise ValueError("All input regions must have one consistent Lucid document ID.")
    return {"documentId": document_ids.pop(), "fetchedAt": fetched_at or source_stamp,
            "title": title or source_title, "regions": regions}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", type=Path, help="Private fetched source JSON or directory of region-*.json tool responses")
    parser.add_argument("--output", required=True, type=Path, help="Portable Shard Atlas JSON archive")
    parser.add_argument("--report", required=True, type=Path, help="Private source coverage report")
    parser.add_argument("--images", type=Path, help="Optional source-ID to local image/base64 manifest")
    parser.add_argument("--domain", choices=("auto", "cpp", "career-ai", "general"), default="auto", help="Topic and code-language domain, auto-detected from source")
    parser.add_argument("--title", help="Imported board title, otherwise uses the document title")
    parser.add_argument("--fetched-at", help="ISO fetch date/timestamp when tool response files do not contain fetchedAt")
    parser.add_argument("--preserve-prose-escapes", action="store_true", help="Do not decode clearly transport-escaped prose Unicode/whitespace")
    args = parser.parse_args()
    # Script execution puts tools/ on sys.path rather than the project root.
    import sys
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    source = load_source(args.input, fetched_at=args.fetched_at, title=args.title)
    images = json.loads(args.images.read_text(encoding="utf-8")) if args.images else None
    archive, report = convert_document(source, images, manifest_dir=args.images.parent if args.images else None,
                                       domain=args.domain, title=args.title, decode_prose_escapes=not args.preserve_prose_escapes)
    from server import Store
    import tempfile
    # Validate through the application's actual import boundary, never live data.
    with tempfile.TemporaryDirectory(prefix="shard-lucid-validate-") as temporary:
        store = Store(Path(temporary) / "validate.sqlite3", seed=False, backup_on_start=False, automatic_backups=False)
        store.import_data(archive)
        second = store.import_data(archive)
        if any(second["importSummary"]["added"].values()):
            raise ValueError("Reimporting the generated archive was not idempotent.")
    for path, data in ((args.output, archive), (args.report, report)):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({name: report[name] for name in ("sourceShapeCount", "sourceEdgeCount", "importedShapeCount",
                                                     "importedLinkCount", "assetCount", "assetBytes", "versionedShapeCount")}, indent=2))


if __name__ == "__main__":
    main()
