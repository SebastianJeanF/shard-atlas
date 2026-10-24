# Synchronization verification

The October 23, 2026 checkpoint began from latest GitHub main, `dd0d1c8c55fb6ad179174729ec63fb592864e47e`. No newer source was reset. The owner accepted the available-device gate after confirming the phone works, allowing code-reference milestones 5–6 to continue.

## Evidence and limits

| Check | Result | Scope |
| --- | --- | --- |
| Owner-private website | Passed | Sites confirmed the existing owner-only access policy and unchanged website URL. The owner completed the requested Windows sign-in. The application does not display an account email. |
| Actual Windows website | Passed | At the initial verification checkpoint, Opera GX loaded 245 shared shards and displayed **Library synced**, with matching device/cloud counts. A normal read-only export completed. The later content pilot and final counts are recorded in [the handoff](handoff.md). |
| Real export integrity | Passed | Unique record IDs, relationship/approach endpoints, decodable image bytes, and full import-preview validation passed. One displayed C++ implementation matched the exported source exactly. The export contained 272 links, 43 assets, 865 revisions, 149 Trash records, and 2 legacy boards. No import or personal-note mutation was used for this check. |
| Windows browser mutation flows | Passed with a local simulated cloud | The canonical interface and real IndexedDB ran at two isolated loopback origins. The actual Worker handler used disposable SQLite/object-storage adapters and synthetic identity. Both-direction updates, an offline edit surviving page reload, reconnect, deletion on one client, restoration on the other, and explicit concurrent-edit conflict review passed. Full portable snapshots matched the simulated cloud. |
| Automated rich two-store fixture | Passed | Exact C++ including Unicode/CRLF, tags, approach-scoped directed links, PNG bytes, revisions, Trash, and legacy board/review recovery were preserved. The separate actual Windows isolated-browser flow verified CRLF code and image display. All fixtures remained outside the personal library. |
| Phone | Owner-confirmed pass | The owner reported checking the actual phone and that it works. This was not phone automation. Individual phone offline/restart/conflict scenarios were not observed or separately attested by the agent. |
| Actual Mac | Earlier release evidence retained | Version 3.0.0 and its real migration were verified in the prior handoff. This Windows session did not access or rebuild the Mac. |
| Browser-process restart and physical network outage | Pending | The isolated test reloaded the page and interrupted cloud transport. It did not restart the entire Opera process or turn off the physical device network. |
| New exact Windows/Mac/phone export comparison | Pending | The prior Mac/Opera comparison remains the baseline. This session had a Windows export but no fresh Mac/phone exports. |

Screenshots, exports, fixture data, diagnostic logs, and credentials remain outside Git. No synthetic collection was attached to the production whole-library slot, and no whole-collection replacement was chosen for the real library.

## Automated checkpoint

- Windows Node.js 24.21.0: `npm test` passed all **116 test entries**, including **118 internal frontend checks** and **51 protocol/browser-sync tests**. Browser storage tests use fake IndexedDB; they are automated simulations.
- Windows Python 3.13: **217 supported tests ran: 209 passed and 8 had explicit OS/toolchain skips**, excluding the POSIX-protected native-sync module. Windows credential rejection was not bypassed.
- WSL Ubuntu 22.04, Python 3.10.12: the full Python suite ran **248 tests: 245 passed and 3 macOS Swift toolchain checks were skipped**. All **31 native-sync tests** passed with real POSIX permissions. This is Linux automated verification, not a Mac native check.
- The **4 source-transfer tests**, JavaScript syntax checks, and `git diff --check` passed.

The added two-store round trip combines offline/restart/reconnect, both update directions, exact implementation text, tags, directed approach relationships, images, deletion/restoration, revisions, Trash, and legacy recovery. Existing tests retain lost-response retries, stale-editor protection, explicit conflict choices, incompatible versions, authentication failures, immutable contribution receipts, and corruption rejection.

## Remaining device confirmations

These remain unverified individually, although the owner has accepted the phone's overall behavior:

1. With disposable QA data in an isolated library, save offline, close/reopen the entire browser or native app, reconnect, and confirm the change arrives on the second device.
2. Confirm both update directions, delete/restore, and simultaneous-edit review on the actual Mac/phone combination. Review both copies before a whole-collection choice.
3. Compare fresh portable exports across devices, including exact code, tags, relationship direction and approach IDs, image bytes, revisions, Trash, and legacy recovery.

Do not perform these checks by replacing the production library with an empty synthetic collection. New shared interface changes require a separate Mac rebuild and native verification at the exact released revision; website publication alone does not update the installed app.
