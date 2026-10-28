# Shard Atlas hosted runtime

This folder supplies the private Sites Worker, D1 revision metadata, and R2 snapshot storage. The shared interface remains in `../static/`, and browser-only behavior remains in `../web/`.

Read [the cross-platform workflow](../docs/cross-platform.md) before publishing. The root `.openai/hosting.json` owns the existing Site identity and bindings. `tools/build_host.py` generates this folder’s private deployment manifest and public assets, builds the runtime, and copies the deployable artifact to root `dist/`.

Use the Sites dependency installer from this folder. For schema changes, edit `db/schema.ts`, run `npm run db:generate`, inspect the generated migration, and commit the SQL and metadata. Never edit an applied migration. Local preview databases are separate from the hosted library.

Generated assets, runtime files, local credentials, and dependency folders are ignored. Do not commit private Drive settings or library snapshots. Preserve the Sites `sites()` integration, dispatch-owned authentication, and request-scoped connector integration when changing the runtime.

## Remote image saves

The private MCP exposes native file-input staging, upload status, and atomic image attachments on the separate add/edit tools. `image-uploads.mjs` verifies temporary private downloads before storing immutable owner-bound bytes. D1 request reservations bound concurrent staging and retries. Uploads expire after 24 hours, while retained staging bytes remain bounded to 96 MiB. Expiry does not delete bytes or free that quota. Staging contains at most 4,096 request records and 64 active uploads. Physical cleanup needs coordinated maintenance, since deleting a source during an in-flight save is unsafe.

`cloud-capsule.mjs` streams embedded image strings around the 16 MiB metadata limit, retaining portable capsule v1, 4 MiB chunks, full snapshot checksums, and the existing 256 MiB library limit. It preserves original image bytes and opaque recovery fields. New image assets join a single revision-checked shard commit. A successful upload alone never changes the library. Accepted immutable receipts permit replay after staging expires and preserve later edits or deletions.

`shard_atlas_verify_image_workflow` runs an owner-authorized integration check in a fixed isolated library selected by an internal Symbol. Public arguments cannot choose a library namespace. The check verifies new and existing shard image saves, exact image hashes, and retries without writing the personal library head.

The native file-input descriptor follows the [official OpenAI file-input contract](https://developers.openai.com/plugins/reference). Temporary downloads currently accept private `*.oaiusercontent.com` HTTPS hosts. A real connected-client handoff is a release check because the host selects the actual download address. Never invent one or treat a mocked download as proof of platform delivery.
