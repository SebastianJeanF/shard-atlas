# Cross-platform handoff

**Goal:** maintain one source workflow and one private technical library across the Mac app, Windows browsers, and phones.

## Current execution

| Milestone | State | Completion evidence |
| --- | --- | --- |
| 1. Protect and inventory | Verified for available collections | Consistent Mac SQLite backup, exact isolated restore, and browser export comparison passed. Other physical devices have not been inventoried. |
| 2. Consolidate source | Complete | Shared UI, both adapters, hosted runtime, builds, checks, and handoff instructions live in this repository. |
| 3. Private sync foundation | Deployed and verified | D1/R2 bindings and migrations applied. Authenticated readback passed and anonymous access was denied. |
| 4. Browser sync | Deployed and verified | Live Opera GX downloaded the library, reported synced, and exported records matching the Mac exactly. Phone-width layout and lookup passed. |
| 5. Mac sync | Installed and verified | Version 3.0.0 rebuilt, signed, reopened, and reported synced through the actual local service. |
| 6. Real migration | Available collections migrated | Every portable record in the browser export matched the Mac. Other devices retain first-connection review for a different existing collection. |
| 7. Everyday verification | Available-device gate accepted | Actual Windows Opera GX loaded the owner-private shared library and displayed **Library synced**. The owner confirmed the phone works. Isolated Windows browser flows and the complete automated suites passed; see [verification scope and evidence](sync-verification.md). |

## Released source

The application code released on October 23, 2026 is GitHub commit `f33c61cf9d3f43ef53e64438601b28e9b9d03f4b`. The matching Sites source mirror is `29bddbdad86963557350d6ac689bf2dbb97a1b4f`. Deployment `appgdep_6adbfa8dbcd481918c10fb7dea4b73ec` succeeded with runtime environment revision 1. The Mac bundle includes the same GitHub source revision. Later documentation and handoff-tool commits do not imply a new application deployment.

The October 23 Windows verification checkpoint changes contribution tooling and tests only. It preserves the Mac's POSIX credential protection, adds Windows startup locking and Unicode-safe JSON transport, and repairs portable test fixtures. It does not update the website or installed Mac app. Code-reference milestones 5–6 may now proceed after the owner's actual-phone confirmation; milestone 7 remains outside that implementation scope.

## First use on Windows or a phone

Open the existing private website and sign in with the owner's ChatGPT account. An empty browser downloads the shared library automatically. Open **Library sync** and check for **Library synced**. If an offline update is waiting, close all Shard Atlas website windows and reopen. Do not clear website storage to install an update.

If that device already has different saved knowledge, export it before choosing a copy. Conflict resolution currently selects a complete device or cloud collection. Both versions remain recoverable, but automatic per-shard conflict merging is not implemented. Do not choose a complete replacement until the two copies have been reviewed.

For development, clone this repository into a separate local checkout, read the cross-platform workflow, run its checks, and use the existing Sites project. Website sign-in does not supply Git or hosting-source credentials. Obtain fresh supported access rather than copying a Mac private connection file.

## Continue safely

Read `AGENTS.md` and [the cross-platform workflow](cross-platform.md). Inspect the actual Git state and hosting deployment before continuing. This file records work status rather than granting access or proving a deployment.

The personal SQLite database, backup manifests, and raw exports are deliberately excluded from Git. Keep a private consistent snapshot before migrating real knowledge. Preserve all code text, stable identities, assets, relationships, history, and Trash. Never use personal data for automated tests.

Website publication and Mac rebuilding are separate release steps. Record both outcomes after verification. Keep credentials in supported private configuration and obtain fresh Sites source access on each computer.
