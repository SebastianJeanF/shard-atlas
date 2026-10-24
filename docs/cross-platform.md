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
4. Mirror the verified tracked source into the existing Sites source checkout, preserving its `.git` and ignored runtime files. Build there and use the Sites source helper to push and package the exact state.
5. Publish the matching artifact to the existing private Site and verify its deployment result. Record the source revision and release status in the handoff.

The production runtime uses `SHARD_ATLAS_OWNER_PRIVATE=true`, `SHARD_ATLAS_ALLOW_SERVICE_ACCESS=true`, `SHARD_ATLAS_OWNER_EMAIL`, and `SHARD_ATLAS_SERVICE_SECRET_SHA256`. Configure these through Sites runtime settings. The last value verifies a separate application service secret. Never expose a raw service secret in browser assets.

## Update the Mac app

Pull the released source revision, run the relevant checks, then run:

```sh
python3 desktop/build.py
open "Shard Atlas.app"
```

Close the previous app through its normal quit flow before reopening the rebuilt app. Preserve unsaved-edit prompts. The Mac app loads its bundled interface and local Python service, so publishing the website alone does not update the installed app. Verify its backend version and source revision after rebuilding.

For native testing, use `--output PATH --qa-db PATH` with a temporary database. Never run destructive tests against a personal collection.

## Library content and device state

Cloud capsules preserve the full portable archive, including current shards, typed relationships, approach identities, exact C++ text, images, revisions, Trash, and legacy recovery records. Contribution receipts travel with the library to prevent old inbox batches from recreating deleted notes.

Drafts, local database backups, import undo receipts, private connection settings, and sync outboxes remain device-local. A remote replacement creates a safety snapshot and preserves these local records. Closed apps catch up when reopened. Offline changes remain pending across restarts.

The first connection to an existing different collection requires explicit review. An empty browser can download the cloud library. Concurrent edits use conditional revision publication. Both snapshots survive a conflict, and the interface requires a choice rather than silently selecting a winner. A new edit after the preview invalidates that preview.

The Mac connection file is `library-sync.json` beside its SQLite database, readable only by its owner. It contains the fixed Site URL, existing Sites service access token, separate application service secret, and optional polling interval. Do not include it in an archive, browser response, Git commit, or chat. New devices require supported authenticated setup. Do not expose the loopback Python service to a network.

## Release checks

Check create, edit, delete, restore, image display, and exact code across two independent clients. Test offline edits, lost responses, simultaneous changes, expired sign-in, blocked incompatible versions, open editor protection, and retry after restart. Verify the real collection only through reads and backed-up migration steps. Keep all synthetic records in isolated databases and browser profiles.
