"""Truthful software freshness for the running local service and native window."""
from __future__ import annotations

import datetime as dt
from pathlib import Path
import threading
import time

from release_manifest import component_id, local_manifest, validate_manifest


def timestamp():
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


class ReleaseUnavailable(Exception):
    def __init__(self, code="unknown", message="App update check unavailable. Your saved work is retained."):
        super().__init__(message)
        self.code = code


class ReleaseStatus:
    def __init__(self, root, fetch_published=None, cache_seconds=60):
        self.root = Path(root)
        self.fetch_published = fetch_published
        self.cache_seconds = max(0, cache_seconds)
        self.current = local_manifest(self.root)
        self.loaded_backend_id = component_id(self.root, "backend")
        self._published = None
        self._checked_at = None
        self._checked_clock = 0
        self._lock = threading.Lock()

    def published_manifest(self):
        with self._lock:
            # Wall time expires checks across Mac sleep. Clock rollback must
            # invalidate the reference instead of extending its freshness.
            age = time.time() - self._checked_clock
            if self._published is not None and 0 <= age < self.cache_seconds:
                return dict(self._published)
            if self.fetch_published is None:
                raise ReleaseUnavailable("unpaired", "Connect this device to check the published app version.")
            try:
                value = validate_manifest(self.fetch_published())
            except ReleaseUnavailable:
                raise
            except ValueError:
                raise ReleaseUnavailable("unknown", "The published app version could not be verified. Retry after updating the connection.") from None
            except Exception as error:
                code = getattr(error, "code", "offline")
                if code in {"sign_in_required", "sign-in-required", "unauthorized", "forbidden", "unpaired", "unconfigured"}:
                    raise ReleaseUnavailable("unknown", "Sign in or reconnect this device to check app updates.") from None
                raise ReleaseUnavailable("offline", "App update check unavailable. Reconnect and retry; your saved work is retained.") from None
            self._published = value
            self._checked_at = timestamp()
            self._checked_clock = time.time()
            return dict(value)

    def status(self, frontend_id=None, native_id=None):
        current = dict(self.current)
        if frontend_id is not None:
            current["frontendId"] = frontend_id
        current["backendId"] = self.loaded_backend_id
        current["nativeId"] = native_id
        disk = None
        disk_error = False
        try:
            disk = local_manifest(self.root)
            disk["backendId"] = component_id(self.root, "backend")
        except (OSError, ValueError):
            disk_error = True
        published = None
        unavailable = None
        try:
            published = self.published_manifest()
        except ReleaseUnavailable as error:
            unavailable = error
        components = {}
        for name in ("frontend", "backend", "native"):
            key = name + "Id"
            loaded = current.get(key)
            components[name] = {"loaded": loaded, "disk": disk.get(key) if disk else None,
                                "published": published.get(key) if published else None,
                                "matchesPublished": bool(published and loaded == published.get(key))}
        result = {"state": "unknown", "message": "App freshness has not been established.",
                  "checkedAt": self._checked_at if published else None,
                  "current": current, "published": published, "disk": disk,
                  "components": components, "publishedAvailable": published is not None}

        def finish(state, message):
            result.update(state=state, message=message)
            return result

        if disk and self.loaded_backend_id != disk["backendId"]:
            return finish("restart_required", "App files changed while an older service is running. Save your work, then quit and reopen Shard Atlas.")
        if not native_id or disk and native_id != disk["nativeId"]:
            return finish("native_update_required", "The compiled Mac app differs from its expected build. Save your work, then rebuild and install the Mac app.")
        if disk_error:
            return finish("unknown", "Installed app files could not be verified. Your saved work is retained; retry the check.")
        if unavailable:
            return finish("offline" if unavailable.code == "offline" else "unknown", str(unavailable))
        if native_id != published["nativeId"]:
            return finish("native_update_required", "The Mac app build differs from the published release. Save your work, then update the Mac app. A development build may also differ.")
        if not frontend_id:
            return finish("unknown", "This window has no verified interface identity. Save your work, then reopen the updated app.")
        if disk and frontend_id != disk["frontendId"]:
            return finish("update_available", "This window differs from the installed interface. Finish editing and save your work, then quit and reopen Shard Atlas.")
        if frontend_id != published["frontendId"] or self.loaded_backend_id != published["backendId"]:
            return finish("versions_differ", "This app differs from the published release. It may be an older installation or newer development; update or review the versions after saving work.")
        return finish("up_to_date", "The loaded interface, local service, and compiled Mac app match the checked published release.")
