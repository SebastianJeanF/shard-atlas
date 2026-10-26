"""Launcher paths are exercised with isolated files and no real applications."""
import contextlib
import io
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import launch


class LauncherTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name) / "checkout"
        self.root.mkdir()
        self.home = Path(self.temporary.name) / "home"
        self.data = self.home / "Library/Application Support/Shard Atlas"
        self.contexts = contextlib.ExitStack()
        self.addCleanup(self.contexts.close)
        self.contexts.enter_context(mock.patch.object(launch, "ROOT", self.root))
        self.contexts.enter_context(mock.patch.object(launch, "DATA", self.data))
        self.contexts.enter_context(mock.patch.object(Path, "home", return_value=self.home))
        self.open_app = self.contexts.enter_context(mock.patch.object(launch.subprocess, "run"))
        self.spawn = self.contexts.enter_context(mock.patch.object(launch.subprocess, "Popen"))
        self.browser = self.contexts.enter_context(mock.patch.object(launch.webbrowser, "open"))
        self.health = self.contexts.enter_context(mock.patch.object(launch, "health"))
        self.available = self.contexts.enter_context(mock.patch.object(launch, "available", return_value=True))
        self.contexts.enter_context(mock.patch.object(launch.time, "sleep"))
        self.output = self.contexts.enter_context(contextlib.redirect_stdout(io.StringIO()))

    @staticmethod
    def built(path):
        executable = path / "Contents/MacOS/ShardAtlas"
        executable.parent.mkdir(parents=True)
        executable.write_bytes(b"isolated fake executable; never launched")
        return path

    def run_launcher(self, *arguments):
        with mock.patch.object(sys, "argv", [str(self.root / "launch.py"), *arguments]):
            launch.main()

    def test_native_prefers_the_development_build_to_the_installed_app(self):
        development = self.built(self.root / "Shard Atlas.app")
        self.built(self.home / "Applications/Shard Atlas.app")
        self.run_launcher()
        self.open_app.assert_called_once_with(["open", str(development)], check=True)
        self.spawn.assert_not_called()
        self.health.assert_not_called()
        self.assertFalse(self.data.exists())

    def test_native_falls_back_to_the_installed_app_after_checkout_relocation(self):
        # An incomplete development bundle must not mask a usable installation.
        (self.root / "Shard Atlas.app").mkdir()
        installed = self.built(self.home / "Applications/Shard Atlas.app")
        self.run_launcher()
        self.open_app.assert_called_once_with(["open", str(installed)], check=True)
        self.spawn.assert_not_called()
        self.health.assert_not_called()
        self.assertFalse(self.data.exists())

    def test_missing_native_app_reports_both_supported_locations_without_starting_storage(self):
        with self.assertRaisesRegex(SystemExit, r"checkout or ~/Applications.*desktop/build.py"):
            self.run_launcher()
        self.open_app.assert_not_called()
        self.spawn.assert_not_called()
        self.health.assert_not_called()

    def test_browser_modes_start_only_the_explicit_local_database_and_backup_folder(self):
        for flag in ("--browser", "--no-browser"):
            with self.subTest(flag=flag):
                self.health.reset_mock()
                self.health.side_effect = [False] * 10 + [True]
                self.spawn.reset_mock()
                self.browser.reset_mock()
                self.run_launcher(flag)
                self.spawn.assert_called_once()
                args, options = self.spawn.call_args
                self.assertEqual(args[0], [sys.executable, str(self.root / "server.py"), "--db", str(self.data / "shards.sqlite3"),
                                           "--backup-dir", str(self.data / "backups"), "--port", "48731"])
                self.assertEqual(options["cwd"], self.root)
                self.assertIs(options["stdin"], subprocess.DEVNULL)
                self.assertTrue(options["start_new_session"])
                self.assertFalse((self.root / "backups").exists())
                self.assertFalse((self.data / "shards.sqlite3").exists(), "Mocked startup must not create a working database.")
                self.assertTrue((self.data / "server.log").is_file())
                self.open_app.assert_not_called()
                if flag == "--browser":
                    self.browser.assert_called_once_with("http://127.0.0.1:48731")
                else:
                    self.browser.assert_not_called()

    def test_existing_matching_service_is_reused_without_creating_data_or_spawning(self):
        self.health.return_value = True
        self.run_launcher("--browser")
        self.spawn.assert_not_called()
        self.available.assert_not_called()
        self.browser.assert_called_once_with("http://127.0.0.1:48731")
        self.assertFalse(self.data.exists())


if __name__ == "__main__":
    unittest.main()
