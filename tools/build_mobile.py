#!/usr/bin/env python3
"""Build Shard Atlas's standalone phone app using only the Python standard library."""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import shutil
import tempfile
import uuid

ROOT = Path(__file__).resolve().parents[1]
REQUIRED_MOBILE_FILES = (
    'bootstrap.mjs', 'persistence.mjs', 'model.mjs', 'archives.mjs', 'exports.mjs',
    'phone.css', 'manifest.webmanifest', 'sw.js',
    'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png',
)


def mobile_index(source: str) -> str:
    """Adapt the copied shell; the native Mac interface remains untouched."""
    viewport = '<meta name="viewport" content="width=device-width, initial-scale=1.0">'
    script = '<script type="module" src="/app.js"></script>'
    if source.count(viewport) != 1 or source.count(script) != 1:
        raise ValueError("The original app shell changed; review the mobile adaptation before building.")
    source = source.replace(viewport,
        '<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">')
    source = source.replace('<meta name="theme-color" content="#f4f3ef">',
        '<meta name="theme-color" content="#315645">')
    source = source.replace('</head>', '''  <link rel="manifest" href="/manifest.webmanifest">
  <link rel="apple-touch-icon" href="/icons/apple-touch-icon.png">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="default">
  <meta name="apple-mobile-web-app-title" content="Shard Atlas">
  <link rel="stylesheet" href="/phone.css">
</head>''', 1)
    return source.replace(script, '<script type="module" src="/bootstrap.mjs"></script>')


def mobile_app(source: str) -> str:
    """Build-only entry point for adapting desktop API calls to local storage."""
    replacements = {
        "const response=await fetch(path,{method,":
            "const response=await (window.shardAtlasMobile?.fetch || fetch)(path,{method,",
        "context?.imageSource?context.imageSource(image):image":
            "context?.imageSource?context.imageSource(image):(window.shardAtlasMobile?.imageSource(image)||image)",
        "?src:importImageUrls": "?(window.shardAtlasMobile?.imageSource(src)||src):importImageUrls",
        "$('#editor-dialog').close();render();toast(cleaned?":
            "$('#editor-dialog').close();render();document.dispatchEvent(new CustomEvent('shard-atlas-saved'));toast(cleaned?",
    }
    for original, replacement in replacements.items():
        if source.count(original) != 1:
            raise ValueError("The desktop API or image rendering changed; review the mobile adapter before building.")
        source = source.replace(original, replacement, 1)
    return source.replace('this Mac', 'this device').replace('database backup', 'local snapshot')


def _copy_public_tree(source: Path, destination: Path) -> None:
    """Never follow source symlinks into a personal collection or backup."""
    if source.is_symlink():
        raise ValueError("A public asset directory must not be a symlink.")
    for item in sorted(source.rglob('*')):
        if any(part.startswith('.') for part in item.relative_to(source).parts):
            continue
        if item.is_symlink():
            raise ValueError(f"Public assets must not contain symlinks: {item.relative_to(ROOT)}")
        if item.is_file():
            target = destination / item.relative_to(source)
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(item, target)


def _validate_output(output: Path) -> Path:
    output = output.expanduser().absolute()
    # A typo must never replace the checkout or its editable source trees.
    resolved = output.resolve()
    if resolved == ROOT or resolved in ROOT.parents or ROOT in resolved.parents and (
        resolved.parts[len(ROOT.parts)] in {'.git', 'static', 'mobile', 'tools', 'tests', 'desktop', 'docs', 'integrations'}
    ):
        raise ValueError("Choose a build directory outside the editable source directories.")
    if output.is_symlink() or output.exists() and not output.is_dir():
        raise ValueError("The output must be a directory, not a file or symlink.")
    return output


def build(output: Path = ROOT / 'mobile-dist') -> dict:
    output = _validate_output(output)
    missing = [name for name in REQUIRED_MOBILE_FILES if not (ROOT / 'mobile' / name).is_file()]
    if missing:
        raise ValueError('The phone app is incomplete. Missing mobile files: ' + ', '.join(missing))
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='.shard-atlas-mobile-', dir=output.parent) as temporary:
        staging = Path(temporary) / 'app'
        staging.mkdir()
        _copy_public_tree(ROOT / 'static', staging)
        mobile = ROOT / 'mobile'
        for item in sorted(mobile.iterdir()):
            if item.is_file() and (item.suffix in {'.js', '.mjs', '.css'} or item.name == 'manifest.webmanifest'):
                if item.is_symlink():
                    raise ValueError(f"Mobile assets must not be symlinks: {item.name}")
                shutil.copy2(item, staging / item.name)
        _copy_public_tree(mobile / 'icons', staging / 'icons')
        (staging / 'index.html').write_text(mobile_index((staging / 'index.html').read_text(encoding='utf-8')), encoding='utf-8')
        (staging / 'app.js').write_text(mobile_app((staging / 'app.js').read_text(encoding='utf-8')), encoding='utf-8')

        paths = sorted(path for path in staging.rglob('*') if path.is_file())
        digest = hashlib.sha256()
        for path in paths:
            relative = path.relative_to(staging).as_posix()
            if relative.split('/')[0] in {'api', 'assets'}:
                raise ValueError("Private API or image data must not be shipped in the app shell.")
            digest.update(relative.encode('utf-8') + b'\0' + path.read_bytes() + b'\0')
        version = digest.hexdigest()[:20]
        urls = ['/' if path.name == 'index.html' and path.parent == staging else '/' + path.relative_to(staging).as_posix()
                for path in paths if path.name != 'sw.js']
        # Cache the canonical index as well as start_url for navigation fallback.
        urls = sorted(set(urls + ['/index.html']))
        worker = (staging / 'sw.js').read_text(encoding='utf-8')
        worker = worker.replace('__SHARD_ATLAS_VERSION__', version)
        worker = worker.replace('__SHARD_ATLAS_ASSETS__', json.dumps(urls, ensure_ascii=False))
        (staging / 'sw.js').write_text(worker, encoding='utf-8')

        previous = output.with_name(f'.{output.name}-previous-{uuid.uuid4().hex}')
        if output.exists():
            output.rename(previous)
        try:
            staging.rename(output)
        except BaseException:
            if previous.exists():
                previous.rename(output)
            raise
        if previous.exists():
            shutil.rmtree(previous)
    return {'output': str(output), 'version': version, 'assets': len(urls)}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=ROOT / 'mobile-dist', help='Directory for the built standalone app.')
    arguments = parser.parse_args()
    try:
        result = build(arguments.output)
    except (OSError, ValueError) as error:
        parser.exit(1, f'Could not build the phone app: {error}\n')
    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    main()
