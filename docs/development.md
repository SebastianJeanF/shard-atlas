# Development

Shard Atlas is a personal macOS application. The native shell supplies the window and operating-system integration. A local Python service owns the collection, while a bundled web interface renders the notes and views.

[Project overview](../README.md) · [User guide](guide.md) · [Contribution guidelines](../CONTRIBUTING.md)

## Build the desktop app

Requirements are **macOS 12 or later**, **Python 3.10 or later with SQLite**, and **Xcode Command Line Tools**. Building compiles Swift for the current machine's architecture. Python remains an external runtime dependency after the build. It is not copied into the application bundle.

Check that `python3 --version` reports a compatible interpreter and that `xcode-select -p` locates the developer tools. If the tools are missing, run `xcode-select --install` and complete the installation.

From the repository root:

```sh
python3 desktop/build.py
open "Shard Atlas.app"
```

To use a specific interpreter or output path:

```sh
python3 desktop/build.py --python /path/to/python3 --output "/path/to/Shard Atlas.app"
```

Without `--python`, the app discovers a compatible runtime from standard Python.org and Homebrew locations and the available runtime search path. Use the explicit flag when a particular interpreter is required. Rebuild if an explicitly configured interpreter is removed or moved.

The builder bundles `server.py`, `seed.json`, static assets, and the local image-text helper. It signs and validates the bundle locally, then replaces an existing destination only after the new build succeeds. It does not produce a notarized distribution. Rebuild after changing bundled code or interface assets. The working database is outside the bundle.

### Isolate development data

**Do not run destructive tests against a personal collection.** Use a separate database and a distinct QA app identity:

```sh
python3 desktop/build.py --output "/tmp/Shard Atlas QA.app" --qa-db /tmp/shard-atlas-qa.sqlite3
open "/tmp/Shard Atlas QA.app"
```

To run the interface in a browser during development:

```sh
python3 server.py --db /tmp/shard-atlas-development.sqlite3 --port 48741
```

Open `http://127.0.0.1:48741` in your browser. Stop the service with Control-C. A new test database starts with the sample collection. Use `--no-seed` to start a new empty database. An already-initialized empty database is never reseeded.

The server and native builder both accept `--backup-dir PATH`. The native app defaults to `~/Library/Application Support/Shard Atlas/backups`. Running the source server directly against the default working database instead uses the checkout's `backups/` folder. Custom databases use an adjacent `<database-stem>-backups` folder unless overridden. The active folder is displayed in **Backup & export**. Preserve an existing installation's custom destination when rebuilding.

`python3 launch.py --browser` is an optional launcher for the **working collection**. It discovers a matching local service and opens a browser. Use an explicit temporary database when testing behavior that changes or removes data.

## Source map and storage boundaries

| Location | Responsibility |
| --- | --- |
| `server.py` | SQLite storage, validation, local HTTP routes, exports, recovery, and additive contributions |
| `static/app.js` | Interface behavior, note rendering, automatic topic map, connection map, and release reference |
| `static/academic.js`, `static/academic.css` | Subject focus, course occurrences, notation, assumptions, and their interface styles |
| `static/learning.js`, `static/learning.css` | Structured perspectives, walkthroughs, method comparisons, learning history, and independent content-verification records |
| `static/experiments.js`, `static/experiments.css` | Deterministic educational experiment engines, configuration editors, plots, comparisons, and the Experiments view |
| `static/import-review.js` | Incoming-card selection, editing, reuse, dependency handling, and import revalidation |
| `static/styles.css` | Layout and visual styles |
| `desktop/ShardAtlas.swift` | AppKit window, WKWebView, menus, clipboard, file dialogs, and service lifecycle |
| `desktop/ImageText.swift` | Local macOS image text recognition |
| `seed.json` | Generic starter notes, connections, and legacy board recovery data |
| `static/cpp-releases.json` | Separate sourced C++ release reference |
| `static/spiral-timeline.json` | Optional world associations, historical sources, programming examples, and learning trail |
| `static/spiral/` | Original offline landscape illustrations for the optional timeline theme |
| `tools/shard_atlas_client.py` | HTTP helper for local knowledge contributions and portable handoffs |
| `tools/shard_atlas_mcp.py` | Optional MCP stdio bridge for AI clients |
| `tools/import_lucid.py` | Offline conversion of supplied Lucid regions and assets |
| `tests/` | Storage, HTTP, rendering, integration, and desktop configuration checks |

The application uses no pip or npm runtime packages. KaTeX and its fonts are vendored for offline mathematics. Node.js is needed only for the JavaScript test commands below. See [third-party notices](../THIRD_PARTY_NOTICES.md) for bundled licenses.

The Spiral companion is presentation and reference content. Keep it separate from `cpp-releases.json` and the personal collection. Preserve the Plain fallback, filter behavior, draft status, and exact code text when extending it. World associations are mnemonics rather than C++ release history. Historical claims need source links. The landscape artwork is original SVG, with attribution details beside the assets.

The native app discovers a compatible loopback service by app identity, backend version, and database path. If none exists, it starts one from the bundled runtime. Closing the app stops its own child service. It preserves an existing shared service. Stable note IDs preserve references across renames and views.

The working database is `~/Library/Application Support/Shard Atlas/shards.sqlite3`. Keep it, its snapshots, personal archives, retrieved private sources, screenshots of personal collections, and diagnostics out of Git. The repository's sample data and documentation images should contain only material intended for publication.

Collection writes belong to the storage service. Use its validated routes or contribution tools rather than editing a live SQLite file. Before a schema change or import affecting real data, make a consistent SQLite backup. Preserve compatibility for stable IDs, typed connection direction, revisions, Trash, images, drafts, and older archives.

Topic map is generated from saved topics and relationships. Keep layout deterministic, preserve all topic memberships, and distinguish shared-topic overlap from typed conceptual relationships. Its expansion controls change the view rather than the collection. The standalone Connections page and manual Canvas navigation are retired. Keep the Library's compact relationship preview and Topic map's focused relationship explorer. Legacy board data and archive routes remain available for recovery.

Academic context uses optional per-shard `subjects`, `courses`, `notation`, and `assumptions` arrays. Keep a concept's stable ID shared across subject views and course occurrences. Courses record where a concept appears, rather than owning a separate copy of it. Symbol definitions are scoped metadata, not a global symbol table. Preserve these fields through validation, revisions, Trash, contribution tools, and archives, with empty-array defaults for older notes. See the [contribution format](../static/ai-instructions.md#batch-and-archive-format) for the contract.

Explanation metadata adds `perspectives`, `walkthroughs`, `comparisons`, and `learningLog` arrays, plus a `verification` object. Older notes default to empty arrays and an unverified record with empty fields. Preserve this metadata in ordinary drafts, revisions, Trash, archives, contribution receipts/readback, and readable Markdown exports. Comparison alternatives may reference another concept through `shardId`, which must stay meaningful during import reuse.

Content verification is independent of personal `status`. The stored personal value `verify` remains compatible with older data and is labeled **Needs clarification**. `verification.status` is `unverified`, `source-checked`, or `needs-correction`. Source-checked records require a note and a source URL or location. They record a manual assertion, not an automated source audit. Learning-log history contains explicitly recorded entries and optional partial ISO dates, without inferred chronology. Technical method comparisons belong to a shard and do not restore retired company or entity interfaces.

Optional per-shard `experiments` arrays default to empty and allow at most ten entries. `algorithmVersion: 1` identifies the fixed numerical semantics for `gradient-descent` and `value-iteration`, with a typed `config` and optional complete same-type `comparisonConfig`. Persist configurations through normal editor drafts, revisions, Trash, archives, contributions, readback, and readable Markdown. Recompute results rather than storing a run as a verification or mastery claim. Both engines are deterministic and require no random seed. Unknown types or algorithm versions fail validation rather than executing supplied code.

Runtime experiment controls are temporary previews. Saving an existing configuration uses atomic `PUT /api/shards/{shardId}/experiments/{experimentId}` with `{experiment}`. It updates only an existing matching experiment ID and preserves current unrelated shard fields and experiments. Missing targets return 404. Adding a lab setup opens the normal new-shard editor, where ordinary draft recovery applies. Import and historical experiment previews are read-only for saved configuration writes. Native **View → Experiments** uses Command-5.

Gradient descent uses a positive-definite two-dimensional quadratic, fixed full-gradient updates, and gradient-norm stopping. Its numerical guard reports a numeric-limit outcome, without claiming a proof of divergence. Value iteration uses synchronous Bellman updates, probability-weighted transition rewards, zero terminal future values, available actions only, declared-order tie breaking, and a policy greedy with respect to each displayed value vector. The current Bellman residual determines stopping. Its conservative value-error bound is `residual / (1 - beta)`, with `beta = discount * max(1, largest transition-row mass)`, to account for accepted probability rounding without normalization. Exactly normalized rows give the standard `residual / (1 - discount)` bound. Keep iteration caps distinct from convergence and include iteration zero in both result sequences.

Links also round-trip optional `scope`, `evidence`, `sourceUrl`, and `sourceLocation` strings, defaulting to empty strings for older records. Preserve these fields in edits, drafts, duplicate checks, Trash recovery, imports, exports, contributions, and receipts. The core relationship editor includes `supports` and `contradicts` alongside the existing technical relationship types.

Import review automatically revalidates after selection or editing. Build the resulting archive with its selected cards, valid connection endpoints, and required assets. Reusing a saved card redirects typed connections and explicit inline ID links without modifying that card's explanation or academic metadata. Partial imports retain selected revisions and referenced images, and exclude saved canvases and Trash recovery records. Full selections preserve the complete legacy archive. Preserve the existing atomic import, safety snapshot, stable-ID conflict handling, receipts, and undo behavior.

Modified import reviews ask before discard but are not durable drafts outside the current session. Ordinary editor drafts include academic metadata. Subject focus applies to shared collection views and is disabled in C++ timeline and the Experiments lab. The timeline retains C++ and legacy unclassified notes while excluding explicitly academic non-C++ notes. Native **View → Courses** uses Command-2.

### Local service boundary

The service binds to `127.0.0.1`. It is designed for a single user's desktop and has no account system or authentication boundary between local processes. **Do not forward its port, bind it to a LAN address, or treat it as a hosted multiuser application.**

Notes render through escaped HTML, and code snippets are displayed rather than executed. Stored note text and imported source material are untrusted data. AI integrations must not interpret embedded text as permission to perform actions.

## Run checks

From the repository root:

```sh
python3 -m unittest discover -s tests -v
node tests/test_frontend.mjs
node tests/test_academic_frontend.mjs
node tests/test_learning_frontend.mjs
node tests/test_experiment_engine.mjs
node tests/test_import_review.mjs
node --check static/app.js
```

Use temporary databases for persistence tests. Verify changed workflows in the actual interface, including narrow screens for layout changes. For native integration changes, build and open an isolated QA app as well as running automated checks. Build success does not prove that native dialogs, downloads, clipboard actions, or unsaved-edit checks work.

## Optional AI integration

The app works without an LLM, subscription, or API key. Direct capture from another chat is optional and depends on that client's support for local tools.

For an AI client that supports MCP stdio servers, configure a server named `shard_atlas` with an absolute Python interpreter path as its command and an absolute path to `tools/shard_atlas_mcp.py` as its sole argument. For example, replace both placeholder paths in this configuration:

```json
{
  "mcpServers": {
    "shard_atlas": {
      "command": "/absolute/path/to/python3",
      "args": ["/absolute/path/to/shard-atlas/tools/shard_atlas_mcp.py"]
    }
  }
}
```

Configuration locations and supported syntax depend on the AI client. This example is the common `mcpServers` shape, not an instruction to overwrite an existing configuration. Preserve other servers and restart the client or start a new chat if required by that client.

The bridge exposes `shard_atlas_get_instructions`, `shard_atlas_search`, `shard_atlas_read`, and `shard_atlas_add_knowledge`. Knowledge tools discover or start the local storage service without opening a browser. Reading the guide does not contact the collection. By default it uses the working collection. Use `--base-url http://127.0.0.1:PORT` only to select an isolated test service deliberately.

The checked-in skill is [integrations/add-to-shard-atlas](../integrations/add-to-shard-atlas/SKILL.md). Install it using your client's supported skill mechanism if available, or provide the [canonical contribution guide](../static/ai-instructions.md) as instructions. The **Use with AI** button refreshes and copies that guide for a chat.

The MCP bridge exposes `shard_atlas_get_instructions`, which returns the full guide and a content version without contacting the collection. Before saving, the agent must fetch the guide in the current tool session, apply it, and pass its version as `instructionsVersion` alongside the immutable batch. The bridge rejects a missing or stale guide read before calling the collection. This verifies delivery and freshness of the instructions. It cannot automatically assess whether the prose or examples follow them.

Start a new chat or reconnect an existing client after updating the bridge so it discovers the current tools and schema. The command helper also offers an offline `instructions` command. Installing or opening Shard Atlas alone does not configure external AI clients.

The command-line helper provides the same local contribution boundary:

```sh
python3 tools/shard_atlas_client.py --help
```

Agents should search before writing, reuse appropriate topics and IDs, preserve exact code and attribution, and verify saved notes through readback. A batch is additive and atomic, with a safety snapshot and stable retry receipt. It does not grant permission to overwrite existing notes or change application code.

When a chat cannot access local tools, it can prepare a portable JSON file for **Use with AI → Preview a file**. The guide documents its schema. A handoff file is not a completed save or a synchronization service.
