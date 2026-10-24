# Cross-platform development and private library sync

**One repository owns the shared interface, both storage adapters, and the private hosted service.** Windows develops and publishes the website. macOS rebuilds the native app from the same source revision.

## Source ownership

| Location | Responsibility |
| --- | --- |
| `static/` | Shared interface, code references, courses, experiments, and relationship views |
| `static/platform.js` | Explicit device boundary for requests, images, native integrations, and wording |
| `web/` | Browser adapter, IndexedDB storage, phone layout, Drive inbox, offline shell, and sync coordinator |
| `server.py`, `library_sync.py` | Mac SQLite storage and private cloud synchronization |
| `desktop/` | Native Mac window, dialogs, clipboard, and app builder |
| `sync/` | Versioned cloud protocol, client, D1 revision bookkeeping, and R2 snapshot storage |
| `hosting/` | Sites Worker runtime, generated D1 migrations, and hosting build dependencies |
| `tools/build_web.py`, `tools/build_host.py` | Deterministic browser composition and hosted artifact generation |

Edit shared interface files once. `web-dist/`, `hosting/public/`, `dist/`, and app bundles are generated output. Never maintain a second edited copy of `app.js`. Each computer should have its own Git checkout. Use commits and branches to transfer source rather than concurrently editing a Drive-synchronized checkout.

## Set up on Windows or Mac

Install Git, Python 3.10 or later, and a current Node.js release supporting `node:sqlite`. Node.js 24 or later is recommended for the complete test suite. The native build also requires macOS 12 or later and Xcode Command Line Tools.

```sh
git clone https://github.com/SebastianJeanF/shard-atlas.git
cd shard-atlas
npm ci
npm test
```

Build the browser interface with `npm run build:web`. For a static local preview, serve `web-dist/` on `127.0.0.1`. That preview has local storage but no production cloud identity or cloud database.

Run the Python persistence checks with `python3 -m unittest discover -s tests -v`. On Windows, use `py -3` if `python3` is not available.

## Publish the existing website

The tracked `.openai/hosting.json` identifies the existing Site and its `DB` and `BUCKET` bindings. **Preserve its identity and owner-private access.** Source access and publication use the Sites skill and a fresh source credential. Never store that credential in Git or a handoff document.

1. Install hosting dependencies through the Sites skill's dependency installer from `hosting/`.
2. Build using `python3 tools/build_host.py`. Supply `--drive-config PATH` for private Drive deployment settings. Those settings remain outside tracked source.
3. For schema changes, edit `hosting/db/schema.ts`, run `npm run db:generate` from `hosting/`, inspect the generated SQL, and commit the migration and metadata. Applied migrations are immutable.
4. After opening the existing Sites source checkout with the Sites helper, use `python3 tools/prepare_site_source.py --checkout PATH` to copy the verified tracked source and matching built artifact. The helper checks project identity and working-tree safety, preserving `.git` and ignored runtime files. Then use the Sites source helper to push and package the exact state.
5. Publish the matching artifact to the existing private Site and verify its deployment result. Record the source revision and release status in the handoff.

The production runtime uses `SHARD_ATLAS_OWNER_PRIVATE=true`, `SHARD_ATLAS_ALLOW_SERVICE_ACCESS=true`, `SHARD_ATLAS_OWNER_EMAIL`, and `SHARD_ATLAS_SERVICE_SECRET_SHA256`. Configure these through Sites runtime settings. The last value verifies a separate application service secret. Never expose a raw service secret in browser assets.

Preserve the deployment's existing private `drive-config.json` when publishing. Obtain it through authenticated access to the current Site and supply its private local path with `--drive-config`. A build without that option uses blank public defaults, so a publisher must not accidentally reset an existing deployment's Drive settings.

## Update the Mac app

Fetch and safely fast-forward the latest main containing the released application revision, preserve local changes, and run the relevant checks. Make a consistent private database backup before updating the working app. Quit the previous app normally so its unsaved-change protection can run, then build and reopen:

```sh
python3 desktop/build.py
open "Shard Atlas.app"
```

Preserve unsaved-edit prompts. The Mac app loads its bundled interface and local Python service, so publishing the website alone does not update the installed app. Verify `Contents/Resources/runtime/static/build-info.json`, the running service's `/build-info.json`, backend version, and bundled backend source bytes after rebuilding. Record the actual bundled revision separately from later documentation commits.

For native testing, use `--output PATH --qa-db PATH` with a temporary database. Never run destructive tests against a personal collection.

Native sync validates incoming historical snapshots and Trash before retaining their original payload fields. Older clients may have inserted empty modern fields into legacy recovery records. A guarded check can reconcile that representation with the current cloud base only when live records match exactly, each differing recovery record equals the validated cloud record, no edit is open, and the local fingerprint remains unchanged. It makes a safety backup, changes only recovery payloads, and does not publish or advance the cloud base. A real content difference is never repaired by guessing.

## Library content and device state

Cloud capsules preserve the full portable archive, including current shards, typed relationships, approach identities, exact C++ text, images, revisions, Trash, and legacy recovery records. Contribution receipts travel with the library to prevent old inbox batches from recreating deleted notes.

Drafts, local database backups, import undo receipts, private connection settings, and sync outboxes remain device-local. A remote replacement creates a safety snapshot and preserves these local records. Closed apps catch up when reopened. Offline changes remain pending across restarts.

The first connection to an existing different collection requires explicit review. An empty browser can download the cloud library. Concurrent edits use conditional revision publication. Both snapshots survive a conflict, and the interface requires a choice rather than silently selecting a winner. A new edit after the preview invalidates that preview.

The Mac connection file is `library-sync.json` beside its SQLite database, readable only by its owner. It contains the fixed Site URL, existing Sites service access token, separate application service secret, and optional polling interval. Do not include it in an archive, browser response, Git commit, or chat. New devices require supported authenticated setup. Do not expose the loopback Python service to a network.

## Release checks

Check create, edit, delete, restore, image display, and exact code across two independent clients. Test offline edits, lost responses, simultaneous changes, expired sign-in, blocked incompatible versions, open editor protection, and retry after restart. Verify the real collection only through reads and backed-up migration steps. Keep all synthetic records in isolated databases and browser profiles.

## Efficient updates and verification

**Apply this workflow to every application update without waiting for the user to repeat it.** Keep the release checks above and use the following steps to avoid repeated work.

1. **Establish the inputs once.** Safely fetch the latest source, preserve local changes, and read the current handoff and verification record. Identify changed components and their dependencies before selecting checks. Preflight the toolchain, isolated fixtures, browser profile, and available physical devices together.
2. **Reuse isolated QA tooling.** Reuse existing synthetic fixtures and scenario scripts for service startup, readiness, mutations, process restarts, exact comparisons, and cleanup. Give each run isolated writable state. Keep personal exports, credentials, backups, profiles, and screenshots outside Git and the working collection. Only sanitized reusable scripts and synthetic fixtures may enter Git. Synthetic synchronization must use an explicitly isolated fixture and must never reach the production whole-library slot.
3. **Iterate with focused checks.** Run the affected tests while fixing an issue. Once the application code is final, run the full applicable Python and JavaScript suites, including Swift checks on macOS. Run independent suites concurrently while the source stays fixed and their databases, ports, profiles, and output directories remain separate. Serialize operations that replace shared generated output. Repeat checks when later changes, failures, or unresolved concerns invalidate the evidence.
4. **Reuse evidence by actual inputs.** Record the source revision, relevant file hashes including uncommitted changes, toolchain, fixture version, and results. Carry forward a workflow result only when all its relevant inputs and dependencies are unchanged. Rerun affected integration checks after backend changes. A matching interface hash alone does not establish unchanged synchronization or native bridge behavior.
5. **Avoid redundant compilation and packaging.** Where a verified compilation cache exists, key each Swift executable by source, compiler, SDK, architecture, and flags. Keep QA and working configurations separate, then assemble, sign, and verify every final bundle. Reuse generated browser output only after validating its complete inputs and deployment configuration. Record whether an optimization is available or still proposed. Documentation-only changes do not require rebuilding or republishing unchanged application content.
6. **Focus real UI verification.** Automate fixture setup and protocol actions. Exercise changed native clipboard, dialogs, rendering, close/quit protection, and conflict confirmation through the real UI, including changes to their dependencies. Coordinate UI automation on the shared computer. API success, simulated layouts, and actual-device checks remain distinct evidence.
7. **Keep exact comparison and installation gates.** Compare complete portable records by stable ID, detect duplicates, and preserve exact code, tags, relationship direction and approach IDs, decoded image bytes, revisions, Trash, and legacy recovery. Keep missing fields distinct from empty fields. Before updating the working app, make a consistent private backup and quit normally. Verify the reopened final bundle and backend revision, **Library synced**, and intact knowledge. Earlier record counts are checkpoints, not restoration targets.
8. **Prepare device checks together and report scope.** Use a separate remote QA library for physical network and second-device scenarios. Retain earlier owner-confirmed phone results without asking for another general phone check. Mark unavailable specific scenarios pending. Update the handoff with phase timings, reused and newly executed evidence, actual bundled revision, build/install outcomes, and remaining checks. Keep reusable tooling improvements proportional to the task.
