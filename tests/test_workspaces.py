"""Workspace, evidence, and migration safeguards, using temporary databases only."""

import copy
from contextlib import closing
import http.client
import json
from pathlib import Path
import sqlite3
import sys
import tempfile
import threading
from types import SimpleNamespace
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from server import AppError, DATABASE_VERSION, KNOWLEDGE_DEFAULTS, LocalServer, Store
from tools.shard_atlas_client import AtlasClient, ClientError


class WorkspaceTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.path = self.root / "test.sqlite3"
        self.store = Store(self.path, root=self.root, seed=False, backup_on_start=False, automatic_backups=False)

    def tearDown(self):
        self.temporary.cleanup()

    def shard(self, title="OpenAI compensation", **fields):
        state = self.store.create_shard({"title": title, **fields})
        return next(item for item in state["shards"] if item["title"] == title)

    def board(self, shard_id, **fields):
        state = self.store.create_board({"title": "Career and AI", "items": [{"shardId": shard_id, "x": 12, "y": 24, "sectionId": "ai"}],
            "sections": [{"id": "ai", "title": "AI companies", "collapsed": False}], **fields})
        return next(item for item in state["boards"] if item["id"] == state["boardId"])

    def test_import_preview_distinguishes_relative_images_from_remote_source_paths(self):
        archive = {"schemaVersion": 1, "shards": [
            {"id": "remote-source", "title": "Remote source", "content": "[Original](https://example.com/assets/article)\n\nOriginal Lucid shape data:\n```json\n{\"thumbnail\":\"https://example.com/assets/favicon.webp\"}\n```"},
            {"id": "missing-local", "title": "Local image", "content": "![Original](/assets/missing-image)"}], "links": []}
        preview = self.store.import_preview(archive)
        self.assertEqual([item["assetId"] for item in preview["missing"]], ["missing-image"])
        self.assertEqual(len(self.store.state()["shards"]), 0)

    def test_import_preview_applies_title_normalization_without_hiding_changed_content(self):
        archive = {"schemaVersion": 1, "shards": [{"id": "trimmed-title", "title": "A source title ", "content": "Original explanation"}], "links": []}
        self.store.import_data(archive)
        self.assertEqual(self.store.import_preview(archive)["conflicts"], [])
        archive["shards"][0]["content"] = "Changed explanation"
        self.assertEqual(len(self.store.import_preview(archive)["conflicts"]), 1)

    def test_evidence_survives_edits_revisions_trash_contribution_and_archive(self):
        fields = {"evidenceStatus": "reported", "publicationDate": "2026-10", "verifiedDate": "2026", "eventDate": "2026-10", "eventType": "research",
            "entities": ["OpenAI"], "entityType": "company", "inbox": True,
            "sources": [{"url": "https://example.com/report", "title": "Report", "publishedDate": "2026-10", "accessedDate": "2026-10-14", "note": "Reported total pay"}],
            "facts": [{"label": "Median senior compensation", "value": "636000", "unit": "USD/year", "sourceUrl": "https://example.com/report", "asOf": "2026-10"}]}
        original = self.shard(content="Reported L4 senior median, not a new-grad salary.", **fields)
        initial = self.store.revisions(original["id"])["revisions"][0]
        self.store.update_shard(original["id"], {"title": "Company", "evidenceStatus": "disputed", "status": "solid"})
        restored = self.store.restore_revision(original["id"], {"revisionId": initial["id"]})["shards"][0]
        for key in KNOWLEDGE_DEFAULTS:
            self.assertEqual(restored[key], original[key])
        self.assertEqual(restored["status"], "learning")
        self.store.delete_shard(original["id"])
        trashed = self.store.trash()["trash"][0]
        self.assertEqual(trashed["shard"]["sources"], fields["sources"])
        self.store.restore_trash(trashed["id"])
        receipt = self.store.contribute({"requestId": "new-metadata", "shards": [{"id": "contributed-ai", "title": "AI event", **fields}]})
        self.assertTrue(receipt["verified"])
        archive = self.store.export_data()
        imported = Store(self.root / "other.sqlite3", root=self.root, seed=False, backup_on_start=False, automatic_backups=False)
        imported.import_data(archive)
        self.assertEqual(imported.export_data(), archive)

    def test_contribution_rolls_back_if_saved_sources_do_not_match(self):
        before = self.store.export_data()
        batch = {"requestId": "source-loss", "shards": [{"id": "ownership-source", "title": "Ownership", "tags": ["C++"],
            "content": "An object owns its resource.", "sources": [{"url": "https://example.com/ownership", "note": "Preserve this caveat."}]}], "links": []}
        insert_shard = self.store._insert_shard
        def lose_sources(connection, shard):
            insert_shard(connection, shard)
            connection.execute("UPDATE shards SET knowledge=json_set(knowledge,'$.sources',json('[]')) WHERE id=?", (shard["id"],))
        with mock.patch.object(self.store, "_insert_shard", side_effect=lose_sources), self.assertRaises(AppError) as error:
            self.store.contribute(batch)
        self.assertEqual(error.exception.status, 500)
        self.assertEqual(self.store.export_data(), before)
        with self.store.connect() as connection:
            self.assertIsNone(connection.execute("SELECT 1 FROM metadata WHERE key='contribution:source-loss'").fetchone())
        receipt = self.store.contribute(batch)
        self.assertTrue(receipt["verified"])
        self.assertEqual(self.store.state()["shards"][0]["sources"][0]["note"], "Preserve this caveat.")

    def test_helper_verifies_multiple_sources_and_preserves_later_source_edits(self):
        server = LocalServer(("127.0.0.1", 0), self.store)
        thread = threading.Thread(target=lambda: server.serve_forever(poll_interval=.05), daemon=True)
        thread.start()
        client = AtlasClient(f"http://127.0.0.1:{server.server_address[1]}")
        batch = {"requestId": "verified-sources", "shards": [{"id": "sourced-ownership", "title": "Ownership", "tags": ["C++"],
            "content": "An object owns its resource.", "sources": [
                {"url": "https://example.com/specification", "title": "Specification", "note": "Applies to this example."},
                {"url": "https://example.com/explanation", "publishedDate": "2026-10"}]}], "links": []}
        try:
            self.assertTrue(client.add(batch)["verified"])
            saved = self.store.state()["shards"][0]
            self.assertEqual(len(saved["sources"]), 2)
            self.assertEqual(saved["sources"][1]["accessedDate"], "")
            self.assertTrue(client.add(batch)["verified"])
            edited = copy.deepcopy(saved["sources"])
            edited[0]["note"] = "User corrected the source scope."
            self.store.update_shard(saved["id"], {"sources": edited})
            replay = client.add(batch)
            self.assertTrue(replay["replayed"])
            self.assertTrue(replay["originalSaveVerified"])
            self.assertFalse(replay["verified"])
            self.assertFalse(replay["currentContentMatches"])
            self.assertEqual(replay["changedShardIds"], [saved["id"]])
            self.assertEqual(self.store.state()["shards"][0]["sources"], edited)
            second = copy.deepcopy(batch)
            second["requestId"] = "source-readback-failure"
            second["shards"][0].update(id="different-note", title="Unique ownership", content="Separate explanation.")
            real_state = client.state
            def wrong_source_readback():
                state = real_state()
                next(item for item in state["shards"] if item["id"] == "different-note")["sources"] = []
                return state
            with mock.patch.object(client, "state", side_effect=wrong_source_readback), self.assertRaises(ClientError):
                client.add(second)
            actual = next(item for item in self.store.state()["shards"] if item["id"] == "different-note")
            self.assertEqual(actual["sources"], saved["sources"])
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)

    def test_metadata_validation_is_atomic_and_accepts_partial_dates(self):
        original = self.shard()
        for date in ("2026", "2026-10", "2026-10-14"):
            state = self.store.update_shard(original["id"], {"eventDate": date})
            self.assertEqual(state["shards"][0]["eventDate"], date)
        before = self.store.export_data()
        invalid = [{"eventDate": "2026-13"}, {"verifiedDate": "2026-02-30"}, {"evidenceStatus": "certain"}, {"sources": [{"url": "javascript:alert(1)"}]},
            {"facts": [{"label": "pay", "value": 636000}]}, {"inbox": 1}, {"entities": "OpenAI"}, {"entityType": "vendor"}, {"eventType": "prediction"}]
        for changes in invalid:
            with self.subTest(changes=changes), self.assertRaises(AppError):
                self.store.update_shard(original["id"], changes)
            self.assertEqual(self.store.export_data(), before)

    def test_saved_boards_share_notes_preserve_positions_and_survive_trash_restore(self):
        shard = self.shard()
        board = self.board(shard["id"])
        second = self.board(shard["id"], title="Companies")
        self.store.update_shard(shard["id"], {"title": "Updated company page"})
        updated = self.store.update_board(board["id"], {"viewport": {"x": -35, "y": 90, "zoom": .03}, "sections": [{"id": "ai", "title": "AI companies", "collapsed": True}]})
        saved = next(item for item in updated["boards"] if item["id"] == board["id"])
        self.assertEqual(saved["items"], board["items"])
        self.assertTrue(saved["sections"][0]["collapsed"])
        self.store.delete_shard(shard["id"])
        # The missing card keeps its position until the note is restored.
        self.assertEqual(self.store.state()["boards"][0]["items"], board["items"])
        self.store.update_board(board["id"], {"description": "Move after delete"})
        self.store.restore_trash(self.store.trash()["trash"][0]["id"])
        reopened = Store(self.path, root=self.root, seed=False, backup_on_start=False, automatic_backups=False)
        self.assertEqual(reopened.state(), self.store.state())
        reopened.delete_board(second["id"])
        self.assertEqual(len(reopened.state()["boards"]), 1)
        self.assertEqual(len(reopened.state()["shards"]), 1)

    def test_section_note_anchors_preserve_heading_connections_and_undo_dependencies(self):
        heading = self.shard("AI Career")
        note = self.shard("Career detail")
        self.store.create_link({"fromId": heading["id"], "toId": note["id"], "type": "related_to"})
        board = self.board(note["id"], sections=[{"id": "ai", "title": "AI Career", "shardId": heading["id"]}])
        self.assertEqual(board["sections"][0]["shardId"], heading["id"])
        archive = self.store.export_data()
        other = Store(self.root / "anchored.sqlite3", root=self.root, seed=False, backup_on_start=False, automatic_backups=False)
        other.import_data(archive)
        self.assertEqual(other.export_data(), archive)
        self.store.delete_shard(heading["id"])
        self.store.update_board(board["id"], {"description": "Retain missing heading position"})
        self.assertEqual(self.store.state()["boards"][0]["sections"][0]["shardId"], heading["id"])
        self.store.restore_trash(self.store.trash()["trash"][0]["id"])
        self.assertEqual(self.store.state()["links"][0]["fromId"], heading["id"])
        with self.assertRaises(AppError):
            self.store.create_board({"title": "Invalid anchor", "sections": [{"id": "missing", "title": "Missing", "shardId": "unknown-heading"}]})
        imported = self.store.import_data({"schemaVersion": 1, "shards": [{"id": "import-heading", "title": "Imported heading"}]})
        self.store.create_board({"title": "Later board", "sections": [{"id": "later", "title": "Imported heading", "shardId": "import-heading"}]})
        undone = self.store.undo_import(imported["importSummary"]["importId"])
        self.assertIn("import-heading", {item["id"] for item in undone["shards"]})
        edited_import = self.store.import_data({"schemaVersion": 1, "shards": [{"id": "edited-heading", "title": "Edited board heading"}],
            "boards": [{"id": "edited-source-board", "title": "Source board", "sections": [{"id": "source-section", "title": "Edited board heading", "shardId": "edited-heading"}]}]})
        self.store.update_board("edited-source-board", {"description": "User edited the imported board"})
        preserved = self.store.undo_import(edited_import["importSummary"]["importId"])
        self.assertIn("edited-heading", {item["id"] for item in preserved["shards"]})
        self.assertIn("edited-source-board", {item["id"] for item in preserved["boards"]})
        preview = self.store.import_preview({"schemaVersion": 1, "boards": [{"id": "dangling-board", "title": "Dangling header", "sections": [{"id": "dangling", "title": "Deleted", "shardId": "deleted-header"}]}]})
        self.assertTrue(preview["valid"])
        self.assertEqual(preview["missing"][0]["shardId"], "deleted-header")

    def test_board_bounds_sections_and_refs_are_validated(self):
        shard = self.shard()
        for fields in ({"items": [{"shardId": "missing"}]}, {"items": [{"shardId": shard["id"], "x": float("inf")}]},
            {"items": [{"shardId": shard["id"], "sectionId": "missing"}]}, {"viewport": {"zoom": 0}},
            {"sections": [{"id": "s", "title": "S", "collapsed": "yes"}]}, {"items": [{"shardId": shard["id"]}] * 2}):
            with self.subTest(fields=fields), self.assertRaises(AppError):
                self.board(shard["id"], **fields)
        self.assertEqual(self.store.state()["boards"], [])

    def test_import_preview_reports_coverage_duplicates_conflicts_missing_without_writes(self):
        shard = self.shard()
        before = self.store.export_data()
        archive = {"schemaVersion": 1, "shards": [{**shard, "content": "Attempted replacement"}],
            "boards": [{"id": "source-board", "title": "Source board", "items": [{"shardId": "missing"}]}]}
        preview = self.store.import_preview(archive)
        self.assertTrue(preview["valid"])
        self.assertEqual(preview["added"]["boards"], 1)
        self.assertEqual(preview["skipped"]["shards"], 1)
        self.assertEqual(len(preview["conflicts"]), 1)
        self.assertEqual(preview["missing"][0]["shardId"], "missing")
        self.assertEqual(preview["coverage"]["boardItems"], 1)
        self.assertEqual(self.store.export_data(), before)
        self.assertFalse(self.store.backup_dir.exists())
        invalid = self.store.import_preview({"schemaVersion": 1, "links": [{"id": "bad", "fromId": "a", "toId": "b"}]})
        self.assertFalse(invalid["valid"])
        self.assertEqual(len(invalid["missing"]), 2)

    def test_import_undo_is_additive_durable_and_preserves_later_edits(self):
        existing = self.shard("Existing note")
        archive = {"schemaVersion": 1, "shards": [{"id": "import-a", "title": "A"}, {"id": "import-b", "title": "B"}],
            "links": [{"id": "import-edge", "fromId": "import-a", "toId": existing["id"], "type": "supports"}],
            "boards": [{"id": "import-board", "title": "Imported board", "items": [{"shardId": "import-a"}, {"shardId": "import-b"}]}]}
        imported = self.store.import_data(archive)
        import_id = imported["importSummary"]["importId"]
        self.assertEqual(self.store.imports()["imports"][0]["id"], import_id)
        self.store.update_shard("import-b", {"content": "User improved B"})
        reopened = Store(self.path, root=self.root, seed=False, backup_on_start=False, automatic_backups=False)
        result = reopened.undo_import(import_id)
        self.assertEqual({item["id"] for item in result["shards"]}, {existing["id"], "import-b"})
        self.assertEqual(result["boards"], [])
        self.assertEqual(result["links"], [])
        self.assertEqual(next(item for item in result["shards"] if item["id"] == "import-b")["content"], "User improved B")
        self.assertTrue(any(item["id"] == "import-b" and item["reason"] == "modified after import" for item in result["undoSummary"]["skipped"]))
        self.assertTrue(reopened.undo_import(import_id)["undoSummary"]["replayed"])

    def test_undo_preserves_imported_notes_referenced_by_later_knowledge(self):
        imported = self.store.import_data({"schemaVersion": 1, "shards": [{"id": "imported", "title": "Imported"}]})
        later = self.shard("Later", content="See [[id:imported|Imported]].")
        board = self.board("imported")
        result = self.store.undo_import(imported["importSummary"]["importId"])
        self.assertEqual({item["id"] for item in result["shards"]}, {"imported", later["id"]})
        self.assertEqual(result["boards"][0]["id"], board["id"])
        self.assertTrue(self.store.revisions("imported")["revisions"])

    def test_undo_restores_review_totals_on_existing_notes(self):
        shard = self.shard()
        imported = self.store.import_data({"schemaVersion": 1, "reviews": [{"id": "imported-review", "shardId": shard["id"], "grade": "easy", "reviewedAt": "2026-10-14T12:00:00Z", "nextReviewAt": "2026-10-28T12:00:00Z"}]})
        self.assertEqual(imported["shards"][0]["reviewCount"], 1)
        self.store.undo_import(imported["importSummary"]["importId"])
        self.assertEqual(self.store.state()["shards"][0], shard)

    def test_undo_requires_safety_snapshot_and_does_not_mutate_on_failure(self):
        imported = self.store.import_data({"schemaVersion": 1, "shards": [{"id": "imported", "title": "Imported"}]})
        before = self.store.export_data()
        with mock.patch.object(self.store, "backup", side_effect=OSError("disk full")), self.assertRaises(AppError):
            self.store.undo_import(imported["importSummary"]["importId"])
        self.assertEqual(self.store.export_data(), before)

    def test_corrupt_knowledge_metadata_snapshot_is_rejected_before_restore(self):
        self.shard(content="Keep original knowledge")
        before = self.store.export_data()
        backup = self.store.backup()
        with closing(sqlite3.connect(self.store.backup_dir / backup["filename"])) as connection, connection:
            connection.execute("UPDATE shards SET knowledge='[\"sources\"]'")
        listed = self.store.backups()["backups"]
        self.assertFalse(next(item for item in listed if item["filename"] == backup["filename"])["valid"])
        with self.assertRaises(AppError):
            self.store.restore_backup(backup["filename"])
        self.assertEqual(self.store.export_data(), before)

    def test_undo_preserves_restored_notes_and_images_needed_by_retained_revisions(self):
        png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jR7sAAAAASUVORK5CYII="
        imported = self.store.import_data({"schemaVersion": 1, "shards": [{"id": "image-note", "title": "Image note", "content": "![Original](/assets/import-image)"}],
            "assets": [{"id": "import-image", "name": "source.png", "mimeType": "image/png", "data": png}]})
        self.store.update_shard("image-note", {"content": "User replaced the explanation and removed the image."})
        self.store.undo_import(imported["importSummary"]["importId"])
        self.assertTrue(self.store.asset("import-image")[0])
        self.assertTrue(any("/assets/import-image" in item["snapshot"]["content"] for item in self.store.revisions("image-note")["revisions"]))
        second = self.store.import_data({"schemaVersion": 1, "shards": [{"id": "restored-note", "title": "Recovered"}]})
        self.store.delete_shard("restored-note")
        trash = next(item for item in self.store.trash()["trash"] if item["shard"]["id"] == "restored-note")
        self.store.restore_trash(trash["id"])
        undone = self.store.undo_import(second["importSummary"]["importId"])
        self.assertIn("restored-note", {item["id"] for item in undone["shards"]})

    def test_image_text_recognition_is_local_reviewable_and_keeps_original(self):
        png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jR7sAAAAASUVORK5CYII="
        asset = self.store.create_asset({"name": "source.png", "mimeType": "image/png", "data": png})
        (self.root / "image-text").write_text("fake QA executable, subprocess is mocked")
        recognized = "std::unique_ptr<int> value = std::make_unique<int>(42);"
        with mock.patch("server.subprocess.run", return_value=SimpleNamespace(returncode=0, stdout=json.dumps({"text": recognized}))) as process:
            result = self.store.image_text(asset["id"])
            self.assertTrue(result["available"])
            self.assertEqual(result["text"], recognized)
            self.assertEqual(result["method"], "apple-vision")
            self.assertEqual(process.call_args.kwargs["timeout"], 30)
            temporary_image = Path(process.call_args.args[0][-1])
            self.assertFalse(temporary_image.exists())
        with mock.patch("server.subprocess.run", side_effect=FileNotFoundError):
            unavailable = self.store.image_text(asset["id"])
            self.assertFalse(unavailable["available"])
            self.assertEqual(unavailable["text"], "")
        self.assertTrue(self.store.asset(asset["id"])[0])

    def test_archive_budget_counts_base64_exactly_without_loading_image_data(self):
        png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jR7sAAAAASUVORK5CYII="
        self.store.create_asset({"name": "source.png", "mimeType": "image/png", "data": png})
        self.shard(content="Unicode: π ∞ 🟢 and literal \\\\n quotes \"escaped\".")
        with self.store.connect() as connection:
            expected = len(json.dumps(self.store._archive(connection), ensure_ascii=False, indent=2).encode("utf-8"))
            self.assertEqual(self.store._archive_budget(connection)[0], expected)
            light = self.store._archive(connection, include_asset_data=False)
            self.assertEqual(light["assets"][0]["data"], "")
            self.assertEqual(light["assets"][0]["size"], 68)

    def test_aggregate_image_capacity_is_checked_atomically_for_cumulative_saves(self):
        png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jR7sAAAAASUVORK5CYII="
        asset = {"name": "source.png", "mimeType": "image/png", "data": png}
        with mock.patch("server.MAX_TOTAL_ASSET_BYTES", 150):
            self.store.create_asset(asset)
            self.store.create_asset(asset)
            before = self.store.export_data()
            with self.assertRaises(AppError) as context:
                self.store.create_asset(asset)
            self.assertEqual(context.exception.status, 413)
            self.assertEqual(self.store.export_data(), before)
            incoming = {"schemaVersion": 1, "assets": [{"id": f"incoming-{index}", **asset} for index in range(3)]}
            with self.assertRaises(AppError):
                self.store.import_data(incoming)
            self.assertEqual(self.store.export_data(), before)

    def test_preview_malformed_collections_and_nonfinite_json_fail_safely(self):
        for payload in ({"schemaVersion": 1, "shards": None}, {"schemaVersion": 1, "shards": [{"id": "bad", "title": "Bad", "content": {}}]},
            {"schemaVersion": 1, "links": [{"id": "bad", "fromId": {}, "toId": []}]}, {"schemaVersion": 1, "boards": None}):
            with self.subTest(payload=payload):
                self.assertFalse(self.store.import_preview(payload)["valid"])
        nonfinite = {"schemaVersion": 1, "shards": [], "unknown": float("nan")}
        with self.assertRaises(AppError):
            self.store.import_preview(nonfinite)
        with self.assertRaises(AppError):
            self.store.import_data(nonfinite)
        self.assertEqual(self.store.state()["shards"], [])

    def test_version_two_migration_has_consistent_preupgrade_snapshot(self):
        shard = self.shard(content="Keep original")
        # Create an actual v2 layout rather than merely changing the version flag.
        with self.store.connect() as connection:
            connection.execute("ALTER TABLE shards DROP COLUMN knowledge")
            connection.execute("DROP TABLE boards")
            connection.execute("DROP TABLE imports")
            connection.execute("DROP TABLE links")
            connection.execute("CREATE TABLE links (id TEXT PRIMARY KEY,from_id TEXT NOT NULL REFERENCES shards(id) ON DELETE CASCADE,to_id TEXT NOT NULL REFERENCES shards(id) ON DELETE CASCADE,type TEXT NOT NULL CHECK(type IN ('depends_on','explains','contrasts_with','example_of','related_to')),note TEXT NOT NULL,created_at TEXT NOT NULL,CHECK(from_id<>to_id),UNIQUE(from_id,to_id,type))")
            connection.execute("PRAGMA user_version=2")
        migrated = Store(self.path, root=self.root, seed=False, backup_on_start=False, automatic_backups=False)
        self.assertEqual(migrated.state()["shards"][0], shard)
        self.assertEqual(migrated.health()["databaseVersion"], DATABASE_VERSION)
        snapshots = list(migrated.backup_dir.glob("*.sqlite3"))
        self.assertEqual(len(snapshots), 1)
        with closing(sqlite3.connect(snapshots[0])) as connection:
            self.assertEqual(connection.execute("PRAGMA user_version").fetchone()[0], 2)
            self.assertNotIn("knowledge", {row[1] for row in connection.execute("PRAGMA table_info(shards)")})
        other = self.shard("Other")
        for relationship in ("part_of", "supports", "contradicts", "supersedes", "released_by"):
            migrated.create_link({"fromId": shard["id"], "toId": other["id"], "type": relationship})
        migrated.restore_backup(snapshots[0].name)
        self.assertEqual(migrated.state()["shards"], [shard])
        self.assertEqual(migrated.state()["boards"], [])

    def test_http_canvas_and_import_routes_preserve_state_while_news_routes_are_retired(self):
        server = LocalServer(("127.0.0.1", 0), self.store)
        thread = threading.Thread(target=lambda: server.serve_forever(poll_interval=.05), daemon=True)
        thread.start()
        port = server.server_address[1]
        def request(method, path, data=None):
            connection = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
            body = json.dumps(data) if data is not None else None
            connection.request(method, path, body, {"Content-Type": "application/json"} if data is not None else {})
            response = connection.getresponse()
            result = response.status, json.loads(response.read())
            connection.close()
            return result
        try:
            shard = self.shard()
            status, state = request("POST", "/api/boards", {"title": "Board", "items": [{"shardId": shard["id"]}]})
            self.assertEqual(status, 201)
            self.assertTrue(state["boards"])
            status, state = request("GET", "/api/data")
            self.assertEqual(status, 200)
            self.assertTrue(state["boards"])
            status, preview = request("POST", "/api/import/preview", {"data": {"schemaVersion": 1, "shards": [{"id": "incoming", "title": "Incoming"}]}})
            self.assertEqual(status, 200)
            self.assertTrue(preview["valid"])
            status, state = request("POST", "/api/import", {"data": {"schemaVersion": 1, "shards": [{"id": "incoming", "title": "Incoming"}]}})
            self.assertEqual(status, 200)
            import_id = state["importSummary"]["importId"]
            self.assertEqual(request("GET", "/api/imports")[1]["imports"][0]["id"], import_id)
            status, undone = request("POST", f"/api/imports/{import_id}/undo", {})
            self.assertEqual(status, 200)
            self.assertEqual(undone["undoSummary"]["removed"]["shards"], 1)
            before = self.store.export_data()
            snapshots = list(self.store.backup_dir.glob("*.sqlite3"))
            for method, path, body in (("POST", "/api/ask", {"question": "Explain ownership"}),
                ("POST", "/api/capture/preview", {"text": "Saved text"}),
                ("GET", "/api/entities", None), ("POST", "/api/compare", {}),
                ("GET", "/api/inbox", None)):
                with self.subTest(method=method, path=path):
                    status, result = request(method, path, body)
                    self.assertEqual(status, 404)
                    self.assertEqual(result, {"error": "Endpoint not found."})
            self.assertEqual(self.store.export_data(), before)
            self.assertEqual(list(self.store.backup_dir.glob("*.sqlite3")), snapshots)
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)


if __name__ == "__main__":
    unittest.main()
