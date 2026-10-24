"""Learning explanations, rich connections, and schema recovery on isolated data."""

import copy
from contextlib import closing
import io
import json
from pathlib import Path
import sqlite3
import sys
import tempfile
import threading
import unittest
from unittest import mock
import zipfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "tools"))
from server import (AppError, DATABASE_VERSION, LINK_KNOWLEDGE_DEFAULTS, LocalServer, Store,
                    VERIFICATION_DEFAULTS, validate_learning, validate_shard)
from shard_atlas_client import AtlasClient, ClientError, portable_archive, valid_health
from shard_atlas_mcp import LINK_SCHEMA, SHARD_SCHEMA

PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jR7sAAAAASUVORK5CYII="
LEARNING_FIELDS = ("perspectives", "walkthroughs", "comparisons", "learningLog", "verification")
LEARNING = {
    "perspectives": [{"title": "A geometric explanation", "viewpoint": "Geometry", "content": "Read the shape before the symbols.",
                      "assumptions": ["Use a finite-dimensional space."], "sourceUrl": "https://example.com/source", "sourceLocation": "Page 2"}],
    "walkthroughs": [{"title": "One update at a time", "kind": "trace", "goal": "Follow the intermediate state.",
                      "steps": [{"title": "Initialize", "expression": "x_0=0", "explanation": "Start from the given value.", "justification": "Given input."},
                                {"expression": "x_1=1", "explanation": "Perform one update.", "justification": "Apply the update rule."}],
                      "conclusion": "This is one iteration, not a convergence guarantee.", "sourceLocation": "Algorithm 1"}],
    "comparisons": [{"title": "Two methods", "question": "Which assumptions fit?", "alternatives": [
        {"name": "Exact method", "shardId": "method-a", "summary": "Uses the model.", "assumptions": ["The model is available."],
         "strengths": ["Exact update."], "limitations": ["Needs the model."], "cost": "One full sweep."},
        {"name": "Sample method", "summary": "Uses observations.", "strengths": ["Can use observed transitions."]}],
        "conclusion": "Choose according to the available information.", "sourceUrl": "https://example.com/methods"}],
    "learningLog": [{"kind": "misconception", "prompt": "I confused one update with the final result.", "status": "resolved",
                     "resolution": "An update changes the current estimate; convergence needs a separate argument.",
                     "history": [{"date": "2026-10", "note": "Recorded the original misunderstanding."},
                                 {"date": "2026-10-21", "note": "Checked the distinction."}], "sourceLocation": "My worked example"}],
    "verification": {"status": "source-checked", "note": "Compared the explanation with the cited source.",
                     "sourceUrl": "https://example.com/source", "sourceLocation": "Page 2", "checkedAt": "2026-10-21"},
}
RICH_LINK = {"scope": "Within the stated assumptions.", "evidence": "The update follows the shared recurrence.",
             "sourceUrl": "https://example.com/connection", "sourceLocation": "Section 4"}


class LearningTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.path = self.root / "learning.sqlite3"
        self.store = self.open_store(self.path)

    def open_store(self, path):
        return Store(path, root=self.root, seed=False, backup_on_start=False, automatic_backups=False)

    def tearDown(self):
        self.store.stop_backup_worker()
        self.temporary.cleanup()

    def create(self, title="A connected explanation", **fields):
        state = self.store.create_shard({"title": title, "content": "A reusable explanation.", **fields})
        return next(shard for shard in state["shards"] if shard["title"] == title)

    def assert_learning(self, shard, expected=LEARNING):
        normalized = validate_learning(expected)
        for field in LEARNING_FIELDS:
            self.assertEqual(shard[field], normalized[field], field)

    def target_import(self, identifier="imported-target", **extras):
        result = self.store.import_data({"schemaVersion": 1, "shards": [{"id": identifier, "title": "Imported target " + identifier}], **extras})
        return result["importSummary"]["importId"]

    def reference_comparison(self, target):
        return [{"title": "Related methods", "alternatives": [{"name": "Referenced method", "shardId": target}, {"name": "Other method"}]}]

    def test_old_shards_and_links_get_defaults_without_changing_understanding(self):
        first = self.create(status="solid", tags=["C++"], languageVersion="C++17")
        second = self.create("Another concept")
        for field in LEARNING_FIELDS[:-1]:
            self.assertEqual(first[field], [])
        self.assertEqual(first["verification"], VERIFICATION_DEFAULTS)
        state = self.store.create_link({"fromId": first["id"], "toId": second["id"], "type": "related_to"})
        self.assertTrue(all(state["links"][0][field] == "" for field in LINK_KNOWLEDGE_DEFAULTS))
        self.assertEqual(first["status"], "solid")
        self.assertEqual(first["languageVersion"], "C++17")

    def test_learning_roundtrips_partial_edits_versions_trash_archives_and_snapshots(self):
        original = self.create(**copy.deepcopy(LEARNING))
        first_version = self.store.revisions(original["id"])["revisions"][0]
        self.store.update_shard(original["id"], {"title": "Refined explanation"})
        self.assert_learning(self.store.state()["shards"][0])
        self.store.update_shard(original["id"], {"perspectives": [], "verification": {"status": "needs-correction", "note": "A condition was missing."}})
        restored = self.store.restore_revision(original["id"], {"revisionId": first_version["id"]})["shards"][0]
        self.assert_learning(restored)
        self.assertEqual(restored["status"], "learning")
        self.store.delete_shard(original["id"])
        trash = self.store.trash()["trash"][0]
        self.assert_learning(trash["shard"])
        self.assert_learning(self.store.restore_trash(trash["id"])["shards"][0])
        archive = self.store.export_data()
        destination = self.open_store(self.root / "roundtrip.sqlite3")
        destination.import_data(archive)
        self.assertEqual(destination.export_data(), archive)
        snapshot = self.store.backup()
        self.store.update_shard(original["id"], {"comparisons": [], "learningLog": []})
        self.assert_learning(self.store.restore_backup(snapshot["filename"])["shards"][0])

    def test_invalid_learning_metadata_is_atomic_and_source_checked_needs_evidence(self):
        original = self.create()
        before = self.store.export_data()
        invalid = [
            {"perspectives": [{"title": "Missing content"}]}, {"perspectives": [{"title": "T", "content": "C", "assumptions": ["x"] * 21}]},
            {"perspectives": [{"title": "T", "content": "x" * 30001}]}, {"perspectives": [{}] * 21},
            {"walkthroughs": [{"title": "T", "steps": []}]}, {"walkthroughs": [{"title": "T", "steps": [{}]}]},
            {"walkthroughs": [{"title": "T", "kind": "proof", "steps": [{"expression": "x"}]}]},
            {"walkthroughs": [{"title": "T", "steps": [{"explanation": "x"}] * 101}]},
            {"comparisons": [{"title": "T", "alternatives": [{"name": "Only one"}]}]},
            {"comparisons": [{"title": "T", "alternatives": [{"name": "A", "limitations": ["x"] * 31}, {"name": "B"}]}]},
            {"comparisons": [{"title": "T", "alternatives": [{"name": "A", "shardId": "bad id"}, {"name": "B"}]}]},
            {"learningLog": [{"prompt": "Question", "status": "resolved"}]},
            {"learningLog": [{"prompt": "Question", "kind": "quiz"}]},
            {"learningLog": [{"prompt": "Question", "history": [{"date": "2026-02-30", "note": "Invalid day"}]}]},
            {"learningLog": [{"prompt": "Question", "history": [{"note": ""}]}]},
            {"verification": {"status": "source-checked", "sourceUrl": "https://example.com"}},
            {"verification": {"status": "source-checked", "note": "Checked"}},
            {"verification": {"status": "mastered"}}, {"verification": {"checkedAt": "2026-13"}},
            {"verification": {"sourceUrl": "javascript:alert(1)"}},
            {"walkthroughs": [{"title": "T", "steps": [{"expression": "x", "unknown": "lost content"}]}]},
            {"comparisons": "wrong type"}, {"learningLog": [None]}, {"verification": None},
        ]
        for fields in invalid:
            with self.subTest(fields=fields):
                with self.assertRaises(AppError):
                    self.store.update_shard(original["id"], fields)
                self.assertEqual(self.store.export_data(), before)
                self.assertFalse(self.store.import_preview({"schemaVersion": 1, "shards": [{"id": "invalid", "title": "Invalid", **fields}]})["valid"])
        checked = self.store.update_shard(original["id"], {"verification": {"status": "source-checked", "note": "Checked the stated condition.", "sourceLocation": "Source page 4"}})["shards"][0]
        self.assertEqual(checked["verification"]["status"], "source-checked")
        self.assertEqual(checked["status"], "learning")

    def test_rich_connections_survive_partial_edit_trash_export_and_import(self):
        first, second = self.create(), self.create("Second explanation")
        link = self.store.create_link({"fromId": first["id"], "toId": second["id"], "type": "explains", "note": "A reason.", **RICH_LINK})["links"][0]
        revised = self.store.update_link(link["id"], {"note": "A refined reason."})["links"][0]
        self.assertEqual({field: revised[field] for field in RICH_LINK}, RICH_LINK)
        before = self.store.export_data()
        for invalid in ({"scope": "x" * 5001}, {"evidence": "x" * 10001}, {"sourceUrl": "file:///private"}, {"sourceLocation": 4}):
            with self.assertRaises(AppError):
                self.store.update_link(link["id"], invalid)
            self.assertEqual(self.store.export_data(), before)
        self.store.delete_shard(first["id"])
        trash = self.store.trash()["trash"][0]
        self.assertEqual(trash["links"][0], revised)
        self.assertEqual(self.store.restore_trash(trash["id"])["links"][0], revised)
        destination = self.open_store(self.root / "richlink.sqlite3")
        destination.import_data(self.store.export_data())
        self.assertEqual(destination.state()["links"][0], revised)

    def test_v3_migration_is_backed_up_idempotent_and_keeps_old_undo_receipts(self):
        legacy_path = self.root / "legacy.sqlite3"
        legacy = self.open_store(legacy_path)
        archive = {"schemaVersion": 1, "shards": [{"id": "old-a", "title": "A"}, {"id": "old-b", "title": "B"}],
                   "links": [{"id": "old-link", "fromId": "old-a", "toId": "old-b", "type": "explains", "note": "Legacy reason"}]}
        import_id = legacy.import_data(archive)["importSummary"]["importId"]
        with legacy.connect() as connection:
            connection.execute("ALTER TABLE links DROP COLUMN knowledge")
            connection.execute("PRAGMA user_version=3")
        before = legacy.state()
        backups_before = set(legacy.backup_dir.glob("*.sqlite3"))
        migrated = self.open_store(legacy_path)
        self.assertEqual(migrated.state(), before)
        self.assertEqual(migrated.health()["databaseVersion"], DATABASE_VERSION)
        backups = set(migrated.backup_dir.glob("*.sqlite3")) - backups_before
        self.assertEqual(len(backups), 1)
        snapshot = next(iter(backups))
        with closing(sqlite3.connect(snapshot)) as connection:
            self.assertEqual(connection.execute("PRAGMA user_version").fetchone()[0], 3)
            self.assertNotIn("knowledge", {row[1] for row in connection.execute("PRAGMA table_info(links)")})
        self.assertEqual(self.open_store(legacy_path).state(), before)
        self.assertEqual(set(migrated.backup_dir.glob("*.sqlite3")) - backups_before, backups)
        self.assertEqual(migrated.undo_import(import_id)["shards"], [])
        restored = migrated.restore_backup(snapshot.name)
        self.assertEqual(restored["shards"], before["shards"])
        self.assertEqual(restored["links"], before["links"])
        with migrated.connect() as connection:
            self.assertEqual(connection.execute("PRAGMA user_version").fetchone()[0], DATABASE_VERSION)

    def test_failed_migration_backup_leaves_v3_schema_and_records_untouched(self):
        note = self.create()
        with self.store.connect() as connection:
            connection.execute("ALTER TABLE links DROP COLUMN knowledge")
            connection.execute("PRAGMA user_version=3")
        with mock.patch.object(Store, "backup", side_effect=OSError("No space")), self.assertRaises(AppError):
            self.open_store(self.path)
        with self.store.connect() as connection:
            self.assertEqual(connection.execute("PRAGMA user_version").fetchone()[0], 3)
            self.assertNotIn("knowledge", {row[1] for row in connection.execute("PRAGMA table_info(links)")})
            self.assertEqual(connection.execute("SELECT id FROM shards").fetchone()[0], note["id"])

    def test_undo_retains_structured_references_in_drafts_and_connection_edits(self):
        target = "draft-target"
        import_id = self.target_import(target)
        self.store.save_draft("editor", {"draft": {"editingId": None, "values": {"comparisons": json.dumps(self.reference_comparison(target))}}})
        self.assertTrue(any(shard["id"] == target for shard in self.store.undo_import(import_id)["shards"]))
        self.store.delete_draft("editor")
        archive = {"schemaVersion": 1, "shards": [{"id": "draft-a", "title": "Draft A"}, {"id": "draft-b", "title": "Draft B"}],
                   "links": [{"id": "draft-edge", "fromId": "draft-a", "toId": "draft-b", "type": "related_to", **RICH_LINK}]}
        import_id = self.store.import_data(archive)["importSummary"]["importId"]
        self.store.save_draft("connection", {"draft": {"editingLinkId": "draft-edge", "values": {}}})
        state = self.store.undo_import(import_id)
        self.assertTrue(any(link["id"] == "draft-edge" for link in state["links"]))
        self.assertTrue({"draft-a", "draft-b"}.issubset({shard["id"] for shard in state["shards"]}))

    def test_undo_retains_comparison_references_in_history_and_transitive_dependencies(self):
        import_id = self.store.import_data({"schemaVersion": 1, "shards": [
            {"id": "history-target", "title": "Target", "comparisons": self.reference_comparison("dependency")},
            {"id": "dependency", "title": "Dependency"}]})["importSummary"]["importId"]
        existing = self.create("Existing explanation", comparisons=self.reference_comparison("history-target"))
        self.store.update_shard(existing["id"], {"comparisons": []})
        state = self.store.undo_import(import_id)
        self.assertTrue({"history-target", "dependency"}.issubset({shard["id"] for shard in state["shards"]}))

    def test_undo_retains_comparison_references_in_legacy_trash(self):
        import_id = self.target_import("trash-target")
        existing = self.create("Trashed explanation", comparisons=self.reference_comparison("trash-target"))
        self.store.delete_shard(existing["id"])
        with self.store.connect() as connection:
            connection.execute("DELETE FROM revisions WHERE shard_id=?", (existing["id"],))
        state = self.store.undo_import(import_id)
        self.assertTrue(any(shard["id"] == "trash-target" for shard in state["shards"]))

    def test_learning_images_are_reported_in_preview_and_preserved_by_retained_history(self):
        archive = {"schemaVersion": 1, "shards": [{"id": "image-target", "title": "Target", "perspectives": [
            {"title": "Picture", "content": "![Explanation](/assets/image-a)"}]}],
            "assets": [{"id": "image-a", "name": "image.png", "mimeType": "image/png", "data": PNG}]}
        broken = copy.deepcopy(archive)
        broken["assets"] = []
        self.assertEqual(self.store.import_preview(broken)["missing"][0]["assetId"], "image-a")
        import_id = self.store.import_data(archive)["importSummary"]["importId"]
        existing = self.create("Retained history", perspectives=[{"title": "Picture", "content": "![Explanation](/assets/image-a)"}])
        self.store.update_shard(existing["id"], {"perspectives": []})
        self.store.undo_import(import_id)
        self.assertEqual(self.store.asset("image-a")[1], "image/png")

    def test_nested_markdown_images_are_checked_in_every_learning_surface(self):
        image = "![Source diagram](/assets/nested-image)"
        candidates = [
            {"perspectives": [{"title": "Picture", "content": image}]},
            {"walkthroughs": [{"title": "Trace", "steps": [{"explanation": image}]}]},
            {"comparisons": [{"title": "Methods", "alternatives": [{"name": "A", "summary": image}, {"name": "B"}]}]},
            {"learningLog": [{"prompt": "A question", "history": [{"note": image}]}]},
            {"verification": {"note": image}},
        ]
        for candidate in candidates:
            with self.subTest(field=next(iter(candidate))):
                preview = self.store.import_preview({"schemaVersion": 1, "shards": [{"id": "nested", "title": "Nested", **candidate}]})
                self.assertTrue(preview["valid"])
                self.assertEqual([entry["assetId"] for entry in preview["missing"]], ["nested-image"])

    def test_undo_preserves_assets_used_only_by_a_retained_rich_connection(self):
        first, second = self.create(), self.create("Second")
        result = self.store.import_data({"schemaVersion": 1, "assets": [{"id": "connection-image", "name": "proof.png", "mimeType": "image/png", "data": PNG}]})
        self.store.create_link({"fromId": first["id"], "toId": second["id"], "evidence": "![Reason](/assets/connection-image)"})
        self.store.undo_import(result["importSummary"]["importId"])
        self.assertEqual(self.store.asset("connection-image")[1], "image/png")
        with zipfile.ZipFile(io.BytesIO(self.store.markdown_export())) as archive:
            name = next(name for name in archive.namelist() if name.startswith("shards/") and first["id"] in name)
            self.assertIn("![Reason](../assets/connection-image.png)", archive.read(name).decode())

    def test_markdown_export_contains_learning_versions_sources_and_rich_connection_context(self):
        first, second = self.create(**copy.deepcopy(LEARNING)), self.create("Second explanation")
        self.store.create_link({"fromId": first["id"], "toId": second["id"], "note": "A useful connection.", **RICH_LINK})
        with zipfile.ZipFile(io.BytesIO(self.store.markdown_export())) as archive:
            name = next(name for name in archive.namelist() if name.startswith("shards/") and first["id"] in name)
            text = archive.read(name).decode()
            for phrase in ("## Perspectives", "A geometric explanation", "## Walkthroughs", "Justification:", "## Method comparisons",
                           "Exact method", "## Questions and misconceptions", "original misunderstanding", "## Content verification",
                           "source-checked", RICH_LINK["scope"], RICH_LINK["evidence"], RICH_LINK["sourceUrl"]):
                self.assertIn(phrase, text)
            self.assert_learning(next(shard for shard in json.loads(archive.read("shard-atlas.json"))["shards"] if shard["id"] == first["id"]))

    def test_contribution_aliases_learning_references_and_verifies_rich_fields_over_http(self):
        existing = self.create("Canonical method", content="The same method.")
        learning = copy.deepcopy(LEARNING)
        learning["perspectives"][0]["content"] = "Use [[id:duplicate|the method]], but keep `[[id:duplicate]]` literal."
        learning["comparisons"][0]["alternatives"][0]["shardId"] = "duplicate"
        batch = {"requestId": "learning-contribution", "shards": [
            {"id": "duplicate", "title": existing["title"], "content": existing["content"], "tags": []},
            {"id": "learning-added", "title": "New learning", "content": "A distinct explanation.", "tags": [], **learning}],
            "links": [{"fromId": "learning-added", "toId": "duplicate", "type": "explains", **RICH_LINK}]}
        self.assertIn("walkthroughs", portable_archive(batch)["shards"][1])
        server = LocalServer(("127.0.0.1", 0), self.store)
        thread = threading.Thread(target=lambda: server.serve_forever(poll_interval=.05), daemon=True)
        thread.start()
        client = AtlasClient(f"http://127.0.0.1:{server.server_address[1]}")
        try:
            self.assertTrue(client.add(batch)["verified"])
            saved = next(shard for shard in self.store.state()["shards"] if shard["id"] == "learning-added")
            self.assertIn("[[id:" + existing["id"] + "|", saved["perspectives"][0]["content"])
            self.assertIn("`[[id:duplicate]]`", saved["perspectives"][0]["content"])
            self.assertEqual(saved["comparisons"][0]["alternatives"][0]["shardId"], existing["id"])
            self.assertEqual(saved["status"], "learning")
            self.assertTrue(client.search("shared recurrence")["matches"])
            self.assertTrue(client.search("original misunderstanding")["matches"])
            link = self.store.state()["links"][0]
            self.store.update_link(link["id"], {"scope": "User corrected the scope."})
            self.assertFalse(client.add(batch)["currentContentMatches"])
            self.assertEqual(self.store.state()["links"][0]["scope"], "User corrected the scope.")
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)

    def test_missing_rich_link_readback_rolls_back_a_new_contribution(self):
        batch = {"requestId": "lost-link-context", "shards": [{"id": "a", "title": "A"}, {"id": "b", "title": "B"}],
                 "links": [{"fromId": "a", "toId": "b", "type": "explains", **RICH_LINK}]}
        before = self.store.export_data()
        insert = self.store._insert_link
        def lose_context(connection, link):
            insert(connection, link)
            connection.execute("UPDATE links SET knowledge='{}' WHERE id=?", (link["id"],))
        with mock.patch.object(self.store, "_insert_link", side_effect=lose_context), self.assertRaises(AppError):
            self.store.contribute(batch)
        self.assertEqual(self.store.export_data(), before)

    def test_mcp_schema_exposes_nested_learning_and_connection_fields(self):
        self.assertTrue(set(LEARNING_FIELDS).issubset(SHARD_SCHEMA["properties"]))
        self.assertTrue(set(LINK_KNOWLEDGE_DEFAULTS).issubset(LINK_SCHEMA["properties"]))
        self.assertTrue({"supports", "contradicts"}.issubset(LINK_SCHEMA["properties"]["type"]["enum"]))

    def test_contributor_discovery_rejects_older_services_without_current_metadata_support(self):
        health = self.store.health()
        self.assertFalse(valid_health({**health, "backendVersion": "2.5.0"}, self.path))
        self.assertFalse(valid_health({**health, "backendVersion": "2.2.0"}, self.path))
        self.assertFalse(valid_health({**health, "backendVersion": "2.6.0"}, self.path))
        self.assertFalse(valid_health({**health, "backendVersion": "2.7.0"}, self.path))
        self.assertTrue(valid_health({**health, "backendVersion": "2.9.0"}, self.path))
        self.assertTrue(valid_health({**health, "backendVersion": "3.0.0"}, self.path))


if __name__ == "__main__":
    unittest.main()
