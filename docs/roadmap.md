# Shard Atlas roadmap

Shard Atlas is expanding its existing technical collection to connect computer science, mathematics, and machine learning. The rollout keeps shared concepts available across subject and course views.

[Project overview](../README.md) · [User guide](guide.md) · [Development](development.md)

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

Milestone 5 is a focused visual exploration update with role-aware graph controls and tag-based browsing. Existing Topic map exploration remains available in version 2.9.0. Milestone 6 is a broader pilot with real saved content and workflow refinement. Milestone 7, optional, would suggest relevant existing shards with reasons while keeping suggestions distinct from saved relationships. These remain future work.

## Initial content rollout

**CS 4789 and CS 3780 are the planned initial course collections.** This application update has not populated real course shards. QA fixtures remain isolated from the working collection.

## Excluded from this rollout

Recall, application practice, and spaced review are excluded.
