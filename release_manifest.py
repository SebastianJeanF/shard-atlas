"""Deterministic identities for published software, independent of user data.

Runtime source files are named explicitly. Asset and hosted dependency roots are
allowlisted separately; generated output and local configuration never enter an
identity. Adding a runtime module requires updating these lists and their tests.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import re

APPLICATION = "shard-atlas"
SCHEMA_VERSION = 1
DIGEST = re.compile(r"[a-f0-9]{64}\Z")
FIELDS = ("releaseId", "frontendId", "backendId", "hostedId", "nativeId")
FRONTEND_FILES = (
    "static/index.html", "static/app.js", "static/platform.js", "static/styles.css", "static/image-editor.js",
    "static/academic.js", "static/academic.css", "static/code-solutions.js", "static/code-solutions.css",
    "static/experiments.js", "static/experiments.css", "static/learning.js", "static/learning.css",
    "static/import-review.js", "static/library-sync.js", "static/library-sync.css",
    "static/release-status.js", "static/release-status.css", "static/ai-instructions.md", "static/cloud-backups.js",
    "static/cpp-releases.json", "static/spiral-timeline.json", "static/icon.svg",
    "web/archives.mjs", "web/bootstrap.mjs", "web/drive-client.mjs", "web/drive-ui.mjs",
    "web/entry.html", "web/exports.mjs", "web/head.html", "web/inbox.mjs",
    "web/knowledge-validation.mjs", "web/library-sync.mjs", "web/model.mjs", "web/persistence.mjs",
    "web/sw.js", "web/cloud-backups.mjs", "web/backup-policy.mjs", "sync/client.mjs", "sync/protocol.mjs", "tools/build_web.py",
)
FRONTEND_ASSET_ROOTS = ("static/vendor/katex", "static/spiral", "web/public")
BACKEND_FILES = ("server.py", "library_sync.py", "cloud_backups.py", "release_manifest.py", "release_status.py", "seed.json")
NATIVE_FILES = ("desktop/ShardAtlas.swift", "desktop/ImageText.swift", "desktop/build.py", "desktop/ShardAtlas.icns", "static/drive-inbox.js")
HOSTED_FILES = ("sync/worker.mjs", "sync/storage.mjs", "sync/protocol.mjs", "sync/release.mjs", "sync/schema.sql", "tools/build_host.py", "release_manifest.py",
                "static/ai-instructions.md", "web/model.mjs", "web/inbox.mjs", "web/archives.mjs", "web/knowledge-validation.mjs", "sync/client.mjs",
                "hosting/package.json", "hosting/package-lock.json", "hosting/vite.config.ts", "hosting/next.config.ts",
                "hosting/tsconfig.json", "hosting/postcss.config.mjs", "hosting/cloudflare-env.d.ts", "hosting/drizzle.config.ts",
                ".openai/hosting.json", "tools/cloud_backup_runner.py")
HOSTED_ROOTS = ("hosting/app", "hosting/lib", "hosting/worker", "hosting/db", "hosting/drizzle", "hosting/scripts",
                "hosting/components", "hosting/hooks", "hosting/vendor")
GENERATED_NAMES = {"release-manifest.json", "release-manifest.js", "build-info.json", ".DS_Store"}


def _asset_files(root: Path, roots: tuple[str, ...]):
    for name in roots:
        directory = root / name
        if not directory.is_dir():
            raise ValueError(f"Missing release source directory: {name}")
        for path in sorted(directory.rglob("*")):
            relative = path.relative_to(root)
            if any(part.startswith(".") or part in {"node_modules", "local-emblems", "__pycache__"} for part in relative.parts):
                continue
            if path.name in GENERATED_NAMES or relative.as_posix() == "web/public/drive-config.json":
                continue
            if path.is_symlink():
                raise ValueError(f"Release sources must not be symlinks: {relative}")
            if path.is_file():
                yield relative.as_posix()


def source_files(root: Path, component: str) -> tuple[str, ...]:
    root = Path(root)
    files, directories = {
        "frontend": (FRONTEND_FILES, FRONTEND_ASSET_ROOTS),
        "backend": (BACKEND_FILES, ()),
        "native": (NATIVE_FILES, ()),
        "hosted": (HOSTED_FILES, HOSTED_ROOTS),
    }[component]
    return tuple(sorted(set(files) | set(_asset_files(root, directories))))


def component_id(root: Path, component: str) -> str:
    root = Path(root)
    digest = hashlib.sha256()
    for name in source_files(root, component):
        path = root / name
        if path.is_symlink() or not path.is_file():
            raise ValueError(f"Missing or unsafe release source: {name}")
        payload = path.read_bytes()
        # Length framing makes both filenames and file boundaries unambiguous.
        encoded = name.encode("utf-8")
        digest.update(len(encoded).to_bytes(8, "big"))
        digest.update(encoded)
        digest.update(len(payload).to_bytes(8, "big"))
        digest.update(payload)
    return digest.hexdigest()


def generate_manifest(root: Path) -> dict:
    result = {"schemaVersion": SCHEMA_VERSION, "application": APPLICATION}
    for component in ("frontend", "backend", "hosted", "native"):
        result[component + "Id"] = component_id(root, component)
    identity = json.dumps(result, sort_keys=True, separators=(",", ":")).encode("utf-8")
    result["releaseId"] = hashlib.sha256(identity).hexdigest()
    return result


def validate_manifest(value) -> dict:
    if (not isinstance(value, dict) or type(value.get("schemaVersion")) is not int
            or value["schemaVersion"] != SCHEMA_VERSION or value.get("application") != APPLICATION
            or any(not isinstance(value.get(key), str) or not DIGEST.fullmatch(value[key]) for key in FIELDS)):
        raise ValueError("The published software identity is unavailable or incompatible.")
    return {"schemaVersion": SCHEMA_VERSION, "application": APPLICATION, **{key: value[key] for key in FIELDS}}


def local_manifest(root: Path) -> dict:
    """Bundled apps retain their complete build identity even without web sources."""
    path = Path(root) / "static/release-manifest.json"
    if path.is_file():
        return validate_manifest(json.loads(path.read_text(encoding="utf-8")))
    return generate_manifest(Path(root))


def write_embedded_manifest(directory: Path, manifest: dict) -> None:
    directory = Path(directory)
    value = validate_manifest(manifest)
    encoded = json.dumps(value, sort_keys=True, separators=(",", ":"))
    (directory / "release-manifest.json").write_text(encoded + "\n", encoding="utf-8", newline="\n")
    (directory / "release-manifest.js").write_text("window.SHARD_ATLAS_RELEASE = Object.freeze(" + encoded + ");\n", encoding="utf-8", newline="\n")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parent)
    args = parser.parse_args()
    print(json.dumps(generate_manifest(args.root), indent=2))


if __name__ == "__main__":
    main()
