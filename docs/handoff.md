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

The original synchronization release on October 23, 2026 uses GitHub commit `f33c61cf9d3f43ef53e64438601b28e9b9d03f4b`. The matching Sites source mirror is `29bddbdad86963557350d6ac689bf2dbb97a1b4f`. Deployment `appgdep_6adbfa8dbcd481918c10fb7dea4b73ec` succeeded with runtime environment revision 1. The installed Mac bundle includes that GitHub source revision. Later documentation and handoff-tool commits do not imply a new application deployment.

The October 23 Windows verification checkpoint changed contribution tooling and tests only. It preserved the Mac's POSIX credential protection, added Windows startup locking and Unicode-safe JSON transport, and repaired portable test fixtures. That checkpoint did not update the website or installed Mac app. The owner's actual-phone confirmation allowed code-reference milestones 5–6 to proceed; milestone 7 remains outside that implementation scope.

## Code-reference milestones 5–6

The latest website release uses GitHub source `e9231c65120fc1bb64b9c335b346a24f7ac03cab`, mirrored to Sites source `252d0af59165cf4c28a24987dc7ff15a88a3c2ac`. Private deployment `appgdep_6adc0b79ca008191912c02680207c3fc` succeeded with environment revision 1 at the existing URL, <https://shard-atlas.deltamaster64.chatgpt.site>. Owner-only access, D1/R2 bindings, and existing private Drive settings were preserved.

Milestone 5 adds role-aware focused exploration, a retained starting context, clear saved relationship direction and approach names, symmetric alternatives, separate optional dashed shared-topic overlap, and topic browsing. The layout remains deterministic and no collection-wide Connections page or recommendation system was introduced.

Milestone 6 adds direct role-specific capture, creation from an unsuccessful role-filtered lookup, and visible/editable named variants for every code role. A real library inspection found that the existing comparator snippet's two implementations were hidden; both now display with their exact saved code. Paste JSON archive adds validated preview and explicit saving when a file picker is unavailable. Unsaved pasted text and its review participate in native close, browser unload, and synchronization guards.

The broader pilot saved six complementary references through the production website's validated preview: Two Sum, lower bound/exact search, Koko Eating Bananas, BFS, Dijkstra, and two Quickselect variants. Eight explained relationships connect these to existing knowledge and each other. The website reported **Library synced**, with **251 shards on the device and in the cloud copy**. The post-save portable export contained 280 links and 871 revisions. Exact comparison preserved every original record: 245 shards, 272 links, 43 assets and their image bytes, 865 revisions, 149 Trash records, and 2 legacy boards. All seven new implementation units matched the extracted source text exactly, including stable approach identities. No duplicate pilot records were added. Personal notes, source-document identifiers, exports, and compiler evidence remain outside Git.

Release validation: **118 JavaScript test entries passed**, including **124 main frontend checks**, source/browser code-reference checks, and the isolated synchronization suites. The application revision `ce2945b6444cd5256c59469cafdda4a632a6c51f` passed **248 Python tests in WSL Linux**: 245 passed and 3 macOS Swift toolchain checks were skipped. The final release adds only documentation and a CSS correction to that revision. Actual Windows browser checks exercised graph direction/filtering/topic browsing, direct capture, variant-only references, and exact pasted-code round trips. The final visual check found and corrected inherited vertical filter sizing at medium widths; filter heights were verified at 972 CSS pixels and 390 CSS pixels. The 390-pixel layout check is a simulated phone width, separate from the owner's actual-phone confirmation. Seven new C++ source units were compiled and exercised with independent assertion drivers under GCC 11.4.0 with AddressSanitizer and UndefinedBehaviorSanitizer.

## Mac update still pending

**The installed Mac app remains version 3.0.0 at source `f33c61cf9d3f43ef53e64438601b28e9b9d03f4b`. Publishing the website did not update it.** Shared assets changed, so rebuild from `e9231c65120fc1bb64b9c335b346a24f7ac03cab` or a later descendant retaining these changes. Record the actual bundled source revision after building.

1. Pull the source and run the full checks on macOS, including the three Swift checks skipped on Windows/Linux. Build an isolated QA app with `python3 desktop/build.py --output PATH --qa-db PATH`, using a disposable database.
2. In that QA app, verify graph role filters, direction, shared-topic separation, topic browsing, direct capture, snippet/algorithm variants, and Paste JSON preview/save/discard. Check native clipboard, file dialogs, exports, image display, and unsaved-close/quit prompts.
3. Rebuild the working app with `python3 desktop/build.py`, quit the previous app normally, reopen, and confirm the bundled revision, **Library synced**, and intact code, images, relationships, and recovery content. These native checks remain **pending** until performed on the Mac.

## First use on Windows or a phone

Open the existing private website and sign in with the owner's ChatGPT account. An empty browser downloads the shared library automatically. Open **Library sync** and check for **Library synced**. If an offline update is waiting, close all Shard Atlas website windows and reopen. Do not clear website storage to install an update.

If that device already has different saved knowledge, export it before choosing a copy. Conflict resolution currently selects a complete device or cloud collection. Both versions remain recoverable, but automatic per-shard conflict merging is not implemented. Do not choose a complete replacement until the two copies have been reviewed.

For development, clone this repository into a separate local checkout, read the cross-platform workflow, run its checks, and use the existing Sites project. Website sign-in does not supply Git or hosting-source credentials. Obtain fresh supported access rather than copying a Mac private connection file.

## Continue safely

Read `AGENTS.md` and [the cross-platform workflow](cross-platform.md). Inspect the actual Git state and hosting deployment before continuing. This file records work status rather than granting access or proving a deployment.

The personal SQLite database, backup manifests, and raw exports are deliberately excluded from Git. Keep a private consistent snapshot before migrating real knowledge. Preserve all code text, stable identities, assets, relationships, history, and Trash. Never use personal data for automated tests.

Website publication and Mac rebuilding are separate release steps. Record both outcomes after verification. Keep credentials in supported private configuration and obtain fresh Sites source access on each computer.
