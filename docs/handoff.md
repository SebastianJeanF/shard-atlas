# Cross-platform handoff

**Goal:** maintain one source workflow and one private technical library across the Mac app, Windows browsers, and phones.

## Current execution

| Milestone | State | Completion evidence |
| --- | --- | --- |
| 1. Protect and inventory | Mac backup verified | Consistent SQLite snapshot and isolated restore passed. Other device collections need observation before reconciliation. |
| 2. Consolidate source | In progress | Shared UI and browser adapter now live in this repository. Combined build and tests are being verified. |
| 3. Private sync foundation | In progress | D1/R2 protocol and conditional publication have isolated tests. Production configuration and deployment remain to verify. |
| 4. Browser sync | In progress | Durable local outbox and shared status interface are being integrated. |
| 5. Mac sync | In progress | Python client, local endpoints, and native build are being integrated. |
| 6. Real migration | Pending | Requires verified production service and real collection readback. |
| 7. Everyday verification | Pending | Requires cross-client checks and deployed release evidence. |

## Continue safely

Read `AGENTS.md` and [the cross-platform workflow](cross-platform.md). Inspect the actual Git state and hosting deployment before continuing. This file records work status rather than granting access or proving a deployment.

The personal SQLite database, backup manifests, and raw exports are deliberately excluded from Git. Keep a private consistent snapshot before migrating real knowledge. Preserve all code text, stable identities, assets, relationships, history, and Trash. Never use personal data for automated tests.

Website publication and Mac rebuilding are separate release steps. Record both outcomes after verification. Keep credentials in supported private configuration and obtain fresh Sites source access on each computer.
