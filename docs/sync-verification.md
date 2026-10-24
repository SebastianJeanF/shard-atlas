# Synchronization verification

The first October 23, 2026 checkpoint began from GitHub main `dd0d1c8c55fb6ad179174729ec63fb592864e47e`. The subsequent Mac continuation safely fast-forwarded to `3207e1846564ae09635c760d45e3551d86a83cd3` and released the native recovery-preservation correction at `178d4a54f44e4742318ee663af139c592d2fa2a1`. No newer source or knowledge was reset. The owner's actual-phone confirmation remains accepted.

## Evidence and limits

| Check | Result | Scope |
| --- | --- | --- |
| Owner-private website | Passed | Sites confirmed the existing owner-only access policy and unchanged website URL. The owner completed the requested Windows sign-in. The application does not display an account email. |
| Actual Windows website | Passed | At the initial verification checkpoint, Opera GX loaded 245 shared shards and displayed **Library synced**, with matching device/cloud counts. A normal read-only export completed. The later content pilot and final counts are recorded in [the handoff](handoff.md). |
| Real export integrity | Passed | Unique record IDs, relationship/approach endpoints, decodable image bytes, and full import-preview validation passed. One displayed C++ implementation matched the exported source exactly. The export contained 272 links, 43 assets, 865 revisions, 149 Trash records, and 2 legacy boards. No import or personal-note mutation was used for this check. |
| Windows browser mutation flows | Passed with a local simulated cloud | The canonical interface and real IndexedDB ran at two isolated loopback origins. The actual Worker handler used disposable SQLite/object-storage adapters and synthetic identity. Both-direction updates, an offline edit surviving page reload, reconnect, deletion on one client, restoration on the other, and explicit concurrent-edit conflict review passed. Full portable snapshots matched the simulated cloud. |
| Automated rich two-store fixture | Passed | Exact C++ including Unicode/CRLF, tags, approach-scoped directed links, PNG bytes, revisions, Trash, and legacy board/review recovery were preserved. The separate actual Windows isolated-browser flow verified CRLF code and image display. All fixtures remained outside the personal library. |
| Phone | Owner-confirmed pass | The owner reported checking the actual phone and that it works. This was not phone automation. Individual phone offline/restart/conflict scenarios were not observed or separately attested by the agent. |
| Actual Mac | Passed at the current native release | Version 3.0.0 rebuilt and signed at `178d4a5`, normally reopened, and observed reporting **Library synced**. Native workflows and bundled backend source were verified. |
| Complete native and Opera process restarts | Passed with isolated data on one Mac | A saved native edit survived normal app exit plus backend-process exit/restart. A saved browser edit survived complete isolated Opera process exit and offline reopening from the persistent profile/service-worker cache. Both subsequently synchronized exact portable records after simulated transport recovery. |
| Physical network outage | Pending | Loopback HTTP interruption and Opera offline emulation do not establish behavior after disabling and restoring the physical network adapter against a remote service. |
| Fresh production Mac/Opera/cloud comparison | Passed | Fresh exports matched every portable record by stable ID, including exact C++, tags, directed approach endpoints, image bytes, revisions, Trash, and legacy recovery. The final record counts are in the handoff. No real collection was replaced for testing. |
| Fresh Windows and phone export comparison | Pending | No fresh Windows or phone export was available during the Mac continuation. Their earlier loading and overall phone confirmation remain accepted. |

Screenshots, exports, fixture data, diagnostic logs, and credentials remain outside Git. No synthetic collection was attached to the production whole-library slot, and no whole-collection replacement was chosen for the real library.

## Automated checkpoint

- Windows Node.js 24.21.0: `npm test` passed all **116 test entries**, including **118 internal frontend checks** and **51 protocol/browser-sync tests**. Browser storage tests use fake IndexedDB; they are automated simulations.
- Windows Python 3.13: **217 supported tests ran: 209 passed and 8 had explicit OS/toolchain skips**, excluding the POSIX-protected native-sync module. Windows credential rejection was not bypassed.
- WSL Ubuntu 22.04, Python 3.10.12: the full Python suite ran **248 tests: 245 passed and 3 macOS Swift toolchain checks were skipped**. All **31 native-sync tests** passed with real POSIX permissions. This is Linux automated verification, not a Mac native check.
- The **4 source-transfer tests**, JavaScript syntax checks, and `git diff --check` passed.

The added two-store round trip combines offline/restart/reconnect, both update directions, exact implementation text, tags, directed approach relationships, images, deletion/restoration, revisions, Trash, and legacy recovery. Existing tests retain lost-response retries, stale-editor protection, explicit conflict choices, incompatible versions, authentication failures, immutable contribution receipts, and corruption rejection.

## Mac continuation

The Mac ran macOS 26.6.2 on arm64, Swift 6.4, Python 3.13.9, and Node.js 25.8.0. The initial unmodified release passed all 248 Python tests, including the three previously skipped Swift checks, and all 118 JavaScript entries. After the native recovery correction, the full Python suite passed **252 tests with no skips**, including all **35 native-sync tests**. The correction changed Python synchronization and its tests only. Shared JavaScript syntax and whitespace checks also passed.

Actual native QA verified saved arrow direction, reverse labels, symmetric alternatives, starting-context role filtering, separate optional shared-topic overlap, and tag/neighborhood browsing. Direct snippet capture, snippet/algorithm variant display and editing, exact native copying, Paste JSON preview/save/discard, image file selection and enlargement, the JSON export save dialog, and unsaved editor/paste/review close or quit prompts passed. These were WKWebView interactions on the physical Mac, not simulated screen widths. The initial UI checks used QA build `3207e18`. The rebuilt `178d4a5` retains identical Swift and shared interface assets and passed final native synchronization/conflict/restart checks.

The isolated integration fixture used the production Worker handler with disposable persistent SQLite and filesystem object storage, a separate real Opera profile, the bundled native Python service, and synthetic identity on loopback only. Protocol mutations used the actual native HTTP API and browser platform/IndexedDB adapter. The browser and native conflict choices were also exercised in their visible interfaces, including confirmation dialogs. Both accepted and conflicting cloud snapshots remained recoverable. Both update directions and delete/restore retained exact code, approach-scoped links, images, revisions, Trash, and legacy board/review recovery. The native app/backend processes and the isolated Opera process were confirmed stopped before their respective restarts. Browser offline reopening was observed with `navigator.onLine` false and an active service worker before restoring transport.

This fixture was a local cloud simulation on one physical computer. It was not deployed to the production library or a remote QA service, and it does not prove second-device or physical network recovery. No empty or synthetic collection was connected to the production whole-library slot.

The real export check initially found default-field expansion in 850 old revision snapshots and all 149 Trash payloads on the Mac. The corrected client validated these records, backed up the database, and reconciled only recovery payloads against its unchanged synchronized base. Fresh rebuilt-Mac, signed-in production Opera, and cloud exports then matched exactly. Live records and the cloud revision remained unchanged. The previous app bundle, a consistent SQLite snapshot, and private sync state were retained outside Git before installation. See the [handoff](handoff.md#mac-rebuild-and-verification-completed) for exact revisions, counts, and evidence locations.

## Remaining device confirmations

These remain unverified individually, although the owner has accepted the phone's overall behavior:

1. Set up a separate remote QA library and a second physical device. Test physical network disconnection/reconnection and an offline edit surviving a complete process restart before reaching the other device. The completed same-Mac loopback tests are a separate result.
2. On that isolated remote fixture, confirm both update directions, delete/restore, and simultaneous-edit review on the actual Mac/phone or Mac/Windows combination. Review both copies before a whole-collection choice.
3. Compare fresh Windows and phone portable exports with the verified Mac/Opera/cloud records, including exact code, tags, relationship direction and approach IDs, image bytes, revisions, Trash, and legacy recovery. Do not repeat general phone verification.

Do not perform these checks by replacing the production library with an empty synthetic collection. New shared interface changes require a separate Mac rebuild and native verification at the exact released revision; website publication alone does not update the installed app.
