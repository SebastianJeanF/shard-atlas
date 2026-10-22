# Using Shard Atlas

Shard Atlas stores explanations and the relationships between them. A *shard* is a note about one technical idea. The Library, Courses, Topic map, Experiments, and C++ timeline offer different ways to explore your notes.

[Back to the project](../README.md) · [Build and development](development.md) · [AI contribution guide](../static/ai-instructions.md)

## Start with one idea

Create a shard with a descriptive title and an explanation in your own words. Add examples, caveats, and a source where they help you understand or verify the claim. Topics make the note easier to find. Kind distinguishes concepts, facts, examples, learning moments, and ideas.

Understanding has three states: **Learning**, **Confident**, and **Needs clarification**. These describe your understanding. A separate content-verification record describes a manual source check, rather than whether you understand the idea or an AI generated its text.

The initial collection includes 12 C++ examples and 18 connections. Edit or delete the examples as you build your own collection. Deleting all notes does not cause the app to insert the examples again.

Use the atlas for programming languages, computer science, mathematics, and ML or AI theory. Capture reusable mechanisms, definitions, code, and distinctions. News, company announcements, compensation, career tracking, and forecasts are outside its intended scope.

## Write an explanation

The editor supports Markdown headings, lists, links, and fenced code blocks. Use `$...$` for inline math and `$$...$$` for displayed math. The bundled KaTeX renderer works offline.

Add or paste an image while editing. PNG, JPEG, GIF, and WebP images up to 8 MB each are stored with the collection and included in exports and backups. Screenshot text recognition uses the local macOS helper in desktop builds.

Type `[[` to find another shard and insert an inline link. Links use stable IDs, so renaming the target does not break them. Put literal C++ attributes in inline code so they are not mistaken for note links.

**Drafts and saved notes are separate.** The app saves editor drafts locally for recovery, but a note changes only when you choose **Save**. Closing a changed form or quitting with unsaved edits asks before discarding them.

### Interface colors

Forest green marks the selected idea and primary actions. Amber marks learning or verification states. Code uses purple for keywords, teal for types, blue for functions, orange for numbers, red for literals, and green for comments. Uncertain identifiers remain neutral. The code panel includes a compact key. Highlighting is conservative and does not perform full C++ semantic analysis.

## Find and connect notes

The Library places the selected explanation beside its nearby ideas. Search covers note text, structured explanations, notation, connection context, and connected-note titles. Combine search with kind, understanding, source-verification, and topic filters. When selecting multiple topics, choose whether results must match **all** or **any** of them. Renaming a topic updates the notes that use it.

Use **Search topics** in the sidebar to find a topic by name, then select it to filter the current view. This searches topic names separately from the main note search. Selected topics stay visible while you look for others. Enter selects an exact match or the only matching topic. Escape or the clear button clears the topic search without removing your selections.

Topics are freeform and grow with your notes. Add any useful topic in a shard's comma-separated **Topics** field, including a keyword such as `consteval`. Its name appears in the sidebar after the note is saved. The topic list has no fixed vocabulary or global limit.

Choose **Connect** to describe how two notes relate. The available relationships are *depends on*, *explains*, *contrasts with*, *is an example of*, *relates to*, *is part of*, *supports*, and *contradicts*. Add a reason, scope, evidence, source link, and source location when useful. Scope states the conditions where the connection applies. Evidence records its justification, rather than making every saved connection a verified claim.

Direction matters. An arrow runs from the note making the relationship to its target. For example, an example note can point to the concept it illustrates with *is an example of*. A diagram's proximity or arrow alone does not establish a prerequisite.

The Library includes a compact preview of nearby ideas. Use Topic map to explore saved relationships one step at a time.

## Follow subjects and courses

**Generic · all subjects** shows the shared collection. Choose **C++**, **Computer science**, **Mathematics**, or **Machine learning** to focus on a subject. These views can overlap. An idea can belong to several subjects without becoming several notes. Subject focus changes what you see, rather than moving or copying knowledge.

Use **Courses** to find notes through their course and lecture context. In the editor's **Course & notation** section, add a course code and, when known, a course title, term, lecture or reading, source link, source location, and a short explanation of how the course uses the concept. **Lecture order** provides a numeric order, followed by the lecture label. A source location can identify a page, slide, section, or timestamp. Leave unknown details empty instead of guessing them.

Courses groups occurrences by course code and term. Occurrences without a lecture appear under **Course foundations**. The view starts empty until you add course context to a shard.

**Keep the concept once and record where it appears.** The same shard can have several course occurrences, including several lectures in one course. Its explanation remains available in Library and Topic map. Course context preserves the local framing without turning each lecture mention into a duplicate concept.

Add expandable notation entries to explain each symbol's meaning, type or shape, role, and scope. For example, a role can identify a quantity as an input or a current estimate, while scope identifies the lecture or formulation where that meaning applies. The editor defaults scope to **This explanation**. A symbol's definition belongs to this note and its stated context, rather than a global dictionary. Record the assumptions needed for the explanation's claims, one per line. Course context, notation, and assumptions are included in recoverable editor drafts.

## Develop an explanation

Choose **Edit shard → Learning & explanation** to add structured material beside the main explanation in the desktop app. **Perspectives** keep different views of the same concept together. Give each a title, viewpoint, explanation, and any assumptions or source location needed to interpret it.

**Walkthroughs** record a derivation or algorithm trace as ordered steps. Add a goal, then each step's expression, explanation, and why it follows, followed by a conclusion. Expression fields accept TeX without dollar delimiters. While reading, use the previous, next, or show-all controls to inspect the steps. The sequence explains recorded reasoning or state changes. It does not execute an algorithm or check the mathematics automatically.

**Method comparisons** compare technical alternatives within a shared concept. State the question, then each alternative's summary, assumptions, strengths, limitations, and computational cost. Link an alternative to an existing concept when helpful and record a conclusion and source. These are concept-level comparisons of methods, rather than a separate company or product comparison workspace.

## Record questions and content checks

Use **Questions & misconceptions** to record a question or the original misconception, mark it open or resolved, and explain its resolution. A resolved entry requires a resolution. Optional dated history entries preserve what the user actually recorded. The app does not infer a learning timeline or invent earlier misunderstandings.

**Content verification** has its own states: **Unverified**, **Source checked**, and **Needs correction**. These are manual records. **Source checked** requires a verification note and a source link or source location identifying what was checked. A checked date is optional. This records a source comparison, without automatically certifying every claim or changing personal Understanding. Use **Needs correction** for a content problem and **Needs clarification** when your understanding needs attention.

## Run a reproducible experiment

Open **Experiments** to run the built-in **Quadratic gradient descent** or **Finite MDP value iteration** model immediately. In the desktop app, choose **View → Experiments** or press Command-5. Adjust the settings, choose **Run simulation** or **One update**, and inspect the plots, tables, and previous or next iteration. Enable **Compare with configuration B** to run two configurations with comparable axes. These are small educational models, with no arbitrary function execution, external training environment, or random sampling.

**Runtime settings are previews until explicitly saved.** **Save configuration** updates the selected experiment on its saved shard while preserving the shard's other content and experiments. In the lab, **Add to new shard** opens the normal editor with the setup attached as a recoverable draft. Save that shard to retain it. You can also open **Interactive experiments** in a new or existing shard's normal editor. **Copy setup** transfers the configuration, rather than claiming a completed save. Runtime previews themselves are not recoverable editor drafts.

Saved experiments contain the algorithm version and complete numerical configuration, with an optional comparison configuration. The app recomputes the results from that setup. These two models are deterministic, so a random seed is unnecessary. Import and saved-version previews can run experiments but cannot overwrite their saved configurations. A simulation result does not change personal Understanding or content verification.

### Quadratic gradient descent

The two varying scalar coordinates are `x` and `y`. Fixed input coefficients `a`, `b`, and `c` define the positive-definite quadratic objective `f(x,y) = (a*x*x + 2*b*x*y + c*y*y) / 2`, whose scalar minimum is zero at the origin. Each update subtracts the fixed learning rate times the full gradient. Iteration zero records the starting point. Convergence uses the gradient norm and the chosen tolerance.

For this quadratic, a positive fixed learning rate `alpha` converges from every starting point exactly when `alpha < 2 / lambdaMax`, where `lambdaMax` is the fixed largest eigenvalue of its Hessian. Outside that range, convergence can still occur from particular starting points. A numeric-limit stop protects the simulation from oversized or nonfinite values. It is not a proof of mathematical divergence. The model specializes the [gradient-descent method in Boyd and Vandenberghe](https://web.stanford.edu/~boyd/cvxbook/) using the [quadratic spectral recurrence in these official course notes](https://www.math.utah.edu/~bwang/mathds/Lecture5.pdf).

### Finite MDP value iteration

Edit states, available actions, transition probabilities and rewards, initial values, discount, and stopping settings. Each transition row's probabilities must sum to one within the stated numerical tolerance. Updates are synchronous: every next value uses the same current value vector. Rewards are received on transitions and probability-weighted. Terminal states have zero future value. Unavailable actions are omitted, and exact action ties use the declared action order. The displayed policy is greedy with respect to the currently displayed values. These conventions follow the [official value-iteration and policy-extraction reference](https://inst.eecs.berkeley.edu/~cs188/textbook/mdp/value-iteration.html).

The Bellman residual measures the largest absolute difference between the current values and their next optimality update. For exactly normalized probabilities, `residual / (1 - discount)` bounds the largest value error. To account conservatively for accepted probability rounding, the app uses `residual / (1 - beta)`, where `beta` is the discount times the larger of one and the largest transition-row probability sum. Probabilities are not silently normalized. This is a bound, rather than an observed exact error or a policy-error bound. The simulation stops as converged only when the residual meets the chosen tolerance. Reaching the iteration cap is a separate outcome.

## Explore the Topic map

**Topic map** automatically arranges your collection into topic neighborhoods. Open a neighborhood to explore its shards. Every assigned topic counts, so a shard about both Classes and Templates can bridge those neighborhoods. Search and filters narrow the view without changing your saved notes.

Shared-topic links show which topics overlap. Saved conceptual relationships have a distinct style and retain their labels and direction. Select a shard to explore its saved relationships, then expand a neighboring shard to follow another step. A shared topic does not imply that one idea explains or depends on another.

Broad organizational tags, such as C++, LucidChart, and Images, are hidden by default. Show them when they are useful. The same data and view settings generate the same layout, without manually arranging cards or drawing connections.

Topic map replaces the manual Canvas interface. Existing saved canvases remain in the collection, archives, and backups for recovery. Imported Lucid notes, images, sources, and relationships remain available through the shared collection.

## Explore the C++ release reference

**C++ timeline** shows your shards alongside a bundled, sourced reference from C++98 through the **C++26 working draft**. Your shard cards appear openly at the top of each release. Use **Show** to choose **My shards & reference**, **My shards**, or **Release reference**. Jump to a release, search, and combine topics with all or any matching. Open a shard to read or edit it in Library, or open a reference entry for its explanation and sources.

Subject focus is disabled in this view. The timeline keeps C++ notes and older unclassified notes available, while excluding notes explicitly assigned only to other academic subjects.

The reference works offline. External source links need an internet connection when opened. Entries describe feature groups and adopted changes rather than every overload or defect report. The reference's coverage disclosure explains that boundary.

To place a personal note beside a release, assign a recognized version such as `C++17` under **Source & context → Version or scope**. C++ and unclassified notes without a recognized version appear in the **No release assigned** column, with a jump button above the timeline. Release placement uses your assigned scope and is never guessed from the note's title or topics. Reference entries are separate from personal notes and do not change your understanding status.

### Explore releases through familiar worlds

Choose **Spiral** for illustrated world banners and portal navigation, or **Plain** for the original presentation. The choice stays on this device. Both styles use the same notes, filters, release reference, and C++ version labels.

The world associations provide memory cues: Dragonspyre for C++98, Grizzleheim for C++03, Celestia for C++11, Zafaria through Azteca for C++14, Khrysalis for C++17, the original Castle Darkmoor for C++20, the third story arc for C++23, and the fourth for the C++26 working draft. **Why this world?** explains each association beside its historical sources. Game release dates and C++ standard years retain their separate meanings.

Selected releases include expandable C++ examples about spell effects, capabilities, and deck filtering. A compile-time computation trail connects milestones across releases. These examples belong to the bundled companion and do not add notes to your collection or change your understanding status. The original landscape illustrations work offline, along with the companion text and examples. External source links require an internet connection.

## Capture from another chat

Open **Use with AI** to copy the contribution guide or import a prepared file. An AI client with the optional local integration can search existing notes, reuse topics, add a batch of notes and connections, and verify the result. Saying “Add this to Shard Atlas” works only after that client has been configured. See [integration setup](development.md#optional-ai-integration).

A chat with your configured Google Drive connection can queue one immutable addition file in **ChatGPT → Shard Atlas → Inbox**, even while the Mac is off. Open **Use with AI → Google Drive** and choose **Sync inbox** on the web or **Sync additions** on the Mac. The web app reads Drive directly after Google authorization. The Mac reads the folder synced by Google Drive for desktop. Import receipts prevent repeated requests from adding copies, and source files stay in the inbox for other devices. This carries additions only. It does not synchronize edits, deletions, or your existing collection. See [Drive inbox setup and results](drive-inbox.md).

A chat without local access or the configured Drive connection can prepare an importable JSON file. Choose **Use with AI → Preview a file** to review it. A prepared file has not been saved into the atlas until you import it. Capture uses an AI-prepared handoff with source references and optional academic metadata. The app does not automatically extract concepts from a PDF or fetch the contents of a source link.

Knowledge capture should preserve sources, uncertainty, and exact code. It should add useful explanations rather than overwrite an existing note or claim that you have mastered an idea.

## Import a collection or diagram

**Backup & export → Choose JSON** previews additions, duplicates, conflicts, and missing assets before importing an archive. Imports add missing stable IDs and preserve existing note text. To transfer a complete portable collection, import into an empty collection. To replace an existing collection exactly, restore a database snapshot instead.

Select the cards you want to import. Choose **Edit incoming card** to revise proposed details, then **Apply to review**. Selection and card changes automatically refresh validation for the revised cards, connections, and assets. Check that source references and notation match the selected material. Choose **Save selected to atlas** for a selection or **Save to atlas** for the full archive. Preview edits change the proposed import, not an existing note in your collection.

Use connection checkboxes to include or skip links and expand **Edit connection** to revise their proposed type and rationale, with automatic revalidation and read-only preservation of existing saved relationship IDs.

Choose **Use saved card** when an existing note already covers the incoming idea. Connections and explicit inline links to the incoming ID then point to the saved card. Its saved explanation and metadata stay intact. To add new course context or study material to that card, open it afterward and choose **Edit shard**.

A partial import keeps selected notes' revisions and referenced images. It omits saved canvases and Trash recovery records. Selecting the full archive preserves its complete legacy recovery content. **Import review changes are temporary.** The app asks before discarding a modified review, but those changes are not recoverable editor drafts outside the current session.

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

Choose **View → Courses** or press Command-2 to open course context in the desktop app.

Desktop startup diagnostics are written to `~/Library/Application Support/Shard Atlas/server-desktop.log`. The optional browser launcher uses `server.log` in that folder. For Python selection, rebuilding, or a separate test database, see [development](development.md).
