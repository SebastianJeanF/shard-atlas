"""Check native cross-atlas URL isolation without opening either app or a database."""

import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


@unittest.skipUnless(sys.platform == "darwin" and shutil.which("swiftc"), "Requires the macOS Swift toolchain")
class NativeAtlasNavigationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory()
        root = Path(cls.temporary.name)
        source = (ROOT / "desktop/ShardAtlas.swift").read_text()
        helper = source.split("struct AtlasNavigationLink {", 1)[1].split("\nstruct DesktopConfiguration {", 1)[0]
        harness = '''
let input = try JSONSerialization.jsonObject(with: Data(CommandLine.arguments[1].utf8)) as! [String: Any]
let url = URL(string: input["url"] as! String)!
let qa = input["qa"] as? Bool ?? false
let result = ["accepted": AtlasNavigationLink.parse(url, qa: qa) != nil,
              "historyReturn": AtlasNavigationLink.historyReturn(url, qa: qa)]
let data = try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys])
print(String(data: data, encoding: .utf8)!)
'''
        swift = root / "Navigation.swift"
        swift.write_text("import Foundation\nstruct AtlasNavigationLink {" + helper + harness)
        cls.executable = root / "navigation"
        subprocess.run(["swiftc", "-swift-version", "5", str(swift), "-o", str(cls.executable)], check=True, capture_output=True, text=True)

    @classmethod
    def tearDownClass(cls):
        cls.temporary.cleanup()

    def parse(self, url, qa=False):
        result = subprocess.run([str(self.executable), json.dumps({"url": url, "qa": qa})], check=True, capture_output=True, text=True)
        return json.loads(result.stdout)

    def test_production_and_qa_scheme_registration_remain_separate(self):
        self.assertTrue(self.parse("shardatlas://shard/Math.sigmoid_v2:proof")["accepted"])
        self.assertTrue(self.parse("shardatlas-qa://shard/qa-target", qa=True)["accepted"])
        self.assertFalse(self.parse("shardatlas://shard/target", qa=True)["accepted"])
        self.assertFalse(self.parse("shardatlas-qa://shard/target")["accepted"])

    def test_return_context_is_bounded_paired_identity_not_a_callback(self):
        valid = "shardatlas://shard/id?historyCollection=atlas-uuid&historyRecord=history-context"
        self.assertTrue(self.parse(valid)["accepted"])
        for url in [valid + "&callback=https://example.org", valid + "&historyRecord=another",
                    "shardatlas://shard/id?historyRecord=event", "shardatlas://shard/id?historyCollection=collection",
                    "shardatlas://shard/id?historyCollection=collection&historyRecord=Upper",
                    "shardatlas://user:pass@shard/id", "shardatlas://shard:80/id", "shardatlas://shard/id/extra",
                    "shardatlas://shard/id%0A", "shardatlas://shard/id#fragment",
                    "shardatlas://shard/" + "a" * 101]:
            with self.subTest(url=url):
                self.assertFalse(self.parse(url)["accepted"])

    def test_only_exact_history_event_links_can_leave_the_native_webview(self):
        link = "historyatlas://event/history-context?collection=atlas-uuid"
        self.assertTrue(self.parse(link)["historyReturn"])
        self.assertTrue(self.parse(link.replace("historyatlas:", "historyatlas-qa:"), qa=True)["historyReturn"])
        for url in [link + "&callback=https://example.org", link + "#other", link + "&collection=other",
                    "historyatlas://event/history-context", "historyatlas://event/Upper?collection=atlas-uuid",
                    "historyatlas://other/history-context?collection=atlas-uuid", link.replace("historyatlas:", "historyatlas-qa:")]:
            with self.subTest(url=url):
                self.assertFalse(self.parse(url)["historyReturn"])
        self.assertFalse(self.parse(link, qa=True)["historyReturn"])
