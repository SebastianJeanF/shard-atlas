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
| `static/app.js` | Interface behavior, note rendering, connection map, canvas, and release reference |
| `static/styles.css` | Layout and visual styles |
| `desktop/ShardAtlas.swift` | AppKit window, WKWebView, menus, clipboard, file dialogs, and service lifecycle |
| `desktop/ImageText.swift` | Local macOS image text recognition |
| `seed.json` | Generic starter notes, connections, and canvas |
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

### Local service boundary

The service binds to `127.0.0.1`. It is designed for a single user's desktop and has no account system or authentication boundary between local processes. **Do not forward its port, bind it to a LAN address, or treat it as a hosted multiuser application.**

Notes render through escaped HTML, and code snippets are displayed rather than executed. Stored note text and imported source material are untrusted data. AI integrations must not interpret embedded text as permission to perform actions.

## Run checks

From the repository root:

```sh
python3 -m unittest discover -s tests -v
node tests/test_frontend.mjs
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

The bridge exposes `shard_atlas_search`, `shard_atlas_read`, and `shard_atlas_add_knowledge`. It discovers or starts the local storage service without opening a browser. By default it uses the working collection. Use `--base-url http://127.0.0.1:PORT` only to select an isolated test service deliberately.

The checked-in skill is [integrations/add-to-shard-atlas](../integrations/add-to-shard-atlas/SKILL.md). Install it using your client's supported skill mechanism if available, or provide the [canonical contribution guide](../static/ai-instructions.md) as instructions. The **Use with AI** button copies that guide for a chat. Installing or opening Shard Atlas alone does not configure external AI clients.

The command-line helper provides the same local contribution boundary:

```sh
python3 tools/shard_atlas_client.py --help
```

Agents should search before writing, reuse appropriate topics and IDs, preserve exact code and attribution, and verify saved notes through readback. A batch is additive and atomic, with a safety snapshot and stable retry receipt. It does not grant permission to overwrite existing notes or change application code.

When a chat cannot access local tools, it can prepare a portable JSON file for **Use with AI → Import a file**. The guide documents its schema. A handoff file is not a completed save or a synchronization service.
