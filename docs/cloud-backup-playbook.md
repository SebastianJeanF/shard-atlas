# Cloud backups without a growing local archive

This guide records the Shard Atlas cutover completed on October 26, 2026, and the method another application, such as Next Move, can reuse. **Keep the working library on the device, synchronize saved work through the application's cloud service, and create dated recovery copies from that service into a separate Drive vault.** Google Drive for desktop is outside the normal library and backup delivery paths.

## Give each kind of data one purpose

| Data | Working location | Protection |
| --- | --- | --- |
| Application source | Local checkout outside Drive | Git and the existing GitHub repository |
| Installed application | Local Applications folder | Rebuild or reinstall from verified source |
| Working library | Application Support or browser storage | Offline use, normal cloud Library sync, recovery checkpoints |
| Private connection settings | Private device configuration | Keep outside Git and portable archives, provision separately |
| Dated recovery history | Private cloud storage and the shared Drive vault | Verified immutable archives and manifests |
| Dependencies, builds and QA profiles | Local development or maintenance folders outside Drive | Recreate when possible, archive unique evidence once |
| Emergency capture batches | Existing manual Drive Inbox | Explicit import with existing replay protection |

Git protects software. It does not contain personal shards, images, revisions, Trash or drafts. Synchronization makes current work available across devices. A backup preserves an older recovery point after a mistake has already synchronized. Revision history inside the live library is useful, but is not an independent backup of that library.

## What happens during normal use

The website and connected native apps exchange saved portable knowledge through the private hosted library. The hourly cloud task prepares the latest accepted cloud revision, skips an already verified revision, and copies new checkpoints into Drive. It runs in a cloud executor while the Mac is off or Drive desktop is paused. Hourly checks do not guarantee a particular completion minute.

Each normal recovery point uses **one gzip archive and one small JSON manifest**. The task freshly reads both uploaded files to completion, checks the manifest and compressed and expanded hashes and lengths, verifies destination and ownership, and only then acknowledges the exact Drive file ID. A filename, metadata response, hosted staging receipt or “upload succeeded” message alone does not meet that standard.

A portable library checkpoint contains saved shards, images, connections, saved revisions, Trash, legacy recovery records and immutable contribution receipts. Device recovery is separate. Native SQLite and browser checkpoints also preserve drafts and local import recovery that ordinary Library sync does not carry. Private connection credentials are provisioned separately.

Before protected operations, a cloud-managed device can temporarily stage its current recovery state and upload it to the hosted service. The native staging slot is bounded and retried after failure. Payloads are removed after a durable verified hosted receipt, without waiting for Drive desktop. That receipt is distinct from later **Drive verification**. Failure retains pending safety material and blocks an operation that requires protection. It must not silently discard it or resume unlimited local snapshot history.

**Cloud-only backup history does not mean zero local bytes.** The app, working database, browser storage, private settings and temporary recovery staging still occupy local space. Offline work is not in the cloud until it uploads. Losing a device before that upload can lose its unsynchronized changes.

## Keep ordinary Drive files local and recovery history off the Mac

The tested arrangement keeps the primary account's My Drive in **Mirror** mode. A second approved account owns a private vault outside the primary My Drive tree and shares it with the primary account. The primary account uploads and owns backup files, so those uploads use the primary account's allowance. Folder ownership and uploaded-file ownership are separate facts.

Do not add a My Drive shortcut to the vault, mark it for offline use, or connect its owning account to desktop mirroring without reviewing the storage effect. Manually opening or downloading a backup can still create a local copy. The arrangement was verified for the current Mac and two approved accounts, not guaranteed for every Drive configuration.

Before moving real recovery data, test a disposable file with a running client. Require both positive incoming controls and exclusion evidence:

1. Confirm Mirror mode, the actual account, process and physical root.
2. Download a cloud-created control and a renamed control and verify their exact bytes locally. This proves incoming changes are being processed.
3. Move the disposable folder into the proposed vault while preserving its IDs, content and ownership.
4. Verify the original local payload and its Mirror index relationships disappear, while control changes continue arriving.
5. Verify the destination's complete ancestry, effective access, uploaded-file owner and approved sharing.
6. Move real recovery folders only after those checks pass, preserve IDs and verify every item again.

Absence while paused is inconclusive. This cutover initially failed the incoming controls. A Mac restart restored incoming processing, after which the controls and actual Recovery exclusion passed. That is an observed repair for this incident, not proof that restarting resolves every Drive error. The original paused desktop state was restored.

## Results of this cutover

The accepted library remained unchanged: **253 shards, 280 links, 43 assets, 873 revisions, 149 Trash records and 2 legacy boards**. Complete comparisons covered all ten native SQLite tables and the schema, not counts alone. The current portable backup also preserved all eleven contribution receipts. Actual isolated restore checks used the real recovery handlers without restoring into production.

The first two normal cloud runs were invoked with **Run now** on the active hourly task. They ran in Linux, completed native Drive upload, full readback and acknowledgment, and cleaned temporary cloud files without Mac storage. An earlier scheduled Linux diagnostic independently established timer execution and read access. At final catalog verification, all six checkpoints were verified and none was pending.

The recovery tree contained **35 files totaling 3,584,536,749 logical bytes, about 3.58 GB**, across four recovery folders including the root. This includes one-time historical preservation archives. The automatic folder held six archive/manifest pairs. This is a dated inventory, not a limit or a projection of future use.

The current portable library compressed from about 11.28 MB to 6.18 MB. A native device checkpoint compressed from 55.22 MB to 44.99 MB. The ten older snapshot parts are a one-time preservation format, not the normal format for each new backup.

The verified cleanup removed **10,028 retired backup, duplicate and QA files totaling 21,706,441,103 logical bytes, about 21.71 GB**. Local library backup history is empty. Recovery staging contains only a 487-byte receipt. See the current [handoff](handoff.md) for the execution record. Logical file sizes do not necessarily equal physical space reclaimed because filesystem compression, shared blocks and concurrent disk activity affect that measurement.

## Remove old copies only after proving recovery

Inventory first. Classify each candidate as active working data, unique recovery history, reproducible source/build output, private configuration or expendable temporary material. Preserve unique material before deletion. Do not assume an old folder is disposable because a newer app exists.

Keep a private immutable plan with exact paths, lengths, hashes and stable file identities. Bind every removal to either a complete verified remote copy or an exact reachable Git object for reproducible source. When repacking an archive, verify every original member. Equivalent member contents do not establish byte identity of the original compressed container.

Use fresh service, device and restore checks before cutover. Delete only allowlisted, owned, regular, single-link files with unchanged bytes and path identities. Refuse symlinks and changed files. Defer an entire group if an application has it open. Write and flush an intent before unlinking and an outcome afterward. Stop on journal failure. Newly created backups outside the frozen plan need their own proof and explicit cleanup scope.

After cleanup, compare the complete working records and schema, verify protected settings, inspect the staging slot, check real application status and retain the small audit receipts outside Git. Never apply test data or an automated restore to the production library. Routine retention never permanently deletes Drive data.

## Retention and compression

The active policy selects 24 hourly, 30 daily and 12 monthly recovery points. Older verified archive/manifest pairs move together into **Older backups**. This is archive-only retention, so total cloud history can continue growing. It is not a fixed storage quota or automatic permanent deletion policy. Hosted staging and checkpoint storage have a separate lifecycle and must be monitored too.

Compression is still useful with ample cloud capacity because fewer bytes mean less transfer and temporary processing. It is not what keeps history off the Mac. The earlier content-deduplicating repository proposal was not implemented. This design uses complete compressed checkpoints and skips unchanged verified library revisions. Reconsider deduplication only if measured transfer or cloud growth justifies its added restore and maintenance complexity.

## Apply the method to Next Move

1. Identify the actual live authority, offline database, private settings, Git checkout and every synchronized directory. Include folders such as Documents that may be backed up by Drive separately.
2. Inventory and measure file count, logical bytes, change rate and recoverability. Move dependencies, build output and browser profiles outside Drive before adding sophisticated compression.
3. Define portable cloud recovery and device-only recovery separately. Preserve drafts, pending changes, attachments, history, deletion recovery and idempotency receipts where applicable.
4. Implement immutable checkpoints, bounded staging, retry-safe uploads, full readback verification, visible pending/failed/current states and a real isolated restore path.
5. Prove the cloud executor and destination with a harmless round trip. Test mirror exclusion using positive controls before moving any real history.
6. Enable the new policy only after verified library and device recovery exist. Keep protection on unconfigured or older clients until their own cutover is verified.
7. Offload old unique history, execute a fixed cleanup plan, compare complete live data afterward and document exact evidence and limits.

For Next Move's rare cross-device conflicts, retain both snapshots and require manual reconciliation. This backup design does not authorize adding automatic conflict merging. The emergency Drive import route stays separate from ordinary cross-device synchronization.

## Operate and recover

Open **Backup & export → View backups → Refresh status** to inspect the latest Drive-verified saved library. **Library synced** describes live synchronization. **Drive backup verified** describes a recovery point. Their dates can differ legitimately when no saved cloud revision has changed.

For a restore, review the selected checkpoint and the replacement scope, preserve the current collection first, and explicitly confirm the reviewed restore. A restored whole library replaces the selected saved state. Devices with unfinished changes require review. A full device snapshot has broader local-state coverage than a portable library archive.

If backup maintenance fails, retain the last verified copies and pending material, report the actual failure, and retry through the supported owner connection. Do not redirect backups into a mirrored fallback, change sharing, disable protection or delete the working library to clear an error. Credentials, scoped tickets, signed download URLs and personal payloads must stay out of Git and routine task output.

Implementation entry points: [native policy and staging](../cloud_backups.py), [browser policy](../web/backup-policy.mjs), [hosted catalog and recovery](../hosting/lib/cloud-backups.mjs), [cloud runner](../tools/cloud_backup_runner.py), and [release and device guidance](cross-platform.md).
