# Shard Atlas roadmap

Shard Atlas is expanding its existing technical collection to connect computer science, mathematics, and machine learning. The rollout keeps shared concepts available across subject and course views.

[Project overview](../README.md) · [User guide](guide.md) · [Development](development.md)

## Browser ChatGPT integration

**Direct browser ChatGPT saves are the primary capture route. Google Drive is an emergency manual fallback.** This plan was clarified on October 25, 2026. Its milestone numbers are separate from the code-reference rollout below.

| Milestone | State | Completion requirement |
| --- | --- | --- |
| 1. Private connection | Complete | The owner-private connection works in regular browser ChatGPT. |
| 2. Library search and read | Complete | ChatGPT can inspect saved shards and connections for duplicate checking and related-shard discovery. |
| 3. Direct additions | Implemented and published; actual ChatGPT save check pending | Additions and connections produce verified cloud receipts. Isolated automatic delivery passed; confirm the next legitimate owner contribution through regular browser ChatGPT and the receiving devices. |
| 4. Direct edits | Implemented and published; actual ChatGPT edit execution pending | Sparse revision-checked shard and connection edits retain history, preserve omitted fields and code variants, refuse stale changes, and use existing client conflict review. Mac 3.3.0 is installed and verified. |

Milestone 3 uses the complete contribution guide, expiring signed guide receipts, existing search/read tools, accepted cloud revision checks, validated atomic additions, stable request IDs, and verified save receipts. Regular browser ChatGPT discovered all five tools and read the exact current guide. Valid saves and automatic delivery passed in isolated libraries using the real hosted handler, Python client, and browser adapter with simulated IndexedDB. A successful actual ChatGPT browser save remains pending; these results do not establish physical Windows or phone behavior. See the [release evidence](handoff.md#browser-chatgpt-integration-milestone-3-october-25-2026).

Milestone 4 adds `shard_atlas_edit_knowledge` for explicitly requested changes to existing shards and saved connections. Partial edits preserve omitted fields. Code variants update by stable approach ID, and shard edits retain before and after saved versions. Lost-response retries do not repeat edits or undo later changes. Conditional publication, stale refusal, client draft guards, and explicit conflict review remain in place. Isolated HTTP/native/browser integration, actual Opera delivery and history display, and large built-Worker fixtures passed. The successful production ChatGPT write and physical device checks remain separate verification work.

The Shard Atlas website need not be open for an accepted cloud save. Verification includes receiving changes while open, catch-up after reopening, and protection of unfinished edits. Record actual device evidence and remaining Windows checks separately. Direct deletion and new image uploads remain outside these tools. The agreed core plan has no further implementation milestone after 4.

**Automatic library synchronization already exists.** A connected Mac service receives cloud changes automatically while running and online. A closed app normally catches up when reopened. Unfinished edits defer incoming changes, and conflicts require review. Routine capture must not depend on pressing **Sync now** or importing a Drive batch.

The previously proposed milestone 5, automatic Drive Inbox detection/importing, is removed from the core plan. Keep the existing manual Drive/file import route available for emergencies. Reconsider automation only if that fallback becomes useful enough to justify it. Source/app relocation and cold-file consolidation were completed as separate maintenance on October 25–26, 2026. The recurring deduplicating backup system remains planned. See the [maintenance record](handoff.md#drive-file-count-reduction-october-2526-2026).

## Cross-platform library: version 3.0.0

The shared interface and Mac/browser adapters now live in one repository. A private hosted library synchronizes complete portable records and contribution receipts, with offline local copies, durable retries, safety backups, and explicit whole-collection conflict review. The Mac 3.0.0 app has been rebuilt from `178d4a5`, with native workflows, all macOS checks, and exact production Mac/Opera/cloud export comparisons verified. Isolated native and browser process restarts passed on one physical Mac. Physical network recovery and second-device mutation scenarios remain pending. Earlier actual Windows loading and the owner's phone confirmation remain accepted. See [verification scope](sync-verification.md), [release evidence and remaining checks](handoff.md), and [the development workflow](cross-platform.md).

## Phase 1: complete

- Shared course and lecture collections with overlapping subject focus.
- Local notation definitions and assumptions attached to each concept.
- Selective bulk review with editable incoming cards and connections.
- Reuse of existing cards without overwriting saved knowledge, with import receipts and safe undo.

**Source-backed capture currently means source references and locators preserved through AI-prepared JSON or manual capture.** Automatic PDF extraction is not implemented.

## Phase 2: complete

- Structured perspectives on the same concept, such as mathematical, geometric, algorithmic, and practical explanations.
- Stepwise derivations and algorithm traces.
- Comparisons of technical methods, including assumptions, tradeoffs, and limitations.
- Questions and misconception history linked to the relevant concepts.
- Separate content verification from the user's personal understanding.
- Richer explained typed connections that state why the relationship holds and where it applies.

Open **Edit shard → Learning & explanation** to use the structured editor. Content verification remains independent of personal Understanding, whose clarification state is labeled **Needs clarification**.

## Phase 3: complete

Small reproducible experiments cover quadratic gradient descent and finite-MDP value iteration, with editable configurations, individual updates, plots, numeric tables, and A/B comparisons. Saved setups retain their algorithm version and can be attached to shared concepts.

The initial gradient-descent and value-iteration models are implemented and verified. Additional experiment types remain optional future work. These are finite educational models, with no arbitrary-function execution or external ML training environment.

## Code reference rollout: version 2.9.0

The first four milestones extend the shared Library with quick code lookup and reusable solution connections:

1. **Code foundations.** Optional snippet, algorithm or data structure, and solved-problem roles. Multiple stable-ID approaches retain their code, complexities, assumptions, and pitfalls through recovery, imports, exports, and AI capture.
2. **Fast capture and reference.** Lightweight creation fields and a compact reference view for exact, copyable C++ code, purpose, headers, costs, and caveats.
3. **Search and topic browsing.** Ranked title and alias lookup, code-role filtering, topic all/any matching, existing-topic suggestions, topic merging, and removal of the fixed per-shard topic-count cap.
4. **Specific connections.** Uses, Used in, Implements, and Alternative approach views, with optional approach endpoints and one saved relationship for both directions. Referenced approaches cannot be removed without resolving their connections.

These additions share the existing collection, sources, and recovery features. They do not require separate code and concept libraries. See [code-reference usage](guide.md#keep-code-ready-to-use) and the [capture contract](../static/ai-instructions.md#capture-code-references-and-solved-problems).

### Further code-reference work

5. **Focused visual exploration.** Role filters retain the starting idea as context. Directed saved relationships and symmetric alternatives are distinct from optional dashed shared-topic overlap. Topic chips and neighborhood browsing connect the focused graph to useful tag exploration while preserving deterministic layout.
6. **Broader content pilot and refinement.** The existing library was inventoried before selecting complementary hashing, binary-search, BFS, Dijkstra, and quickselect material. Direct role-specific capture and creation from an unsuccessful lookup reduce capture steps. Named implementation variants are visible and editable for snippets and algorithms as well as solved problems. A paste-and-preview archive route supports capture when a file picker is unavailable, with the same duplicate review and explicit save. Personal content and validation evidence stay outside source Git; the handoff records the saved pilot outcome.

Milestone 7 remains optional and outside this implementation: suggestions of relevant existing shards with reasons, kept separate from saved relationships. This update does not generate those suggestions or import every tab in the source document.

## Initial content rollout

**CS 4789 and CS 3780 are the planned initial course collections.** This application update has not populated real course shards. QA fixtures remain isolated from the working collection.

## Excluded from this rollout

Recall, application practice, and spaced review are excluded.
