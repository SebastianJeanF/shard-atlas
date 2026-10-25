# Cross-platform handoff

**Goal:** maintain one source workflow and one private technical library across the Mac app, Windows browsers, and phones.

## App and data freshness release, October 25, 2026

**Version 3.1.0 is installed on the Mac and the matching website is published.** Application source is `2ef8417b5a2797d882ad740153b4e8da45c2e1a2`. The matching Sites source is `51f8228ad10f60848515b259aaae259a3338b2d0`. Owner-private deployment `appgdep_6ade4fafbf9481919272a436acbf5f0e` succeeded with environment revision 1 at the existing website URL. Existing access, storage bindings, device credentials, and deployed Drive settings were preserved.

The published deterministic release identity is `8bb7961e3c58c78d3c33f208968675beb5dc60e4ca0ad5e0fce122a3d830a336`. Both authenticated release endpoint aliases returned the exact expected manifest. Native release status checked the loaded interface, loaded and on-disk backend, and the identity embedded in the compiled executable. The reopened installed app reported **App up to date** and **Library synced**, with a current cloud check. Publishing the website and replacing the native bundle remain separate operations.

Separate app and library controls now show stale software, required restarts or native builds, version differences, unavailable checks, pending saves, incoming saved data, and incompatible data clients honestly. App checks run every minute and on focus/connectivity changes. Cheap library head checks continue while editors or conflict reviews are protected, without replacing reviewed bases or pending retries. The website update flow retains normal service-worker activation and protects unsaved work. Device service authentication supports an authoritative digest allowlist for independent revocation, retaining the existing legacy digest when no list is configured.

Verification passed **271 Python tests**, **135 JavaScript test entries**, Swift checks, and signed QA and working Mac builds. A final wording-only backend edit passed all 10 release identity/status tests after the full suite. Focused frontend checks covered offline Mac requests and retained drafts. The actual isolated Opera UI displayed a matching release, a visible update banner, unavailable status, phone-width version details, and a blocked reload with the draft unchanged. An isolated WKWebView displayed current, native-update-required, and restart-required states. Ten controlled native release scenarios exercised differing components, absent stamps, unknown/invalid/offline references, and an actually changed QA backend file. QA used disposable state, with no production library connection. A File Provider signing-metadata race was avoided by building outside synchronized folders before installing and verifying the signed working bundle.

The real Mac app quit normally through its application menu. A consistent SQLite backup, private sync state, and the previous app were retained before replacement. Fresh Mac and cloud records matched the preupdate library exactly, including **251 shards, 280 links, 43 assets, 871 revisions, 149 Trash records, 2 legacy boards, and 0 reviews**. The accepted cloud revision was unchanged. The signed-in production Opera website retained its 251 shards, activated the waiting website update after all its Shard Atlas tabs were closed, and displayed **App up to date**, **Library synced**, and offline readiness.

Private evidence is under `Documents/Codex/2026-10-25/shard-atlas-freshness/`. Source, deployment archives, personal exports, test screenshots, backups, and credentials remain separate. The Windows handoff is [Check Shard Atlas on Windows](windows-verification-prompt.md). Actual Windows checks for this release and the specific remote-fixture/physical-network scenarios below remain pending. Documentation commits after the application commit do not change its software identity or require another publication.

## Current execution

| Milestone | State | Completion evidence |
| --- | --- | --- |
| 1. Protect and inventory | Verified for available collections | Consistent Mac SQLite backup, exact isolated restore, and browser export comparison passed. Other physical devices have not been inventoried. |
| 2. Consolidate source | Complete | Shared UI, both adapters, hosted runtime, builds, checks, and handoff instructions live in this repository. |
| 3. Private sync foundation | Deployed and verified | D1/R2 bindings and migrations applied. Authenticated readback passed and anonymous access was denied. |
| 4. Browser sync | Deployed and verified | Live Opera GX downloaded the library, reported synced, and exported records matching the Mac exactly. Phone-width layout and lookup passed. |
| 5. Mac sync | Updated and verified | Version 3.1.0 rebuilt from `2ef8417b5a2797d882ad740153b4e8da45c2e1a2`, signed, reopened, and reported both app current and library synced. Prior native sync QA and fresh exact Mac/cloud exports passed. |
| 6. Real migration | Available collections migrated | Every portable record in the browser export matched the Mac. Other devices retain first-connection review for a different existing collection. |
| 7. Everyday verification | Available checks passed | Actual Windows loading and the owner's phone confirmation are retained. Mac native workflows, isolated Mac/Opera process restarts, and exact production Mac/Opera/cloud exports passed. Physical network and second-device scenarios remain pending. See [verification scope and evidence](sync-verification.md). |

## Released source

The original synchronization release on October 23, 2026 uses GitHub commit `f33c61cf9d3f43ef53e64438601b28e9b9d03f4b`. The matching Sites source mirror is `29bddbdad86963557350d6ac689bf2dbb97a1b4f`. Deployment `appgdep_6adbfa8dbcd481918c10fb7dea4b73ec` succeeded with runtime environment revision 1. The previous Mac bundle included that GitHub source revision. The current Mac rebuild is recorded below. Documentation commits do not imply a new application deployment.

The October 23 Windows verification checkpoint changed contribution tooling and tests only. It preserved the Mac's POSIX credential protection, added Windows startup locking and Unicode-safe JSON transport, and repaired portable test fixtures. That checkpoint did not update the website or installed Mac app. The owner's actual-phone confirmation allowed code-reference milestones 5–6 to proceed; milestone 7 remains outside that implementation scope.

## Code-reference milestones 5–6

The preceding code-reference website release used GitHub source `e9231c65120fc1bb64b9c335b346a24f7ac03cab`, mirrored to Sites source `252d0af59165cf4c28a24987dc7ff15a88a3c2ac`. Private deployment `appgdep_6adc0b79ca008191912c02680207c3fc` succeeded with environment revision 1 at the existing URL, <https://shard-atlas.deltamaster64.chatgpt.site>. Owner-only access, D1/R2 bindings, and existing private Drive settings were preserved.

Milestone 5 adds role-aware focused exploration, a retained starting context, clear saved relationship direction and approach names, symmetric alternatives, separate optional dashed shared-topic overlap, and topic browsing. The layout remains deterministic and no collection-wide Connections page or recommendation system was introduced.

Milestone 6 adds direct role-specific capture, creation from an unsuccessful role-filtered lookup, and visible/editable named variants for every code role. A real library inspection found that the existing comparator snippet's two implementations were hidden; both now display with their exact saved code. Paste JSON archive adds validated preview and explicit saving when a file picker is unavailable. Unsaved pasted text and its review participate in native close, browser unload, and synchronization guards.

The broader pilot saved six complementary references through the production website's validated preview: Two Sum, lower bound/exact search, Koko Eating Bananas, BFS, Dijkstra, and two Quickselect variants. Eight explained relationships connect these to existing knowledge and each other. The website reported **Library synced**, with **251 shards on the device and in the cloud copy**. The post-save portable export contained 280 links and 871 revisions. Exact comparison preserved every original record: 245 shards, 272 links, 43 assets and their image bytes, 865 revisions, 149 Trash records, and 2 legacy boards. All seven new implementation units matched the extracted source text exactly, including stable approach identities. No duplicate pilot records were added. Personal notes, source-document identifiers, exports, and compiler evidence remain outside Git.

Release validation: **118 JavaScript test entries passed**, including **124 main frontend checks**, source/browser code-reference checks, and the isolated synchronization suites. The application revision `ce2945b6444cd5256c59469cafdda4a632a6c51f` passed **248 Python tests in WSL Linux**: 245 passed and 3 macOS Swift toolchain checks were skipped. The final release adds only documentation and a CSS correction to that revision. Actual Windows browser checks exercised graph direction/filtering/topic browsing, direct capture, variant-only references, and exact pasted-code round trips. The final visual check found and corrected inherited vertical filter sizing at medium widths; filter heights were verified at 972 CSS pixels and 390 CSS pixels. The 390-pixel layout check is a simulated phone width, separate from the owner's actual-phone confirmation. Seven new C++ source units were compiled and exercised with independent assertion drivers under GCC 11.4.0 with AddressSanitizer and UndefinedBehaviorSanitizer.

## Mac rebuild and verification completed

**The preceding Mac installation was version 3.0.0 at source `178d4a54f44e4742318ee663af139c592d2fa2a1`.** The clean Mac checkout was fetched and fast-forwarded from `dd0d1c8c55fb6ad179174729ec63fb592864e47e` to `3207e1846564ae09635c760d45e3551d86a83cd3`, preserving the published application release `e9231c65120fc1bb64b9c335b346a24f7ac03cab`. No older handoff commit was restored.

The export comparison found that the earlier native sync client expanded optional empty fields in old revision snapshots and Trash payloads. Commit `178d4a5` preserves validated recovery payloads exactly. It also repairs this older normalization only on a clean, unchanged synchronized base, after a safety backup and a second local-change check. The repair updates recovery payloads without replacing live notes or publishing a cloud revision. Distinct local history and edits arriving during the check remain protected.

| Check | Verified result |
| --- | --- |
| Full macOS suite | **252 Python tests passed, no skips**, including all three Swift configuration checks. The four new recovery-preservation checks passed within 35 native-sync tests. **118 JavaScript test entries passed**. Shared JavaScript syntax and whitespace checks passed. |
| Isolated native build | `desktop/build.py --output PATH --qa-db PATH` built and signed a disposable QA app at `3207e18`, then rebuilt it at `178d4a5`. Test records, fixtures, backups, profiles, screenshots, and exports stayed outside Git and the working collection. |
| Native workflows | Actual WKWebView checks passed for graph role filtering with retained starting context, saved direction, symmetric alternatives, separate shared-topic overlap, topic browsing, direct snippet capture, snippet/algorithm variant display and editing, and Paste JSON preview/save/discard. Native image selection, saved image display/enlargement, JSON export save dialog, clipboard, and unsaved editor/paste/review close or quit protection passed. |
| Exact C++ | The native Copy button produced an exact 105-byte match containing Unicode, tabs, an initial newline, and five CRLF line endings. A title-only native edit retained exact approach code and identities. Pasted code and exported image bytes also matched exactly. |
| Isolated synchronization | The real native service and actual Opera GX IndexedDB synchronized through the real Worker handler with disposable local SQLite/object-storage adapters and synthetic identity. Both update directions, delete/restore, native and browser explicit conflict review, retained conflicting copies, and complete process restarts passed. This was one physical Mac with a loopback cloud simulation. |
| Working installation | A consistent SQLite backup passed integrity and foreign-key checks. Private sync state and the old bundle were preserved. The previous app quit normally. The rebuilt bundle passed signing verification and was reopened with a new native/backend process. Bundle build information and bundled backend file bytes match `178d4a5`. The obsolete standalone 2.9.0 service was shut down normally. |
| Real library | The working app and signed-in production Opera both displayed **Library synced**. Fresh portable exports from Mac, Opera, and cloud matched exactly by stable record ID: **251 shards, 280 links, 43 assets, 871 revisions, 149 Trash records, 2 legacy boards, and 0 reviews**. Comparisons included complete records, exact code, tags, directed approach endpoints, and decoded image bytes. Live records and the cloud revision were unchanged. |

The initial native workflow checks used QA build `3207e18`. The final `178d4a5` build retains the exact same Swift source and shared-interface fingerprint, `b3008419260744abdb5dc68993d7dd0ccc18b4d2c6dc5ee22780725e651a4c6e`. Final native conflict, restart, synchronization, installation, and real-library checks used `178d4a5`.

No website fix was needed. The website remains at application release `e9231c6`, at the existing URL and audience. The Mac-only backend correction did not require publication or reimporting the content pilot. Optional milestone 7 was not implemented.

Private evidence and backups are retained under `Documents/Codex/2026-10-23/shard-atlas-mac-verification/`, including `python-final-tests.log`, `javascript-tests.log`, build logs, `scenario-*.log`, isolated record comparisons, and the private preinstall/postinstall directories. Credentials and personal archives are not in Git.

## Specific remaining checks

- [ ] Use a separate remote QA library and a second physical device to test actual network disconnection and reconnection. The completed outage checks interrupted loopback transport or emulated Opera offline mode. No physical network adapter was disabled.
- [ ] On that isolated remote fixture, verify Mac-to-phone/Windows and reverse updates, complete device-process restarts while offline, delete/restore, and concurrent-edit review with both copies retained. The same-Mac native/browser checks do not establish these physical-device results.
- [ ] Compare fresh Windows and phone portable exports against the current Mac/cloud records. Their earlier Windows loading and the owner's actual-phone confirmation remain accepted. General phone verification does not need repeating.

## First use on Windows or a phone

Open the existing private website and sign in with the owner's ChatGPT account. An empty browser downloads the shared library automatically. Open **Library sync** and check for **Library synced**. If an offline update is waiting, close all Shard Atlas website windows and reopen. Do not clear website storage to install an update.

If that device already has different saved knowledge, export it before choosing a copy. Conflict resolution currently selects a complete device or cloud collection. Both versions remain recoverable, but automatic per-shard conflict merging is not implemented. Do not choose a complete replacement until the two copies have been reviewed.

For development, clone this repository into a separate local checkout, read the cross-platform workflow, run its checks, and use the existing Sites project. Website sign-in does not supply Git or hosting-source credentials. Obtain fresh supported access rather than copying a Mac private connection file.

## Continue safely

Read `AGENTS.md` and [the cross-platform workflow](cross-platform.md). Inspect the actual Git state and hosting deployment before continuing. This file records work status rather than granting access or proving a deployment.

The personal SQLite database, backup manifests, and raw exports are deliberately excluded from Git. Keep a private consistent snapshot before migrating real knowledge. Preserve all code text, stable identities, assets, relationships, history, and Trash. Never use personal data for automated tests.

Website publication and Mac rebuilding are separate release steps. Record both outcomes after verification. Keep credentials in supported private configuration and obtain fresh Sites source access on each computer.
