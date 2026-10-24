#!/usr/bin/env python3
"""Build the shared interface and the existing private Sites Worker artifact."""
from __future__ import annotations
import argparse
import json
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--drive-config', type=Path)
    parser.add_argument('--sites-plugin', type=Path, help='Optional installed Sites plugin root for its verified build helper')
    args = parser.parse_args()
    command = [sys.executable, str(ROOT / 'tools/build_web.py')]
    if args.drive_config:
        command += ['--drive-config', str(args.drive_config.resolve())]
    subprocess.run(command, cwd=ROOT, check=True)
    public = ROOT / 'hosting/public'
    if public.exists():
        shutil.rmtree(public)
    shutil.copytree(ROOT / 'web-dist', public)
    hosting = ROOT / 'hosting/.openai/hosting.json'
    hosting.parent.mkdir(exist_ok=True)
    shutil.copy2(ROOT / '.openai/hosting.json', hosting)
    if args.sites_plugin:
        build = ['node', str(args.sites_plugin.resolve() / 'scripts/build-site.mjs')]
    else:
        build = ['npm.cmd' if sys.platform == 'win32' else 'npm', 'run', 'build']
    subprocess.run(build, cwd=ROOT / 'hosting', check=True)
    output = ROOT / 'dist'
    if output.exists():
        shutil.rmtree(output)
    shutil.copytree(ROOT / 'hosting/dist', output)
    print(json.dumps({'output': str(output), 'projectId': json.loads(hosting.read_text())['project_id']}))

if __name__ == '__main__':
    main()
