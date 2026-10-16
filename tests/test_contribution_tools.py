"""Exercise contributor CLI and MCP against isolated HTTP servers, never live data."""

import copy
import concurrent.futures
import io
import json
from pathlib import Path
import subprocess
import socket
import sys
import tempfile
import threading
import time
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "tools"))
from server import LocalServer, Store
import shard_atlas_client as client_module
from shard_atlas_client import AtlasClient, ClientError, discover, loopback_url, portable_archive, validate_batch, valid_health
from shard_atlas_mcp import MCPServer, ProtocolError, serve


class ContributionToolsTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.store = Store(self.root / "qa.sqlite3", root=self.root, seed=False, backup_on_start=False, automatic_backups=False)
        self.server = LocalServer(("127.0.0.1", 0), self.store)
        self.thread = threading.Thread(target=lambda: self.server.serve_forever(poll_interval=.05), daemon=True)
        self.thread.start()
        self.version = mock.patch("server.BACKEND_VERSION", "2.2.0")
        self.version.start()
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"
        self.client = AtlasClient(self.url)
        self.batch = {"requestId": "qa-contribution-1", "shards": [
            {"id": "qa-ownership", "title": "Ownership", "content": "One owner releases the resource.\n\nSource: https://isocpp.github.io/CppCoreGuidelines/", "tags": ["C++", "Memory"], "sourceUrl": "https://isocpp.github.io/CppCoreGuidelines/"},
            {"id": "qa-raii", "title": "RAII", "content": "A destructor releases its owned resource.", "tags": ["C++", "Memory"]},
        ], "links": [{"fromId": "qa-raii", "toId": "qa-ownership", "type": "explains", "note": "Automatic cleanup implements ownership."}]}

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)
        self.version.stop()
        self.temporary.cleanup()

    def run_cli(self, *arguments):
        return subprocess.run([sys.executable, str(ROOT / "tools/shard_atlas_client.py"), "--base-url", self.url, *arguments], text=True, capture_output=True, timeout=15)

    def test_loopback_restrictions_and_backend_identity(self):
        self.assertEqual(loopback_url(self.url + "/"), self.url)
        for invalid in ["https://127.0.0.1:80", "http://example.com:80", "http://127.0.0.2:80", "http://127.0.0.1", self.url + "/other", self.url + "?q=1", "http://name:secret@localhost:80"]:
            with self.subTest(invalid=invalid), self.assertRaises(ClientError):
                loopback_url(invalid)
        health = self.client.status()
        self.assertTrue(valid_health(health, self.store.db_path))
        self.assertFalse(valid_health(health, self.root / "wrong.sqlite3"))
        self.assertFalse(valid_health({**health, "backendVersion": "2.1.0"}))
        self.assertFalse(valid_health({**health, "app": "other"}))

    def test_v3_evidence_metadata_and_new_relationships_survive_helper_and_mcp(self):
        batch = copy.deepcopy(self.batch)
        batch["requestId"] = "qa-evidence-tools"
        note = batch["shards"][0]
        note.update(evidenceStatus="reported", eventDate="2026-10", eventType="research",
                    entities=["Company, Inc."], sources=[{"url": "https://example.com/paper", "publishedDate": "2026-09"}],
                    facts=[{"label": "Median total compensation", "value": "450000", "unit": "USD/year", "asOf": "2026-10"}])
        batch["links"][0]["type"] = "supports"
        receipt = self.client.add(batch)
        self.assertTrue(receipt["verified"])
        saved = self.client.read([note["id"]])["shards"][0]
        self.assertEqual(saved["entities"], ["Company, Inc."])
        self.assertEqual(saved["eventDate"], "2026-10")
        self.assertEqual(saved["sources"][0]["publishedDate"], "2026-09")
        self.assertEqual(saved["facts"][0]["unit"], "USD/year")
        from shard_atlas_mcp import SHARD_SCHEMA, LINK_SCHEMA
        self.assertIn("sources", SHARD_SCHEMA["properties"])
        self.assertIn("part_of", LINK_SCHEMA["properties"]["type"]["enum"])
        self.assertTrue(valid_health({**self.client.status(), "backendVersion": "3.0.0"}))

    def test_helper_previews_and_verifies_repeatable_board_archive_import(self):
        archive = portable_archive(self.batch)
        archive["boards"] = [{"id": "qa-helper-board", "title": "Shared ideas", "items": [
            {"shardId": self.batch["shards"][0]["id"], "x": 10, "y": 20, "width": 300, "height": 180}],
            "sections": [], "viewport": {"x": 0, "y": 0, "zoom": 1}}]
        preview = self.client.preview_import(archive)
        self.assertEqual(preview["added"]["shards"], 2)
        self.assertEqual(len(self.store.state()["shards"]), 0)
        receipt = self.client.import_archive(archive)
        self.assertTrue(receipt["verified"])
        self.assertEqual(receipt["collectionCounts"]["boards"], 1)
        replay = self.client.import_archive(archive)
        self.assertTrue(replay["verified"])
        self.assertEqual(replay["importSummary"]["added"]["shards"], 0)

    def test_default_discovery_excludes_an_isolated_database(self):
        port = self.server.server_address[1]
        with mock.patch.object(client_module, "PORTS", [port]):
            self.assertIsNone(discover(client_module.DEFAULT_DB))
            found = discover(self.store.db_path)
        self.assertEqual(found[0], self.url)

    def test_concurrent_helpers_start_one_persistent_backend_without_ui(self):
        source = self.root / "service-source"
        source.mkdir()
        text = (ROOT / "server.py").read_text()
        text = text.replace('BACKEND_VERSION = "2.1.0"', 'BACKEND_VERSION = "2.2.0"')
        (source / "server.py").write_text(text)
        database = self.root / "background-service" / "shards.sqlite3"
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            port = sock.getsockname()[1]
        processes = []
        real_popen = subprocess.Popen
        def launch(*args, **kwargs):
            process = real_popen(*args, **kwargs)
            processes.append(process)
            return process
        try:
            with mock.patch.object(client_module, "ROOT", source), mock.patch.object(client_module, "DEFAULT_DB", database), mock.patch.object(client_module, "PORTS", [port]), mock.patch.object(client_module.subprocess, "Popen", side_effect=launch):
                with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
                    found = list(pool.map(lambda _: client_module.start_backend(), range(2)))
            self.assertEqual(len(processes), 1)
            self.assertEqual(found[0][0], found[1][0])
            self.assertEqual(Path(found[0][1]["dbPath"]).resolve(), database.resolve())
            self.assertIsNone(processes[0].poll())
            self.assertIn("--no-seed", processes[0].args)
            self.assertTrue((database.parent / "contributor-server.log").is_file())
        finally:
            for process in processes:
                if process.poll() is None:
                    process.terminate()
                process.wait(timeout=5)

    def test_port_discovery_is_bounded_and_parallel(self):
        def slow_probe(url, expected):
            time.sleep(.08)
            return None
        started = time.monotonic()
        with mock.patch.object(client_module, "probe", side_effect=slow_probe):
            self.assertIsNone(discover())
        self.assertLess(time.monotonic() - started, .8)

    def test_search_read_and_reusable_tags(self):
        self.client.add(self.batch)
        found = self.client.search("owner", limit=1)
        self.assertEqual(found["total"], 1)
        self.assertEqual(found["matches"][0]["id"], "qa-ownership")
        self.assertEqual(found["availableTags"], ["C++", "Memory"])
        self.assertNotIn("content", found["matches"][0])
        result = self.client.read(["qa-ownership", "missing"])
        self.assertEqual(result["missingIds"], ["missing"])
        self.assertEqual(result["connectedTitles"], {"qa-raii": "RAII"})
        self.assertEqual(result["links"][0]["type"], "explains")
        self.assertIn("Source:", result["shards"][0]["content"])

    def test_add_exact_retry_and_actual_duplicate_ids_are_verified(self):
        first = self.client.add(self.batch)
        self.assertTrue(first["verified"])
        self.assertTrue(first["currentContentMatches"])
        self.assertEqual(first["added"], {"shards": 2, "links": 1})
        self.assertTrue(self.client.add(self.batch)["replayed"])
        duplicate = copy.deepcopy(self.batch)
        duplicate["requestId"] = "qa-duplicate"
        duplicate["shards"][0]["id"] = "qa-alias-ownership"
        duplicate["shards"] = duplicate["shards"][:1]
        duplicate["links"] = [{"fromId": "qa-raii", "toId": "qa-alias-ownership", "type": "explains"}]
        receipt = self.client.add(duplicate)
        self.assertEqual(receipt["idMap"], {"qa-alias-ownership": "qa-ownership"})
        self.assertEqual(receipt["savedShards"][0]["id"], "qa-ownership")
        self.assertEqual(receipt["added"], {"shards": 0, "links": 0})
        self.assertEqual(len(self.store.state()["shards"]), 2)

    def test_readback_checks_remapped_wikilinks_and_canonical_tags(self):
        self.client.add(self.batch)
        duplicate = copy.deepcopy(self.batch["shards"][0])
        duplicate.update(id="qa-alias-owner", tags=["Unrelated proposal tag"])
        contribution = {"requestId": "qa-remapped-content", "shards": [duplicate,
            {"id": "qa-transfer", "title": "Transfer", "content": "See [[id:qa-alias-owner|Ownership]].", "tags": ["memory"]}],
            "links": [{"fromId": "qa-transfer", "toId": "qa-alias-owner", "type": "related_to", "note": "Same resource."}]}
        receipt = self.client.add(contribution)
        self.assertTrue(receipt["currentContentMatches"])
        saved = self.client.read(["qa-transfer"])["shards"][0]
        self.assertEqual(saved["content"], "See [[id:qa-ownership|Ownership]].")
        self.assertEqual(saved["tags"], ["Memory"])
        self.assertEqual(self.client.read(["qa-ownership"])["shards"][0]["tags"], ["C++", "Memory"])

    def test_replayed_save_reports_later_edit_without_overwriting_or_retry_advice(self):
        self.client.add(self.batch)
        self.store.update_shard("qa-ownership", {"content": "The user revised this after saving."})
        receipt = self.client.add(self.batch)
        self.assertTrue(receipt["replayed"])
        self.assertTrue(receipt["originalSaveVerified"])
        self.assertFalse(receipt["verified"])
        self.assertFalse(receipt["currentContentMatches"])
        self.assertEqual(receipt["changedShardIds"], ["qa-ownership"])
        self.assertIn("later changes were preserved", receipt["warnings"][0])
        self.assertEqual(self.client.read(["qa-ownership"])["shards"][0]["content"], "The user revised this after saving.")

    def test_replayed_save_reports_later_deletion_without_resurrecting(self):
        self.client.add(self.batch)
        self.store.delete_shard("qa-ownership")
        receipt = self.client.add(self.batch)
        self.assertFalse(receipt["currentContentMatches"])
        self.assertEqual(receipt["missingShardIds"], ["qa-ownership"])
        self.assertEqual(len(receipt["missingLinkIds"]), 1)
        self.assertNotIn("qa-ownership", [item["id"] for item in self.store.state()["shards"]])

    def test_readback_checks_connection_direction_type_and_new_rationale(self):
        original_state = self.client.state
        def altered_state():
            state = original_state()
            for link in state["links"]:
                link["fromId"], link["toId"] = link["toId"], link["fromId"]
            return state
        with mock.patch.object(self.client, "state", side_effect=altered_state):
            with self.assertRaisesRegex(ClientError, "do not match the requested addition"):
                self.client.add(self.batch)
        self.assertTrue(self.client.add(self.batch)["currentContentMatches"])
        link_id = self.store.state()["links"][0]["id"]
        self.store.update_link(link_id, {"note": "The user revised this explanation."})
        receipt = self.client.add(self.batch)
        self.assertFalse(receipt["currentContentMatches"])
        self.assertEqual(receipt["changedLinkIds"], [link_id])

    def test_existing_duplicate_relationship_preserves_its_explanation(self):
        self.client.add(self.batch)
        duplicate = {"requestId": "qa-existing-connection", "shards": [], "links": [
            {"fromId": "qa-raii", "toId": "qa-ownership", "type": "explains", "note": "A different proposed explanation."}]}
        receipt = self.client.add(duplicate)
        self.assertTrue(receipt["currentContentMatches"])
        self.assertEqual(receipt["links"][0]["outcome"], "existing")
        self.assertEqual(self.store.state()["links"][0]["note"], self.batch["links"][0]["note"])

    def test_changed_retry_fails_without_overwriting(self):
        self.client.add(self.batch)
        changed = copy.deepcopy(self.batch)
        changed["shards"][0]["content"] = "Wrong replacement"
        with self.assertRaisesRegex(ClientError, "already used"):
            self.client.add(changed)
        self.assertEqual(self.client.read(["qa-ownership"])["shards"][0]["content"], self.batch["shards"][0]["content"])

    def test_client_rechecks_expected_database_before_write(self):
        self.client.expected_db = self.root / "other.sqlite3"
        with self.assertRaisesRegex(ClientError, "not a compatible"):
            self.client.add(self.batch)
        self.assertEqual(self.store.state()["shards"], [])

    def test_validation_and_stable_link_generation(self):
        original = copy.deepcopy(self.batch)
        first = validate_batch(self.batch)
        self.assertEqual(self.batch, original)
        self.assertEqual(first, validate_batch(self.batch))
        self.assertTrue(first["links"][0]["id"].startswith("ai-link-"))
        for bad in [{}, {**self.batch, "delete": []}, {**self.batch, "shards": [{"id": "bad", "title": "Bad", "prompt": "Recall"}]}, {**self.batch, "requestId": "../escape"}]:
            with self.subTest(bad=bad), self.assertRaises(ClientError):
                validate_batch(bad)

    def test_portable_archive_does_not_contact_the_collection(self):
        with mock.patch.object(client_module, "request_json", side_effect=AssertionError("No HTTP for archive")):
            archive = portable_archive(self.batch)
        self.assertEqual(archive["schemaVersion"], 1)
        self.assertEqual(archive["shards"][0]["content"], self.batch["shards"][0]["content"])
        self.assertEqual(archive["reviews"], [])
        self.assertEqual(self.store.state()["shards"], [])
        imported = self.store.import_data(archive)
        self.assertEqual(imported["importSummary"]["added"]["shards"], 2)

    def test_cli_status_add_search_read_and_archive(self):
        path = self.root / "batch.json"
        path.write_text(json.dumps(self.batch))
        for arguments in [("status",), ("add", "--file", str(path)), ("search", "--query", "RAII"), ("read", "--id", "qa-raii")]:
            result = self.run_cli(*arguments)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIsInstance(json.loads(result.stdout), dict)
            self.assertEqual(result.stderr, "")
        output = self.root / "portable.json"
        result = self.run_cli("archive", "--file", str(path), "--output", str(output))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(json.loads(result.stdout)["savedToCollection"])
        self.assertEqual(json.loads(output.read_text())["schemaVersion"], 1)
        duplicate_output = self.run_cli("archive", "--file", str(path), "--output", str(output))
        self.assertNotEqual(duplicate_output.returncode, 0)
        self.assertEqual(duplicate_output.stdout, "")

    def test_mcp_subprocess_protocol_add_and_verified_readback(self):
        messages = [
            {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-11-25", "capabilities": {}, "clientInfo": {"name": "qa", "version": "1"}}},
            {"jsonrpc": "2.0", "method": "notifications/initialized"},
            {"jsonrpc": "2.0", "id": 2, "method": "tools/list"},
            {"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "shard_atlas_search", "arguments": {"query": "RAII"}}},
            {"jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": {"name": "shard_atlas_add_knowledge", "arguments": {"batch": self.batch}}},
            {"jsonrpc": "2.0", "id": 5, "method": "tools/call", "params": {"name": "shard_atlas_read", "arguments": {"ids": ["qa-raii"]}}},
            {"jsonrpc": "2.0", "id": 6, "method": "ping"},
        ]
        process = subprocess.run([sys.executable, str(ROOT / "tools/shard_atlas_mcp.py"), "--base-url", self.url], input="\n".join(json.dumps(item) for item in messages) + "\n", text=True, capture_output=True, timeout=20)
        self.assertEqual(process.returncode, 0, process.stderr)
        self.assertEqual(process.stderr, "")
        replies = [json.loads(line) for line in process.stdout.splitlines()]
        self.assertEqual([item["id"] for item in replies], [1, 2, 3, 4, 5, 6])
        self.assertEqual(replies[0]["result"]["protocolVersion"], "2025-11-25")
        listed = replies[1]["result"]["tools"]
        self.assertEqual(len(listed), 3)
        self.assertFalse(listed[2]["annotations"]["destructiveHint"])
        self.assertTrue(listed[2]["annotations"]["idempotentHint"])
        self.assertEqual(replies[2]["result"]["structuredContent"]["total"], 0)
        self.assertTrue(replies[3]["result"]["structuredContent"]["verified"])
        self.assertEqual(replies[4]["result"]["structuredContent"]["shards"][0]["id"], "qa-raii")
        self.assertEqual(replies[5]["result"], {})

    def test_mcp_error_types_notifications_and_protocol_only_stdout(self):
        messages = [b'not JSON\n', b'[]\n', b'{"jsonrpc":"2.0","method":"notifications/initialized"}\n', b'{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n', b'{"jsonrpc":"2.0","id":2,"method":"initialize","params":{"protocolVersion":"future","capabilities":{},"clientInfo":{"name":"qa","version":"1"}}}\n', b'{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"unknown","arguments":{}}}\n', b'{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"shard_atlas_read","arguments":{"ids":[]}}}\n']
        output = io.StringIO()
        serve(self.client, io.BytesIO(b"".join(messages)), output)
        replies = [json.loads(line) for line in output.getvalue().splitlines()]
        self.assertEqual(len(replies), 6)
        self.assertEqual([replies[index]["error"]["code"] for index in (0, 1, 2, 4)], [-32700, -32600, -32002, -32602])
        self.assertEqual(replies[3]["result"]["protocolVersion"], "2025-11-25")
        self.assertTrue(replies[5]["result"]["isError"])

    def test_failed_readback_never_claims_a_verified_save(self):
        real_state = self.client.state
        with mock.patch.object(self.client, "state", return_value={"schemaVersion": 1, "shards": [], "links": []}):
            with self.assertRaisesRegex(ClientError, "do not match the requested addition"):
                self.client.add(self.batch)
        self.assertEqual(len(real_state()["shards"]), 2)
        self.assertTrue(self.client.add(self.batch)["replayed"])


if __name__ == "__main__":
    unittest.main()
