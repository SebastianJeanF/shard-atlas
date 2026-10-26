"""Run the real native storage/synchronizer against one isolated loopback cloud.

This helper has no production fallback. Its caller must create the dedicated
fixture marker, and all writable state stays beneath that temporary directory.
"""
from pathlib import Path
import argparse
import json
import signal
import sys
import threading
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from library_sync import LibraryClient, LibrarySync, SITE_URL, atomic_write, canonical
from server import LocalServer, Store

MARKER = ".shard-atlas-cloud-add-fixture"
MARKER_CONTENT = "Shard Atlas isolated cloud-add test fixture\n"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", required=True, type=Path)
    parser.add_argument("--cloud-url", required=True)
    args = parser.parse_args()
    folder = args.root.resolve()
    marker = folder / MARKER
    if not marker.is_file() or marker.is_symlink() or marker.read_text() != MARKER_CONTENT:
        parser.error("A dedicated isolated cloud-add fixture directory is required.")
    url = urlsplit(args.cloud_url)
    try:
        valid = (url.scheme == "http" and url.hostname == "127.0.0.1"
                 and 1 <= url.port <= 65535 and url.path in ("", "/")
                 and not url.username and not url.password and not url.query and not url.fragment)
    except (TypeError, ValueError):
        valid = False
    if not valid:
        parser.error("The isolated cloud must be an explicit loopback HTTP origin.")
    cloud_url = args.cloud_url.rstrip("/")
    native = folder / "native"
    native.mkdir(exist_ok=True)
    if native.is_symlink():
        parser.error("The isolated native directory must not be a symbolic link.")
    config = native / "library-sync.json"
    atomic_write(config, canonical({"siteUrl": SITE_URL,
                                   "serviceToken": "disposable-fixture-token",
                                   "serviceSecret": "disposable-fixture-service-secret",
                                   "pollSeconds": 10}))

    class IsolatedClient(LibraryClient):
        def __init__(self, configuration):
            super().__init__({**configuration, "siteUrl": cloud_url})
            if self.site_url != cloud_url:
                raise RuntimeError("The fixture cloud destination changed.")

    database = native / "shards.sqlite3"
    if database.is_symlink():
        parser.error("The isolated database must not be a symbolic link.")
    store = Store(database, root=ROOT, seed=False, backup_on_start=False,
                  automatic_backups=False, backup_dir=native / "backups")
    server = LocalServer(("127.0.0.1", 0), store, static_dir=ROOT / "static",
                         drive_inbox_path=native / "unused-inbox",
                         library_sync_config=native / "absent-connection.json")
    server.library_sync.stop()
    server.library_sync = LibrarySync(store, config_path=config, client_factory=IsolatedClient)
    server.library_sync.start()
    signal.signal(signal.SIGTERM, lambda *_: threading.Thread(target=server.shutdown, daemon=True).start())
    print(json.dumps({"url": f"http://127.0.0.1:{server.server_address[1]}",
                      "database": str(database), "isolated": True}), flush=True)
    try:
        server.serve_forever(poll_interval=0.1)
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
