#!/usr/bin/env python3
"""Open Shard Atlas, reusing its running local server when possible."""
import json
import socket
import subprocess
import sys
import time
import urllib.request
import webbrowser
from pathlib import Path
from server import BACKEND_VERSION

ROOT = Path(__file__).resolve().parent
DATA = Path.home() / "Library/Application Support/Shard Atlas"


def health(port):
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/health", timeout=0.5) as response:
            result = json.load(response)
        return (isinstance(result, dict)
                and result.get("app") == "shard-atlas"
                and result.get("backendVersion") == BACKEND_VERSION
                and isinstance(result.get("dbPath"), str)
                and Path(result["dbPath"]).resolve() == (DATA / "shards.sqlite3").resolve())
    except (OSError, ValueError):
        return False


def available(port):
    with socket.socket() as sock:
        try:
            sock.bind(("127.0.0.1", port))
            return True
        except OSError:
            return False


def main():
    if '--browser' not in sys.argv and '--no-browser' not in sys.argv:
        candidates = [ROOT / 'Shard Atlas.app', Path.home() / 'Applications/Shard Atlas.app']
        app = next((candidate for candidate in candidates if (candidate / 'Contents/MacOS/ShardAtlas').is_file()), None)
        if app is None:
            raise SystemExit('Shard Atlas was not found in this checkout or ~/Applications. Run python3 desktop/build.py to build it, or install Shard Atlas.app in ~/Applications, then try again.')
        subprocess.run(['open', str(app)], check=True)
        print('Opened Shard Atlas desktop app.')
        return
    for port in range(48731, 48741):
        if health(port):
            break
    else:
        port = next((port for port in range(48731, 48741) if available(port)), None)
        if port is None:
            raise SystemExit("Shard Atlas could not find an available local port. Close another local app and try again.")
        DATA.mkdir(parents=True, exist_ok=True)
        with (DATA / "server.log").open("ab") as log:
            process = subprocess.Popen([sys.executable, str(ROOT / "server.py"), "--db", str(DATA / "shards.sqlite3"),
                                        "--backup-dir", str(DATA / "backups"), "--port", str(port)],
                                       cwd=ROOT, stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True)
        for _ in range(80):
            if health(port):
                break
            if process.poll() is not None:
                raise SystemExit(f"Shard Atlas could not start. See {DATA / 'server.log'}.")
            time.sleep(0.1)
        else:
            raise SystemExit("Shard Atlas is taking longer than expected to open. Try the launcher again.")
    url = f"http://127.0.0.1:{port}"
    if "--no-browser" not in sys.argv:
        webbrowser.open(url)
    print(url)


if __name__ == "__main__":
    main()
