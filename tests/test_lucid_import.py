"""Lossless source conversion, provenance, and actual archive merge boundaries."""

import copy
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from server import AppError, Store
from tools.import_lucid import convert_document, load_source, stable_id


PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jR7sAAAAASUVORK5CYII="


def node(identifier, text=None, shape_type="Process", **properties):
    if text is not None:
        properties.setdefault("TextAreas", [{"key": "Text", "text": text}])
    return {"id": identifier, "shapeType": shape_type, "properties": properties}


def edge(identifier, origin, target, **extra):
    return {"id": identifier, "sourceId": origin, "targetId": target, **extra}


def _raw_text(shape):
    return shape["properties"]["TextAreas"][0]["text"]


def source(nodes, edges=(), *, standalone=()):
    return {"documentId": "test-document", "fetchedAt": "2026-10-14", "regions": [{"pages": [
        {"pageId": "0_0", "pageTitle": "Example page", "requestedChunks": [{"data": {
            "flowcharts": [{"diagramGroupId": "group_1", "nodes": nodes, "edges": list(edges)}],
            "standaloneClusters": list(standalone), "containers": {"itemIds": [], "diagramGroupIds": []}}}]}]}]}


class LucidImportTests(unittest.TestCase):
    def by_source(self, archive, report, identifier):
        shard_id = next(item["shardId"] for item in report["mapping"] if item["sourceId"] == identifier)
        return next(shard for shard in archive["shards"] if shard["id"] == shard_id)

    def test_code_preserves_newlines_tabs_literal_escapes_and_unicode(self):
        code = '#include <iostream>\n\nint main() {\n\tstd::cout << "abc\\ndef" << \'\\n\';\n\t// π remains unchanged\n}\n'
        item = node("~invalid/source/id", code, "Code block", BlockClass="CodeBlock")
        item["label"] = code + "; Add code; 1 2 3 4 5"
        item["properties"]["TextAreas"] += [{"key": "Placeholder", "text": "Add code"},
                                                 {"key": "LineNumbers", "text": "1\n2\n3\n4\n5"}]
        archive, report = convert_document(source([item]))
        shard = archive["shards"][0]
        self.assertIn("```cpp\n" + code + "```", shard["content"])
        self.assertNotIn("Add code", shard["content"])
        self.assertNotIn("1\n2\n3\n4\n5", shard["content"])
        self.assertRegex(shard["id"], r"^lucid-shard-[a-f0-9]{32}$")
        self.assertEqual([field["text"] for field in report["textFields"]], [code])

    def test_nested_clusters_tables_links_and_decorative_geometry_are_accounted(self):
        table = node("table", shape_type="Table", TextAreas=[
            {"key": "Cell_0,0", "text": "Primary"}, {"key": "Cell_0,1", "text": "Alternative"},
            {"key": "Cell_1,0", "text": "|"}, {"key": "Cell_1,1", "text": "bitor"},
            {"key": "Cell_2,0", "text": "multi\nline"}, {"key": "Cell_2,1", "text": "??/"}])
        cluster = {"cluster": [table, node("link", "Reference", "Embedded Link Block",
                                             Link="[https://example.test/reference?x=1&y=2]") ]}
        drawing = node("underline", shape_type="Freehand Drawing")
        archive, report = convert_document(source([drawing, node("empty", shape_type="Rectangle")], standalone=[cluster]))
        self.assertEqual(report["sourceShapeCount"], 4)
        self.assertEqual(len(archive["shards"]), 2)
        self.assertEqual({item["sourceId"] for item in report["skipped"]}, {"underline", "empty"})
        content = self.by_source(archive, report, "table")["content"]
        self.assertTrue(content.startswith("```text\nPrimary"))
        for value in ("Alternative", "bitor", "multi", "line", "??/"):
            self.assertIn(value, content)
        self.assertIn("https://example.test/reference?x=1&y=2", self.by_source(archive, report, "link")["content"])
        self.assertEqual([field["text"] for field in report["textFields"] if field["sourceId"] == "table"],
                         [cell["text"] for cell in table["properties"]["TextAreas"]])

    def test_images_are_offline_deduplicated_and_named_from_actual_neighbors(self):
        document = source([node("heading", "Initialization"), node("image-one", shape_type="User Image"),
                           node("image-two", shape_type="User Image")],
                          [edge("arrow", "heading", "image-one")])
        archive, report = convert_document(document, {identifier: {"mimeType": "image/png", "data": PNG}
                                                     for identifier in ("image-one", "image-two")})
        self.assertEqual(len(archive["assets"]), 1)
        self.assertEqual(report["missingImages"], [])
        self.assertEqual(self.by_source(archive, report, "image-one")["title"], "Initialization · image")
        for identifier in ("image-one", "image-two"):
            self.assertIn("/assets/" + archive["assets"][0]["id"], self.by_source(archive, report, identifier)["content"])
        _, missing = convert_document(document)
        self.assertEqual({item["sourceId"] for item in missing["missingImages"]}, {"image-one", "image-two"})
        with self.assertRaises(AppError):
            convert_document(document, {"image-one": {"mimeType": "image/png", "data": "aGVsbG8="}})

    def test_connections_keep_direction_labels_styles_and_every_source_edge(self):
        document = source([node("a", "Namespaces"), node("b", "Types"), node("empty", shape_type="Rectangle")], [
            edge("first", "a", "b", label="source label", properties={"Endpoint1": "style: None, x: 1", "Endpoint2": "style: Arrow, x: 2"}),
            edge("second", "a", "b", label="second source label"), edge("decorative", "a", "empty")])
        archive, report = convert_document(document)
        self.assertEqual(len(archive["links"]), 1)
        link = archive["links"][0]
        self.assertEqual(link["type"], "related_to")
        self.assertEqual(link["fromId"], self.by_source(archive, report, "a")["id"])
        self.assertEqual(link["toId"], self.by_source(archive, report, "b")["id"])
        for fragment in ("first", "second", "source label", "Endpoint2: Arrow"):
            self.assertIn(fragment, link["note"])
        self.assertEqual(report["edgeMapping"][0]["sourceIds"], ["first", "second"])
        self.assertEqual(report["skippedEdges"][0]["sourceId"], "decorative")
        self.assertIn("[[id:" + link["toId"], self.by_source(archive, report, "a")["content"])

    def test_release_context_requires_explicit_labels_or_unambiguous_source_hierarchy(self):
        nodes = [node("r17", "C++17"), node("r20", "C++20"), node("feature", "Attributes"),
                 node("child", "[[nodiscard]]"), node("ambiguous", "Common feature"),
                 node("conflict", "This differs since C++23."), node("mention", "A general discussion of C++17 and C++20."),
                 node("label", "std::string_view\nC++ 17"), node("since", "List-initialization (since C++11)")]
        edges = [edge("one", "r17", "feature"), edge("two", "feature", "child"),
                 edge("three", "r17", "ambiguous"), edge("four", "r20", "ambiguous"), edge("five", "r17", "conflict")]
        archive, report = convert_document(source(nodes, edges))
        self.assertEqual(self.by_source(archive, report, "child")["languageVersion"], "C++17")
        for identifier in ("ambiguous", "conflict", "mention"):
            self.assertEqual(self.by_source(archive, report, identifier)["languageVersion"], "")
        self.assertEqual(self.by_source(archive, report, "label")["languageVersion"], "C++17")
        self.assertEqual(self.by_source(archive, report, "since")["languageVersion"], "C++11")
        context = next(item["releaseContext"] for item in report["mapping"] if item["sourceId"] == "child")
        self.assertEqual(context["path"], ["r17", "feature", "child"])
        self.assertIn("Diagram release context: C++17 → Attributes", self.by_source(archive, report, "child")["content"])

    def test_cpp_attributes_remain_literal_and_monospace_source_gets_cpp_fence(self):
        document = source([node("attribute", "The [[nodiscard]] attribute; `[[maybe_unused]]` also exists."),
                           node("mono", "template<class T>\nusing Item = T;", "Rectangle",
                                TextAreas=[{"key": "Text", "text": "template<class T>\nusing Item = T;", "fontFamily": "DejaVu Sans Mono"}])])
        archive, report = convert_document(document)
        text = self.by_source(archive, report, "attribute")["content"]
        self.assertIn("`[[nodiscard]]`", text)
        self.assertIn("`[[maybe_unused]]`", text)
        self.assertNotIn("``[[maybe_unused]]``", text)
        self.assertIn("```cpp\ntemplate<class T>\nusing Item = T;\n```", self.by_source(archive, report, "mono")["content"])

    def test_repeated_fetch_records_do_not_duplicate_and_conflicting_copies_fail(self):
        document = source([node("same", "Notes")])
        document["regions"].append(copy.deepcopy(document["regions"][0]))
        archive, report = convert_document(document)
        self.assertEqual(len(archive["shards"]), 1)
        self.assertEqual(len(report["duplicateFetchRecords"]), 1)
        document["regions"][1]["pages"][0]["requestedChunks"][0]["data"]["flowcharts"][0]["nodes"][0]["label"] = "Conflicting"
        with self.assertRaisesRegex(ValueError, "Conflicting duplicate"):
            convert_document(document)

    def test_archive_is_stable_valid_and_reimport_preserves_user_edits(self):
        document = source([node("a/~", "Namespaces"), node("b", "Types")], [edge("e/~", "a/~", "b")])
        archive, _ = convert_document(document)
        self.assertEqual(archive, convert_document(copy.deepcopy(document))[0])
        self.assertNotEqual(stable_id("shard", "doc-one", "0_0", "same"), stable_id("shard", "doc-two", "0_0", "same"))
        with tempfile.TemporaryDirectory() as temporary:
            store = Store(Path(temporary) / "notes.sqlite3", seed=False, backup_on_start=False, automatic_backups=False)
            user = store.create_shard({"title": "Existing personal note"})["shards"][0]
            first = store.import_data(archive)
            self.assertEqual(first["importSummary"]["added"]["shards"], 2)
            imported = archive["shards"][0]
            store.update_shard(imported["id"], {"content": "My later improvement"})
            second = store.import_data(archive)
            self.assertFalse(any(second["importSummary"]["added"].values()))
            self.assertEqual(len(second["shards"]), 3)
            self.assertEqual(next(shard["content"] for shard in second["shards"] if shard["id"] == imported["id"]), "My later improvement")
            self.assertIn(user["id"], {shard["id"] for shard in second["shards"]})

    def test_cli_validates_and_writes_private_outputs(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            fetched, output, report = (root / name for name in ("source.json", "archive.json", "report.json"))
            fetched.write_text(json.dumps(source([node("n", "Namespaces")])) , encoding="utf-8")
            result = subprocess.run([sys.executable, str(Path(__file__).resolve().parents[1] / "tools/import_lucid.py"),
                                     str(fetched), "--output", str(output), "--report", str(report)],
                                    text=True, capture_output=True, check=True)
            self.assertEqual(json.loads(result.stdout)["importedShapeCount"], 1)
            self.assertEqual(json.loads(output.read_text())["schemaVersion"], 1)
            self.assertEqual(json.loads(report.read_text())["sourceShapeCount"], 1)

    def test_general_import_preserves_authored_placeholder_fields_and_source_scope(self):
        item = node("careers", shape_type="Text", TextAreas=[
            {"key": "Text", "text": "OpenAI research careers"},
            {"key": "Placeholder", "text": "My placeholder for a future career decision"},
            {"key": "LineNumbers", "text": "Line numbers describe the source, not editor chrome"}])
        archive, report = convert_document(source([item]), domain="career-ai")
        shard = archive["shards"][0]
        self.assertNotIn("C++", shard["tags"])
        self.assertEqual(shard["languageVersion"], "")
        self.assertIn("My placeholder for a future career decision", shard["content"])
        self.assertIn("Line numbers describe the source", shard["content"])
        self.assertIn("AI", shard["tags"])
        self.assertIn("Career", shard["tags"])
        self.assertEqual(shard["entities"], ["OpenAI"])
        self.assertEqual(shard["evidenceStatus"], "unverified")
        self.assertEqual(shard["status"], "learning")
        self.assertTrue(report["noLostSubstantiveText"])
        self.assertEqual(report["meaningfulShapeCount"], 1)

    def test_saved_board_retains_relative_geometry_headings_and_decorative_markers(self):
        heading = node("heading", "AI Career", BoundingBox="x: -500, y: -200, w: 1200, h: 120")
        card = node("card", "Research engineering", BoundingBox="x: -250, y: 80, w: 260, h: 180", FillColor="#123456ff")
        marker = node("marker", shape_type="Star", BoundingBox="x: 200, y: 120, w: 160, h: 160")
        archive, report = convert_document(source([heading, card, marker], [edge("arrow", "heading", "card")]),
                                            domain="career-ai", title="Career/AI")
        self.assertEqual(len(archive["shards"]), 2)
        board = archive["boards"][0]
        self.assertEqual(board["title"], "Career/AI")
        self.assertEqual(len(board["sections"]), 2)
        self.assertEqual(len(board["items"]), 1)
        board_note_ids = ({item["shardId"] for item in board["items"]}
                          | {section["shardId"] for section in board["sections"] if section["shardId"]})
        self.assertEqual(board_note_ids, {shard["id"] for shard in archive["shards"]})
        self.assertTrue(all(link[endpoint] in board_note_ids for link in archive["links"] for endpoint in ("fromId", "toId")))
        self.assertEqual({section["shardId"] for section in board["sections"]}, {"", self.by_source(archive, report, "heading")["id"]})
        item = board["items"][0]
        self.assertEqual((item["x"], item["y"], item["width"], item["height"]), (330, 360, 260, 180))
        self.assertIn(item["sectionId"], {section["id"] for section in board["sections"]})
        self.assertIn('"FillColor": "#123456ff"', self.by_source(archive, report, "card")["content"])
        self.assertEqual(report["sourceRecords"][0]["shape"], heading)
        self.assertEqual(report["transferredSourceEdgeCount"], 1)
        self.assertEqual(report["sourceEdgeRecords"][0]["edge"]["sourceId"], "heading")
        self.assertEqual(report["coverage"]["meaningfulShapes"], {"source": 2, "transferred": 2})
        with tempfile.TemporaryDirectory() as temporary:
            store = Store(Path(temporary) / "board.sqlite3", seed=False, backup_on_start=False, automatic_backups=False)
            first = store.import_data(archive)
            self.assertEqual(first["boards"][0]["items"][0]["width"], 260)
            self.assertEqual(first["boards"][0]["sections"][0]["shardId"], self.by_source(archive, report, "heading")["id"])
            self.assertFalse(any(store.import_data(archive)["importSummary"]["added"].values()))

    def test_timeline_dates_retain_precision_and_separate_rumors_from_verification(self):
        heading = node("month", "September 2026", BoundingBox="x: 0, y: 0, w: 1200, h: 120")
        day = node("day", "September 14th, Monday", "Text", BoundingBox="x: 400, y: 300, w: 280, h: 40")
        rumor = node("rumor", "Rumor: OpenAI may release a new model\n10:59 PM · Sep 13, 2026", BoundingBox="x: 300, y: 500, w: 280, h: 180", Link="[https://example.test/post]")
        forecast = node("forecast", "A 70% chance of misaligned AI takeover", BoundingBox="x: 700, y: 500, w: 280, h: 180")
        date = node("explicit", "May 20th, 2026", BoundingBox="x: 8000, y: 0, w: 160, h: 80")
        adjacent = node("adjacent", "Unrelated adjacent research card", BoundingBox="x: 8000, y: 100, w: 200, h: 180")
        prose = node("prose", "A research note discusses May 20, 2026 and 2027", BoundingBox="x: -8000, y: 0, w: 200, h: 180")
        archive, report = convert_document(source([heading, day, rumor, forecast, date, adjacent, prose]), domain="career-ai")
        self.assertEqual(self.by_source(archive, report, "month")["eventDate"], "2026-09")
        self.assertEqual(self.by_source(archive, report, "day")["eventDate"], "2026-09-14")
        note = self.by_source(archive, report, "rumor")
        self.assertEqual(note["eventDate"], "2026-09-14")
        self.assertEqual(note["eventType"], "rumor")
        self.assertEqual(note["evidenceStatus"], "unverified")
        self.assertEqual(note["publicationDate"], "2026-09-13")
        self.assertEqual(note["sources"][0]["publishedDate"], "2026-09-13")
        self.assertEqual(note["sources"][-1]["publishedDate"], "")
        self.assertEqual(self.by_source(archive, report, "forecast")["eventType"], "forecast")
        self.assertEqual(note["verifiedDate"], "")
        self.assertIn("year inherited", note["content"])
        self.assertEqual(self.by_source(archive, report, "explicit")["eventDate"], "2026-05-20")
        self.assertEqual(self.by_source(archive, report, "adjacent")["eventDate"], "")
        self.assertEqual(self.by_source(archive, report, "prose")["eventDate"], "")
        self.assertEqual(report["untransferredSubstantiveText"], [])

    def test_prose_transport_decoding_preserves_raw_source_and_code_escapes(self):
        prose = node("prose", r"Sam\u2019s note\nNext paragraph", "Text")
        code = node("code", r'print("literal\u2019\n")', "Code block", BlockClass="CodeBlock")
        archive, report = convert_document(source([prose, code]), domain="general")
        content = self.by_source(archive, report, "prose")["content"]
        self.assertTrue(content.startswith("Sam’s note\nNext paragraph"))
        self.assertIn(r"Sam\\u2019s note\\nNext paragraph", content)
        self.assertTrue(self.by_source(archive, report, "code")["content"].startswith('```text\n' + _raw_text(code)))
        self.assertEqual(report["displayTransformations"][0]["originalText"], r"Sam\u2019s note\nNext paragraph")
        self.assertEqual([field["text"] for field in report["textFields"]], [r"Sam\u2019s note\nNext paragraph", _raw_text(code)])

    def test_directory_source_loads_all_tool_regions_and_rejects_mixed_documents(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for index in range(1, 4):
                region = source([node(f"shape-{index}", f"Career note {index}")])["regions"][0]
                (root / f"region-{index:02}.json").write_text(json.dumps({"document_id": "career-document", "title": "Career/AI", "text": json.dumps(region)}))
            fetched = load_source(root, fetched_at="2026-10-14")
            archive, report = convert_document(fetched)
            self.assertEqual(len(archive["shards"]), 3)
            self.assertEqual(report["domain"], "career-ai")
            self.assertNotIn("C++", {tag for shard in archive["shards"] for tag in shard["tags"]})
            wrong = root / "region-04.json"
            wrong.write_text(json.dumps({"document_id": "different-document", "text": json.dumps(region)}))
            with self.assertRaisesRegex(ValueError, "consistent Lucid document ID"):
                load_source(root, fetched_at="2026-10-14")

    def test_coverage_distinguishes_lossless_fetched_text_from_an_incomplete_document(self):
        document = source([node("n", "Fetched content")])
        page = document["regions"][0]["pages"][0]
        page["totalChunks"] = 3
        page["requestedChunks"][0]["chunkIndex"] = 1
        _, report = convert_document(document)
        self.assertTrue(report["noLostSubstantiveText"])
        self.assertFalse(report["completeSourceCoverage"])
        self.assertEqual(report["regionCoverage"][0]["missingChunks"], [0, 2])
        self.assertIn("missing source chunks", " ".join(report["warnings"]))


if __name__ == "__main__":
    unittest.main()
