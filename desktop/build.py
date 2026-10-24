#!/usr/bin/env python3
"""Build the local macOS app without package-manager dependencies."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import plistlib
import shutil
import subprocess
import sys
import tempfile
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def run(*arguments: str) -> None:
    subprocess.run(arguments, check=True)


def desktop_configuration(python: Path | None = None, qa_db: Path | None = None,
                          backup_dir: Path | None = None) -> dict:
    """Keep portable builds independent of the machine that compiled them."""
    config = {"backendVersion": "3.0.0"}
    if python is not None:
        config["pythonCandidates"] = [str(python.expanduser().resolve())]
    if qa_db is not None:
        config["qaDatabase"] = str(qa_db.expanduser().resolve())
    elif backup_dir is not None:
        config["backupDirectory"] = str(backup_dir.expanduser().resolve())
    return config


def build(output: Path, python: Path | None = None, qa_db: Path | None = None,
          backup_dir: Path | None = None) -> None:
    output = output.expanduser().absolute()
    if output.suffix != ".app":
        raise SystemExit("The output must be a path ending in .app.")
    if sys.platform != "darwin":
        raise SystemExit("The desktop app must be built on macOS.")
    interpreter = (python or Path(sys.executable)).expanduser().resolve()
    subprocess.run([str(interpreter), "-c", "import sys, sqlite3; assert sys.version_info >= (3, 10)"], check=True)
    output.parent.mkdir(parents=True, exist_ok=True)
    # File-provider folders can add Finder metadata while codesign is inspecting
    # a bundle. Finish signing outside sync-watched destinations first.
    with tempfile.TemporaryDirectory(prefix="shard-atlas-build-") as staging:
        bundle = Path(staging) / output.name
        contents = bundle / "Contents"
        executable = contents / "MacOS" / "ShardAtlas"
        resources = contents / "Resources"
        runtime = resources / "runtime"
        executable.parent.mkdir(parents=True)
        runtime.mkdir(parents=True)
        for filename in ("server.py", "library_sync.py", "seed.json"):
            shutil.copy2(ROOT / filename, runtime / filename)
        shutil.copytree(ROOT / "static", runtime / "static", ignore=shutil.ignore_patterns(".DS_Store"))
        try:
            revision = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True, stderr=subprocess.DEVNULL).strip()
        except (OSError, subprocess.CalledProcessError):
            revision = "unknown"
        digest = hashlib.sha256()
        for asset in sorted((ROOT / "static").rglob("*")):
            if asset.is_file() and not any(part.startswith('.') for part in asset.relative_to(ROOT / 'static').parts):
                digest.update(asset.relative_to(ROOT / "static").as_posix().encode())
                digest.update(asset.read_bytes())
        (runtime / 'static/build-info.json').write_text(json.dumps({"version": "3.0.0", "sourceRevision": revision, "interfaceFingerprint": digest.hexdigest()}) + '\n', encoding='utf-8')
        config = desktop_configuration(python, qa_db, backup_dir)
        (resources / "desktop-config.json").write_text(json.dumps(config, indent=2) + "\n", encoding="utf-8")
        info = {
            "CFBundleIdentifier": "com.sebastian.shardatlas.qa" if qa_db is not None else "local.sebastian.shardatlas",
            "CFBundleName": "Shard Atlas QA" if qa_db is not None else "Shard Atlas",
            "CFBundleDisplayName": "Shard Atlas QA" if qa_db is not None else "Shard Atlas",
            "CFBundleExecutable": "ShardAtlas",
            "CFBundlePackageType": "APPL",
            "CFBundleShortVersionString": "3.0.0",
            "CFBundleVersion": "30",
            "LSMinimumSystemVersion": "12.0",
            "NSHighResolutionCapable": True,
            "NSPrincipalClass": "NSApplication",
            "NSAppTransportSecurity": {
                "NSAllowsLocalNetworking": True,
                "NSExceptionDomains": {"127.0.0.1": {"NSExceptionAllowsInsecureHTTPLoads": True}},
            },
        }
        icon = ROOT / "desktop" / "ShardAtlas.icns"
        if icon.exists():
            shutil.copy2(icon, resources / "ShardAtlas.icns")
            info["CFBundleIconFile"] = "ShardAtlas"
        with (contents / "Info.plist").open("wb") as target:
            plistlib.dump(info, target)
        (contents / "PkgInfo").write_bytes(b"APPL????")
        source = Path(staging) / "ShardAtlas.swift"
        shutil.copy2(ROOT / "desktop" / "ShardAtlas.swift", source)
        run("/usr/bin/swiftc", "-swift-version", "5", "-O", "-framework", "Cocoa", "-framework", "WebKit",
            "-target", f"{os.uname().machine}-apple-macos12.0", str(source), "-o", str(executable))
        run("/usr/bin/swiftc", "-swift-version", "5", "-O", "-framework", "Vision", "-framework", "Foundation",
            "-target", f"{os.uname().machine}-apple-macos12.0", str(ROOT / "desktop" / "ImageText.swift"), "-o", str(runtime / "image-text"))
        run("/usr/bin/codesign", "--force", "--sign", "-", str(runtime / "image-text"))
        run("/usr/bin/xattr", "-cr", str(bundle))
        run("/usr/bin/codesign", "--force", "--sign", "-", str(bundle))
        run("/usr/bin/codesign", "--verify", "--deep", "--strict", str(bundle))
        run("/usr/bin/plutil", "-lint", str(contents / "Info.plist"))
        previous = output.with_name(f".{output.name}-previous-{uuid.uuid4().hex}")
        if output.exists() or output.is_symlink():
            output.rename(previous)
        try:
            shutil.move(str(bundle), str(output))
            run("/usr/bin/xattr", "-cr", str(output))
            run("/usr/bin/codesign", "--verify", "--deep", "--strict", str(output))
        except BaseException:
            if output.is_symlink():
                output.unlink()
            elif output.exists():
                shutil.rmtree(output)
            if previous.exists() or previous.is_symlink():
                previous.rename(output)
            raise
        else:
            if previous.is_symlink():
                previous.unlink()
            elif previous.exists():
                shutil.rmtree(previous)
    print(f"Built {output}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=ROOT / "Shard Atlas.app", help="Destination app bundle; the existing app is replaced only after validation")
    parser.add_argument("--python", type=Path, help="Explicit local Python 3.10+ override; by default the app discovers Python on the destination Mac")
    parser.add_argument("--qa-db", type=Path, help="Embed an isolated test database path and distinct QA app identity")
    parser.add_argument("--backup-dir", type=Path, help="Explicit local snapshot directory; default: Application Support/Shard Atlas/backups (QA builds always use an adjacent isolated directory)")
    args = parser.parse_args()
    build(args.output, args.python, args.qa_db, args.backup_dir)


if __name__ == "__main__":
    main()
