"""Academic metadata and recovery contracts, using isolated collections only."""

import copy
import io
import json
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from unittest import mock
import zipfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "tools"))
from server import AppError, LocalServer, Store, validate_academic, validate_shard
from shard_atlas_client import AtlasClient, ClientError, portable_archive
from shard_atlas_mcp import SHARD_SCHEMA


ACADEMIC_FIELDS = ("subjects", "courses", "notation", "assumptions")
ACADEMIC = {
    "subjects": ["Mathematics", "ML"],
    "courses": [
        {"courseCode": "CS 4789", "courseTitle": "Reinforcement Learning", "term": "Fall 2026",
         "lecture": "Value iteration", "position": 3, "sourceUrl": "https://example.com/notes3.pdf",
         "sourceLocation": "Section 3.2, page 4", "context": "Discounted finite-state setting."},
        {"courseCode": "Mathematics", "lecture": "Fixed points", "position": 2.5},
    ],
    "notation": [
        {"symbol": "\\gamma", "meaning": "Discount factor", "shape": "Scalar", "role": "Fixed input",
         "scope": "CS 4789, discounted MDP"},
        {"symbol": "\\gamma", "meaning": "Deviation tolerance", "shape": "Scalar", "role": "Chosen bound",
         "scope": "CS 3780, validation"},
    ],
    "assumptions": ["The state and action sets are finite.", "The discount is nonnegative and below one."],
}


class AcademicTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.path = self.root / "qa.sqlite3"
        self.store = self.open_store(self.path)

    def open_store(self, path):
        return Store(path, root=self.root, seed=False, backup_on_start=False, automatic_backups=False)

    def tearDown(self):
        self.store.stop_backup_worker()
        self.temporary.cleanup()

    def create(self, **changes):
        return self.store.create_shard({"title": "Bellman backups", "content": "Immediate reward plus continuation value.",
                                       **copy.deepcopy(ACADEMIC), **changes})["shards"][0]

    def assert_academic(self, saved, expected=ACADEMIC):
        normalized = validate_academic(expected)
        for field in ACADEMIC_FIELDS:
            self.assertEqual(saved[field], normalized[field], field)

    def test_academic_occurrences_and_local_symbol_scopes_survive_partial_edit_and_reopen(self):
        original = self.create()
        edited = self.store.update_shard(original["id"], {"content": "An expanded explanation."})["shards"][0]
        self.assert_academic(edited)
        reopened = self.open_store(self.path)
        try:
            self.assertEqual(reopened.state()["shards"][0], edited)
            self.assertEqual(len(edited["notation"]), 2)
            self.assertNotEqual(edited["notation"][0]["scope"], edited["notation"][1]["scope"])
            self.assertEqual(edited["createdAt"], original["createdAt"])
        finally:
            reopened.stop_backup_worker()

    def test_old_notes_get_empty_academic_defaults_without_changing_cpp_fields(self):
        saved = self.store.create_shard({"title": "C++ ownership", "content": "An owner releases its resource.",
                                         "tags": ["C++"], "languageVersion": "C++98"})["shards"][0]
        for field in ACADEMIC_FIELDS:
            self.assertEqual(saved[field], [])
        self.assertEqual(saved["languageVersion"], "C++98")
        self.assertEqual(saved["tags"], ["C++"])

    def test_invalid_metadata_is_rejected_atomically_in_edits_and_imports(self):
        original = self.create()
        before = self.store.export_data()
        invalid = [
            {"subjects": "ML"}, {"subjects": [""]}, {"subjects": ["x"] * 21},
            {"subjects": ["x" * 81]}, {"assumptions": [" " ]}, {"assumptions": ["x" * 2001]},
            {"assumptions": ["x"] * 101}, {"courses": {}}, {"courses": [{}]},
            {"courses": [{"courseCode": "CS 4789", "position": True}]},
            {"courses": [{"courseCode": "CS 4789", "position": float("nan")}]},
            {"courses": [{"courseCode": "CS 4789", "position": float("inf")}]},
            {"courses": [{"courseCode": "CS 4789", "position": -1}]},
            {"courses": [{"courseCode": "CS 4789", "position": 10 ** 1000}]},
            {"courses": [{"courseCode": "CS 4789", "sourceUrl": "javascript:alert(1)"}]},
            {"courses": [{"courseCode": "CS 4789", "sourceUrl": "https://user:secret@example.com/"}]},
            {"courses": [{"courseCode": "CS 4789", "unknown": "Lost context"}]},
            {"notation": [{"symbol": "V"}]}, {"notation": [{"meaning": "A value"}]},
            {"notation": [{"symbol": "V", "meaning": "Value", "scope": 3}]},
            {"notation": [{"symbol": "V", "meaning": "Value", "unknown": "Lost meaning"}]},
            {"notation": [{"symbol": "V", "meaning": "Value"}] * 101},
        ]
        for changes in invalid:
            with self.subTest(changes=changes):
                with self.assertRaises(AppError):
                    self.store.update_shard(original["id"], changes)
                self.assertEqual(self.store.export_data(), before)
                with self.assertRaises(AppError):
                    self.store.import_data({"schemaVersion": 1, "shards": [
                        {"id": "invalid-import", "title": "Must not save", **changes}]})
                self.assertEqual(self.store.export_data(), before)

    def test_academic_metadata_roundtrips_through_archives_revisions_and_trash(self):
        original = self.create()
        revision = self.store.revisions(original["id"])["revisions"][0]
        self.store.update_shard(original["id"], {"courses": [], "notation": [], "assumptions": [], "subjects": []})
        restored = self.store.restore_revision(original["id"], {"revisionId": revision["id"]})["shards"][0]
        self.assert_academic(restored)
        self.store.delete_shard(original["id"])
        trashed = self.store.trash()["trash"][0]
        self.assert_academic(trashed["shard"])
        restored = self.store.restore_trash(trashed["id"])["shards"][0]
        self.assert_academic(restored)
        archive = self.store.export_data()
        destination = self.open_store(self.root / "imported.sqlite3")
        try:
            destination.import_data(archive)
            self.assertEqual(destination.export_data(), archive)
        finally:
            destination.stop_backup_worker()

    def test_safety_snapshot_restores_academic_metadata(self):
        original = self.create()
        snapshot = self.store.backup()
        self.store.update_shard(original["id"], {"notation": [], "courses": []})
        restored = self.store.restore_backup(snapshot["filename"])
        self.assert_academic(restored["shards"][0])

    def test_markdown_export_includes_course_locations_scopes_roles_and_assumptions(self):
        original = self.create()
        with zipfile.ZipFile(io.BytesIO(self.store.markdown_export())) as archive:
            note_name = next(name for name in archive.namelist() if name.startswith("shards/"))
            text = archive.read(note_name).decode("utf-8")
            for phrase in ("Subjects: Mathematics, ML", "## Course occurrences", "CS 4789", "Section 3.2, page 4",
                           "https://example.com/notes3.pdf", "## Notation", "Discount factor", "Role: Fixed input",
                           "Scope: CS 3780, validation", "## Assumptions", ACADEMIC["assumptions"][0]):
                self.assertIn(phrase, text)
            self.assert_academic(json.loads(archive.read("shard-atlas.json"))["shards"][0])
            self.assertEqual(json.loads(archive.read("shard-atlas.json"))["shards"][0]["id"], original["id"])

    def test_preview_checks_metadata_without_saving_and_import_undo_preserves_later_edits(self):
        archive = {"schemaVersion": 1, "shards": [{"id": "previewed", "title": "Iteration", **copy.deepcopy(ACADEMIC)}]}
        self.assertTrue(self.store.import_preview(archive)["valid"])
        self.assertEqual(self.store.state()["shards"], [])
        broken = copy.deepcopy(archive)
        broken["shards"][0]["notation"][0]["meaning"] = ""
        self.assertFalse(self.store.import_preview(broken)["valid"])
        saved = self.store.import_data(archive)
        import_id = saved["importSummary"]["importId"]
        revised = copy.deepcopy(saved["shards"][0]["courses"])
        revised[0]["context"] = "My corrected course context."
        self.store.update_shard("previewed", {"courses": revised})
        undone = self.store.undo_import(import_id)
        self.assertEqual(undone["shards"][0]["courses"], revised)
        self.assertTrue(any(item["kind"] == "shards" for item in undone["undoSummary"]["skipped"]))

    def test_old_receipt_fingerprints_remain_valid_after_empty_defaults_are_read(self):
        saved = self.store.import_data({"schemaVersion": 1, "shards": [{"id": "old-import", "title": "Old C++ note"}]})
        import_id = saved["importSummary"]["importId"]
        with self.store.connect() as connection:
            knowledge = json.loads(connection.execute("SELECT knowledge FROM shards").fetchone()[0])
            for field in ACADEMIC_FIELDS:
                knowledge.pop(field)
            old_knowledge = json.dumps(knowledge)
            connection.execute("UPDATE shards SET knowledge=?", (old_knowledge,))
            for row in connection.execute("SELECT id,snapshot FROM revisions").fetchall():
                snapshot = json.loads(row["snapshot"])
                for field in ACADEMIC_FIELDS:
                    snapshot.pop(field)
                connection.execute("UPDATE revisions SET snapshot=? WHERE id=?", (json.dumps(snapshot), row["id"]))
            receipt = json.loads(connection.execute("SELECT payload FROM imports WHERE id=?", (import_id,)).fetchone()[0])
            for table, records in receipt["records"].items():
                for record in records:
                    record["fingerprint"] = self.store._record_fingerprint(connection, table, record["id"])
            connection.execute("UPDATE imports SET payload=? WHERE id=?", (json.dumps(receipt), import_id))
        reopened = self.open_store(self.path)
        try:
            for field in ACADEMIC_FIELDS:
                self.assertEqual(reopened.state()["shards"][0][field], [])
            with reopened.connect() as connection:
                self.assertEqual(connection.execute("SELECT knowledge FROM shards").fetchone()[0], old_knowledge)
            self.assertEqual(reopened.undo_import(import_id)["shards"], [])
        finally:
            reopened.stop_backup_worker()

    def test_bulk_refined_import_keeps_current_explanation_alongside_older_history(self):
        old = validate_shard({"id": "bulk-refined", "title": "An incoming concept", "content": "Original source text."}, imported=True)
        current = {**old, "content": "My bulk-reviewed explanation.", **copy.deepcopy(ACADEMIC)}
        archive = {"schemaVersion": 1, "shards": [current], "revisions": [{"id": "old-source-version", "shardId": old["id"],
            "createdAt": old["createdAt"], "reason": "original", "snapshot": old}]}
        saved = self.store.import_data(archive)
        versions = self.store.revisions(old["id"])["revisions"]
        self.assertEqual({record["snapshot"]["content"] for record in versions}, {old["content"], current["content"]})
        refined = next(record for record in versions if record["snapshot"]["content"] == current["content"])
        self.assert_academic(refined["snapshot"])
        self.assertEqual(len(versions), 2)
        before = self.store.export_data()
        self.store.import_data(archive)
        self.assertEqual(self.store.export_data(), before, "Reimport must not add history to an existing card.")
        self.store.update_shard(old["id"], {"content": "A later normal edit."})
        self.assertTrue(any(record["snapshot"]["content"] == current["content"] for record in self.store.revisions(old["id"])["revisions"]))
        restored = self.store.restore_revision(old["id"], {"revisionId": refined["id"]})["shards"][0]
        self.assertEqual(restored["content"], current["content"])
        self.assert_academic(restored)

    def test_import_does_not_duplicate_a_matching_current_snapshot(self):
        current = validate_shard({"id": "already-recorded", "title": "Current concept", **copy.deepcopy(ACADEMIC)}, imported=True)
        archive = {"schemaVersion": 1, "shards": [current], "revisions": [{"id": "matching-version", "shardId": current["id"],
            "createdAt": current["createdAt"], "reason": "created", "snapshot": current}]}
        self.store.import_data(archive)
        self.assertEqual(len(self.store.revisions(current["id"])["revisions"]), 1)

    def test_portable_contributions_accept_and_verify_all_academic_fields(self):
        batch = {"requestId": "academic-contribution", "shards": [
            {"id": "academic-contributed", "title": "Contraction", "content": "Distances shrink.", "tags": [], **copy.deepcopy(ACADEMIC)}], "links": []}
        self.assert_academic(portable_archive(batch)["shards"][0])
        server = LocalServer(("127.0.0.1", 0), self.store)
        thread = threading.Thread(target=lambda: server.serve_forever(poll_interval=.05), daemon=True)
        thread.start()
        client = AtlasClient(f"http://127.0.0.1:{server.server_address[1]}")
        try:
            self.assertTrue(client.add(batch)["verified"])
            saved = self.store.state()["shards"][0]
            self.assert_academic(saved)
            self.assertEqual(client.search("CS 4789")["matches"][0]["id"], saved["id"])
            self.assertEqual(client.search("Deviation tolerance")["matches"][0]["id"], saved["id"])
            self.assertTrue(client.add(batch)["replayed"])
            changed = copy.deepcopy(saved["notation"])
            changed[0]["meaning"] = "A corrected meaning."
            self.store.update_shard(saved["id"], {"notation": changed})
            replay = client.add(batch)
            self.assertFalse(replay["currentContentMatches"])
            self.assertEqual(replay["changedShardIds"], [saved["id"]])
            real_state = client.state
            def lost_metadata():
                state = real_state()
                state["shards"][0]["courses"] = []
                return state
            with mock.patch.object(client, "state", side_effect=lost_metadata):
                self.assertFalse(client.add(batch)["currentContentMatches"])
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)

    def test_new_save_with_missing_academic_readback_cannot_claim_success(self):
        server = LocalServer(("127.0.0.1", 0), self.store)
        thread = threading.Thread(target=lambda: server.serve_forever(poll_interval=.05), daemon=True)
        thread.start()
        client = AtlasClient(f"http://127.0.0.1:{server.server_address[1]}")
        batch = {"requestId": "lost-academic-readback", "shards": [{"id": "readback-note", "title": "Readback", **copy.deepcopy(ACADEMIC)}]}
        real_state = client.state
        def lost_metadata():
            state = real_state()
            for shard in state["shards"]:
                shard["subjects"] = []
            return state
        try:
            with mock.patch.object(client, "state", side_effect=lost_metadata), self.assertRaises(ClientError):
                client.add(batch)
            self.assert_academic(self.store.state()["shards"][0])
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)

    def test_mcp_schema_exposes_metadata_with_scoped_notation_and_course_sources(self):
        properties = SHARD_SCHEMA["properties"]
        self.assertTrue(set(ACADEMIC_FIELDS).issubset(properties))
        self.assertEqual(properties["courses"]["items"]["required"], ["courseCode"])
        self.assertIn("sourceLocation", properties["courses"]["items"]["properties"])
        self.assertEqual(properties["notation"]["items"]["required"], ["symbol", "meaning"])
        self.assertIn("scope", properties["notation"]["items"]["properties"])


if __name__ == "__main__":
    unittest.main()
