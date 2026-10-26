"""Bounded numerical experiment configuration and isolated recovery tests."""

import concurrent.futures
import contextlib
import copy
import io
import json
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from unittest import mock
import urllib.error
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "tools"))
from server import (AppError, DATABASE_VERSION, LocalServer, Store, validate_experiment,
                    validate_experiments, validate_shard)
from shard_atlas_client import AtlasClient, ClientError, portable_archive, valid_health
from shard_atlas_mcp import SHARD_SCHEMA

PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jR7sAAAAASUVORK5CYII="
GRADIENT = {"a": 4, "b": 0, "c": 1, "startX": 3, "startY": 2,
            "learningRate": .2, "maxIterations": 60, "tolerance": 1e-8}
VALUE = {"states": [{"id": "start", "label": "Start", "terminal": False, "initialValue": 0},
                    {"id": "goal", "label": "Goal", "terminal": True, "initialValue": 0}],
         "actions": [{"id": "move", "label": "Move"}],
         "transitions": [{"stateId": "start", "actionId": "move", "outcomes": [
             {"nextStateId": "start", "probability": .2, "reward": -1},
             {"nextStateId": "goal", "probability": .8, "reward": 5}]}],
         "discount": .9, "maxIterations": 100, "tolerance": 1e-6}


def experiment(kind="gradient-descent", identifier="experiment-a", **changes):
    return {"id": identifier, "type": kind, "title": "A reproducible example", "algorithmVersion": 1,
            "config": copy.deepcopy(GRADIENT if kind == "gradient-descent" else VALUE), **changes}


class ExperimentTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.path = self.root / "experiments.sqlite3"
        self.store = self.open_store(self.path)

    def open_store(self, path):
        return Store(path, root=self.root, seed=False, backup_on_start=False, automatic_backups=False)

    def tearDown(self):
        self.store.stop_backup_worker()
        self.temporary.cleanup()

    def create(self, **changes):
        existing = {shard["id"] for shard in self.store.state()["shards"]}
        state = self.store.create_shard({"title": "An iterative method", "content": "An explanation.", **changes})
        return next(shard for shard in state["shards"] if shard["id"] not in existing)

    @contextlib.contextmanager
    def service(self):
        server = LocalServer(("127.0.0.1", 0), self.store)
        thread = threading.Thread(target=lambda: server.serve_forever(poll_interval=.05), daemon=True)
        thread.start()
        try:
            yield f"http://127.0.0.1:{server.server_address[1]}"
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)

    def put(self, base, path, payload):
        request = urllib.request.Request(base + path, json.dumps(payload).encode(),
                                         {"Content-Type": "application/json"}, method="PUT")
        try:
            with urllib.request.urlopen(request) as response:
                return response.status, json.load(response)
        except urllib.error.HTTPError as error:
            return error.code, json.load(error)

    def test_legacy_notes_get_empty_defaults_without_rewriting_cpp_knowledge(self):
        saved = self.create(languageVersion="C++17", status="solid", tags=["C++"])
        self.assertEqual(saved["experiments"], [])
        with self.store.connect() as connection:
            knowledge = json.loads(connection.execute("SELECT knowledge FROM shards").fetchone()[0])
            knowledge.pop("experiments")
            encoded = json.dumps(knowledge)
            connection.execute("UPDATE shards SET knowledge=?", (encoded,))
        reopened = self.open_store(self.path)
        try:
            current = reopened.state()["shards"][0]
            self.assertEqual(current["experiments"], [])
            self.assertEqual((current["status"], current["languageVersion"], current["tags"]), ("solid", "C++17", ["C++"]))
            self.assertEqual(reopened.health()["databaseVersion"], DATABASE_VERSION)
            self.assertGreaterEqual(DATABASE_VERSION, 4)
            with reopened.connect() as connection:
                self.assertEqual(connection.execute("SELECT knowledge FROM shards").fetchone()[0], encoded)
        finally:
            reopened.stop_backup_worker()

    def test_explicit_settings_and_optional_descriptive_defaults_are_preserved(self):
        minimal = validate_experiment(experiment())
        for field in ("description", "sourceUrl", "sourceLocation"):
            self.assertEqual(minimal[field], "")
        self.assertIsNone(minimal["comparisonConfig"])
        self.assertEqual(minimal["config"], GRADIENT)
        self.assertEqual(validate_experiment(experiment("value-iteration"))["config"], VALUE)
        both = experiment(comparisonConfig={**GRADIENT, "learningRate": .4}, sourceUrl="https://example.com/method", sourceLocation="Equation 3")
        self.assertEqual(validate_experiment(both)["comparisonConfig"]["learningRate"], .4)

    def test_gradient_constraints_reject_invalid_settings_and_never_execute_code(self):
        invalid = []
        for field, values in {"a": [0, .0009, 1001, True, "4", float("nan"), float("inf"), 10 ** 1000],
                              "b": [-1001, 1001, False], "c": [.0009, 1001],
                              "startX": [-101, 101], "startY": [None, 101],
                              "learningRate": [0, -1, 10.1], "maxIterations": [0, 501, 1.0, True],
                              "tolerance": [0, 1e-13, 1.1]}.items():
            for value in values:
                invalid.append(experiment(config={**GRADIENT, field: value}))
        invalid.extend([experiment(config={**GRADIENT, "b": 2}),
                        experiment(config={**GRADIENT, "a": .001, "c": .001, "b": .001}),
                        experiment(config={**GRADIENT, "code": "raise RuntimeError('never run')"}),
                        experiment(config={key: value for key, value in GRADIENT.items() if key != "startX"}),
                        experiment(config=None), experiment(config=VALUE), experiment(comparisonConfig=VALUE)])
        for candidate in invalid:
            with self.subTest(candidate=candidate), self.assertRaises(AppError):
                validate_experiment(candidate)
        boundary = {"a": .001, "b": 0, "c": 1000, "startX": -100, "startY": 100,
                    "learningRate": 10, "maxIterations": 500, "tolerance": 1e-12}
        self.assertEqual(validate_experiment(experiment(config=boundary))["config"], boundary)

    def test_experiment_object_is_typed_bounded_unique_and_forward_version_safe(self):
        invalid = [None, {}, experiment(id="bad id"), experiment(title=" "), experiment(title="x" * 241),
                   experiment(type="custom-python"), experiment(type=True), experiment(algorithmVersion=2),
                   experiment(algorithmVersion=True), experiment(algorithmVersion=1.0),
                   experiment(description="x" * 5001), experiment(sourceLocation="x" * 241),
                   experiment(sourceUrl="javascript:alert(1)"), experiment(sourceUrl="https://user:secret@example.com"),
                   experiment(results={"converged": True})]
        missing_version = experiment()
        missing_version.pop("algorithmVersion")
        invalid.append(missing_version)
        for candidate in invalid:
            with self.subTest(candidate=candidate), self.assertRaises(AppError):
                validate_experiment(candidate)
        for values in (None, {}, "experiment", [experiment()] * 2,
                       [experiment(identifier=f"e-{index}") for index in range(11)]):
            with self.subTest(values=values), self.assertRaises(AppError):
                validate_experiments(values)
        self.assertEqual(len(validate_experiments([experiment(identifier=f"e-{index}") for index in range(10)])), 10)

    def test_value_iteration_validates_topology_terminal_rules_and_exact_probabilities(self):
        invalid = []
        def altered(change):
            config = copy.deepcopy(VALUE)
            change(config)
            invalid.append(experiment("value-iteration", config=config))
        altered(lambda c: c.update(states=[]))
        altered(lambda c: c.update(actions=[]))
        altered(lambda c: c["states"].append(copy.deepcopy(c["states"][0])))
        altered(lambda c: c["actions"].append(copy.deepcopy(c["actions"][0])))
        altered(lambda c: c["states"][0].update(terminal=0))
        altered(lambda c: c["states"][1].update(initialValue=1))
        altered(lambda c: c["states"][0].update(initialValue=True))
        altered(lambda c: c["states"][0].update(initialValue=float("nan")))
        altered(lambda c: c["states"][0].update(label=""))
        altered(lambda c: c["actions"][0].update(label="x" * 121))
        altered(lambda c: c["transitions"].append(copy.deepcopy(c["transitions"][0])))
        altered(lambda c: c["transitions"][0].update(stateId="missing"))
        altered(lambda c: c["transitions"][0].update(actionId="missing"))
        altered(lambda c: c["transitions"][0].update(stateId="goal"))
        altered(lambda c: c.update(transitions=[]))
        altered(lambda c: c["transitions"][0].update(outcomes=[]))
        altered(lambda c: c["transitions"][0]["outcomes"][0].update(nextStateId="missing"))
        altered(lambda c: c["transitions"][0]["outcomes"][0].update(probability=.1))
        altered(lambda c: c["transitions"][0]["outcomes"][0].update(probability=-.1))
        altered(lambda c: c["transitions"][0]["outcomes"][0].update(probability=True))
        altered(lambda c: c["transitions"][0]["outcomes"][0].update(reward=10001))
        altered(lambda c: c["transitions"][0]["outcomes"][0].update(reward=float("inf")))
        altered(lambda c: c["transitions"][0]["outcomes"][0].update(code="unsupported"))
        for field, value in (("discount", 1), ("discount", -.01), ("discount", False),
                             ("maxIterations", 1.5), ("maxIterations", 501), ("tolerance", 0)):
            altered(lambda c, field=field, value=value: c.update({field: value}))
        for candidate in invalid:
            with self.subTest(candidate=candidate), self.assertRaises(AppError):
                validate_experiment(candidate)
        repeated = copy.deepcopy(VALUE)
        repeated["transitions"][0]["outcomes"] = [{"nextStateId": "goal", "probability": .5, "reward": 2},
                                                   {"nextStateId": "goal", "probability": .5000000005, "reward": 8}]
        saved = validate_experiment(experiment("value-iteration", config=repeated))
        self.assertEqual(saved["config"], repeated, "Accepted rounding must never silently renormalize probabilities.")
        all_terminal = {**VALUE, "states": [{"id": "done", "label": "Done", "terminal": True, "initialValue": 0}], "transitions": []}
        self.assertEqual(validate_experiment(experiment("value-iteration", config=all_terminal))["config"], all_terminal)

    def test_invalid_edit_and_import_leave_current_data_and_history_untouched(self):
        saved = self.create(experiments=[experiment()])
        before = self.store.export_data()
        bad = experiment(config={**GRADIENT, "a": False})
        with self.assertRaises(AppError):
            self.store.update_shard(saved["id"], {"experiments": [bad]})
        with self.assertRaises(AppError):
            self.store.import_data({"schemaVersion": 1, "shards": [{"id": "invalid", "title": "Invalid", "experiments": [bad]}]})
        self.assertFalse(self.store.import_preview({"schemaVersion": 1, "shards": [{"id": "invalid", "title": "Invalid", "experiments": [bad]}]})["valid"])
        self.assertEqual(self.store.export_data(), before)

    def test_settings_survive_partial_edits_versions_trash_archive_and_backup(self):
        values = [experiment(description="A comparison", comparisonConfig={**GRADIENT, "learningRate": .4}),
                  experiment("value-iteration", identifier="value-example")]
        saved = self.create(experiments=values, status="verify", subjects=["ML"])
        normalized = validate_experiments(values)
        version = self.store.revisions(saved["id"])["revisions"][0]
        self.store.update_shard(saved["id"], {"content": "A corrected explanation."})
        self.assertEqual(self.store.state()["shards"][0]["experiments"], normalized)
        self.store.update_shard(saved["id"], {"experiments": []})
        restored = self.store.restore_revision(saved["id"], {"revisionId": version["id"]})["shards"][0]
        self.assertEqual(restored["experiments"], normalized)
        self.assertEqual(restored["status"], "verify")
        self.store.delete_shard(saved["id"])
        trashed = self.store.trash()["trash"][0]
        self.assertEqual(trashed["shard"]["experiments"], normalized)
        self.assertEqual(self.store.restore_trash(trashed["id"])["shards"][0]["experiments"], normalized)
        destination = self.open_store(self.root / "roundtrip.sqlite3")
        try:
            archive = self.store.export_data()
            destination.import_data(archive)
            self.assertEqual(destination.export_data(), archive)
        finally:
            destination.stop_backup_worker()
        backup = self.store.backup()
        self.store.update_shard(saved["id"], {"experiments": []})
        self.assertEqual(self.store.restore_backup(backup["filename"])["shards"][0]["experiments"], normalized)

    def test_large_bounded_mdp_and_incomplete_numeric_drafts_are_recoverable(self):
        states = [{"id": f"state-{index}-" + "s" * 90, "label": "界" * 120, "terminal": False, "initialValue": 10000} for index in range(12)]
        actions = [{"id": f"action-{index}-" + "a" * 90, "label": "界" * 120} for index in range(4)]
        rows = [{"stateId": state["id"], "actionId": action["id"], "outcomes": [
            {"nextStateId": other["id"], "probability": 1 / 12, "reward": -10000} for other in states]}
            for state in states for action in actions]
        config = {"states": states, "actions": actions, "transitions": rows, "discount": .999, "maxIterations": 500, "tolerance": 1e-12}
        values = [experiment("value-iteration", identifier=f"maximum-{index}", description="界" * 5000,
                             config=config, comparisonConfig=config) for index in range(10)]
        validate_experiments(values)
        draft = {"editingId": None, "values": {"experiments": json.dumps(values, ensure_ascii=False)}}
        self.assertGreater(len(json.dumps(draft).encode()), 250000)
        self.store.save_draft("editor", {"draft": draft})
        self.assertEqual(self.store.drafts()["drafts"]["editor"], draft)
        incomplete = experiment(config={**GRADIENT, "startX": "", "learningRate": "-"})
        draft["values"]["experiments"] = json.dumps([incomplete])
        self.store.save_draft("editor", {"draft": draft})
        reopened = self.open_store(self.path)
        try:
            self.assertEqual(reopened.drafts()["drafts"]["editor"], draft)
        finally:
            reopened.stop_backup_worker()

    def test_atomic_http_update_preserves_current_other_metadata_draft_and_both_versions(self):
        saved = self.create(experiments=[experiment(), experiment("value-iteration", identifier="second")])
        stale = copy.deepcopy(saved["experiments"][0])
        self.store.update_shard(saved["id"], {"content": "A newer body from another editor.", "subjects": ["Mathematics"],
                                             "verification": {"status": "needs-correction", "note": "A condition needs checking."}})
        draft = {"editingId": saved["id"], "values": {"content": "Unsaved work."}}
        self.store.save_draft("editor", {"draft": draft})
        stale["config"]["learningRate"] = .3
        with self.service() as base:
            status, state = self.put(base, f"/api/shards/{saved['id']}/experiments/{stale['id']}", {"experiment": stale})
        self.assertEqual(status, 200)
        current = state["shards"][0]
        self.assertEqual(current["content"], "A newer body from another editor.")
        self.assertEqual(current["subjects"], ["Mathematics"])
        self.assertEqual(current["verification"]["status"], "needs-correction")
        self.assertEqual(current["status"], saved["status"])
        self.assertEqual(current["experiments"][0], stale)
        self.assertEqual(current["experiments"][1], saved["experiments"][1])
        self.assertEqual(self.store.drafts()["drafts"]["editor"], draft)
        versions = self.store.revisions(saved["id"])["revisions"]
        self.assertEqual({version["snapshot"]["experiments"][0]["config"]["learningRate"] for version in versions}, {.2, .3})
        self.assertTrue(any(version["snapshot"]["content"] == current["content"] and version["snapshot"]["experiments"][0]["config"]["learningRate"] == .2 for version in versions))

    def test_atomic_update_errors_are_http_typed_and_leave_no_changes(self):
        saved = self.create(experiments=[experiment()])
        before = self.store.export_data()
        with self.service() as base:
            target = f"/api/shards/{saved['id']}/experiments/experiment-a"
            cases = [(target, {"experiment": experiment(config={**GRADIENT, "learningRate": 0})}, 400),
                     (target, {"experiment": experiment(identifier="different")}, 400),
                     (target, {"experiment": experiment(), "content": "Lost concurrent content"}, 400),
                     (f"/api/shards/{saved['id']}/experiments/missing", {"experiment": experiment(identifier="missing")}, 404),
                     ("/api/shards/missing/experiments/experiment-a", {"experiment": experiment()}, 404)]
            for path, payload, expected_status in cases:
                with self.subTest(path=path, payload=payload):
                    self.assertEqual(self.put(base, path, payload)[0], expected_status)
                    self.assertEqual(self.store.export_data(), before)

    def test_independent_services_atomically_merge_distinct_experiment_updates(self):
        saved = self.create(experiments=[experiment(), experiment(identifier="second")])
        other = self.open_store(self.path)
        barrier = threading.Barrier(2)
        def update(store, index):
            candidate = copy.deepcopy(saved["experiments"][index])
            candidate["config"]["learningRate"] = .3 + index / 10
            barrier.wait(timeout=3)
            store.update_experiment(saved["id"], candidate["id"], {"experiment": candidate})
        try:
            with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
                jobs = [executor.submit(update, store, index) for index, store in enumerate((self.store, other))]
                for job in jobs:
                    job.result(timeout=10)
            current = self.store.state()["shards"][0]
            self.assertEqual([value["config"]["learningRate"] for value in current["experiments"]], [.3, .4])
        finally:
            other.stop_backup_worker()

    def test_atomic_save_keeps_an_unrecorded_before_state_and_its_restoration(self):
        saved = self.create(experiments=[experiment()])
        with self.store.connect() as connection:
            connection.execute("DELETE FROM revisions WHERE shard_id=?", (saved["id"],))
        candidate = copy.deepcopy(saved["experiments"][0])
        candidate["config"]["startY"] = -3
        self.store.update_experiment(saved["id"], candidate["id"], {"experiment": candidate})
        versions = self.store.revisions(saved["id"])["revisions"]
        self.assertEqual(len(versions), 2)
        before = next(version for version in versions if version["snapshot"]["experiments"] == saved["experiments"])
        self.assertEqual(self.store.restore_revision(saved["id"], {"revisionId": before["id"]})["shards"][0]["experiments"], saved["experiments"])

    def test_import_reviewed_current_settings_remain_available_beside_older_history(self):
        original = validate_shard({"id": "reviewed-experiment", "title": "Reviewed experiment", "experiments": [experiment()]}, imported=True)
        reviewed = copy.deepcopy(original)
        reviewed["experiments"][0]["config"]["startX"] = -4
        self.store.import_data({"schemaVersion": 1, "shards": [reviewed], "revisions": [{"id": "source-revision", "shardId": original["id"],
            "createdAt": original["createdAt"], "reason": "source settings", "snapshot": original}]})
        versions = self.store.revisions(original["id"])["revisions"]
        self.assertEqual({version["snapshot"]["experiments"][0]["config"]["startX"] for version in versions}, {3, -4})
        self.store.update_shard(original["id"], {"content": "A later explanation."})
        self.assertTrue(any(version["snapshot"]["experiments"] == reviewed["experiments"] for version in self.store.revisions(original["id"])["revisions"]))

    def test_undo_preserves_user_edits_and_experiment_assets_in_retained_history(self):
        values = [experiment(description="![Quadratic](/assets/experiment-image)")]
        archive = {"schemaVersion": 1, "shards": [{"id": "imported", "title": "Imported experiment", "experiments": values}],
                   "assets": [{"id": "experiment-image", "name": "quadratic.png", "mimeType": "image/png", "data": PNG}]}
        broken = copy.deepcopy(archive)
        broken["assets"] = []
        self.assertEqual(self.store.import_preview(broken)["missing"][0]["assetId"], "experiment-image")
        saved = self.store.import_data(archive)
        candidate = copy.deepcopy(saved["shards"][0]["experiments"][0])
        candidate["config"]["startX"] = 4
        self.store.update_experiment("imported", candidate["id"], {"experiment": candidate})
        self.store.update_shard("imported", {"experiments": []})
        undone = self.store.undo_import(saved["importSummary"]["importId"])
        self.assertEqual(undone["shards"][0]["id"], "imported")
        self.assertEqual(self.store.export_data()["assets"][0]["id"], "experiment-image")
        versions = self.store.revisions("imported")["revisions"]
        self.assertTrue(any(version["snapshot"]["experiments"] for version in versions))

    def test_experiment_local_ids_are_not_concept_dependencies(self):
        imported = self.store.import_data({"schemaVersion": 1, "shards": [{"id": "start", "title": "An unrelated imported shard"}]})
        saved = self.create(experiments=[experiment("value-iteration", identifier="start")])
        undone = self.store.undo_import(imported["importSummary"]["importId"])
        self.assertEqual([shard["id"] for shard in undone["shards"]], [saved["id"]])
        self.assertEqual(undone["shards"][0]["experiments"][0]["config"], VALUE)

    def test_markdown_export_includes_reproducible_settings_sources_and_local_images(self):
        self.store.import_data({"schemaVersion": 1, "assets": [{"id": "plot", "name": "plot.png", "mimeType": "image/png", "data": PNG}]})
        saved = self.create(experiments=[experiment(description="![Shape](/assets/plot)", comparisonConfig={**GRADIENT, "learningRate": .4},
                                                   sourceUrl="https://example.com/method", sourceLocation="Algorithm 2")])
        with zipfile.ZipFile(io.BytesIO(self.store.markdown_export())) as archive:
            name = next(name for name in archive.namelist() if name.startswith("shards/"))
            content = archive.read(name).decode()
            for phrase in ("## Reproducible experiments", "Algorithm version: 1", "Configuration A", "Configuration B",
                           '"learningRate": 0.4', "not computed results", "https://example.com/method", "Algorithm 2", "![Shape](../assets/plot.png)"):
                self.assertIn(phrase, content)
            self.assertEqual(json.loads(archive.read("shard-atlas.json"))["shards"][0]["experiments"], saved["experiments"])

    def test_old_import_receipt_still_undoes_after_default_experiments_are_read(self):
        saved = self.store.import_data({"schemaVersion": 1, "shards": [{"id": "old-import", "title": "Legacy note"}]})
        import_id = saved["importSummary"]["importId"]
        with self.store.connect() as connection:
            knowledge = json.loads(connection.execute("SELECT knowledge FROM shards").fetchone()[0])
            knowledge.pop("experiments")
            connection.execute("UPDATE shards SET knowledge=?", (json.dumps(knowledge),))
            for row in connection.execute("SELECT id,snapshot FROM revisions").fetchall():
                snapshot = json.loads(row["snapshot"])
                snapshot.pop("experiments")
                connection.execute("UPDATE revisions SET snapshot=? WHERE id=?", (json.dumps(snapshot), row["id"]))
            receipt = json.loads(connection.execute("SELECT payload FROM imports WHERE id=?", (import_id,)).fetchone()[0])
            for table, records in receipt["records"].items():
                for record in records:
                    record["fingerprint"] = self.store._record_fingerprint(connection, table, record["id"])
            connection.execute("UPDATE imports SET payload=? WHERE id=?", (json.dumps(receipt), import_id))
        self.assertEqual(self.store.state()["shards"][0]["experiments"], [])
        self.assertEqual(self.store.undo_import(import_id)["shards"], [])

    def test_contributions_verify_search_settings_and_do_not_alias_local_state_ids(self):
        existing = self.create(title="Canonical concept", content="The same concept.")
        local = copy.deepcopy(VALUE)
        local["states"][0]["id"] = "duplicate"
        local["transitions"][0]["stateId"] = "duplicate"
        local["transitions"][0]["outcomes"][0]["nextStateId"] = "duplicate"
        values = [experiment("value-iteration", config=local, description="A distinctive Bellman setting.")]
        batch = {"requestId": "experiment-contribution", "shards": [
            {"id": "duplicate", "title": existing["title"], "content": existing["content"], "tags": []},
            {"id": "experiment-contributed", "title": "A new concept", "content": "A new explanation.", "experiments": values}]}
        self.assertEqual(portable_archive(batch)["shards"][1]["experiments"], validate_experiments(values))
        with self.service() as base:
            client = AtlasClient(base)
            self.assertTrue(client.add(batch)["verified"])
            saved = next(shard for shard in client.state()["shards"] if shard["id"] == "experiment-contributed")
            self.assertEqual(saved["experiments"][0]["config"], local)
            self.assertEqual(client.search("distinctive Bellman setting")["matches"][0]["id"], saved["id"])
            candidate = copy.deepcopy(saved["experiments"][0])
            candidate["config"]["discount"] = .5
            self.store.update_experiment(saved["id"], candidate["id"], {"experiment": candidate})
            self.assertFalse(client.add(batch)["currentContentMatches"])

    def test_missing_experiment_readback_cannot_claim_success_and_discovery_requires_current_version(self):
        batch = {"requestId": "experiment-readback", "shards": [{"id": "with-experiment", "title": "A runnable example", "experiments": [experiment()]}]}
        with self.service() as base:
            client = AtlasClient(base)
            real_state = client.state
            def incomplete_state():
                state = real_state()
                for shard in state["shards"]:
                    shard["experiments"] = []
                return state
            with mock.patch.object(client, "state", side_effect=incomplete_state), self.assertRaises(ClientError):
                client.add(batch)
        self.assertEqual(len(self.store.state()["shards"][0]["experiments"]), 1)
        health = self.store.health()
        self.assertFalse(valid_health({**health, "backendVersion": "2.6.0"}, self.path))
        self.assertFalse(valid_health({**health, "backendVersion": "2.7.0"}, self.path))
        self.assertTrue(valid_health({**health, "backendVersion": "2.9.0"}, self.path))

    def test_mcp_schema_exposes_both_bounded_nested_configuration_types(self):
        schema = SHARD_SCHEMA["properties"]["experiments"]
        self.assertEqual(schema["maxItems"], 10)
        variants = schema["items"]["oneOf"]
        self.assertEqual({item["properties"]["type"]["enum"][0] for item in variants}, {"gradient-descent", "value-iteration"})
        for item in variants:
            self.assertFalse(item["additionalProperties"])
            self.assertTrue({"id", "type", "title", "algorithmVersion", "config"}.issubset(item["required"]))
            self.assertFalse(item["properties"]["config"]["additionalProperties"])
            self.assertIn("comparisonConfig", item["properties"])


if __name__ == "__main__":
    unittest.main()
