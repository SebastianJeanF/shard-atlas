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

## Initial content rollout

**CS 4789 and CS 3780 are the planned initial course collections.** This application update has not populated real course shards. QA fixtures remain isolated from the working collection.

## Excluded from this rollout

Recall, application practice, and spaced review are excluded.
