import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {gzipSync} from 'node:zlib';
import {LibraryStorage} from '../sync/storage.mjs';
import {preparePendingSnapshot} from '../sync/client.mjs';
import {sha256, CHUNK_BYTES} from '../sync/protocol.mjs';
import {CloudBackupError, prepareLibraryBackup, prepareDeviceBackup, listCloudBackups, cloudBackupStatus, acknowledgeCloudBackup,
  failCloudBackup, archiveCloudBackup, requestCloudRestore, listCloudRestores, prepareCloudRestore, commitCloudRestore, handleCloudBackupRequest} from '../hosting/lib/cloud-backups.mjs';

const STAMP = '2026-10-26T18:00:00.000Z';
const IDENTITY = {userId: 'owner-user', email: 'owner@example.test'};
const OPTIONS = {identity: IDENTITY, now: () => STAMP};
const encode = value => new TextEncoder().encode(value);
const capsule = (title = 'Saved content') => ({format: 'shard-atlas-library', version: 1, archive: {
  schemaVersion: 1, shards: [{id: 'note', title, content: '\nC++ exact text\r\n\treturn x;\n', tags: ['C++']}], links: [], reviews: [], boards: [], assets: [{id: 'image', data: 'BASE64'}],
  revisions: [{id: 'revision', snapshot: {title: 'Earlier'}}], trash: [{id: 'trash', shard: {id: 'deleted'}}], futureMetadata: {exact: ['keep']}},
  contributionReceipts: [{requestId: 'old-batch', batchFingerprint: 'keep'}], futureTopLevel: {preserve: true}});
function fixture(t) {
  const sqlite = new DatabaseSync(':memory:'); sqlite.exec(readFileSync(new URL('../sync/schema.sql', import.meta.url), 'utf8')); t.after(() => sqlite.close());
  const objects = new Map(), controls = {loseNextBatch: false, beforeBatch: null, failRead: false};
  const DB = {prepare(sql) {return {bind(...values) {return {
    async first() {if (controls.failRead) throw new Error('PRIVATE_DATABASE'); return sqlite.prepare(sql).get(...values) || null;},
    async all() {return {results: sqlite.prepare(sql).all(...values)};},
    execute() {return {results: sqlite.prepare(sql).all(...values)};},
  };}};}, async batch(statements) {
    const before = controls.beforeBatch; controls.beforeBatch = null; if (before) await before();
    sqlite.exec('BEGIN'); let result;
    try {result = statements.map(statement => statement.execute()); sqlite.exec('COMMIT');} catch (error) {sqlite.exec('ROLLBACK'); throw error;}
    if (controls.loseNextBatch) {controls.loseNextBatch = false; throw new Error('PRIVATE_LOST_REPLY');} return result;
  }};
  const BUCKET = {async head(key) {return objects.has(key) ? {size: objects.get(key).byteLength} : null;},
    async get(key) {const bytes = objects.get(key); return bytes ? {size: bytes.byteLength, body: new Response(bytes).body} : null;},
    async put(key, value) {objects.set(key, new Uint8Array(value));}};
  const env = {DB, BUCKET, SHARD_ATLAS_OWNER_PRIVATE: 'true', SHARD_ATLAS_OWNER_EMAIL: IDENTITY.email,
    SHARD_ATLAS_BACKUP_SIGNING_SECRET: 'synthetic-signing-secret-at-least-thirty-two-bytes', SHARD_ATLAS_CLOUD_BACKUPS_ENABLED: 'false'};
  const storage = new LibraryStorage(DB, BUCKET);
  let n = 0;
  async function publish(value, baseRevision) {
    baseRevision ??= await storage.head();
    const pending = await preparePendingSnapshot(value, baseRevision, 'fixture-mutation-' + ++n);
    for (const chunk of pending.chunks) await storage.putBlob(chunk.sha256, chunk.data);
    return storage.publish({id: 'fixture-revision-' + ++n, mutationId: pending.mutationId, baseRevision,
      fingerprint: await sha256(encode(JSON.stringify({baseRevision, manifest: pending.manifest}))), manifest: pending.manifest, createdAt: STAMP});
  }
  const request = (path, {method = 'GET', body, headers = {}} = {}) => new Request('https://atlas.example.test/api/cloud-backups' + path, {
    method, headers: {'oai-authenticated-user-id': IDENTITY.userId, 'oai-authenticated-user-email': IDENTITY.email, ...headers}, ...(body !== undefined ? {body: typeof body === 'string' || body instanceof Uint8Array ? body : JSON.stringify(body)} : {})});
  return {env, sqlite, objects, controls, storage, publish, request};
}
async function rejects(call, code) {await assert.rejects(call, error => {assert.ok(error instanceof CloudBackupError); assert.equal(error.code, code); assert.doesNotMatch(error.message, /PRIVATE_|SELECT |device-blobs/); return true;});}
async function acknowledge(f, prepared) {
  return acknowledgeCloudBackup(f.env, {checkpointId: prepared.checkpoint.id, driveFileId: 'drive-file-' + prepared.checkpoint.id,
    sourceSha256: prepared.checkpoint.manifest.sha256, compressedSha256: 'a'.repeat(64), compressedBytes: 128,
    verifiedAt: STAMP, verification: 'download-sha256', counts: {shards: 1, assets: 1, revisions: 1, trash: 1}}, OPTIONS);
}
async function sourceBackup(f, title = 'Original') {
  const source = await f.publish(capsule(title));
  const prepared = await prepareLibraryBackup(f.env, {requestId: 'backup-' + title}, OPTIONS);
  await acknowledge(f, prepared);
  return {source, prepared};
}

test('complete cloud backup preserves raw full capsule without using the AI reader', async t => {
  const f = fixture(t), original = capsule(), published = await f.publish(original);
  const prepared = await prepareLibraryBackup(f.env, {requestId: 'backup-one'}, OPTIONS);
  assert.equal(prepared.checkpoint.sourceRevision, published.id);
  assert.equal(prepared.skip, false); assert.equal(prepared.checkpoint.status, 'uploading');
  const chunk = prepared.checkpoint.manifest.chunks[0];
  const response = await handleCloudBackupRequest(new Request('https://atlas.example.test' + prepared.transfer.chunkPath.replace('{sha256}', chunk.sha256), {
    headers: {'X-Shard-Atlas-Backup-Ticket': prepared.transfer.ticket}}), f.env, OPTIONS);
  assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store, private');
  assert.deepEqual(await response.json(), original);
  assert.equal(await f.storage.head(), published.id);
  assert.equal(f.sqlite.prepare('SELECT count(*) AS n FROM library_commits').get().n, 1);
});

test('export rejects missing, altered, expired, cross-purpose, wrong-owner and out-of-manifest tickets', async t => {
  const f = fixture(t); await f.publish(capsule());
  const backup = await prepareLibraryBackup(f.env, {}, OPTIONS), hash = backup.checkpoint.manifest.chunks[0].sha256;
  const call = (ticket, target = hash, env = f.env, options = OPTIONS) => handleCloudBackupRequest(new Request('https://atlas.example.test' + backup.transfer.chunkPath.replace('{sha256}', target), {headers: ticket ? {'X-Shard-Atlas-Backup-Ticket': ticket} : {}}), env, options);
  assert.equal((await call(null)).status, 403);
  assert.equal((await call(backup.transfer.ticket + 'x')).status, 403);
  assert.equal((await call(backup.transfer.ticket, 'b'.repeat(64))).status, 403);
  assert.equal((await call(backup.transfer.ticket, hash, {...f.env, SHARD_ATLAS_OWNER_EMAIL: 'different@example.test'})).status, 403);
  assert.equal((await call(backup.transfer.ticket, hash, f.env, {...OPTIONS, now: '2026-10-26T20:00:00Z'})).status, 403);
  assert.equal((await call(backup.transfer.ticket, hash, {...f.env, SHARD_ATLAS_OWNER_PRIVATE: 'false'})).status, 503);
});

test('owner authentication and cross-origin protections are independent from service dispatch', async t => {
  const f = fixture(t); await f.publish(capsule());
  assert.equal((await handleCloudBackupRequest(new Request('https://atlas.example.test/api/cloud-backups/status'), f.env)).status, 401);
  assert.equal((await handleCloudBackupRequest(f.request('/status', {headers: {'oai-authenticated-user-email': 'intruder@example.test'}}), f.env)).status, 403);
  assert.equal((await handleCloudBackupRequest(f.request('/request', {method: 'POST', body: {}, headers: {origin: 'https://evil.example'}}), f.env)).status, 403);
  assert.equal((await handleCloudBackupRequest(f.request('/request', {method: 'POST', body: {}}), f.env)).status, 200);
  assert.equal(await handleCloudBackupRequest(new Request('https://atlas.example.test/api/other'), f.env), null);
});

test('leases avoid competing uploads; same request resumes and expired leases can be reclaimed', async t => {
  const f = fixture(t); await f.publish(capsule());
  const first = await prepareLibraryBackup(f.env, {requestId: 'worker-one'}, OPTIONS);
  const competing = await prepareLibraryBackup(f.env, {requestId: 'worker-two'}, OPTIONS);
  assert.equal(competing.checkpoint.id, first.checkpoint.id); assert.equal(competing.busy, true); assert.equal(competing.skip, true);
  assert.equal((await prepareLibraryBackup(f.env, {requestId: 'worker-one'}, OPTIONS)).skip, false);
  assert.equal((await prepareLibraryBackup(f.env, {requestId: 'worker-two'}, {...OPTIONS, now: '2026-10-26T18:16:00Z'})).skip, false);
  assert.equal(f.sqlite.prepare('SELECT count(*) AS n FROM backup_checkpoints').get().n, 1);
});

test('verified Drive receipts are immutable, idempotent, and distinct from staged cloud durability', async t => {
  const f = fixture(t); await f.publish(capsule());
  const prepared = await prepareLibraryBackup(f.env, {requestId: 'worker'}, OPTIONS);
  const bad = {checkpointId: prepared.checkpoint.id, sourceSha256: 'b'.repeat(64), verification: 'download-sha256'};
  await rejects(() => acknowledgeCloudBackup(f.env, bad, OPTIONS), 'verification_required');
  const result = await acknowledge(f, prepared); assert.equal(result.driveVerified, true);
  const again = await acknowledge(f, prepared); assert.equal(again.checkpoint.verifiedAt, STAMP);
  const next = await prepareLibraryBackup(f.env, {requestId: 'later-worker'}, OPTIONS); assert.equal(next.skip, true);
  await rejects(() => acknowledgeCloudBackup(f.env, {checkpointId: prepared.checkpoint.id, sourceSha256: prepared.checkpoint.sha256,
    compressedSha256: 'a'.repeat(64), compressedBytes: 129, driveFileId: result.checkpoint.driveFileId, verifiedAt: STAMP, verification: 'download-sha256'}, OPTIONS), 'receipt_mismatch');
});

test('cloud policy is not activated by publishing configuration alone', async t => {
  const f = fixture(t); await f.publish(capsule());
  let status = await cloudBackupStatus(f.env, {}, OPTIONS);
  assert.equal(status.configured, true); assert.equal(status.managed, false); assert.equal(status.localHistoryAllowed, true);
  const prepared = await prepareLibraryBackup(f.env, {}, OPTIONS); await acknowledge(f, prepared);
  f.env.SHARD_ATLAS_CLOUD_BACKUPS_ENABLED = 'true'; status = await cloudBackupStatus(f.env, {}, OPTIONS);
  assert.equal(status.managed, true); assert.equal(status.localHistoryAllowed, false); assert.equal(status.state, 'current');
  assert.equal(status.lastVerified.driveVerified, true); assert.equal(status.lastVerified.counts.shards, 1);
  await f.publish(capsule('Later edit')); assert.equal((await cloudBackupStatus(f.env, {}, OPTIONS)).state, 'pending');
  const unavailable = await cloudBackupStatus({...f.env, SHARD_ATLAS_BACKUP_SIGNING_SECRET: ''}, {}, OPTIONS);
  assert.equal(unavailable.managed, false); assert.equal(unavailable.localHistoryAllowed, true);
});

test('device snapshots require all verified chunks and return real cloud references only after durability', async t => {
  const f = fixture(t), raw = encode('SQLite format 3\u0000synthetic consistent device checkpoint'), compressed = new Uint8Array(gzipSync(raw)), hash = await sha256(compressed);
  const args = {requestId: 'device-snapshot-one', deviceId: 'mac-device', format: 'shard-atlas-device-sqlite-gzip',
    sha256: hash, bytes: compressed.byteLength, originalSha256: await sha256(raw), originalBytes: raw.length, chunks: [{sha256: hash, bytes: compressed.byteLength}]};
  await rejects(() => prepareDeviceBackup(f.env, args, OPTIONS), 'missing_chunk');
  let response = await handleCloudBackupRequest(f.request('/device-snapshots/blobs/' + hash, {method: 'PUT', body: encode('wrong')}), f.env, OPTIONS);
  assert.equal(response.status, 422);
  response = await handleCloudBackupRequest(f.request('/device-snapshots/blobs/' + hash, {method: 'PUT', body: compressed}), f.env, OPTIONS); assert.equal(response.status, 200);
  const receipt = await prepareDeviceBackup(f.env, args, OPTIONS);
  assert.equal(receipt.durable, true); assert.equal(receipt.verified, true); assert.equal(receipt.driveVerified, false); assert.equal(receipt.status, 'staged');
  assert.equal(receipt.filename, 'cloud:' + receipt.id); assert.equal(receipt.sourceHash, hash);
  assert.equal((await prepareDeviceBackup(f.env, args, OPTIONS)).id, receipt.id);
  const transfer = await prepareLibraryBackup(f.env, {checkpointId: receipt.id}, OPTIONS); assert.equal(transfer.checkpoint.kind, 'device');
  response = await handleCloudBackupRequest(new Request('https://atlas.example.test' + transfer.transfer.chunkPath.replace('{sha256}', hash), {headers: {'X-Shard-Atlas-Backup-Ticket': transfer.transfer.ticket}}), f.env, OPTIONS);
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), compressed);
  assert.equal((await listCloudBackups(f.env, {kind: 'device'}, OPTIONS)).items.length, 1);
});

test('backup failures remain visible; archive-only retention preserves verified recovery references', async t => {
  const f = fixture(t); await f.publish(capsule()); const prepared = await prepareLibraryBackup(f.env, {}, OPTIONS);
  await failCloudBackup(f.env, {checkpointId: prepared.checkpoint.id, code: 'verification_failed'}, OPTIONS);
  assert.equal((await cloudBackupStatus(f.env, {}, OPTIONS)).state, 'attention');
  await rejects(() => archiveCloudBackup(f.env, {checkpointId: prepared.checkpoint.id, folderId: 'older-folder'}, OPTIONS), 'verification_required');
  await acknowledge(f, prepared);
  const archived = await archiveCloudBackup(f.env, {checkpointId: prepared.checkpoint.id, folderId: 'older-folder'}, OPTIONS);
  assert.equal(archived.permanentDeletion, false); assert.equal(archived.checkpoint.status, 'archived'); assert.ok(archived.checkpoint.driveFileId);
});

async function restoration(f) {
  const {source, prepared} = await sourceBackup(f);
  const current = await f.publish(capsule('Current changed content'));
  await requestCloudRestore(f.env, {requestId: 'restore-one', checkpointId: prepared.checkpoint.id, expectedRevision: current.id}, OPTIONS);
  const target = capsule('Original'); target.contributionReceipts.push({requestId: 'newer-batch', fingerprint: 'must remain'});
  const pending = await preparePendingSnapshot(target, current.id, 'prepared-restore');
  const args = {requestId: 'restore-one', sourceSha256: prepared.checkpoint.sha256, manifest: pending.manifest, validated: true, receiptsPreserved: true, counts: {shards: 1, assets: 1}};
  return {source, prepared, current, target, pending, args};
}

test('restore preview is unavailable until all prepared chunks are durable; current library is preserved first', async t => {
  const f = fixture(t), r = await restoration(f);
  const first = await prepareCloudRestore(f.env, r.args, OPTIONS);
  assert.equal(first.status, 'uploading'); assert.equal(first.previewTicket, null); assert.ok(first.preRestoreCheckpointId);
  assert.equal((await listCloudRestores(f.env, {}, OPTIONS)).items[0].previewTicket, null);
  for (const chunk of r.pending.chunks) {
    const response = await handleCloudBackupRequest(new Request('https://atlas.example.test' + first.uploadTransfer.chunkPath.replace('{sha256}', chunk.sha256), {
      method: 'PUT', headers: {'X-Shard-Atlas-Backup-Ticket': first.uploadTransfer.ticket}, body: chunk.data}), f.env, OPTIONS);
    assert.equal(response.status, 200);
  }
  const ready = await prepareCloudRestore(f.env, r.args, OPTIONS);
  assert.equal(ready.status, 'prepared'); assert.ok(ready.previewTicket);
  const preserved = (await listCloudBackups(f.env, {}, OPTIONS)).items.find(value => value.id === ready.preRestoreCheckpointId);
  assert.equal(preserved.sourceRevision, r.current.id);
  assert.equal(await f.storage.head(), r.current.id);
  await rejects(() => commitCloudRestore(f.env, {requestId: 'restore-one', previewTicket: ready.previewTicket, confirm: false}, OPTIONS), 'confirmation_required');
});

test('confirmed restoration publishes a new revision, preserves exact capsule and merges prepared receipts, and retries do not rewind', async t => {
  const f = fixture(t), r = await restoration(f);
  for (const chunk of r.pending.chunks) await f.storage.putBlob(chunk.sha256, chunk.data);
  const ready = await prepareCloudRestore(f.env, r.args, OPTIONS);
  const confirmation = {requestId: 'restore-one', previewTicket: ready.previewTicket, confirm: true};
  const result = await commitCloudRestore(f.env, confirmation, OPTIONS);
  assert.equal(result.verified, true); assert.notEqual(result.acceptedRevision, r.source.id); assert.notEqual(result.acceptedRevision, r.current.id);
  const saved = JSON.parse(await new Response((await f.storage.blob(r.pending.manifest.chunks[0].sha256)).body).text()); assert.deepEqual(saved, r.target);
  const commit = await f.storage.commit(result.acceptedRevision); assert.equal(commit.base_revision, r.current.id);
  const later = await f.publish(capsule('User edit after restoration'));
  const replay = await commitCloudRestore(f.env, confirmation, {...OPTIONS, now: '2026-10-27T18:00:00Z'});
  assert.equal(replay.replayed, true); assert.equal(replay.currentContentMatches, false); assert.equal(await f.storage.head(), later.id);
});

test('stale previews and races retain both libraries without silently rebasing', async t => {
  const f = fixture(t), r = await restoration(f);
  for (const chunk of r.pending.chunks) await f.storage.putBlob(chunk.sha256, chunk.data);
  const ready = await prepareCloudRestore(f.env, r.args, OPTIONS);
  const newer = await f.publish(capsule('Concurrent owner edit'));
  await rejects(() => commitCloudRestore(f.env, {requestId: 'restore-one', previewTicket: ready.previewTicket, confirm: true}, OPTIONS), 'cloud_library_changed');
  assert.equal(await f.storage.head(), newer.id);
  const stale = (await listCloudRestores(f.env, {}, OPTIONS)).items[0];
  assert.equal(stale.status, 'stale'); assert.equal(stale.previewTicket, null);
});

test('lost restoration reply is recovered through its durable mutation receipt', async t => {
  const f = fixture(t), r = await restoration(f);
  for (const chunk of r.pending.chunks) await f.storage.putBlob(chunk.sha256, chunk.data);
  const ready = await prepareCloudRestore(f.env, r.args, OPTIONS), args = {requestId: 'restore-one', previewTicket: ready.previewTicket, confirm: true};
  f.controls.loseNextBatch = true;
  await rejects(() => commitCloudRestore(f.env, args, OPTIONS), 'restore_outcome_unknown');
  const head = await f.storage.head();
  const recovered = await commitCloudRestore(f.env, args, OPTIONS); assert.equal(recovered.replayed, true); assert.equal(recovered.acceptedRevision, head);
});

test('invalid backup receipt and restore request do not publish or expose private errors', async t => {
  const f = fixture(t); await f.publish(capsule()); const unverified = await prepareLibraryBackup(f.env, {}, OPTIONS);
  await rejects(async () => requestCloudRestore(f.env, {requestId: 'restore-one', checkpointId: unverified.checkpoint.id, expectedRevision: await f.storage.head()}, OPTIONS), 'verification_required');
  const invalid = await handleCloudBackupRequest(f.request('/request', {method: 'POST', body: '{not JSON'}), f.env, OPTIONS); assert.equal(invalid.status, 400);
  f.controls.failRead = true;
  const unavailable = await handleCloudBackupRequest(f.request('/status'), f.env, OPTIONS); assert.equal(unavailable.status, 503); assert.doesNotMatch(await unavailable.text(), /PRIVATE_DATABASE|SELECT/);
});

test('native device access keeps the existing application secret requirement and protocol response', async t => {
  const f = fixture(t); f.env.SHARD_ATLAS_ALLOW_SERVICE_ACCESS = 'true'; f.env.SHARD_ATLAS_SERVICE_SECRET_SHA256 = await sha256(encode('synthetic-device-secret'));
  const bearerOnly = new Request('https://atlas.example.test/api/cloud-backups/status', {headers: {'OAI-Sites-Authorization': 'Bearer synthetic-dispatch-only'}});
  assert.equal((await handleCloudBackupRequest(bearerOnly, f.env, OPTIONS)).status, 401);
  const authenticated = new Request('https://atlas.example.test/api/cloud-backups/status', {headers: {'X-Shard-Atlas-Service': 'synthetic-device-secret', 'X-Shard-Atlas-Sync': '1'}});
  const response = await handleCloudBackupRequest(authenticated, f.env, OPTIONS);
  assert.equal(response.status, 200); assert.equal(response.headers.get('X-Shard-Atlas-Sync'), '1');
});

test('a change racing after restore head precheck cannot replace the newer accepted library', async t => {
  const f = fixture(t), r = await restoration(f);
  for (const chunk of r.pending.chunks) await f.storage.putBlob(chunk.sha256, chunk.data);
  const ready = await prepareCloudRestore(f.env, r.args, OPTIONS);
  let racing;
  f.controls.beforeBatch = async () => {racing = await f.publish(capsule('Race accepted before restore transaction'));};
  await rejects(() => commitCloudRestore(f.env, {requestId: 'restore-one', previewTicket: ready.previewTicket, confirm: true}, OPTIONS), 'request_conflicted');
  assert.equal(await f.storage.head(), racing.id);
  assert.equal(f.sqlite.prepare("SELECT count(*) AS n FROM library_commits WHERE status='conflict'").get().n, 1);
});

test('restore upload tickets cannot read backups and prepared content cannot be silently replaced', async t => {
  const f = fixture(t), r = await restoration(f), staged = await prepareCloudRestore(f.env, r.args, OPTIONS);
  const originalChunk = r.prepared.checkpoint.manifest.chunks[0];
  const response = await handleCloudBackupRequest(new Request('https://atlas.example.test' + r.prepared.transfer.chunkPath.replace('{sha256}', originalChunk.sha256), {
    headers: {'X-Shard-Atlas-Backup-Ticket': staged.uploadTransfer.ticket}}), f.env, OPTIONS);
  assert.equal(response.status, 403);
  const changed = await preparePendingSnapshot(capsule('A different restoration target'), r.current.id, 'different-target');
  await rejects(() => prepareCloudRestore(f.env, {...r.args, manifest: changed.manifest}, OPTIONS), 'request_id_reused');
});
