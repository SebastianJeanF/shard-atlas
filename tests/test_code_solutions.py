"""Code-reference persistence and relationship safety using temporary collections."""

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
from server import (AppError, DATABASE_VERSION, DriveInbox, LocalServer, Store,
                    remap_shard_references, validate_code_solution)
from shard_atlas_client import AtlasClient, inbox_envelope, portable_archive, valid_health
from shard_atlas_mcp import CODE_SOLUTION_SCHEMA, LINK_SCHEMA, SHARD_SCHEMA, MCPServer

CODE = 'int lowbit(int n) {\n\treturn n & -n; // [[id:literal]]\n}\n\n'
SOLUTION = {"role": "problem", "aliases": ["course scheduling", "find order"], "purpose": "Return a valid course order.",
    "code": CODE, "headers": ["<vector>"], "timeComplexity": "O(V + E)", "spaceComplexity": "O(V + E)",
    "complexityNotes": "Count adjacency storage.", "assumptions": ["Course IDs are in range."], "pitfalls": ["Reject cycles."],
    "approaches": [{"id": "kahn", "title": "Kahn", "summary": "Remove zero-indegree vertices.", "code": CODE, "headers": ["<queue>"],
                    "timeComplexity": "O(V + E)", "spaceComplexity": "O(V + E)", "assumptions": ["Directed graph."], "pitfalls": ["Check result size."]},
                   {"id": "dfs", "title": "DFS", "summary": "Reverse finishing order.", "code": "// DFS\n"}]}


class CodeSolutionsTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.store = self.open_store(self.root / "qa.sqlite3")

    def open_store(self, path):
        return Store(path, root=self.root, seed=False, backup_on_start=False, automatic_backups=False)

    def tearDown(self):
        self.store.stop_backup_worker()
        self.temporary.cleanup()

    def create(self, title="Course Schedule II", solution=None):
        state = self.store.create_shard({"title": title, "codeSolution": copy.deepcopy(SOLUTION if solution is None else solution)})
        return next(item for item in state["shards"] if item["title"] == title)

    def connect(self, source, target, approach="kahn", **extra):
        existing_ids = {item["id"] for item in self.store.state()["links"]}
        state = self.store.create_link({"fromId": source["id"], "toId": target["id"], "type": "uses", "fromApproachId": approach, **extra})
        created = [item for item in state["links"] if item["id"] not in existing_ids]
        self.assertEqual(len(created), 1)
        return created[0]

    def test_exact_source_and_metadata_survive_old_patch_reopen_drafts_and_recovery(self):
        original = self.create()
        normalized = validate_code_solution(SOLUTION)
        revision = self.store.revisions(original["id"])["revisions"][0]
        self.store.save_draft("editor", {"draft": {"editingId": original["id"], "values": {"codeSolution": SOLUTION}}})
        self.assertEqual(self.store.drafts()["drafts"]["editor"]["values"]["codeSolution"]["code"], CODE)
        self.store.update_shard(original["id"], {"title": "Scheduling"})
        self.assertEqual(self.open_store(self.store.db_path).state()["shards"][0]["codeSolution"], normalized)
        self.store.update_shard(original["id"], {"codeSolution": {"role": "snippet", "code": "changed"}})
        restored = self.store.restore_revision(original["id"], {"revisionId": revision["id"]})
        self.assertEqual(restored["shards"][0]["codeSolution"], normalized)
        self.store.delete_shard(original["id"])
        trash = self.store.trash()["trash"][0]
        self.assertEqual(trash["shard"]["codeSolution"]["code"], CODE)
        self.store.restore_trash(trash["id"])
        backup = self.store.backup()
        self.store.update_shard(original["id"], {"codeSolution": {}})
        self.assertEqual(self.store.restore_backup(backup["filename"])["shards"][0]["codeSolution"], normalized)

    def test_arbitrary_tags_retain_per_tag_validation(self):
        tags = ["Tag " + str(index) for index in range(125)]
        state = self.store.create_shard({"title": "Many topics", "tags": tags})
        self.assertEqual(state["shards"][0]["tags"], tags)
        for invalid in (["x" * 81], [""], ["same", "same"], "wrong"):
            with self.assertRaises(AppError):
                self.store.update_shard(state["shards"][0]["id"], {"tags": invalid})

    def test_approach_ids_fallback_are_stable_and_bad_metadata_is_atomic(self):
        source = self.create(solution={"role": "problem", "approaches": [{"title": "One", "code": CODE}]})
        identifier = source["codeSolution"]["approaches"][0]["id"]
        self.assertTrue(identifier)
        self.store.update_shard(source["id"], {"status": "solid"})
        self.assertEqual(self.store.state()["shards"][0]["codeSolution"]["approaches"][0]["id"], identifier)
        before = self.store.export_data()
        invalid = [{"role": "data_structure"}, {"code": "bad\0"}, {"approaches": [{"id": "same"}, {"id": "same"}]},
                   {"aliases": "wrong"}, {"approaches": [{"id": "bad id"}]}, {"extra": "lost"}, {"code": "x" * 100001}]
        for data in invalid:
            with self.subTest(data=str(data)[:120]), self.assertRaises(AppError):
                self.store.update_shard(source["id"], {"codeSolution": data})
            self.assertEqual(self.store.export_data(), before)

    def test_same_technique_supports_distinct_approaches_and_crud_validation(self):
        problem = self.create()
        technique = self.create("Topological sort", {"role": "algorithm"})
        first = self.connect(problem, technique, "kahn")
        second = self.connect(problem, technique, "dfs")
        self.assertNotEqual(first["id"], second["id"])
        self.assertEqual(len(self.store.state()["links"]), 2)
        with self.assertRaises(AppError):
            self.connect(problem, technique, "kahn")
        for data in ({"fromApproachId": "missing"}, {"toApproachId": "dfs"}, {"fromApproachId": None}):
            before = self.store.export_data()
            with self.assertRaises(AppError):
                self.store.update_link(first["id"], data)
            self.assertEqual(self.store.export_data(), before)
        updated = self.store.update_link(first["id"], {"type": "implements", "note": "A concrete implementation."})
        self.assertEqual(next(item for item in updated["links"] if item["id"] == first["id"])["fromApproachId"], "kahn")

    def test_alternatives_are_symmetric_single_edges_including_within_a_problem(self):
        first = self.create("First", {"role": "algorithm"})
        second = self.create("Second", {"role": "algorithm"})
        self.store.create_link({"fromId": first["id"], "toId": second["id"], "type": "alternative_to"})
        with self.assertRaises(AppError):
            self.store.create_link({"fromId": second["id"], "toId": first["id"], "type": "alternative_to"})
        problem = self.create()
        self.store.create_link({"fromId": problem["id"], "toId": problem["id"], "type": "alternative_to", "fromApproachId": "kahn", "toApproachId": "dfs"})
        with self.assertRaises(AppError):
            self.store.create_link({"fromId": problem["id"], "toId": problem["id"], "type": "alternative_to", "fromApproachId": "dfs", "toApproachId": "kahn"})

    def test_deleting_linked_approach_or_restoring_old_revision_is_blocked_even_for_trash(self):
        problem = self.create(solution={"role": "problem"})
        early = self.store.revisions(problem["id"])["revisions"][0]
        self.store.update_shard(problem["id"], {"codeSolution": SOLUTION})
        technique = self.create("Kahn algorithm", {"role": "algorithm"})
        link = self.connect(problem, technique)
        before = self.store.export_data()
        with self.assertRaisesRegex(AppError, "solution approach"):
            self.store.update_shard(problem["id"], {"codeSolution": {}})
        with self.assertRaisesRegex(AppError, "solution approach"):
            self.store.restore_revision(problem["id"], {"revisionId": early["id"]})
        self.assertEqual(self.store.export_data(), before)
        self.store.delete_shard(technique["id"])
        with self.assertRaisesRegex(AppError, "Trash"):
            self.store.update_shard(problem["id"], {"codeSolution": {}})
        restored = self.store.restore_trash(self.store.trash()["trash"][0]["id"])
        self.assertEqual(restored["links"][0], link)
        self.store.delete_link(link["id"])
        self.store.update_shard(problem["id"], {"codeSolution": {}})

    def test_archive_preview_roundtrip_repeated_import_and_markdown(self):
        problem = self.create()
        technique = self.create("Kahn algorithm", {"role": "algorithm"})
        self.connect(problem, technique, "kahn")
        self.connect(problem, technique, "dfs")
        archive = self.store.export_data()
        target = self.open_store(self.root / "target.sqlite3")
        self.assertTrue(target.import_preview(archive)["valid"])
        target.import_data(archive)
        self.assertEqual(target.export_data(), archive)
        self.assertEqual(target.import_data(archive)["importSummary"]["added"]["links"], 0)
        with zipfile.ZipFile(io.BytesIO(self.store.markdown_export())) as package:
            saved = json.loads(package.read("shard-atlas.json"))
            saved_problem = next(item for item in saved["shards"] if item["id"] == problem["id"])
            self.assertEqual(saved_problem["codeSolution"]["code"], CODE)
            markdown = package.read(next(name for name in package.namelist() if name.startswith("shards/Course"))).decode()
            self.assertIn(CODE, markdown)
            self.assertIn("Approach ID: kahn", markdown)
        invalid = copy.deepcopy(archive)
        invalid["links"][0]["fromApproachId"] = "missing"
        self.assertFalse(target.import_preview(invalid)["valid"])
        with self.assertRaises(AppError):
            target.import_data(invalid)

    def test_independent_store_writers_cannot_link_an_approach_during_its_deletion(self):
        problem = self.create()
        technique = self.create("Independent writer", {"role": "algorithm"})
        other = self.open_store(self.store.db_path)
        checked, attempted, finished = threading.Event(), threading.Event(), threading.Event()
        errors = []
        original = Store._protect_approach_references
        def after_check(connection, shard):
            original(connection, shard)
            checked.set()
            self.assertTrue(attempted.wait(2))
            # Without BEGIN IMMEDIATE the competing write can finish here and
            # invalidate the check before the approach update is written.
            finished.wait(.1)
        def add_link():
            checked.wait(2)
            attempted.set()
            try:
                other.create_link({"fromId": problem["id"], "fromApproachId": "kahn", "toId": technique["id"], "type": "uses"})
            except AppError as error:
                errors.append(error)
            finally:
                finished.set()
        thread = threading.Thread(target=add_link)
        thread.start()
        try:
            with mock.patch.object(Store, "_protect_approach_references", side_effect=after_check):
                self.store.update_shard(problem["id"], {"codeSolution": {}})
            thread.join(3)
            self.assertFalse(thread.is_alive())
            self.assertEqual(len(errors), 1)
            self.assertIn("missing solution approach", str(errors[0]))
            self.assertEqual(self.store.state()["links"], [])
        finally:
            thread.join(3)

    def test_duplicate_import_ref_uses_preserved_existing_shard_and_scoped_identity(self):
        problem = self.create()
        technique = self.create("Kahn algorithm", {"role": "algorithm"})
        link = self.connect(problem, technique)
        incoming = {"schemaVersion": 1, "shards": [{**problem, "codeSolution": {"role": "problem", "approaches": [{"id": "incoming-only"}]}}],
                    "links": [{**link, "id": "new-scope", "fromApproachId": "incoming-only"}]}
        self.assertFalse(self.store.import_preview(incoming)["valid"])
        duplicate = {"schemaVersion": 1, "links": [{**link, "id": "duplicate"}]}
        self.assertFalse(self.store.import_preview(duplicate)["valid"])
        distinct = {"schemaVersion": 1, "links": [{**link, "id": "new-scope", "fromApproachId": "dfs"}]}
        self.assertTrue(self.store.import_preview(distinct)["valid"])
        self.store.import_data(distinct)
        self.assertEqual(len(self.store.state()["links"]), 2)

    def test_contribution_reuse_remaps_endpoints_and_preserves_distinct_code(self):
        problem = self.create()
        technique = self.create("Kahn algorithm", {"role": "algorithm", "purpose": "Sort a DAG."})
        batch = {"requestId": "code-reuse", "shards": [{"id": "alias", "title": problem["title"], "codeSolution": SOLUTION}],
            "links": [{"id": "scoped-one", "fromId": "alias", "fromApproachId": "kahn", "toId": technique["id"], "type": "uses"},
                      {"id": "scoped-two", "fromId": "alias", "fromApproachId": "dfs", "toId": technique["id"], "type": "uses"}]}
        result = self.store.contribute(batch)
        self.assertEqual(result["idMap"]["alias"], problem["id"])
        self.assertEqual(result["added"], {"shards": 0, "links": 2})
        self.assertTrue(self.store.contribute(batch)["replayed"])
        changed = copy.deepcopy(batch)
        changed["requestId"] = "different-code"
        changed["shards"][0]["id"] = "different"
        changed["shards"][0]["codeSolution"]["code"] = "// a different solution\n"
        changed["links"] = []
        self.assertEqual(self.store.contribute(changed)["added"]["shards"], 1)
        with self.assertRaises(AppError):
            self.store.contribute({"requestId": "overwrite-code", "shards": [{"id": problem["id"], "title": problem["title"], "codeSolution": {"code": "different"}}]})

    def test_reference_remap_changes_prose_but_never_literal_source(self):
        source = {"codeSolution": {"purpose": "Use [[id:old|method]].", "code": '"[[id:old]]"\n',
            "approaches": [{"id": "keep", "summary": "Use [[id:old]].", "code": '"[[id:old]]"\n'}]}}
        remapped = remap_shard_references(source, {"old": "new"})
        self.assertIn("[[id:new", remapped["codeSolution"]["purpose"])
        self.assertIn("[[id:new", remapped["codeSolution"]["approaches"][0]["summary"])
        self.assertEqual(remapped["codeSolution"]["code"], source["codeSolution"]["code"])
        self.assertEqual(remapped["codeSolution"]["approaches"][0]["code"], source["codeSolution"]["approaches"][0]["code"])
        literal = {"schemaVersion": 1, "shards": [{"id": "literal-source", "title": "Literal strings", "codeSolution": {"role": "snippet",
            "code": 'const char* x = "![not an image](/assets/example) [[id:unrelated]]";\n', "headers": ["[[id:not-a-link]]"]}}]}
        preview = self.store.import_preview(literal)
        self.assertTrue(preview["valid"])
        self.assertEqual(preview["missing"], [])

    def test_v4_schema_upgrade_is_backed_up_and_restorable(self):
        first = self.create("Old one", {})
        second = self.create("Old two", {})
        old_link = self.store.create_link({"fromId": first["id"], "toId": second["id"], "type": "related_to"})["links"][0]
        with self.store.connect() as connection:
            connection.executescript("""CREATE TABLE old_links (
                id TEXT PRIMARY KEY, from_id TEXT NOT NULL REFERENCES shards(id) ON DELETE CASCADE,
                to_id TEXT NOT NULL REFERENCES shards(id) ON DELETE CASCADE,
                type TEXT NOT NULL CHECK(type IN ('depends_on','explains','contrasts_with','example_of','related_to','part_of','supports','contradicts','supersedes','released_by')),
                note TEXT NOT NULL, created_at TEXT NOT NULL, knowledge TEXT NOT NULL DEFAULT '{}',
                CHECK(from_id <> to_id), UNIQUE(from_id,to_id,type));
                INSERT INTO old_links SELECT id,from_id,to_id,type,note,created_at,knowledge FROM links;
                DROP TABLE links; ALTER TABLE old_links RENAME TO links; PRAGMA user_version=4;""")
        with mock.patch.object(Store, "backup", side_effect=OSError("blocked")):
            with self.assertRaisesRegex(AppError, "safety snapshot"):
                self.open_store(self.store.db_path)
        with closing(sqlite3.connect(self.store.db_path)) as connection:
            self.assertEqual(connection.execute("PRAGMA user_version").fetchone()[0], 4)
        upgraded = self.open_store(self.store.db_path)
        self.assertEqual(upgraded.state()["links"], [old_link])
        backups = upgraded.backups()["backups"]
        self.assertTrue(backups)
        self.assertTrue(all(item["valid"] for item in backups))
        upgraded.restore_backup(backups[0]["filename"])
        with upgraded.connect() as connection:
            self.assertEqual(connection.execute("PRAGMA user_version").fetchone()[0], DATABASE_VERSION)
            self.assertEqual(connection.execute("PRAGMA foreign_key_check").fetchall(), [])

    def test_helper_mcp_and_drive_preserve_code_and_search_aliases(self):
        server = LocalServer(("127.0.0.1", 0), self.store)
        thread = threading.Thread(target=lambda: server.serve_forever(poll_interval=.01), daemon=True)
        thread.start()
        try:
            client = AtlasClient(f"http://127.0.0.1:{server.server_address[1]}")
            batch = {"requestId": "code-tools", "shards": [{"id": "popcount", "title": "Population count", "tags": ["Integers", "Bits", *("Topic " + str(index) for index in range(75))],
                "codeSolution": {"role": "snippet", "aliases": ["count ones", "popcount"], "purpose": "Count set bits.", "code": CODE}}], "links": []}
            self.assertTrue(client.add(batch)["verified"])
            for query in ("count ones", "population count", "popcount"):
                self.assertEqual(client.search(query)["matches"][0]["id"], "popcount")
            self.assertEqual(client.search("", role="problem")["total"], 0)
            self.assertEqual(client.search("", tags=["Integers", "Other"], tag_match="any")["total"], 1)
            self.assertEqual(client.search("", tags=["Integers", "Other"], tag_match="all")["total"], 0)
            self.assertEqual(client.read(["popcount"])["shards"][0]["codeSolution"]["code"], CODE)
            scoped = {"requestId": "code-scoped-tools", "shards": [
                {"id": "z-problem", "title": "A graph problem", "codeSolution": SOLUTION},
                {"id": "a-algorithm", "title": "Graph traversal", "codeSolution": {"role": "algorithm"}}],
                "links": [{"id": "scoped-kahn", "fromId": "z-problem", "fromApproachId": "kahn", "toId": "a-algorithm", "type": "uses"},
                          {"id": "scoped-dfs", "fromId": "z-problem", "fromApproachId": "dfs", "toId": "a-algorithm", "type": "uses"},
                          {"id": "symmetric", "fromId": "z-problem", "toId": "a-algorithm", "type": "alternative_to"}]}
            self.assertTrue(client.add(scoped)["verified"])
            self.assertEqual(len(client.read(["z-problem"])["links"]), 3)
            envelope = inbox_envelope(batch)
            inbox = self.root / "inbox"
            inbox.mkdir()
            (inbox / "batch.json").write_text(json.dumps(envelope))
            target = self.open_store(self.root / "drive.sqlite3")
            result = DriveInbox(target, inbox).sync()
            self.assertEqual(target.state()["shards"][0]["codeSolution"]["code"], CODE)
            self.assertEqual(portable_archive(batch)["shards"][0]["codeSolution"]["code"], CODE)
            self.assertIn("codeSolution", SHARD_SCHEMA["properties"])
            self.assertNotIn("maxItems", SHARD_SCHEMA["properties"]["tags"])
            self.assertIn("uses", LINK_SCHEMA["properties"]["type"]["enum"])
            self.assertIn("fromApproachId", LINK_SCHEMA["properties"])
            self.assertEqual(CODE_SOLUTION_SCHEMA["properties"]["code"]["maxLength"], 100000)
            self.assertFalse(valid_health({**self.store.health(), "backendVersion": "2.8.0"}))
            self.assertTrue(valid_health({**self.store.health(), "backendVersion": "2.9.0"}))
            reuse = {"requestId": "code-tools-reuse", "shards": [{**batch["shards"][0], "id": "popcount-alias"}], "links": []}
            self.assertTrue(client.add(reuse)["verified"])
            self.store.update_shard("popcount", {"codeSolution": {**batch["shards"][0]["codeSolution"], "code": "// user edited\n"}})
            replay = client.add(reuse)
            self.assertFalse(replay["currentContentMatches"])
            self.assertEqual(replay["changedShardIds"], ["popcount"])
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)


if __name__ == "__main__":
    unittest.main()
