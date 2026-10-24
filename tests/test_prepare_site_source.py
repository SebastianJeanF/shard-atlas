import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("prepare_site_source", ROOT / "tools/prepare_site_source.py")
HELPER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(HELPER)


def git(root, *arguments):
    return subprocess.check_output(["git", "-C", str(root), *arguments], stderr=subprocess.PIPE)


def write(root, path, content):
    target = root / path
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content)


class PrepareSiteSourceTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        base = Path(self.temporary.name)
        self.source, self.checkout = base / "canonical", base / "sites"
        for root in (self.source, self.checkout):
            root.mkdir()
            git(root, "init", "--quiet")
            git(root, "config", "user.email", "test@example.org")
            git(root, "config", "user.name", "Test")
            write(root, ".openai/hosting.json", '{"project_id":"appgprj_test"}')
        write(self.source, ".gitignore", "/dist/\n/local-only/\n")
        write(self.source, "static/app.js", "shared source\n")
        write(self.checkout, ".gitignore", "/dist/\n/.private/\n/node_modules/\n")
        write(self.checkout, "obsolete.js", "obsolete source\n")
        for root in (self.source, self.checkout):
            git(root, "add", "--all")
            git(root, "commit", "--quiet", "-m", "Initial")
        self.revision = git(self.source, "rev-parse", "HEAD").decode().strip()
        self.artifact = self.source / "dist"
        write(self.artifact, ".openai/hosting.json", '{"project_id":"appgprj_test"}')
        write(self.artifact, "client/build-info.json", json.dumps({"format": "shard-atlas-web-build/v1", "sourceRevision": self.revision, "interfaceFingerprint": "a" * 64}))
        write(self.artifact, "server/index.js", "built worker\n")
        write(self.artifact, "server/wrangler.json", "{}")

    def prepare(self):
        return HELPER.prepare(self.checkout, self.artifact, source=self.source)

    def test_only_committed_source_is_copied_and_local_secrets_stay_ignored(self):
        write(self.source, "local-only/private.json", "source private data")
        write(self.checkout, ".private/credentials.json", "target secret")
        write(self.checkout, "node_modules/runtime.js", "installed dependency")
        original_git_config = (self.checkout / ".git/config").read_bytes()
        result = self.prepare()
        self.assertEqual(result["sourceRevision"], self.revision)
        self.assertEqual((self.checkout / "static/app.js").read_text(), "shared source\n")
        self.assertFalse((self.checkout / "obsolete.js").exists())
        self.assertFalse((self.checkout / "local-only").exists())
        self.assertEqual((self.checkout / ".private/credentials.json").read_text(), "target secret")
        self.assertEqual((self.checkout / "node_modules/runtime.js").read_text(), "installed dependency")
        self.assertEqual((self.checkout / ".git/config").read_bytes(), original_git_config)
        self.assertEqual((self.checkout / "dist/server/index.js").read_text(), "built worker\n")
        git(self.checkout, "check-ignore", ".private/credentials.json", "node_modules/runtime.js", "dist/server/index.js")
        self.assertEqual(git(self.checkout, "diff", "--cached", "--name-only"), b"", "Preparation must not stage changes")
        untracked = git(self.checkout, "ls-files", "--others", "--exclude-standard").decode()
        self.assertNotIn("credentials", untracked)
        self.assertNotIn("dist/", untracked)

    def test_dirty_target_or_source_is_rejected_before_mutation(self):
        write(self.checkout, "obsolete.js", "uncommitted work")
        with self.assertRaisesRegex(ValueError, "tracked changes"):
            self.prepare()
        self.assertEqual((self.checkout / "obsolete.js").read_text(), "uncommitted work")
        git(self.checkout, "restore", "obsolete.js")
        write(self.source, "static/app.js", "uncommitted source")
        with self.assertRaisesRegex(ValueError, "source must be clean"):
            self.prepare()
        self.assertTrue((self.checkout / "obsolete.js").exists())

    def test_project_or_artifact_revision_mismatch_is_rejected(self):
        write(self.artifact, ".openai/hosting.json", '{"project_id":"different_project"}')
        with self.assertRaisesRegex(ValueError, "artifact hosting project"):
            self.prepare()
        write(self.artifact, ".openai/hosting.json", '{"project_id":"appgprj_test"}')
        metadata = json.loads((self.artifact / "client/build-info.json").read_text())
        metadata["sourceRevision"] = "b" * 40
        write(self.artifact, "client/build-info.json", json.dumps(metadata))
        with self.assertRaisesRegex(ValueError, "exact committed source"):
            self.prepare()
        self.assertTrue((self.checkout / "obsolete.js").exists())

    def test_untracked_collision_is_preserved(self):
        write(self.checkout, "static/app.js", "local untracked work")
        with self.assertRaisesRegex(ValueError, "overwrite an untracked"):
            self.prepare()
        self.assertEqual((self.checkout / "static/app.js").read_text(), "local untracked work")


if __name__ == "__main__":
    unittest.main()
