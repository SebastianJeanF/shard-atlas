# Using Shard Atlas

Shard Atlas stores explanations and the relationships between them. A *shard* is a note about one technical idea. The Library, connection map, and canvases are different views of the same notes.

[Back to the project](../README.md) · [Build and development](development.md) · [AI contribution guide](../static/ai-instructions.md)

## Start with one idea

Create a shard with a descriptive title and an explanation in your own words. Add examples, caveats, and a source where they help you understand or verify the claim. Topics make the note easier to find. Kind distinguishes concepts, facts, examples, learning moments, and ideas.

Understanding has three states: **Learning**, **Confident**, and **Needs verification**. These describe your understanding, rather than whether an AI generated the text.

The initial collection includes 12 C++ examples, 18 connections, and a sample canvas. Edit or delete the examples as you build your own collection. Deleting all notes does not cause the app to insert the examples again.

Use the atlas for programming languages, computer science, mathematics, and ML or AI theory. Capture reusable mechanisms, definitions, code, and distinctions. News, company announcements, compensation, career tracking, and forecasts are outside its intended scope.

## Write an explanation

The editor supports Markdown headings, lists, links, and fenced code blocks. Use `$...$` for inline math and `$$...$$` for displayed math. The bundled KaTeX renderer works offline.

Add or paste an image while editing. PNG, JPEG, GIF, and WebP images up to 8 MB each are stored with the collection and included in exports and backups. Screenshot text recognition uses the local macOS helper in desktop builds.

Type `[[` to find another shard and insert an inline link. Links use stable IDs, so renaming the target does not break them. Put literal C++ attributes in inline code so they are not mistaken for note links.

**Drafts and saved notes are separate.** The app saves editor drafts locally for recovery, but a note changes only when you choose **Save**. Closing a changed form or quitting with unsaved edits asks before discarding them.

### Interface colors

Forest green marks the selected idea and primary actions. Amber marks learning or verification states. Code uses purple for keywords, teal for types, blue for functions, orange for numbers, red for literals, and green for comments. Uncertain identifiers remain neutral. The code panel includes a compact key. Highlighting is conservative and does not perform full C++ semantic analysis.

## Find and connect notes

The Library places the selected explanation beside its nearby ideas. Search covers note text, connection explanations, and connected-note titles. Combine search with kind, understanding, and topic filters. When selecting multiple topics, choose whether results must match **all** or **any** of them. Renaming a topic updates the notes that use it.

Use **Search topics** in the sidebar to find a topic by name, then select it to filter the current view. This searches topic names separately from the main note search. Selected topics stay visible while you look for others. Enter selects an exact match or the only matching topic. Escape or the clear button clears the topic search without removing your selections.

Topics are freeform and grow with your notes. Add any useful topic in a shard's comma-separated **Topics** field, including a keyword such as `consteval`. Its name appears in the sidebar after the note is saved. The topic list has no fixed vocabulary or global limit.

Choose **Connect** to describe how two notes relate. The available relationships are *depends on*, *explains*, *contrasts with*, *is an example of*, *relates to*, and *is part of*. Add a reason when it makes the relationship clearer.

Direction matters. An arrow runs from the note making the relationship to its target. For example, an example note can point to the concept it illustrates with *is an example of*. A diagram's proximity or arrow alone does not establish a prerequisite.

The connection map shows the filtered collection or a selected neighborhood. Color and group by topic or kind, use the legend to read the colors, and select a node to open its explanation.

## Arrange ideas on a canvas

**Canvas** is a spatial view of saved notes. It preserves positions and sizes, labeled sections, collapsed groups, and pan and zoom. The same note can appear on several canvases without copying its content.

Use **Add note** to place an existing explanation, **Add section** to group ideas, and **Connect** to describe a relationship. Existing connections appear between their cards. Search, jump to a section, use the minimap, or choose **Fit canvas** to find your place.

Moving a card changes the canvas arrangement. Editing its explanation changes the shared note everywhere it appears.

## Explore the C++ release reference

**C++ timeline** shows your shards alongside a bundled, sourced reference from C++98 through the **C++26 working draft**. Your shard cards appear openly at the top of each release. Use **Show** to choose **My shards & reference**, **My shards**, or **Release reference**. Jump to a release, search, and combine topics with all or any matching. Open a shard to read or edit it in Library, or open a reference entry for its explanation and sources.

The reference works offline. External source links need an internet connection when opened. Entries describe feature groups and adopted changes rather than every overload or defect report. The reference's coverage disclosure explains that boundary.

To place a personal note beside a release, assign a recognized version such as `C++17` under **Source & context → Version or scope**. Shards without a recognized version appear in the **No release assigned** column, with a jump button above the timeline. Release placement uses your assigned scope and is never guessed from the note's title or topics. Reference entries are separate from personal notes and do not change your understanding status.

### Explore releases through familiar worlds

Choose **Spiral** for illustrated world banners and portal navigation, or **Plain** for the original presentation. The choice stays on this device. Both styles use the same notes, filters, release reference, and C++ version labels.

The world associations provide memory cues: Dragonspyre for C++98, Grizzleheim for C++03, Celestia for C++11, Zafaria through Azteca for C++14, Khrysalis for C++17, the original Castle Darkmoor for C++20, the third story arc for C++23, and the fourth for the C++26 working draft. **Why this world?** explains each association beside its historical sources. Game release dates and C++ standard years retain their separate meanings.

Selected releases include expandable C++ examples about spell effects, capabilities, and deck filtering. A compile-time computation trail connects milestones across releases. These examples belong to the bundled companion and do not add notes to your collection or change your understanding status. The original landscape illustrations work offline, along with the companion text and examples. External source links require an internet connection.

## Capture from another chat

Open **Use with AI** to copy the contribution guide or import a prepared file. An AI client with the optional local integration can search existing notes, reuse topics, add a batch of notes and connections, and verify the result. Saying “Add this to Shard Atlas” works only after that client has been configured. See [integration setup](development.md#optional-ai-integration).

A chat without local access can prepare an importable JSON file. Choose **Use with AI → Import a file** to review it. A prepared file has not been saved into the atlas until you import it.

Knowledge capture should preserve sources, uncertainty, and exact code. It should add useful explanations rather than overwrite an existing note or claim that you have mastered an idea.

## Import a collection or diagram

**Backup & export → Choose JSON** previews additions, duplicates, conflicts, and missing assets before importing an archive. Imports add missing stable IDs and preserve existing note text. To transfer a complete portable collection, import into an empty collection. To replace an existing collection exactly, restore a database snapshot instead.

The app creates a safety snapshot before an import and saves a receipt with **Undo import**. Undo removes unchanged additions from that import. Notes edited afterward or referenced by later work are retained. Review the result when some additions are retained. Import receipts belong to database snapshots rather than portable knowledge archives.

The offline [Lucid converter](../tools/import_lucid.py) accepts retrieved structured document regions and optional images:

```sh
python3 tools/import_lucid.py lucid-source.json --images lucid-images.json --output lucid-archive.json --report lucid-report.json
```

Use `--domain cpp` for C++ material or `--domain general` for another technical subject. The converter does not sign into Lucid or fetch a private diagram. It retains meaningful text, code, table cells, source links, images, and source coordinates from the supplied data.

Imported notes receive stable document and shape identities. Reimporting preserves existing notes rather than duplicating them or overwriting edits. Source arrows become *relates to* connections with their recorded direction and labels. They are not guessed prerequisites. Review the converter's coverage report and keep retrieved source data out of the source repository.

## Storage, backups, and recovery

**The source code and your knowledge use separate storage.** Your working database is:

```text
~/Library/Application Support/Shard Atlas/shards.sqlite3
```

It contains notes, connections, images, canvases, revisions, Trash, and other recovery metadata. Building or replacing the app bundle does not replace this database. The default backup folder is:

```text
~/Library/Application Support/Shard Atlas/backups
```

A configured backup destination can differ. **Backup & export** displays the active folder. A custom database normally keeps snapshots in an adjacent folder named `<database-stem>-backups`.

### Automatic and manual copies

The app creates consistent SQLite snapshots at startup when that day's snapshot is absent, and before operations such as imports and restores. During use, changed data is backed up roughly every 60–90 seconds. An idle collection does not create repeated periodic snapshots. **Back up now** creates an immediate snapshot.

Snapshots are complete database copies. **Automatic retention cleanup is not implemented**, so sustained editing can accumulate files. Review the folder periodically and retain recovery points appropriate to your needs.

Backups are local files. To keep a cloud copy, choose a folder uploaded by your own sync service. A successful local snapshot does not confirm that a cloud upload has completed. Git excludes databases, backups, exports, and private working material. Publishing or cloning the application source does not transfer a personal collection.

### Choose a recovery format

| Copy | Includes | Use |
| --- | --- | --- |
| JSON archive | Notes, connections, canvases, images, revisions, deleted notes, and portable metadata | Transfer or additive import |
| Markdown ZIP | Readable notes and a complete JSON archive | Read without the app and retain an import copy |
| Database snapshot | The complete SQLite collection, including recovery receipts and drafts | Restore an exact recovery point |

Portable JSON archives support up to 256 MB, including images and saved versions. Changes that would exceed the portable capacity are rejected before altering saved data. Snapshots provide complete SQLite recovery copies.

Use **revision history** to inspect or restore an earlier version of one note. Use **Trash** to restore a deleted note with its available connections. These options avoid replacing unrelated work.

For complete recovery, open the backup list in **Backup & export** and choose a snapshot. The app validates it and makes a recovery copy of the current collection before replacing it. **Restoring a snapshot replaces the whole collection** with that saved state.

## Native controls and troubleshooting

The desktop app has its own window, Dock icon, menus, clipboard bridge, and file dialogs. Command-Q quits. The app stops a storage service it started and leaves an already-running shared service available.

The shortcut menu lists available keys. Command or Control-K focuses search, Command or Control-N creates a shard, and Command or Control-Enter saves the editor. Native File and View menus provide the main actions.

Desktop startup diagnostics are written to `~/Library/Application Support/Shard Atlas/server-desktop.log`. The optional browser launcher uses `server.log` in that folder. For Python selection, rebuilding, or a separate test database, see [development](development.md).
