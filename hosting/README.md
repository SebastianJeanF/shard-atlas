# Shard Atlas hosted runtime

This folder supplies the private Sites Worker, D1 revision metadata, and R2 snapshot storage. The shared interface remains in `../static/`, and browser-only behavior remains in `../web/`.

Read [the cross-platform workflow](../docs/cross-platform.md) before publishing. The root `.openai/hosting.json` owns the existing Site identity and bindings. `tools/build_host.py` generates this folder’s private deployment manifest and public assets, builds the runtime, and copies the deployable artifact to root `dist/`.

Use the Sites dependency installer from this folder. For schema changes, edit `db/schema.ts`, run `npm run db:generate`, inspect the generated migration, and commit the SQL and metadata. Never edit an applied migration. Local preview databases are separate from the hosted library.

Generated assets, runtime files, local credentials, and dependency folders are ignored. Do not commit private Drive settings or library snapshots. Preserve the Sites `sites()` integration, dispatch-owned authentication, and request-scoped connector integration when changing the runtime.
