"""Check portable bundle configuration without opening an app or a real database."""

import importlib.util
import json
import re
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("desktop_build", ROOT / "desktop/build.py")
desktop_build = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(desktop_build)


class BundleConfigurationTests(unittest.TestCase):
    def test_every_view_menu_command_is_accepted_by_the_native_dispatcher(self):
        source = (ROOT / "desktop/ShardAtlas.swift").read_text()
        view_menu = source.split('let view = NSMenu(title: "View")', 1)[1].split('addMenu(view', 1)[0]
        commands = re.findall(r'\("[^"]+", "([a-z]+)", "[^"]+"\)', view_menu)
        dispatcher = source.split('@objc private func runCommand', 1)[1].split('window.makeKeyAndOrderFront', 1)[0]
        allowed = set(re.findall(r'"([a-z]+)"', dispatcher))
        self.assertIn("courses", commands)
        self.assertTrue(set(commands) <= allowed, set(commands) - allowed)

    def test_default_bundle_contains_no_builder_paths(self):
        config = desktop_build.desktop_configuration()
        self.assertEqual(set(config), {"backendVersion"})
        from server import BACKEND_VERSION
        self.assertEqual(config["backendVersion"], BACKEND_VERSION)

    def test_only_explicit_local_overrides_are_embedded(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            config = desktop_build.desktop_configuration(root / "python3", backup_dir=root / "snapshots")
            self.assertEqual(config["pythonCandidates"], [str(root / "python3")])
            self.assertEqual(config["backupDirectory"], str(root / "snapshots"))
            self.assertNotIn("qaDatabase", config)

    def test_qa_bundle_never_embeds_production_backup_override(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            config = desktop_build.desktop_configuration(qa_db=root / "qa.sqlite3", backup_dir=root / "production")
            self.assertEqual(config["qaDatabase"], str(root / "qa.sqlite3"))
            self.assertNotIn("backupDirectory", config)


@unittest.skipUnless(sys.platform == "darwin" and shutil.which("swiftc"), "Requires the macOS Swift toolchain")
class NativeConfigurationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory()
        cls.root = Path(cls.temporary.name)
        source = (ROOT / "desktop/ShardAtlas.swift").read_text()
        configuration = source.split("struct DesktopConfiguration {", 1)[1].split("\nenum BackendError:", 1)[0]
        harness = '''
let input = try JSONSerialization.jsonObject(with: Data(CommandLine.arguments[1].utf8)) as! [String: Any]
let config = DesktopConfiguration(arguments: input["arguments"] as? [String] ?? ["test"],
    environment: input["environment"] as? [String: String] ?? [:],
    homeDirectory: URL(fileURLWithPath: input["home"] as! String),
    metadata: input["metadata"] as? [String: Any] ?? [:])
let result: [String: Any] = ["database": config.database.path, "backups": config.backups.path,
    "pythonCandidates": config.pythonCandidates, "isQA": config.isQA]
let data = try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys])
print(String(data: data, encoding: .utf8)!)
'''
        swift = cls.root / "Configuration.swift"
        swift.write_text("import Foundation\nstruct DesktopConfiguration {" + configuration + harness)
        cls.executable = cls.root / "configuration"
        subprocess.run(["swiftc", "-swift-version", "5", str(swift), "-o", str(cls.executable)], check=True, capture_output=True, text=True)

    @classmethod
    def tearDownClass(cls):
        cls.temporary.cleanup()

    def configuration(self, **values):
        values.setdefault("home", str(self.root / "new-user"))
        result = subprocess.run([str(self.executable), json.dumps(values)], check=True, capture_output=True, text=True)
        return json.loads(result.stdout)

    def test_fresh_user_uses_local_support_and_runtime_python_discovery(self):
        config = self.configuration(environment={"PATH": "/custom/python/bin:/usr/bin:/custom/python/bin"})
        support = self.root / "new-user/Library/Application Support/Shard Atlas"
        self.assertEqual(config["database"], str(support / "shards.sqlite3"))
        self.assertEqual(config["backups"], str(support / "backups"))
        self.assertFalse(config["isQA"])
        self.assertEqual(config["pythonCandidates"][0], "/custom/python/bin/python3")
        self.assertEqual(config["pythonCandidates"].count("/custom/python/bin/python3"), 1)
        self.assertIn("/Library/Frameworks/Python.framework/Versions/Current/bin/python3", config["pythonCandidates"])

    def test_local_backup_override_does_not_require_existing_parent(self):
        destination = str(self.root / "not-created/cloud/backups")
        config = self.configuration(metadata={"backupDirectory": destination, "pythonCandidates": ["/explicit/python3"]})
        self.assertEqual(config["backups"], destination)
        self.assertEqual(config["pythonCandidates"][0], "/explicit/python3")
        override = str(self.root / "runtime/backups")
        config = self.configuration(metadata={"backupDirectory": destination}, arguments=["test", "--backup-dir", override])
        self.assertEqual(config["backups"], override)

    def test_qa_ignores_real_backup_overrides(self):
        database = str(self.root / "isolated/qa.sqlite3")
        config = self.configuration(metadata={"qaDatabase": database, "backupDirectory": "/production/backups"},
                                    arguments=["test", "--backup-dir", "/another-production/backups"])
        self.assertEqual(config["database"], database)
        self.assertEqual(config["backups"], str(self.root / "isolated/qa-backups"))
        self.assertTrue(config["isQA"])


if __name__ == "__main__":
    unittest.main()
