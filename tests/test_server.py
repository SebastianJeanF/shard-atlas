"""Persistence, import integrity, and actual loopback HTTP boundary tests."""

import copy
import base64
import datetime as dt
import http.client
import io
import json
import sqlite3
import sys
import tempfile
import threading
import time
import unittest
import zipfile
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from server import AppError, DATABASE_VERSION, LocalServer, REVIEW_DAYS, Store

PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jR7sAAAAASUVORK5CYII="


class StoreTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name).resolve()
        self.db = self.root / "application-support" / "shards.sqlite3"
        self.store = Store(self.db, root=self.root, seed=False, backup_on_start=False, automatic_backups=False)

    def tearDown(self):
        self.temporary.cleanup()

    def shard(self, title="Understanding ownership", **fields):
        state = self.store.create_shard({"title": title, **fields})
        return next(shard for shard in state["shards"] if shard["title"] == title)

    def test_crud_persists_read_only_metadata_and_preserves_plain_text(self):
        injection = '<script>alert("example")</script>\n`code` & <img src=x onerror=alert(1)>'
        original = self.shard(content=injection, tags=["C++", "memory"], prompt="What owns this resource?")
        state = self.store.update_shard(original["id"], {
            "title": "Ownership and lifetime", "kind": "mistake", "status": "verify",
            "sourceUrl": "https://en.cppreference.com/", "languageVersion": "C++20",
            "createdAt": "1900-01-01T00:00:00Z", "reviewCount": 99,
        })
        updated = state["shards"][0]
        self.assertEqual(updated["content"], injection)
        self.assertEqual(updated["createdAt"], original["createdAt"])
        self.assertEqual(updated["reviewCount"], 0)
        reopened = Store(self.db, root=self.root, seed=False, backup_on_start=False)
        self.assertEqual(reopened.state(), state)
        self.assertEqual(reopened.delete_shard(original["id"])["shards"], [])
        with self.assertRaises(AppError) as context:
            reopened.update_shard(original["id"], {"title": "Missing"})
        self.assertEqual(context.exception.status, 404)

    def test_links_reviews_and_deletion_cascade(self):
        first = self.shard("RAII")
        second = self.shard("Exception safety")
        state = self.store.create_link({"fromId": first["id"], "toId": second["id"], "type": "explains", "note": "Cleanup occurs during unwinding."})
        self.assertEqual(len(state["links"]), 1)
        state = self.store.create_review({"shardId": first["id"], "grade": "good"})
        self.assertEqual(len(state["reviews"]), 1)
        state = self.store.delete_shard(first["id"])
        self.assertEqual([shard["id"] for shard in state["shards"]], [second["id"]])
        self.assertEqual(state["links"], [])
        self.assertEqual(state["reviews"], [])

    def test_review_uses_fixed_day_schedule_for_every_grade(self):
        shard = self.shard()
        for count, (grade, days) in enumerate(REVIEW_DAYS.items(), start=1):
            state = self.store.create_review({"shardId": shard["id"], "grade": grade})
            review = next(review for review in state["reviews"] if review["grade"] == grade)
            parsed = lambda value: dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
            self.assertEqual(parsed(review["nextReviewAt"]) - parsed(review["reviewedAt"]), dt.timedelta(days=days))
            self.assertEqual(state["shards"][0]["reviewCount"], count)
            self.assertEqual(state["shards"][0]["lastReviewedAt"], review["reviewedAt"])
            self.assertEqual(state["shards"][0]["nextReviewAt"], review["nextReviewAt"])

    def test_invalid_import_is_atomic_and_does_not_create_backup(self):
        self.shard("Keep this")
        before = self.store.state()
        payload = {"schemaVersion": 1, "shards": [{"id": "new-shard", "title": "Must not be added"}], "links": [{"id": "bad-link", "fromId": "new-shard", "toId": "missing-shard", "type": "explains"}], "reviews": []}
        with self.assertRaises(AppError):
            self.store.import_data(payload)
        self.assertEqual(self.store.state(), before)
        self.assertFalse(self.store.backup_dir.exists())

    def test_contribution_is_additive_durable_and_idempotent_after_reopening(self):
        original = self.shard("Existing", content="Keep this", tags=["C++", "Memory"])
        self.store.save_draft("editor", {"draft": {"values": {"title": "Unfinished"}}})
        before = self.store.export_data()
        batch = {"requestId": "chat-123", "shards": [
            {"id": "ai-raii", "title": "RAII", "content": "Scope owns resources.", "tags": ["c++", "memory", "MEMORY", "ownership", "Ownership"], "kind": "concept", "status": "verify", "sourceUrl": "https://isocpp.org/", "languageVersion": "C++98"}],
            "links": [{"fromId": "ai-raii", "toId": original["id"], "type": "related_to", "note": "Ownership context."}]}
        receipt = self.store.contribute(batch)
        self.assertTrue(receipt["verified"])
        self.assertFalse(receipt["replayed"])
        self.assertEqual(receipt["added"], {"shards": 1, "links": 1})
        self.assertEqual(receipt["skipped"], {"shards": 0, "links": 0})
        state = self.store.state()
        added = next(item for item in state["shards"] if item["id"] == "ai-raii")
        self.assertEqual(added["tags"], ["C++", "Memory", "ownership"])
        self.assertEqual(next(item for item in state["shards"] if item["id"] == original["id"]), original)
        self.assertEqual(self.store.drafts()["drafts"]["editor"]["values"]["title"], "Unfinished")
        self.assertEqual(self.store.revisions("ai-raii")["revisions"][0]["reason"], "ai-contribution")
        snapshot = Store(self.store.backup_dir / receipt["backupFilename"], seed=False, backup_on_start=False, automatic_backups=False)
        self.assertEqual(snapshot.export_data(), before)
        reopened = Store(self.db, root=self.root, seed=False, backup_on_start=False, automatic_backups=False)
        replay = reopened.contribute(copy.deepcopy(batch))
        self.assertTrue(replay["replayed"])
        self.assertEqual(replay["backupFilename"], receipt["backupFilename"])
        self.assertEqual(reopened.state(), state)
        self.assertEqual(len(list(self.store.backup_dir.glob("*.sqlite3"))), 1)
        changed = copy.deepcopy(batch)
        changed["shards"][0]["content"] = "Different explanation."
        with self.assertRaises(AppError) as context:
            reopened.contribute(changed)
        self.assertEqual(context.exception.status, 409)
        self.assertEqual(reopened.state(), state)
        reopened.delete_shard("ai-raii")
        after_delete = reopened.state()
        replay = reopened.contribute(batch)
        self.assertEqual(replay["missingShardIds"], ["ai-raii"])
        self.assertEqual(reopened.state(), after_delete)

    def test_contribution_deduplicates_conservatively_and_remaps_relationships(self):
        original = self.shard("Ownership   model", content="Exact content", tags=["Memory"])
        other = self.shard("Other", content="Keep", tags=["C++"])
        old_link = self.store.create_link({"fromId": original["id"], "toId": other["id"], "type": "explains", "note": "Keep original note"})["links"][0]
        batch = {"requestId": "matching-notes", "shards": [
            {"id": "alias", "title": "ownership model", "content": "Exact content", "tags": ["memory"]},
            {"id": "new", "title": "New detail", "content": "See [[id:alias|Ownership]].", "tags": ["c++"]},
            {"id": "case-sensitive-code", "title": "ownership model", "content": "exact content"}],
            "links": [{"id": "duplicate-edge", "fromId": "alias", "toId": other["id"], "type": "explains", "note": "Do not replace"},
                      {"fromId": "new", "toId": "alias", "type": "example_of"}]}
        receipt = self.store.contribute(batch)
        self.assertEqual(receipt["idMap"]["alias"], original["id"])
        self.assertEqual(receipt["added"], {"shards": 2, "links": 1})
        self.assertEqual(receipt["skipped"], {"shards": 1, "links": 1})
        self.assertEqual(receipt["links"][0]["id"], old_link["id"])
        state = self.store.state()
        self.assertEqual(next(item for item in state["links"] if item["id"] == old_link["id"])["note"], "Keep original note")
        self.assertEqual(next(item for item in state["shards"] if item["id"] == "new")["content"], f"See [[id:{original['id']}|Ownership]].")
        self.assertEqual(next(item for item in state["shards"] if item["id"] == "new")["tags"], ["C++"])
        existing = self.store.export_data()
        repeat = copy.deepcopy(batch)
        repeat["requestId"] = "new-chat-same-notes"
        # The canonical IDs returned in the receipt support later contributions.
        repeat["shards"][1]["content"] = f"See [[id:{original['id']}|Ownership]]."
        again = self.store.contribute(repeat)
        self.assertEqual(again["added"], {"shards": 0, "links": 0})
        self.assertEqual(self.store.export_data(), existing)

    def test_invalid_contribution_is_atomic_and_does_not_create_backup(self):
        original = self.shard("Keep this", content="Existing content")
        before = self.store.export_data()
        batches = [
            {"requestId": "bad", "shards": [{"title": "Missing stable ID"}]},
            {"requestId": "bad", "shards": [{"id": "new", "title": "New", "prompt": "Legacy field"}]},
            {"requestId": "bad", "shards": [{"id": "new", "title": "New", "status": "learned"}]},
            {"requestId": "bad", "shards": [{"id": "new", "title": "New"}], "links": [{"fromId": "new", "toId": "missing"}]},
            {"requestId": "bad", "shards": [{"id": "new", "title": "New"}, {"id": original["id"], "title": "Overwrite", "content": "Different"}]},
            {"requestId": "bad", "shards": [{"id": "new", "title": "New"}, {"id": "new", "title": "Twice"}]},
            {"requestId": "bad", "shards": [{"id": "first", "title": "Same"}, {"id": "second", "title": "Same"}], "links": [{"fromId": "first", "toId": "second"}]},
        ]
        for batch in batches:
            with self.subTest(batch=batch), self.assertRaises(AppError):
                self.store.contribute(batch)
            self.assertEqual(self.store.export_data(), before)
            self.assertFalse(self.store.backup_dir.exists())
        with self.store.connect() as connection:
            self.assertEqual(connection.execute("SELECT count(*) FROM metadata WHERE key LIKE 'contribution:%'").fetchone()[0], 0)

    def test_contribution_conflicts_with_existing_link_ids_and_trashed_shard_ids(self):
        first, second = self.shard("First"), self.shard("Second")
        link = self.store.create_link({"fromId": first["id"], "toId": second["id"], "note": "Original"})["links"][0]
        before = self.store.state()
        with self.assertRaises(AppError) as context:
            self.store.contribute({"requestId": "bad-edge", "links": [{"id": link["id"], "fromId": first["id"], "toId": second["id"], "note": "Changed"}]})
        self.assertEqual(context.exception.status, 409)
        self.assertEqual(self.store.state(), before)
        self.store.delete_shard(first["id"])
        with self.assertRaises(AppError) as context:
            self.store.contribute({"requestId": "no-resurrection", "shards": [{"id": first["id"], "title": first["title"]}]})
        self.assertEqual(context.exception.status, 409)
        self.assertEqual(len(self.store.state()["shards"]), 1)

    def test_contribution_backup_failure_quota_and_receipt_limit_roll_back_everything(self):
        batch = {"requestId": "bounded-batch", "shards": [{"id": "new", "title": "New", "content": "Explanation"}]}
        before = self.store.export_data()
        with mock.patch.object(self.store, "backup", side_effect=OSError("disk full")):
            with self.assertRaises(AppError) as context:
                self.store.contribute(batch)
        self.assertEqual(context.exception.status, 500)
        for constant, limit in (("MAX_ARCHIVE_BYTES", 100), ("MAX_CONTRIBUTION_RECEIPT_BYTES", 1), ("MAX_CONTRIBUTION_RECEIPTS", 0)):
            with mock.patch("server." + constant, limit), self.assertRaises(AppError) as context:
                self.store.contribute(batch)
            self.assertEqual(context.exception.status, 413)
            self.assertEqual(self.store.export_data(), before)
            with self.store.connect() as connection:
                self.assertEqual(connection.execute("SELECT count(*) FROM metadata WHERE key LIKE 'contribution:%'").fetchone()[0], 0)
        self.assertEqual(self.store.contribute(batch)["added"]["shards"], 1)

    def test_concurrent_contribution_retry_inserts_one_batch(self):
        batch = {"requestId": "concurrent", "shards": [{"id": "one", "title": "One"}]}
        with ThreadPoolExecutor(max_workers=4) as executor:
            receipts = list(executor.map(lambda _: self.store.contribute(batch), range(4)))
        self.assertEqual(sum(not item["replayed"] for item in receipts), 1)
        self.assertEqual(len(self.store.state()["shards"]), 1)
        self.assertEqual(len(self.store.revisions("one")["revisions"]), 1)

    def test_export_import_round_trip_including_complete_review_history(self):
        first = self.shard("A", content="Text with Ω and <script>")
        second = self.shard("B", kind="event", eventDate="2026-10-12")
        self.store.create_link({"fromId": first["id"], "toId": second["id"], "type": "depends_on"})
        self.store.create_review({"shardId": first["id"], "grade": "again"})
        self.store.create_review({"shardId": first["id"], "grade": "easy"})
        expected = self.store.state()
        imported_store = Store(self.root / "other.sqlite3", root=self.root / "other", seed=False, backup_on_start=False)
        result = imported_store.import_data(expected)
        self.assertEqual(imported_store.state(), expected)
        self.assertEqual({key: result["importSummary"]["added"][key] for key in ("shards", "links", "reviews")}, {"shards": 2, "links": 1, "reviews": 2})
        repeated = imported_store.import_data(expected)
        self.assertEqual({key: repeated["importSummary"]["skipped"][key] for key in ("shards", "links", "reviews")}, {"shards": 2, "links": 1, "reviews": 2})
        self.assertEqual(imported_store.state(), expected)

    def test_import_keeps_existing_shard_content_and_recomputes_review_aggregates(self):
        shard = self.shard("Original", content="Keep my edit")
        payload = {"schemaVersion": 1, "shards": [{**shard, "title": "Overwrite attempt", "content": "Old content"}], "links": [], "reviews": [{"id": "imported-review", "shardId": shard["id"], "grade": "hard", "reviewedAt": "2026-10-01T12:00:00Z", "nextReviewAt": "2026-10-04T12:00:00Z"}]}
        result = self.store.import_data(payload)
        current = result["shards"][0]
        self.assertEqual(current["title"], "Original")
        self.assertEqual(current["content"], "Keep my edit")
        self.assertEqual(current["reviewCount"], 1)
        self.assertEqual(current["lastReviewedAt"], "2026-10-01T12:00:00.000Z")
        self.assertEqual(result["importSummary"]["skipped"]["shards"], 1)

    def test_import_checks_duplicates_tags_urls_and_all_record_types(self):
        invalid_shards = [
            {"id": "x", "title": "X", "tags": ["C++", "C++"]},
            {"id": "x", "title": "X", "sourceUrl": "javascript:alert(1)"},
            {"id": "x", "title": "X", "reviewCount": True},
            {"id": "../escape", "title": "X"},
            {"id": "x", "title": "X", "kind": []},
            {"id": "x", "title": "X", "eventDate": "2026-02-30"},
        ]
        for invalid in invalid_shards:
            with self.subTest(invalid=invalid), self.assertRaises(AppError):
                self.store.import_data({"schemaVersion": 1, "shards": [invalid], "links": [], "reviews": []})
        with self.assertRaises(AppError):
            self.store.import_data({"schemaVersion": 1, "shards": [{"id": "x", "title": "X"}, {"id": "x", "title": "Y"}]})
        with self.assertRaises(AppError):
            self.store.import_data({"schemaVersion": True, "shards": []})
        self.assertEqual(self.store.state()["shards"], [])

    def test_duplicate_relationship_rejected_without_partial_import(self):
        first = self.shard("A")
        second = self.shard("B")
        state = self.store.create_link({"fromId": first["id"], "toId": second["id"], "type": "related_to"})
        payload = copy.deepcopy(state)
        payload["shards"].append({"id": "must-rollback", "title": "New"})
        payload["links"][0]["id"] = "duplicate-new-id"
        with self.assertRaises(AppError) as context:
            self.store.import_data(payload)
        self.assertEqual(context.exception.status, 409)
        self.assertEqual(self.store.state(), state)

    def test_backups_are_consistent_and_restore_all_records(self):
        first = self.shard("A")
        second = self.shard("B")
        self.store.create_link({"fromId": first["id"], "toId": second["id"], "type": "explains"})
        self.store.create_review({"shardId": first["id"], "grade": "good"})
        expected = self.store.state()
        backup = self.store.backup()
        backup_file = self.store.backup_dir / backup["filename"]
        with closing(sqlite3.connect(backup_file)) as connection:
            self.assertEqual(connection.execute("PRAGMA integrity_check").fetchone()[0], "ok")
            self.assertEqual(connection.execute("PRAGMA foreign_key_check").fetchall(), [])
            self.assertEqual(connection.execute("PRAGMA user_version").fetchone()[0], DATABASE_VERSION)
        self.store.delete_shard(first["id"])
        restored = Store(backup_file, root=self.root, seed=False, backup_on_start=False)
        self.assertEqual(restored.state(), expected)

    def test_deletion_creates_a_restorable_backup_and_stops_if_backup_fails(self):
        shard = self.shard("Recoverable")
        before = self.store.state()
        self.store.delete_shard(shard["id"])
        backups = list(self.store.backup_dir.glob("*.sqlite3"))
        self.assertEqual(len(backups), 1)
        restored = Store(backups[0], root=self.root, seed=False, backup_on_start=False)
        self.assertEqual(restored.state(), before)
        shard = self.shard("Cannot delete without backup")
        old_backup_dir = self.store.backup_dir
        blocked = self.root / "not-a-directory"
        blocked.write_text("occupied")
        self.store.backup_dir = blocked
        try:
            with self.assertRaises(AppError):
                self.store.delete_shard(shard["id"])
            self.assertEqual(len(self.store.state()["shards"]), 1)
            self.assertIsNotNone(self.store.health()["lastBackupError"])
        finally:
            self.store.backup_dir = old_backup_dir

    def test_seed_only_runs_once_even_when_user_empties_collection(self):
        seed_path = self.root / "seed.json"
        seed_path.write_text(json.dumps({"schemaVersion": 1, "shards": [{"id": "starter", "title": "Starter"}], "links": [], "reviews": []}))
        db = self.root / "seeded.sqlite3"
        seeded = Store(db, root=self.root, seed_path=seed_path, backup_on_start=False)
        self.assertEqual(len(seeded.state()["shards"]), 1)
        seeded.delete_shard("starter")
        reopened = Store(db, root=self.root, seed_path=seed_path, backup_on_start=False)
        self.assertEqual(reopened.state()["shards"], [])

    def test_custom_databases_and_working_database_have_isolated_daily_backups(self):
        project = self.root / "project"
        default_database = self.root / "application-support" / "working.sqlite3"
        with mock.patch("server.DEFAULT_DB", default_database):
            custom = Store(self.root / "qa.sqlite3", root=project, seed=False)
            self.assertEqual(custom.backup_dir, self.root / "qa-backups")
            custom.create_shard({"title": "Only in QA"})
            custom.backup()
            working = Store(default_database, root=project, seed=False)
            self.assertEqual(working.backup_dir, project / "backups")
            self.assertEqual(len(list(working.backup_dir.glob("*.sqlite3"))), 1)
            self.assertEqual(working.state()["shards"], [])
            working_backup = next(working.backup_dir.glob("*.sqlite3"))
            restored = Store(working_backup, root=project, seed=False, backup_on_start=False)
            self.assertEqual(restored.state()["shards"], [])
            second_custom = Store(self.root / "another-qa.sqlite3", root=project, seed=False)
            self.assertEqual(second_custom.backup_dir, self.root / "another-qa-backups")
            self.assertEqual(len(list(second_custom.backup_dir.glob("*.sqlite3"))), 1)
            reopened = Store(default_database, root=project, seed=False)
            self.assertEqual(len(list(reopened.backup_dir.glob("*.sqlite3"))), 1)

    def test_explicit_backup_directory_override_is_reported_and_used(self):
        destination = self.root / "chosen-snapshots"
        store = Store(self.root / "custom.sqlite3", root=self.root, seed=False, backup_dir=destination)
        self.assertEqual(store.backup_dir, destination)
        self.assertEqual(store.health()["backupDirectory"], str(destination))
        self.assertEqual(len(list(destination.glob("*.sqlite3"))), 1)
        self.assertFalse((self.root / "custom-backups").exists())

    def test_markdown_zip_contains_stable_ids_links_and_json_history(self):
        first = self.shard("A/B", content="Explanation", prompt="Recall?")
        second = self.shard("A B")
        self.store.create_link({"fromId": first["id"], "toId": second["id"], "type": "contrasts_with", "note": "Different ownership."})
        self.store.create_review({"shardId": first["id"], "grade": "good"})
        with zipfile.ZipFile(io.BytesIO(self.store.markdown_export())) as archive:
            self.assertEqual(json.loads(archive.read("shard-atlas.json")), self.store.export_data())
            self.assertEqual(json.loads(archive.read("relationships.json")), self.store.state()["links"])
            markdown_files = [name for name in archive.namelist() if name.endswith(".md")]
            self.assertEqual(len(markdown_files), 2)
            self.assertEqual(len(set(markdown_files)), 2)
            text = archive.read(next(name for name in markdown_files if first["id"] in name)).decode()
            self.assertNotIn("Recall?", text)
            self.assertIn("Different ownership.", text)
            self.assertNotIn("## Review history", text)

    def test_concurrent_writes_do_not_lose_records(self):
        with ThreadPoolExecutor(max_workers=6) as executor:
            list(executor.map(lambda number: self.store.create_shard({"title": f"Shard {number}"}), range(24)))
        self.assertEqual(len(self.store.state()["shards"]), 24)

    def test_version_one_migration_preserves_notes_and_legacy_reviews(self):
        shard = self.shard("Existing note", content="Never replace this")
        self.store.create_review({"shardId": shard["id"], "grade": "good"})
        before = self.store.state()
        with self.store.connect() as connection:
            for table in ("revisions", "trash", "assets", "drafts"):
                connection.execute(f"DROP TABLE {table}")
            connection.execute("PRAGMA user_version=1")
        migrated = Store(self.db, root=self.root, seed=False, automatic_backups=False, backup_on_start=False)
        self.assertEqual(migrated.state(), before)
        revisions = migrated.revisions(shard["id"])["revisions"]
        self.assertEqual(len(revisions), 1)
        self.assertEqual(revisions[0]["snapshot"], before["shards"][0])
        with migrated.connect() as connection:
            self.assertEqual(connection.execute("PRAGMA user_version").fetchone()[0], DATABASE_VERSION)

    def test_editable_relationships_and_global_topic_rename_are_atomic(self):
        first = self.shard("A", tags=["old", "merged"])
        second = self.shard("B", tags=["old"])
        link = self.store.create_link({"fromId": first["id"], "toId": second["id"], "type": "explains"})["links"][0]
        state = self.store.update_link(link["id"], {"note": "An improved explanation", "type": "depends_on"})
        self.assertEqual(state["links"][0]["id"], link["id"])
        self.assertEqual(state["links"][0]["createdAt"], link["createdAt"])
        self.assertEqual(state["links"][0]["note"], "An improved explanation")
        before = self.store.state()
        with self.assertRaises(AppError):
            self.store.update_link(link["id"], {"toId": first["id"]})
        self.assertEqual(self.store.state(), before)
        renamed = self.store.rename_tag({"from": "old", "to": "merged"})
        self.assertEqual([item["tags"] for item in renamed["shards"]], [["merged"], ["merged"]])
        self.assertEqual(len(self.store.revisions(first["id"])["revisions"]), 2)

    def test_revision_restore_preserves_stable_id_and_current_review_history(self):
        shard = self.shard(content="Original", tags=["initial"])
        original_revision = self.store.revisions(shard["id"])["revisions"][0]
        self.store.update_shard(shard["id"], {"content": "Changed", "tags": ["new"]})
        self.store.create_review({"shardId": shard["id"], "grade": "easy"})
        state = self.store.restore_revision(shard["id"], {"revisionId": original_revision["id"]})
        self.assertEqual(state["shards"][0]["content"], "Original")
        self.assertEqual(state["shards"][0]["tags"], ["initial"])
        self.assertEqual(state["shards"][0]["reviewCount"], 1)
        self.assertEqual(len(state["reviews"]), 1)
        self.assertEqual(len(self.store.revisions(shard["id"])["revisions"]), 3)

    def test_trash_restores_original_ids_and_links_after_both_endpoints_deleted(self):
        first, second = self.shard("A"), self.shard("B")
        original_link = self.store.create_link({"fromId": first["id"], "toId": second["id"], "note": "Keep this explanation"})["links"][0]
        self.store.create_review({"shardId": first["id"], "grade": "good"})
        self.store.delete_shard(first["id"])
        self.store.delete_shard(second["id"])
        trash = {item["shard"]["id"]: item for item in self.store.trash()["trash"]}
        partial = self.store.restore_trash(trash[first["id"]]["id"])
        self.assertEqual(partial["restoreSummary"], {"restoredLinks": 0, "skippedLinks": 1})
        self.assertEqual(len(partial["reviews"]), 1)
        restored = self.store.restore_trash(trash[second["id"]]["id"])
        self.assertEqual(restored["links"], [original_link])
        self.assertEqual(self.store.trash()["trash"], [])

    def test_exact_snapshot_restore_and_invalid_snapshot_rejection(self):
        shard = self.shard("A", content="Snapshot content")
        self.store.create_asset({"name": "example.png", "mimeType": "image/png", "data": PNG})
        snapshot = self.store.backup()
        expected = self.store.export_data()
        self.store.update_shard(shard["id"], {"content": "Later content"})
        self.shard("Later addition")
        before_restore = self.store.state()
        result = self.store.restore_backup(snapshot["filename"])
        self.assertEqual(self.store.export_data(), expected)
        safety_path = self.store.backup_dir / result["restoreSummary"]["preRestoreBackupFilename"]
        safety = Store(safety_path, seed=False, automatic_backups=False, backup_on_start=False)
        self.assertEqual(safety.state(), before_restore)
        for filename in ("../outside.sqlite3", str(snapshot), "unknown.sqlite3"):
            with self.assertRaises(AppError):
                self.store.restore_backup(filename)
        bad = self.store.backup_dir / "shards-20000101-000000-000000.sqlite3"
        bad.write_bytes(b"not a SQLite database")
        with self.assertRaises(AppError):
            self.store.restore_backup(bad.name)
        self.assertEqual(self.store.export_data(), expected)
        listed = self.store.backups()["backups"]
        self.assertFalse(next(item for item in listed if item["filename"] == bad.name)["valid"])

    def test_restore_legacy_snapshot_migrates_additively_and_rejects_bad_revision_payloads(self):
        self.shard("Legacy", content="Retain this", prompt="Legacy question")
        expected = self.store.state()
        with self.store.connect() as connection:
            for table in ("revisions", "trash", "assets", "drafts"):
                connection.execute(f"DROP TABLE {table}")
            connection.execute("PRAGMA user_version=1")
        legacy = self.store.backup()
        upgraded = Store(self.db, root=self.root, seed=False, backup_on_start=False, automatic_backups=False)
        upgraded.create_shard({"title": "Later"})
        upgraded.restore_backup(legacy["filename"])
        self.assertEqual(upgraded.state(), expected)
        self.assertEqual(len(upgraded.revisions(expected["shards"][0]["id"])["revisions"]), 1)
        invalid = upgraded.backup()
        path = upgraded.backup_dir / invalid["filename"]
        with closing(sqlite3.connect(path)) as connection:
            connection.execute("UPDATE revisions SET snapshot='invalid JSON'")
            connection.commit()
        listed = upgraded.backups()["backups"]
        self.assertFalse(next(item for item in listed if item["filename"] == invalid["filename"])["valid"])
        with self.assertRaises(AppError):
            upgraded.restore_backup(invalid["filename"])
        self.assertEqual(upgraded.state(), expected)

    def test_images_revisions_and_trash_roundtrip_in_json_and_markdown_zip(self):
        asset = self.store.create_asset({"name": "diagram.png", "mimeType": "image/png", "data": PNG})
        first = self.shard("With image", content=f"![Diagram]({asset['url']})")
        self.store.update_shard(first["id"], {"title": "Refined image"})
        deleted = self.shard("Deleted idea")
        self.store.create_link({"fromId": first["id"], "toId": deleted["id"], "note": "Keep in trash"})
        self.store.delete_shard(deleted["id"])
        expected = self.store.export_data()
        imported = Store(self.root / "archive.sqlite3", seed=False, automatic_backups=False, backup_on_start=False)
        imported.import_data(expected)
        self.assertEqual(imported.export_data(), expected)
        self.assertEqual(imported.asset(asset["id"])[0], base64.b64decode(PNG))
        with zipfile.ZipFile(io.BytesIO(self.store.markdown_export())) as archive:
            self.assertEqual(json.loads(archive.read("shard-atlas.json")), expected)
            self.assertEqual(archive.read(f"assets/{asset['id']}.png"), base64.b64decode(PNG))
            note = next(name for name in archive.namelist() if name.endswith(".md"))
            self.assertIn(f"../assets/{asset['id']}.png", archive.read(note).decode())

    def test_invalid_raster_asset_import_rolls_back_every_optional_record(self):
        shard = self.shard("Keep")
        before = self.store.export_data()
        payload = copy.deepcopy(before)
        payload["shards"].append({"id": "new", "title": "Must not save"})
        payload["assets"] = [{"id": "bad-image", "name": "unsafe.svg", "mimeType": "image/png", "data": base64.b64encode(b"<svg></svg>").decode()}]
        with self.assertRaises(AppError):
            self.store.import_data(payload)
        self.assertEqual(self.store.export_data(), before)
        for data in ("not-base64", base64.b64encode(b"javascript:alert(1)").decode()):
            with self.assertRaises(AppError):
                self.store.create_asset({"name": "bad.png", "mimeType": "image/png", "data": data})
        self.assertEqual(self.store.revisions(shard["id"])["revisions"][0]["snapshot"]["title"], "Keep")

    def test_throttled_backup_worker_captures_changes_while_open(self):
        store = Store(self.root / "periodic.sqlite3", seed=False, backup_on_start=False,
                      backup_interval_seconds=0.08, backup_poll_seconds=0.01)
        store.start_backup_worker()
        try:
            shard = store.create_shard({"title": "A", "content": "first"})["shards"][0]
            first_count = len(list(store.backup_dir.glob("*.sqlite3")))
            self.assertEqual(first_count, 1)
            store.update_shard(shard["id"], {"content": "changed while open"})
            self.assertEqual(len(list(store.backup_dir.glob("*.sqlite3"))), first_count)
            deadline = time.monotonic() + 1
            while len(list(store.backup_dir.glob("*.sqlite3"))) == first_count and time.monotonic() < deadline:
                time.sleep(0.01)
            self.assertEqual(len(list(store.backup_dir.glob("*.sqlite3"))), first_count + 1)
            newest = max(store.backup_dir.glob("*.sqlite3"))
            restored = Store(newest, seed=False, automatic_backups=False, backup_on_start=False)
            self.assertEqual(restored.state()["shards"][0]["content"], "changed while open")
        finally:
            store.stop_backup_worker()

    def test_drafts_survive_reopening_but_are_excluded_from_portable_archive(self):
        draft = {"editingId": None, "values": {"title": "Unfinished", "content": "Still thinking"}}
        self.store.save_draft("editor", {"draft": draft})
        reopened = Store(self.db, seed=False, automatic_backups=False, backup_on_start=False)
        self.assertEqual(reopened.drafts()["drafts"]["editor"], draft)
        self.assertNotIn("drafts", reopened.export_data())
        reopened.delete_draft("editor")
        self.assertIsNone(reopened.drafts()["drafts"]["editor"])

    def test_projected_archive_limit_rejects_cumulative_images_and_revision_growth_atomically(self):
        self.store.create_asset({"name": "first.png", "mimeType": "image/png", "data": PNG})
        shard = self.shard("Existing", content="Saved explanation")
        before = self.store.export_data()
        with self.store.connect() as connection:
            used = self.store._archive_budget(connection)[0]
        with mock.patch("server.MAX_ARCHIVE_BYTES", used + 10):
            for mutation in (
                lambda: self.store.create_asset({"name": "second.png", "mimeType": "image/png", "data": PNG}),
                lambda: self.store.update_shard(shard["id"], {"content": "Another explanation"}),
            ):
                with self.assertRaises(AppError) as context:
                    mutation()
                self.assertEqual(context.exception.status, 413)
                self.assertEqual(self.store.export_data(), before)

    def test_successful_saves_clear_remote_drafts_in_the_same_transaction(self):
        self.store.save_draft("editor", {"draft": {"values": {"title": "New"}}})
        first = self.shard("A")
        self.assertIsNone(self.store.drafts()["drafts"]["editor"])
        second = self.shard("B")
        self.store.save_draft("connection", {"draft": {"values": {"note": "Reason"}}})
        link = self.store.create_link({"fromId": first["id"], "toId": second["id"]})["links"][0]
        self.assertIsNone(self.store.drafts()["drafts"]["connection"])
        draft = {"editingId": first["id"], "values": {"content": "Unsaved"}}
        self.store.save_draft("editor", {"draft": draft})
        with self.assertRaises(AppError):
            self.store.update_shard(first["id"], {"title": ""})
        self.assertEqual(self.store.drafts()["drafts"]["editor"], draft)
        self.store.update_shard(first["id"], {"content": "Saved"})
        self.assertIsNone(self.store.drafts()["drafts"]["editor"])
        self.store.save_draft("connection", {"draft": {"values": {"note": "Changed"}}})
        self.store.update_link(link["id"], {"note": "Changed"})
        self.assertIsNone(self.store.drafts()["drafts"]["connection"])


class HttpTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name).resolve()
        self.static = self.root / "static"
        self.static.mkdir()
        (self.static / "index.html").write_text("<!doctype html><title>Shard Atlas</title>")
        (self.static / "app.js").write_text("console.log('local');")
        (self.root / "private.txt").write_text("private data")
        (self.static / "secret.txt").symlink_to(self.root / "private.txt")
        self.store = Store(self.root / "db.sqlite3", root=self.root, seed=False, backup_on_start=False)
        self.server = LocalServer(("127.0.0.1", 0), self.store, static_dir=self.static)
        self.port = self.server.server_address[1]
        self.thread = threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=1)
        self.temporary.cleanup()

    def request(self, method, path, data=None, headers=None, raw=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        request_headers = dict(headers or {})
        body = raw
        if data is not None:
            body = json.dumps(data)
            request_headers.setdefault("Content-Type", "application/json")
        connection.request(method, path, body, request_headers)
        response = connection.getresponse()
        status, response_headers, content = response.status, dict(response.getheaders()), response.read()
        connection.close()
        if content and response_headers.get("Content-Type", "").startswith("application/json"):
            content = json.loads(content)
        return status, response_headers, content

    def test_actual_http_crud_review_and_export(self):
        status, _, state = self.request("POST", "/api/shards", {"title": "HTTP shard", "content": "<script>saved as text</script>"})
        self.assertEqual(status, 201)
        shard_id = state["shards"][0]["id"]
        status, _, state = self.request("PUT", f"/api/shards/{shard_id}", {"prompt": "Recall the model?"})
        self.assertEqual(status, 200)
        self.assertEqual(state["shards"][0]["prompt"], "Recall the model?")
        self.assertEqual(self.request("POST", "/api/reviews", {"shardId": shard_id, "grade": "easy"})[0], 201)
        status, headers, exported = self.request("GET", "/api/export")
        self.assertEqual(status, 200)
        self.assertIn("attachment", headers["Content-Disposition"])
        self.assertEqual(len(exported["reviews"]), 1)
        status, headers, zipped = self.request("GET", "/api/export/markdown")
        self.assertEqual(status, 200)
        self.assertEqual(headers["Content-Type"], "application/zip")
        with zipfile.ZipFile(io.BytesIO(zipped)) as archive:
            self.assertEqual(json.loads(archive.read("shard-atlas.json")), exported)
        self.assertEqual(self.request("DELETE", f"/api/shards/{shard_id}")[2]["shards"], [])

    def test_local_emblem_pack_overlays_without_mutating_public_catalog_or_knowledge(self):
        catalog = {"schemaVersion": 1, "releases": {"cpp20": {"emblems": [
            {"id": "four-dungeons", "name": "Castle Darkmoor", "src": "/spiral/emblems/four-dungeons.svg", "license": "MIT", "officialArtwork": False}]}}}
        catalog_path = self.static / "spiral-timeline.json"
        catalog_path.write_text(json.dumps(catalog))
        self.assertEqual(self.request("GET", "/spiral-timeline.json")[2], catalog)
        pack = self.static / "spiral" / "local-emblems"
        pack.mkdir(parents=True)
        (pack / "four-dungeons.png").write_bytes(base64.b64decode(PNG))
        (pack / "manifest.json").write_text(json.dumps({"schemaVersion": 1, "icons": [
            {"id": "four-dungeons", "file": "four-dungeons.png", "sourcePageUrl": "https://example.com/world"}]}))
        before = self.store.state()
        status, _, served = self.request("GET", "/spiral-timeline.json")
        self.assertEqual(status, 200)
        emblem = served["releases"]["cpp20"]["emblems"][0]
        self.assertEqual(emblem["src"], "/spiral/local-emblems/four-dungeons.png")
        self.assertTrue(emblem["officialArtwork"])
        self.assertNotEqual(emblem["license"], "MIT")
        self.assertEqual(emblem["sourceUrl"], "https://example.com/world")
        self.assertEqual(json.loads(catalog_path.read_text()), catalog)
        self.assertEqual(self.store.state(), before)
        self.assertEqual(self.request("GET", emblem["src"])[0], 200)

    def test_invalid_or_missing_local_emblems_keep_original_fallback(self):
        catalog = {"schemaVersion": 1, "releases": {"cpp98": {"emblems": [
            {"id": "dragonspyre", "name": "Dragonspyre", "src": "/spiral/emblems/dragonspyre.svg"}]}}}
        (self.static / "spiral-timeline.json").write_text(json.dumps(catalog))
        pack = self.static / "spiral" / "local-emblems"
        pack.mkdir(parents=True)
        manifest = pack / "manifest.json"
        manifest.write_text("{invalid json")
        self.assertEqual(self.request("GET", "/spiral-timeline.json")[2], catalog)
        for filename in ("missing.png", "../../private.txt", "https://example.com/world.png", "outside.png"):
            if filename == "outside.png":
                (pack / filename).symlink_to(self.root / "private.txt")
            manifest.write_text(json.dumps({"schemaVersion": 1, "icons": [{"id": "dragonspyre", "file": filename}]}))
            self.assertEqual(self.request("GET", "/spiral-timeline.json")[2], catalog)

    def test_http_contribution_receipts_are_additive_and_retry_safe(self):
        batch = {"requestId": "http-chat", "shards": [{"id": "http-ai-note", "title": "HTTP contribution", "tags": ["C++", "c++"]}]}
        status, _, receipt = self.request("POST", "/api/contributions", batch)
        self.assertEqual(status, 200)
        self.assertEqual(receipt["added"], {"shards": 1, "links": 0})
        self.assertTrue(receipt["verified"])
        self.assertTrue(self.request("POST", "/api/contributions", batch)[2]["replayed"])
        batch["shards"][0]["title"] = "Cannot overwrite"
        self.assertEqual(self.request("POST", "/api/contributions", batch)[0], 409)
        self.assertEqual(self.request("GET", "/api/state")[2]["shards"][0]["title"], "HTTP contribution")
        self.assertEqual(self.request("POST", "/api/contributions", {"requestId": "bad", "shards": [{"title": "No ID"}]})[0], 400)
        self.assertEqual(self.request("POST", "/api/contributions", {"requestId": "foreign", "shards": [{"id": "x", "title": "No"}]}, {"Origin": "https://evil.example"})[0], 403)

    def test_actual_import_backup_and_health_endpoints(self):
        payload = {"schemaVersion": 1, "shards": [{"id": "imported", "title": "Imported"}], "links": [], "reviews": []}
        status, _, state = self.request("POST", "/api/import", {"data": payload})
        self.assertEqual(status, 200)
        self.assertEqual(state["importSummary"]["added"]["shards"], 1)
        status, _, backup = self.request("POST", "/api/backup", {})
        self.assertEqual(status, 201)
        self.assertTrue((self.store.backup_dir / backup["filename"]).is_file())
        status, _, health = self.request("GET", "/api/health")
        self.assertEqual(status, 200)
        self.assertEqual(health["app"], "shard-atlas")
        self.assertEqual(health["shardCount"], 1)
        self.assertEqual(health["dbPath"], str(self.store.db_path))
        self.assertIsNone(health["lastBackupError"])

    def test_http_relationship_revision_and_trash_recovery_routes(self):
        first = self.request("POST", "/api/shards", {"title": "A", "content": "Original", "tags": ["old"]})[2]["shards"][0]
        state = self.request("POST", "/api/shards", {"title": "B"})[2]
        second = next(item for item in state["shards"] if item["title"] == "B")
        link = self.request("POST", "/api/links", {"fromId": first["id"], "toId": second["id"], "note": "Original reason"})[2]["links"][0]
        status, _, state = self.request("PUT", "/api/links/" + link["id"], {"note": "Edited reason"})
        self.assertEqual(status, 200)
        self.assertEqual(state["links"][0]["note"], "Edited reason")
        self.assertEqual(self.request("PUT", "/api/tags/rename", {"from": "old", "to": "new"})[0], 200)
        status, _, revisions = self.request("GET", "/api/shards/" + first["id"] + "/revisions")
        self.assertEqual(status, 200)
        original = revisions["revisions"][-1]
        self.assertEqual(self.request("POST", "/api/shards/" + first["id"] + "/restore", {"revisionId": original["id"]})[0], 200)
        self.request("DELETE", "/api/shards/" + first["id"])
        status, _, trash = self.request("GET", "/api/trash")
        self.assertEqual(status, 200)
        status, _, restored = self.request("POST", "/api/trash/" + trash["trash"][0]["id"] + "/restore", {})
        self.assertEqual(status, 200)
        self.assertEqual(len(restored["shards"]), 2)
        self.assertEqual(restored["restoreSummary"]["restoredLinks"], 1)

    def test_http_assets_drafts_and_verified_snapshot_restore(self):
        status, _, asset = self.request("POST", "/api/assets", {"name": "image.png", "mimeType": "image/png", "data": PNG})
        self.assertEqual(status, 201)
        status, headers, image = self.request("GET", asset["url"])
        self.assertEqual(status, 200)
        self.assertEqual(headers["Content-Type"], "image/png")
        self.assertEqual(image, base64.b64decode(PNG))
        self.assertEqual(self.request("POST", "/api/assets", {"name": "bad.svg", "mimeType": "image/svg+xml", "data": PNG})[0], 400)
        draft = {"values": {"title": "Draft"}}
        self.assertEqual(self.request("PUT", "/api/drafts/editor", {"draft": draft})[2], {"ok": True})
        self.assertEqual(self.request("GET", "/api/drafts")[2]["drafts"]["editor"], draft)
        self.assertEqual(self.request("DELETE", "/api/drafts/editor")[0], 200)
        self.request("POST", "/api/shards", {"title": "Original collection"})
        snapshot = self.request("POST", "/api/backup", {})[2]
        status, _, backups = self.request("GET", "/api/backups")
        self.assertEqual(status, 200)
        self.assertTrue(next(item for item in backups["backups"] if item["filename"] == snapshot["filename"])["valid"])
        self.request("POST", "/api/shards", {"title": "Later addition"})
        status, _, restored = self.request("POST", "/api/backups/restore", {"filename": snapshot["filename"]})
        self.assertEqual(status, 200)
        self.assertEqual(len(restored["shards"]), 1)
        self.assertIn("preRestoreBackupFilename", restored["restoreSummary"])
        self.assertEqual(self.request("POST", "/api/backups/restore", {"filename": "../db.sqlite3"})[0], 400)
        self.assertEqual(self.request("GET", asset["url"])[2], base64.b64decode(PNG))

    def test_foreign_host_and_origin_are_rejected_without_writing(self):
        invalid_headers = [
            {"Host": "evil.example"},
            {"Origin": "https://evil.example"},
            {"Origin": "null"},
            {"Origin": f"http://localhost:{self.port}"},
            {"Sec-Fetch-Site": "cross-site"},
        ]
        for headers in invalid_headers:
            with self.subTest(headers=headers):
                status, response_headers, _ = self.request("POST", "/api/shards", {"title": "Forbidden"}, headers)
                self.assertEqual(status, 403)
                self.assertNotIn("Access-Control-Allow-Origin", response_headers)
        valid_origin = {"Origin": f"http://127.0.0.1:{self.port}"}
        self.assertEqual(self.request("GET", "/api/state", headers=valid_origin)[0], 200)
        self.assertEqual(self.store.state()["shards"], [])

    def test_cross_site_top_level_entry_navigation_can_open_the_app(self):
        navigation = {"Sec-Fetch-Site": "cross-site", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "document"}
        for method in ("GET", "HEAD"):
            for path in ("/", "/index.html", "/?entry=link", "/index.html?entry=link"):
                with self.subTest(method=method, path=path):
                    status, headers, body = self.request(method, path, headers=navigation)
                    self.assertEqual(status, 200)
                    self.assertIn("text/html", headers["Content-Type"])
                    self.assertNotIn("Access-Control-Allow-Origin", headers)
                    self.assertIn("frame-ancestors 'none'", headers["Content-Security-Policy"])
                    if method == "HEAD":
                        self.assertEqual(body, b"")
                    else:
                        self.assertIn(b"Shard Atlas", body)

    def test_cross_site_navigation_cannot_read_data_assets_or_other_static_files(self):
        navigation = {"Sec-Fetch-Site": "cross-site", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "document"}
        asset = self.store.create_asset({"name": "private.png", "mimeType": "image/png", "data": PNG})
        for method in ("GET", "HEAD"):
            for path in ("/api/state", "/api/data", "/api/export", "/api/health", "/app.js", asset["url"]):
                with self.subTest(method=method, path=path):
                    status, headers, _ = self.request(method, path, headers=navigation)
                    self.assertEqual(status, 403)
                    self.assertNotIn("Access-Control-Allow-Origin", headers)

    def test_cross_site_navigation_metadata_cannot_authorize_a_write(self):
        navigation = {"Sec-Fetch-Site": "cross-site", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "document"}
        for path in ("/", "/index.html", "/api/shards", "/api/backup"):
            with self.subTest(path=path):
                status, _, _ = self.request("POST", path, {"title": "Forbidden"}, navigation)
                self.assertEqual(status, 403)
        self.assertEqual(self.store.state()["shards"], [])
        self.assertFalse(self.store.backup_dir.exists())

    def test_cross_site_entry_navigation_does_not_bypass_host_or_origin_checks(self):
        navigation = {"Sec-Fetch-Site": "cross-site", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "document"}
        forbidden = [
            {"Host": "evil.example"},
            {"Origin": "https://evil.example"},
            {"Origin": "null"},
            {"Origin": f"http://localhost:{self.port}"},
            {"Origin": f"http://127.0.0.1:{self.port}"},
        ]
        for method in ("GET", "HEAD"):
            for path in ("/", "/index.html"):
                for headers in forbidden:
                    with self.subTest(method=method, path=path, headers=headers):
                        status, _, _ = self.request(method, path, headers={**navigation, **headers})
                        self.assertEqual(status, 403)

    def test_cross_site_entry_requires_a_top_level_document_navigation(self):
        for headers in (
            {"Sec-Fetch-Site": "cross-site"},
            {"Sec-Fetch-Site": "cross-site", "Sec-Fetch-Mode": "navigate"},
            {"Sec-Fetch-Site": "cross-site", "Sec-Fetch-Dest": "document"},
            {"Sec-Fetch-Site": "cross-site", "Sec-Fetch-Mode": "cors", "Sec-Fetch-Dest": "document"},
            {"Sec-Fetch-Site": "cross-site", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "iframe"},
        ):
            with self.subTest(headers=headers):
                self.assertEqual(self.request("GET", "/", headers=headers)[0], 403)

    def test_json_content_type_and_invalid_data_rejected(self):
        self.assertEqual(self.request("POST", "/api/shards", raw='{"title":"No"}', headers={"Content-Type": "text/plain"})[0], 415)
        self.assertEqual(self.request("POST", "/api/shards", raw='{oops', headers={"Content-Type": "application/json"})[0], 400)
        self.assertEqual(self.request("POST", "/api/shards", raw='{"title":"NaN","reviewCount":NaN}', headers={"Content-Type": "application/json"})[0], 400)
        self.assertEqual(self.request("POST", "/api/shards", {"title": "Wrong kind", "kind": []})[0], 400)
        self.assertEqual(self.request("POST", "/api/reviews", {"shardId": "x", "grade": {}})[0], 400)
        self.assertEqual(self.store.state()["shards"], [])

    def test_static_files_have_security_headers_and_no_traversal(self):
        status, headers, body = self.request("GET", "/")
        self.assertEqual(status, 200)
        self.assertIn(b"Shard Atlas", body)
        self.assertEqual(headers["X-Content-Type-Options"], "nosniff")
        self.assertIn("script-src 'self'", headers["Content-Security-Policy"])
        self.assertEqual(self.request("GET", "/app.js")[0], 200)
        for path in ("/../private.txt", "/%2e%2e/private.txt", "/%2F..%2Fprivate.txt", "/secret.txt", "/api/missing"):
            with self.subTest(path=path):
                self.assertEqual(self.request("GET", path)[0], 404)

    def test_server_cannot_bind_to_external_interface(self):
        with self.assertRaises(ValueError):
            LocalServer(("0.0.0.0", 0), self.store)


if __name__ == "__main__":
    unittest.main()
