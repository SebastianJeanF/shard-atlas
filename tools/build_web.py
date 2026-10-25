#!/usr/bin/env python3
"""Compose the browser application from the shared interface and browser host."""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from release_manifest import generate_manifest, write_embedded_manifest
BUILD_MARKER = ".shard-atlas-web-build"
PRIVATE_PATHS = {"drive-inbox.js", "spiral/local-emblems"}
CONFIG_KEYS = {"clientId", "folderId", "expectedEmail"}


def public_files(folder: Path):
    for source in sorted(folder.rglob("*")):
        relative = source.relative_to(folder)
        if any(part.startswith(".") for part in relative.parts):
            continue
        if any(relative == Path(excluded) or Path(excluded) in relative.parents for excluded in PRIVATE_PATHS):
            continue
        if source.is_symlink():
            raise ValueError(f"Public assets must not be symlinks: {relative}")
        if source.is_file():
            yield source, relative


def replace_block(html: str, name: str, replacement: str) -> str:
    pattern = rf"[ \t]*<!-- platform:{re.escape(name)}:start -->\n.*?<!-- platform:{re.escape(name)}:end -->"
    result, count = re.subn(pattern, lambda _: replacement.rstrip("\n"), html, flags=re.S)
    if count != 1:
        raise ValueError(f"Expected one declared platform block: {name}")
    return result


def browser_html() -> str:
    html = (ROOT / "static/index.html").read_text(encoding="utf-8")
    marker = "  <!-- platform:head -->"
    if html.count(marker) != 1:
        raise ValueError("Expected one declared platform head slot")
    html = html.replace(marker, (ROOT / "web/head.html").read_text(encoding="utf-8").rstrip("\n"))
    html = replace_block(html, "mac-drive", "")
    html = replace_block(html, "mac-drive-script", "")
    return replace_block(html, "entry", (ROOT / "web/entry.html").read_text(encoding="utf-8"))


def refresh_offline_cache(output: Path) -> str:
    files = sorted("/" + relative.as_posix() for _, relative in public_files(output)
                   if relative.as_posix() not in {"sw.js", "drive-config.json"})
    worker = output / "sw.js"
    source = worker.read_text(encoding="utf-8")
    cache_pattern = r"const CACHE_NAME = '[^']+';"
    inventory_pattern = r"const PRECACHE_FILES = \[[^\n]*\];"
    if len(re.findall(cache_pattern, source)) != 1 or len(re.findall(inventory_pattern, source)) != 1:
        raise ValueError("The service worker must contain one cache identity and one asset inventory")
    normalized = re.sub(cache_pattern, "const CACHE_NAME = '__GENERATED_CACHE_ID__';", source)
    normalized = re.sub(inventory_pattern, "const PRECACHE_FILES = __GENERATED_ASSET_INVENTORY__;", normalized)
    digest = hashlib.sha256(normalized.encode("utf-8"))
    for file in files:
        digest.update(file.encode("utf-8"))
        digest.update((output / file[1:]).read_bytes())
    identity = "shard-atlas-shell-" + digest.hexdigest()[:20]
    source = re.sub(cache_pattern, f"const CACHE_NAME = '{identity}';", source)
    source = re.sub(inventory_pattern, lambda _: "const PRECACHE_FILES = " + json.dumps(["/", *files], separators=(",", ":")) + ";", source)
    worker.write_text(source, encoding="utf-8", newline="\n")
    return identity


def drive_configuration(path: Path) -> dict:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict) or set(value) != CONFIG_KEYS or any(not isinstance(item, str) for item in value.values()):
        raise ValueError("Drive deployment configuration must contain only clientId, folderId, and expectedEmail strings")
    return value


def build(output: Path, drive_config: Path | None = None) -> dict:
    output = output.resolve()
    if output == ROOT or ROOT.is_relative_to(output) or any(output.is_relative_to(ROOT / folder) for folder in ("static", "web", "tools", "tests", "desktop", "docs")):
        raise ValueError("Build output must be separate from source directories")
    if output.exists() and (not output.is_dir() or any(output.iterdir()) and not (output / BUILD_MARKER).is_file()):
        raise ValueError("Refusing to replace a nonempty directory that is not a generated Shard Atlas web build")
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".shard-atlas-web-", dir=output.parent) as temporary:
        staging = Path(temporary) / "application"
        staging.mkdir()
        for source, relative in public_files(ROOT / "static"):
            target = staging / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, target)
        for source, relative in public_files(ROOT / "web/public"):
            target = staging / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, target)
        for source in sorted((ROOT / "web").glob("*.mjs")):
            shutil.copyfile(source, staging / source.name)
        if (ROOT / "sync").is_dir():
            for name in ("client.mjs", "protocol.mjs"):
                source = ROOT / "sync" / name
                if not source.is_file():
                    raise ValueError(f"Missing browser sync module: {name}")
                (staging / "sync").mkdir(exist_ok=True)
                shutil.copyfile(source, staging / "sync" / source.name)
        shutil.copyfile(ROOT / "web/sw.js", staging / "sw.js")
        (staging / "index.html").write_text(browser_html(), encoding="utf-8", newline="\n")
        release = generate_manifest(ROOT)
        write_embedded_manifest(staging, release)
        if drive_config:
            configuration = drive_configuration(drive_config)
            (staging / "drive-config.json").write_text(json.dumps(configuration, indent=2) + "\n", encoding="utf-8", newline="\n")
        fingerprint = hashlib.sha256()
        for source, relative in public_files(staging):
            if relative.as_posix() in {"drive-config.json", "sw.js"}:
                continue
            fingerprint.update(relative.as_posix().encode("utf-8"))
            fingerprint.update(source.read_bytes())
        try:
            revision = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True, stderr=subprocess.DEVNULL).strip()
        except (OSError, subprocess.CalledProcessError):
            revision = "unknown"
        info = {"format": "shard-atlas-web-build/v1", "sourceRevision": revision, "interfaceFingerprint": fingerprint.hexdigest(), "release": release}
        (staging / "build-info.json").write_text(json.dumps(info, indent=2) + "\n", encoding="utf-8", newline="\n")
        cache_identity = refresh_offline_cache(staging)
        (staging / BUILD_MARKER).write_text("Generated by tools/build_web.py\n", encoding="utf-8")
        if output.exists():
            output.rename(Path(temporary) / "previous")
        staging.rename(output)
    return {**info, "cacheIdentity": cache_identity, "fileCount": sum(1 for _ in public_files(output))}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=ROOT / "web-dist")
    parser.add_argument("--drive-config", type=Path, help="Private deployment settings; never copied into tracked source")
    parser.add_argument("--refresh-cache", type=Path, help="Regenerate only an existing build's service-worker inventory")
    args = parser.parse_args()
    if args.refresh_cache:
        print(refresh_offline_cache(args.refresh_cache))
    else:
        print(json.dumps(build(args.output, args.drive_config), indent=2))


if __name__ == "__main__":
    main()
