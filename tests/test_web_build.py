"""The website must ship the same interface without copying local-only files."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("atlas_web_build", ROOT / "tools/build_web.py")
BUILDER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(BUILDER)


class WebBuildTests(unittest.TestCase):
    def test_shared_interface_is_identical_and_composition_preserves_hosts(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "web-dist"
            BUILDER.build(output)
            for filename in ("app.js", "platform.js", "styles.css", "code-solutions.js", "code-solutions.css", "ai-instructions.md"):
                self.assertEqual((ROOT / "static" / filename).read_bytes(), (output / filename).read_bytes(), filename)
            html = (output / "index.html").read_text(encoding="utf-8")
            self.assertIn('src="/bootstrap.mjs"', html)
            self.assertIn('href="/manifest.webmanifest"', html)
            self.assertIn('href="/phone.css"', html)
            self.assertNotIn('src="/app.js"', html)
            self.assertNotIn('src="/drive-inbox.js"', html)
            self.assertNotIn('id="drive-inbox-title"', html)
            self.assertNotIn("platform:", html)
            self.assertLess(html.index('src="/platform.js"'), html.index('src="/bootstrap.mjs"'))
            self.assertIn('src="/drive-inbox.js"', (ROOT / "static/index.html").read_text(encoding="utf-8"))
            self.assertFalse((output / "drive-inbox.js").exists())
            self.assertFalse((output / "spiral/local-emblems").exists())
            self.assertFalse((output / "tests").exists())

    def test_repeat_build_is_deterministic_and_removes_obsolete_files(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "web-dist"
            first = BUILDER.build(output)
            before = {str(path.relative_to(output)): path.read_bytes() for path in output.rglob("*") if path.is_file()}
            (output / "obsolete.js").write_text("Old release")
            second = BUILDER.build(output)
            after = {str(path.relative_to(output)): path.read_bytes() for path in output.rglob("*") if path.is_file()}
            self.assertEqual(first, second)
            self.assertEqual(before, after)

    def test_private_drive_configuration_is_explicit_and_never_precached(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "web-dist"
            BUILDER.build(output)
            self.assertEqual(json.loads((output / "drive-config.json").read_text()), dict.fromkeys(BUILDER.CONFIG_KEYS, ""))
            configuration = Path(directory) / "deployment.json"
            configuration.write_text(json.dumps({"clientId": "public.apps.googleusercontent.com", "folderId": "private-folder", "expectedEmail": "owner@example.org"}))
            BUILDER.build(output, configuration)
            self.assertEqual(json.loads((output / "drive-config.json").read_text())["folderId"], "private-folder")
            worker = (output / "sw.js").read_text()
            self.assertNotIn('"/drive-config.json"', worker)
            self.assertNotIn('"/.shard-atlas-web-build"', worker)
            configuration.write_text('{"accessToken":"credential"}')
            with self.assertRaisesRegex(ValueError, "only clientId"):
                BUILDER.build(output, configuration)
            self.assertEqual(json.loads((output / "drive-config.json").read_text())["folderId"], "private-folder")

    def test_build_refuses_to_replace_source_or_unrelated_directory(self):
        with tempfile.TemporaryDirectory() as directory:
            unrelated = Path(directory) / "important"
            unrelated.mkdir()
            (unrelated / "keep.txt").write_text("Keep")
            with self.assertRaisesRegex(ValueError, "Refusing to replace"):
                BUILDER.build(unrelated)
            self.assertEqual((unrelated / "keep.txt").read_text(), "Keep")
        with self.assertRaisesRegex(ValueError, "separate from source"):
            BUILDER.build(ROOT / "static")


if __name__ == "__main__":
    unittest.main()
