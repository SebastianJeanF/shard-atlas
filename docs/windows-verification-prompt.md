# Check Shard Atlas on Windows

Check that this Windows computer has the complete Shard Atlas synchronization and app freshness features released on October 25, 2026. Use the existing private website at https://shard-atlas.deltamaster64.chatgpt.site and the canonical private repository `SebastianJeanF/shard-atlas`. Read `AGENTS.md`, `docs/cross-platform.md`, `docs/handoff.md`, and `docs/sync-verification.md` first. Compare against the full guide at https://docs.google.com/document/d/1RIb2LmrWU8Y34v0zmrWz138aUAPKAk8zTJvG9_-lkms/edit.

**Preserve my knowledge and unfinished work.** Inspect the current checkout and browser state before updating. Preserve local changes, safely fetch the latest main, and record the checked commit. Export the current Windows library before any browser update or migration. Use Opera GX unless I specify another browser. Finish or retain open edits before closing all Shard Atlas website windows and reopening. Never clear website storage to update the app.

## Verify the real Windows installation

1. Confirm separate visible **Library sync** and **App version** controls. The app version check should establish **App up to date** only after successfully reading the authenticated published manifest. Inspect `/api/release` and `/api/sync/release`, verify identical manifests and `Cache-Control: no-store, private`, and compare the loaded interface identity with the published `frontendId`. Record `releaseId`, component fingerprints, and the actual browser/PWA in use. A newer Git commit or matching shard count does not prove that the open page is current.
2. Check the update banner, version details, and **Check again** control. Confirm checks run at startup, every 60 seconds while visible, on focus, and on connectivity changes. A waiting offline website update should explain that all website windows must close before reopening. It must preserve unsaved work and avoid forcibly activating a new service worker over other windows.
3. Confirm Library sync reports the current accepted cloud revision and recent check time. Incoming saved data must be detected while editing, with the editor retained until it is safe to apply. Pending, offline, unconnected, sign-in, incompatible-version, unavailable-check, and conflict states must be truthful. A failed or expired check must not retain **Library synced** as a freshness claim.
4. Export the real Windows library read-only and compare complete records by stable ID with the accepted cloud snapshot. Check exact code and line endings, tags, directed relationships and approach IDs, decoded image bytes, saved revisions, Trash, legacy records, and contribution receipts. Keep exports and credentials outside Git. Record actual counts as evidence, without treating historical counts as restoration targets.

## Exercise failure scenarios with isolated data

Run the applicable JavaScript and Python suites, accounting for Windows toolchain restrictions. Use isolated browser profiles, temporary databases, and a separate synthetic cloud fixture to check both update directions, deletion/restoration, simultaneous saves, retained conflicts, lost-response retry with the same mutation ID, offline edits surviving a complete process restart, corrupt chunks, incompatible versions, revoked authentication, and first connection to different existing data. Check complete portable records and unchanged outbox bases after blocked operations.

Simulate an old loaded interface and an unavailable release endpoint. Verify the visible update and uncertainty states, the unsaved-work reload guard, and narrow-screen layout. Keep simulation results distinct from actual physical-network results. Perform physical disconnect/reconnect and second-device scenarios only against a separate remote QA library. If that fixture or device is unavailable, mark the exact scenario pending. Do not replace or edit the production library to demonstrate synchronization.

Browser sign-in does not require copying the Mac's private connection file. If a native service is intentionally paired later, use a distinct device secret through supported setup, retaining the existing device digests. The configured digest allowlist must support revocation without rotating other devices. Never print credentials or include them in screenshots or reports.

Mac-only compiled-window and loaded Python backend checks are **not applicable to the Windows browser/PWA**. Do not report those as Windows failures or imply a native Windows executable exists. Verify their automated coverage where the toolchain permits, and retain the Mac release evidence in the handoff.

## Report the result

Return a concise table with each guide requirement, **Pass / Missing / Pending / Not applicable**, evidence, source/deployment identity, and scope: automated, simulated, actual Windows, actual second device, or owner-confirmed. Identify any remaining user action. Do not call a scenario passed solely because its test exists. This request authorizes safe local/browser updates and verification, but does not require changing application code or republishing the website. Report any implementation gap before making a new release.
