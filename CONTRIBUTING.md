# Contributing to Shard Atlas

Shard Atlas helps people understand and connect technical ideas. Contributions should preserve a reliable local collection and a clear, comfortable interface.

## Before changing code

Read [development](docs/development.md) for setup, architecture, and tests, then read [AGENTS.md](AGENTS.md) for repository guidance. Describe the problem and the behavior you want to change in an issue or pull request. For a substantial design change, discuss the approach before building it.

Use a separate database for development. Keep personal notes, exports, retrieved private sources, snapshots, and diagnostics out of commits. Use the included sample collection for screenshots and demonstrations.

## Make a focused change

Preserve stable note IDs, relationship direction, portable archives, revisions, Trash, images, and drafts. Keep starter content separate from personal data, and do not reseed a collection that someone emptied. Persistence changes need meaningful recovery and compatibility coverage.

The Python service uses the standard library. Avoid adding dependencies without a concrete reason. Keep offline rendering available. Preserve the native window, file dialogs, clipboard, downloads, menu commands, and checks for unsaved edits.

Use clear labels and explain technical choices only when they help the person using the app. Technical notes, connections, the canvas, and the C++ release reference are the current focus. Do not reintroduce retired news, company, comparison, or recall interfaces through an unrelated change.

## Verify and submit

Run the checks in [development](docs/development.md#run-checks) appropriate to your changes. Test the affected interface with sample data. Rebuild the desktop app when changing bundled assets or native integration, and use an isolated QA database.

A pull request should explain:

- The concrete problem and resulting behavior.
- Any data migration or compatibility implications.
- How you verified the change, with sample-data screenshots for visible changes.
- Any material limitation or follow-up work.

Do not include personal collection content or private access details in an issue, screenshot, test fixture, or pull request. If you discover an issue involving sensitive data, contact the maintainer privately before posting the details.

## Add knowledge to your own atlas

Saving a personal note is different from contributing application code. Use the app, its [AI contribution guide](static/ai-instructions.md), or its import tools. Do not add personal knowledge by editing `seed.json` or a source file. Starter examples and the public release catalog are shared reference material, so changes to them should be suitable for every fresh installation.
