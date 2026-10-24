#!/usr/bin/env python3
"""Prepare an existing Sites checkout from a clean canonical commit and build.

This copies source and generated artifacts only. It never stages, commits,
authenticates, invokes a hosting API, or deploys.
"""
from __future__ import annotations

import argparse
import io
import json
from pathlib import Path
import re
import shutil
import subprocess
import tarfile
import tempfile

ROOT = Path(__file__).resolve().parents[1]


def git(root: Path, *arguments: str) -> bytes:
    try:
        return subprocess.check_output(["git", "-C", str(root), *arguments], stderr=subprocess.PIPE)
    except (OSError, subprocess.CalledProcessError) as error:
        raise ValueError("The checkout must be an accessible Git repository.") from error


def repository(path: Path) -> Path:
    path = path.resolve(strict=True)
    root = Path(git(path, "rev-parse", "--show-toplevel").decode().strip()).resolve()
    if root != path:
        raise ValueError("Pass the root directory of the Git checkout.")
    return root


def safe_relative(value: str) -> Path:
    path = Path(value)
    if path.is_absolute() or "\\" in value or any(part in {"..", ".git"} for part in path.parts):
        raise ValueError("A source path is unsafe for cross-platform copying.")
    return path


def tracked(root: Path) -> dict[Path, str]:
    result = {}
    for item in git(root, "ls-files", "--stage", "-z").decode("utf-8").split("\0"):
        if not item:
            continue
        metadata, value = item.split("\t", 1)
        mode, _, stage = metadata.split()
        if stage != "0":
            raise ValueError("Resolve Git conflicts before preparing a checkout.")
        result[safe_relative(value)] = mode
    return result


def read_json(path: Path) -> dict:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, ValueError) as error:
        raise ValueError("Required project or artifact metadata is missing or invalid.") from error
    if not isinstance(value, dict):
        raise ValueError("Project and artifact metadata must be JSON objects.")
    return value


def project(path: Path) -> str:
    value = read_json(path).get("project_id")
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9_-]+", value):
        raise ValueError("A valid existing Sites project identity is required.")
    return value


def no_symlink_parents(root: Path, relative: Path) -> None:
    current = root
    for component in relative.parts:
        current = current / component
        if current.is_symlink():
            raise ValueError("Refusing to copy through a checkout symlink.")


def prepare(checkout: Path, artifact: Path | None = None, *, source: Path = ROOT) -> dict:
    source, checkout = repository(source), repository(checkout)
    if source == checkout or source.is_relative_to(checkout) or checkout.is_relative_to(source):
        raise ValueError("Canonical source and Sites checkout must be separate Git roots.")
    if git(source, "status", "--porcelain", "--untracked-files=normal").strip():
        raise ValueError("Canonical source must be clean and committed before preparing a checkout.")
    if git(checkout, "status", "--porcelain", "--untracked-files=no").strip():
        raise ValueError("The Sites checkout has tracked changes; commit or preserve them before preparing it.")
    revision = git(source, "rev-parse", "HEAD").decode().strip()
    source_files, target_files = tracked(source), tracked(checkout)
    ignored = [value for value in git(checkout, "ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z").decode("utf-8").split("\0") if value]
    if any(mode not in {"100644", "100755"} for mode in source_files.values()):
        raise ValueError("Canonical source must contain regular files, without symlinks or submodules.")
    if Path(".openai/hosting.json") not in source_files:
        raise ValueError("The canonical hosting project identity must be tracked in Git.")
    identity = project(source / ".openai/hosting.json")
    if project(checkout / ".openai/hosting.json") != identity:
        raise ValueError("Source and target hosting project IDs do not match.")
    artifact = (artifact or source / "dist").resolve(strict=True)
    if artifact == source or artifact == checkout or artifact.is_relative_to(checkout):
        raise ValueError("The built artifact must be separate from the Sites checkout.")
    if project(artifact / ".openai/hosting.json") != identity:
        raise ValueError("Built artifact hosting project ID does not match the checkout.")
    build = read_json(artifact / "client/build-info.json")
    if (build.get("format") != "shard-atlas-web-build/v1" or build.get("sourceRevision") != revision
            or not re.fullmatch(r"[a-f0-9]{64}", str(build.get("interfaceFingerprint", "")))):
        raise ValueError("Rebuild the artifact from this exact committed source revision.")
    if not (artifact / "server/index.js").is_file() or not (artifact / "server/wrangler.json").is_file():
        raise ValueError("The artifact is missing its built hosting worker.")
    for path in artifact.rglob("*"):
        if path.is_symlink() or ".git" in path.relative_to(artifact).parts:
            raise ValueError("The built artifact contains an unsafe symlink or Git directory.")
    for relative in source_files:
        no_symlink_parents(checkout, relative)
        target = checkout / relative
        if target.is_dir() or target.exists() and relative not in target_files:
            raise ValueError("A source path would overwrite an untracked file or directory; preserve it first.")
    removed = set(target_files) - set(source_files)
    for relative in removed:
        no_symlink_parents(checkout, relative)
    destination = checkout / "dist"
    if destination.is_symlink():
        raise ValueError("The generated artifact destination must not be a symlink.")
    if destination.exists() and not destination.is_dir():
        raise ValueError("The generated artifact destination must be a directory.")
    if destination.exists() and any(destination.iterdir()):
        marker = destination / ".openai/hosting.json"
        if marker.is_file():
            if project(marker) != identity:
                raise ValueError("The existing generated artifact belongs to another project.")
        elif any(path.is_file() and path.relative_to(checkout) not in target_files for path in destination.rglob("*")):
            raise ValueError("Preserve unrecognized files in the artifact destination before replacing it.")
    # Snapshot committed bytes rather than possibly racing filesystem edits.
    archive = git(source, "archive", "--format=tar", revision)
    with tempfile.TemporaryDirectory(prefix=".shard-atlas-site-", dir=checkout.parent) as directory:
        staging = Path(directory)
        prepared = staging / "source"
        prepared.mkdir()
        with tarfile.open(fileobj=io.BytesIO(archive)) as bundle:
            for entry in bundle.getmembers():
                if entry.isdir():
                    continue
                relative = safe_relative(entry.name)
                if not entry.isfile() or relative not in source_files:
                    raise ValueError("The committed source archive contains an unsupported entry.")
                target = prepared / relative
                target.parent.mkdir(parents=True, exist_ok=True)
                with bundle.extractfile(entry) as content, target.open("wb") as output:
                    shutil.copyfileobj(content, output)
                target.chmod(0o755 if source_files[relative] == "100755" else 0o644)
        shutil.copytree(artifact, staging / "artifact")
        # Replacing a legacy .gitignore must not expose local credentials or
        # dependency/runtime folders to a later `git add`. Keep those exact
        # checkout-local exclusions in Git metadata, outside portable source.
        exclude = Path(git(checkout, "rev-parse", "--git-path", "info/exclude").decode().strip())
        if not exclude.is_absolute():
            exclude = checkout / exclude
        previous = exclude.read_text(encoding="utf-8") if exclude.exists() else ""
        rules = []
        for value in ignored:
            safe_relative(value.rstrip("/"))
            rule = "/" + re.sub(r"([\\*?\[\] ])", r"\\\1", value)
            if rule not in previous.splitlines():
                rules.append(rule)
        if rules:
            exclude.parent.mkdir(parents=True, exist_ok=True)
            exclude.write_text(previous.rstrip("\n") + "\n# Shard Atlas: preserve checkout-local ignored files\n" + "\n".join(rules) + "\n", encoding="utf-8")
        for relative in removed:
            (checkout / relative).unlink(missing_ok=True)
        for relative in source_files:
            target = checkout / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(prepared / relative, target)
        if destination.exists():
            destination.rename(staging / "previous-artifact")
        (staging / "artifact").rename(destination)
    return {"projectId": identity, "sourceRevision": revision, "sourceFiles": len(source_files),
            "removedTrackedFiles": len(removed), "checkout": str(checkout), "artifact": str(destination)}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--checkout", type=Path, required=True, help="Existing checkout opened through the Sites source workflow")
    parser.add_argument("--artifact", type=Path, default=ROOT / "dist", help="Built hosting artifact; defaults to this repository's dist/")
    args = parser.parse_args()
    try:
        print(json.dumps(prepare(args.checkout, args.artifact), indent=2))
    except (ValueError, OSError) as error:
        parser.exit(1, str(error) + "\n")


if __name__ == "__main__":
    main()
