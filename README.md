# Shard Atlas

**A local workspace for technical ideas and the connections between them.**

Write an explanation, keep its examples and sources beside it, and connect it to what you already know. Shard Atlas brings notes, course context, an automatic topic map, and a C++ release timeline into a macOS app that works offline.

[User guide](docs/guide.md) · [Roadmap](docs/roadmap.md) · [Development](docs/development.md) · [Contributing](CONTRIBUTING.md)

![A short tour of Shard Atlas using the included sample collection](docs/images/demo.gif)

## From a note to a connected explanation

- **Keep the details.** Notes support Markdown, highlighted C++ code, mathematics, images, source references, and links to other notes.
- **Explain the relationship.** Connect ideas with labels such as *depends on*, *contrasts with*, and *is an example of*, with a reason for each connection.
- **See how topics fit together.** Explore automatic neighborhoods, find shards shared by several topics, and expand saved relationships without arranging cards or drawing lines.
- **Follow an idea across subjects and courses.** Use Generic, C++, Computer science, Mathematics, or Machine learning views of the same collection. Keep a concept's course and lecture occurrences, source locations, notation, and assumptions beside its explanation.
- **Keep your bearings.** Search notes or find topics by typing, then filter by topic, kind, or understanding. Topics grow freely with your notes. Explore the separate, sourced C++ release reference from C++98 through the C++26 working draft.
- **Give each release a familiar place.** An optional Wizard101 inspired timeline pairs C++ releases with illustrated worlds, distinct emblems, coordinated column colors, source-linked context, and small programming examples. Grouped releases show every mapped world. Switch to Plain for the original timeline presentation. The public source includes original artwork, with support for a separate local game-icon pack.

![The Library view with a sample C++ explanation and its connected notes](docs/images/library.png)

Topic map uses every topic assigned to a shard, so an idea can bridge several neighborhoods. Shared topics and saved conceptual relationships have distinct visual styles. Broad organizational tags are hidden by default and can be shown when useful. Layout is generated consistently from your collection and filters. Legacy saved canvases remain in archives and backups for recovery.

The included collection has **12 C++ notes and 18 connections**. It is a starting point to explore and replace with your own explanations. Shard Atlas also fits computer science, mathematics, and ML or AI theory.

## Build and open

The desktop app requires **macOS 12 or later**, **Python 3.10 or later**, and **Xcode Command Line Tools** to build. The app uses Python already installed on your machine. It does not bundle a Python interpreter. There are no pip or npm packages to install for the application.

```sh
git clone https://github.com/SebastianJeanF/shard-atlas.git
cd shard-atlas
python3 desktop/build.py
open "Shard Atlas.app"
```

If needed, install Xcode Command Line Tools with `xcode-select --install` and install a compatible Python interpreter before building. See [setup and troubleshooting](docs/development.md#build-the-desktop-app) for interpreter selection and isolated development.

This is currently a **source build**, signed locally during compilation. There is no notarized, self-contained download. The native window uses AppKit and WKWebView around a bundled local Python service.

## Your knowledge stays local

Your collection lives in SQLite under `~/Library/Application Support/Shard Atlas`, outside the source checkout. No account is required for the app, and your notes do not become part of this Git repository.

Saved revisions, Trash, automatic database snapshots, and JSON or Markdown exports provide recovery options. Backups are local files. Cloud backup requires configuring a destination that your own sync service uploads. See [storage, backups, and recovery](docs/guide.md#storage-backups-and-recovery) for locations and restore behavior.

The service listens on the local loopback interface. Shard Atlas is a personal desktop application without user authentication or a multiuser hosting mode. Do not expose its service to a network.

## Capture from an AI chat

**“Add this to Shard Atlas”** can save technical explanations and useful connections when your AI client has the optional local integration configured. The app's **Use with AI** guide explains the workflow. Without local access, a chat can prepare a portable JSON file with source references and course context. Review, select, and edit its cards in the import preview before saving.

The application does not automatically install tools into every AI service. See the [AI integration setup](docs/development.md#optional-ai-integration) and the [knowledge contribution guide](static/ai-instructions.md).

## Work on Shard Atlas

The project uses a Python standard-library storage service, plain JavaScript and CSS, and a Swift desktop wrapper. KaTeX is bundled for offline math rendering. See [development and architecture](docs/development.md) for the source map, tests, and data boundaries.

Contributions are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) before changing persistence or importing personal data.

Shard Atlas is available under the [MIT license](LICENSE). Bundled third-party components retain their [own licenses](THIRD_PARTY_NOTICES.md).
