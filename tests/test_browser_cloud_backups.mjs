import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {DatabaseSync} from 'node:sqlite';
import {gunzipSync} from 'node:zlib';
import {IDBFactory} from 'fake-indexeddb';
import {BrowserStore} from '../web/persistence.mjs';
import {BrowserCloudBackups} from '../web/cloud-backups.mjs';
import {handleCloudBackupRequest} from '../hosting/lib/cloud-backups.mjs';

async function fixture(t, uploader) {
  const store = new BrowserStore(new IDBFactory(), {recoveryUploader: uploader});
  t.after(async () => (await store.ready).close());
  await store.atomic(db => {db.cloudBackupPolicy = {mode: 'cloud', verified: true, deviceId: 'browser-fixture'};});
  const shard = (await store.request('/api/shards', 'POST', {title: 'Recovery fixture'})).result.shards[0];
  return {store, shard};
}
const read = async store => (await store.atomic(db => db, {readonly: true})).database;
const receipt = id => ({id, verified: true, durable: true, filename: `cloud:${id}`, createdAt: '2026-01-01T00:00:00Z'});

test('cloud-mode destructive writes preserve exact device state before committing without local history', async t => {
  const preserved = [];
  const {store, shard} = await fixture(t, async snapshot => {preserved.push(snapshot); return receipt('remote-one');});
  await store.request('/api/drafts/editor', 'PUT', {draft: {values: {title: 'Unfinished draft'}}});
  await store.atomic(db => {db.imports.push({id: 'import-fixture', undo: ['keep']});});
  await store.request('/api/shards/' + shard.id, 'DELETE');
  const db = await read(store);
  assert.equal(preserved.length, 1);
  assert.equal(preserved[0].archive.shards[0].id, shard.id);
  assert.equal(preserved[0].drafts.editor.values.title, 'Unfinished draft');
  assert.equal(preserved[0].imports[0].id, 'import-fixture');
  assert.equal(db.archive.shards.length, 0);
  assert.equal(db.archive.trash[0].shard.id, shard.id);
  assert.equal(db.backups.length, 0);
  assert.equal(db.cloudBackupPolicy.lastDeviceCheckpoint.filename, 'cloud:remote-one');
});

test('a failed recovery upload aborts deletion while ordinary offline editing remains available', async t => {
  const {store, shard} = await fixture(t, async () => {throw new Error('offline');});
  await store.request('/api/shards/' + shard.id, 'PUT', {content: 'Edited offline'});
  await assert.rejects(store.request('/api/shards/' + shard.id, 'DELETE'), /offline/);
  const db = await read(store);
  assert.equal(db.archive.shards[0].content, 'Edited offline');
  assert.equal(db.archive.trash.length, 0);
  assert.equal(db.backups.length, 0);
});

test('a draft changing during upload invalidates the prior approval and preserves the newer state', async t => {
  const captured = [];
  let store;
  const fixtureResult = await fixture(t, async snapshot => {
    captured.push(snapshot);
    if (captured.length === 1) await store.atomic(db => {db.drafts.editor = {values: {title: 'Changed in another tab'}};});
    return receipt('remote-' + captured.length);
  });
  store = fixtureResult.store;
  await store.request('/api/shards/' + fixtureResult.shard.id, 'DELETE');
  const db = await read(store);
  assert.equal(captured.length, 2);
  assert.equal(captured[1].drafts.editor.values.title, 'Changed in another tab');
  assert.equal(db.drafts.editor.values.title, 'Changed in another tab');
  assert.equal(db.archive.shards.length, 0);
  assert.equal(db.backups.length, 0);
});

test('unverified receipts never authorize a destructive transaction', async t => {
  const {store, shard} = await fixture(t, async () => ({id: 'not-verified'}));
  await assert.rejects(store.request('/api/shards/' + shard.id, 'DELETE'), /not verified/);
  assert.equal((await read(store)).archive.shards.length, 1);
});

test('copy-then-commit archive imports and undo reuse the matching cloud approval', async t => {
  let calls = 0;
  const {store} = await fixture(t, async () => receipt('copy-checkpoint-' + ++calls));
  const imported = await store.request('/api/import', 'POST', {data: {schemaVersion: 1, shards: [{id: 'imported-shard', title: 'Imported fixture'}]}});
  assert.equal(imported.result.importSummary.added.shards, 1);
  assert.match(imported.result.importSummary.backupFilename, /^cloud:/);
  assert.equal((await read(store)).backups.length, 0);
  await store.request('/api/imports/' + imported.result.importSummary.importId + '/undo', 'POST');
  assert.equal((await read(store)).archive.shards.some(value => value.id === 'imported-shard'), false);
  assert.equal((await read(store)).backups.length, 0);
  assert.equal(calls, 2);
});

test('standalone browser collections keep their existing snapshot behavior', async t => {
  const store = new BrowserStore(new IDBFactory());
  t.after(async () => (await store.ready).close());
  await store.request('/api/backup', 'POST');
  await store.request('/api/backup', 'POST');
  assert.equal((await read(store)).backups.length, 2);
});

test('managed mode is activated only after independent Drive verification', async t => {
  const store = new BrowserStore(new IDBFactory());
  t.after(async () => (await store.ready).close());
  let verified = false;
  const backups = new BrowserCloudBackups(store, {fetch: async () => Response.json({configured: true, managed: true,
    mode: 'cloud', localHistoryAllowed: false, lastVerified: verified ? {driveFileId: 'drive-fixture'} : null})});
  await backups.refresh();
  assert.equal((await read(store)).cloudBackupPolicy, undefined);
  verified = true; await backups.refresh();
  assert.equal((await read(store)).cloudBackupPolicy.mode, 'cloud');
  assert.match((await read(store)).cloudBackupPolicy.deviceId, /^browser-/);
});

test('device staging verifies complete source and uploaded bytes before returning approval', async t => {
  const {store} = await fixture(t, async () => receipt('unused'));
  const uploads = new Map();
  let mismatch = false;
  const backups = new BrowserCloudBackups(store, {fetch: async (url, options) => {
    if (options.method === 'PUT') {uploads.set(url.split('/').at(-1), new Uint8Array(options.body)); return Response.json({ok: true});}
    const body = JSON.parse(options.body);
    assert.ok(body.originalBytes > 0);
    assert.equal(body.chunks.reduce((sum, chunk) => sum + chunk.bytes, 0), body.bytes);
    for (const chunk of body.chunks) assert.equal(uploads.get(chunk.sha256).byteLength, chunk.bytes);
    return Response.json({...receipt('staged-one'), sha256: body.sha256, bytes: body.bytes + Number(mismatch)});
  }});
  assert.equal((await backups.preserve({archive: {shards: []}, drafts: {}, imports: [], inboxReceipts: []})).id, 'staged-one');
  mismatch = true;
  await assert.rejects(backups.preserve({archive: {shards: []}, drafts: {}, imports: [], inboxReceipts: []}), /failed verification/);
});

test('backup labels distinguish cloud recovery from library sync and stale checks', () => {
  const context = {window: {}};
  vm.runInNewContext(readFileSync(new URL('../static/cloud-backups.js', import.meta.url), 'utf8'), context);
  const ui = context.window.ShardAtlasCloudBackupUI;
  assert.equal(ui.displayState({configured: true, lastVerified: {driveFileId: 'file'}}), 'verified');
  assert.equal(ui.displayState({configured: true, pendingCount: 1, lastVerified: {driveFileId: 'file'}}), 'pending');
  assert.equal(ui.displayState({configured: true, state: 'pending', lastVerified: {driveFileId: 'file'}}), 'pending');
  assert.equal(ui.displayState({configured: true, checkUnavailable: true, lastVerified: {driveFileId: 'file'}}), 'unavailable');
  assert.equal(ui.displayState({configured: true, lastAttempt: {error: 'Upload failed'}}), 'attention');
  assert.equal(ui.sizeLabel(11282772), '11.3 MB');
});

test('older browser history remains local until its independent Drive copy is verified', async t => {
  const store = new BrowserStore(new IDBFactory());
  t.after(async () => (await store.ready).close());
  await store.request('/api/backup', 'POST');
  await store.atomic(db => {db.cloudBackupPolicy = {mode: 'cloud', verified: true, deviceId: 'browser-fixture'};});
  let driveVerified = false, uploads = 0;
  const backups = new BrowserCloudBackups(store, {fetch: async () => Response.json({items: [{id: 'old-checkpoint', driveVerified, driveFileId: driveVerified ? 'drive-file' : null}], nextCursor: null})});
  backups.preserve = async snapshot => {uploads++; assert.deepEqual(snapshot.drafts, {}); return receipt('old-checkpoint');};
  await backups.migrateLegacyOne();
  assert.equal((await read(store)).backups.length, 1);
  await backups.migrateLegacyOne();
  assert.equal((await read(store)).backups.length, 1);
  assert.equal(uploads, 1);
  driveVerified = true;
  await backups.migrateLegacyOne();
  assert.equal((await read(store)).backups.length, 0);
  assert.equal(uploads, 1);
});

test('a changed historical entry is retained and must be uploaded again before retirement', async t => {
  const store = new BrowserStore(new IDBFactory());
  t.after(async () => (await store.ready).close());
  await store.request('/api/backup', 'POST');
  await store.atomic(db => {db.cloudBackupPolicy = {mode: 'cloud', verified: true, deviceId: 'browser-fixture'};});
  const backups = new BrowserCloudBackups(store, {fetch: async () => Response.json({items: [{id: 'old-checkpoint', driveVerified: true, driveFileId: 'drive-file'}], nextCursor: null})});
  let uploads = 0;
  backups.preserve = async () => {uploads++; return receipt('old-checkpoint-' + uploads);};
  await backups.migrateLegacyOne();
  await store.atomic(db => {db.backups[0].drafts.editor = {values: {title: 'Unique older draft'}};});
  await backups.migrateLegacyOne();
  assert.equal((await read(store)).backups.length, 1);
  assert.deepEqual((await read(store)).cloudBackupPolicy.legacyMigrations, {});
  await backups.migrateLegacyOne();
  assert.equal(uploads, 2);
  assert.equal((await read(store)).backups[0].drafts.editor.values.title, 'Unique older draft');
});

test('browser safety uploads roundtrip through the actual cloud device-checkpoint handler', async t => {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('../sync/schema.sql', import.meta.url), 'utf8'));
  t.after(() => sqlite.close());
  const DB = {prepare(sql) {return {bind(...values) {return {
    async first() {return sqlite.prepare(sql).get(...values) || null;},
    async all() {return {results: sqlite.prepare(sql).all(...values)};},
    execute() {return {results: sqlite.prepare(sql).all(...values)};},
  };}};}, async batch(statements) {sqlite.exec('BEGIN'); try {const result = statements.map(statement => statement.execute()); sqlite.exec('COMMIT'); return result;} catch (error) {sqlite.exec('ROLLBACK'); throw error;}}};
  const objects = new Map();
  const BUCKET = {async put(key, bytes) {objects.set(key, new Uint8Array(bytes));},
    async head(key) {return objects.has(key) ? {size: objects.get(key).byteLength} : null;},
    async get(key) {const bytes = objects.get(key); return bytes ? {size: bytes.byteLength, body: new Response(bytes).body} : null;}};
  const env = {DB, BUCKET, SHARD_ATLAS_OWNER_PRIVATE: 'true', SHARD_ATLAS_OWNER_EMAIL: 'owner@example.test',
    SHARD_ATLAS_BACKUP_SIGNING_SECRET: 'synthetic-backup-signing-secret-at-least-32-bytes'};
  const {store, shard} = await fixture(t, async () => receipt('unused'));
  new BrowserCloudBackups(store, {fetch: (url, options) => handleCloudBackupRequest(new Request('https://atlas.example.test' + url,
    {...options, headers: {...options.headers, 'oai-authenticated-user-id': 'owner', 'oai-authenticated-user-email': 'owner@example.test'}}), env)});
  await store.request('/api/drafts/editor', 'PUT', {draft: {values: {content: 'Unfinished exact source\r\n\tα'}}});
  await store.request('/api/shards/' + shard.id, 'DELETE');
  const row = sqlite.prepare("SELECT * FROM backup_checkpoints WHERE kind = 'device'").get();
  assert.equal(row.status, 'staged');
  assert.equal(row.drive_file_id, '');
  const manifest = JSON.parse(row.manifest);
  const uploaded = Buffer.concat(manifest.chunks.map(chunk => Buffer.from(objects.get('backups/owner/device-blobs/' + chunk.sha256))));
  const decoded = JSON.parse(manifest.format.endsWith('-gzip') ? gunzipSync(uploaded) : uploaded);
  assert.equal(decoded.archive.shards[0].id, shard.id);
  assert.equal(decoded.drafts.editor.values.content, 'Unfinished exact source\r\n\tα');
  assert.equal((await read(store)).backups.length, 0);
});
