import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {IDBFactory} from 'fake-indexeddb';
import {BrowserStore} from '../web-dist/persistence.mjs';
import {BrowserLibrarySync, libraryCapsule} from '../web-dist/library-sync.mjs';
import {LibraryClient, preparePendingSnapshot} from '../sync/client.mjs';
import {handleLibraryRequest} from '../sync/worker.mjs';

function cloud() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('../sync/schema.sql', import.meta.url), 'utf8'));
  const DB = {prepare(sql) {return {bind(...values) {const run = () => sqlite.prepare(sql).all(...values); return {first: async () => run()[0] || null, all: async () => ({results: run()}), run: () => ({results: run()})};}};},
    async batch(statements) {sqlite.exec('BEGIN'); try {const result = statements.map(statement => statement.run()); sqlite.exec('COMMIT'); return result;} catch (error) {sqlite.exec('ROLLBACK'); throw error;}}};
  const objects = new Map(), BUCKET = {async head(key) {const value = objects.get(key); return value ? {size: value.byteLength} : null;},
    async put(key, value) {objects.set(key, new Uint8Array(value));}, async get(key) {const value = objects.get(key); return value ? {size: value.byteLength, body: new Response(value).body} : null;}};
  let online = true, afterRequest = null;
  const fetch = async (url, init = {}) => {
    if (!online) throw new Error('offline');
    const request = new Request(new URL(url, 'https://atlas.example.test'), {...init, headers: {...init.headers, 'oai-authenticated-user-id': 'owner'}});
    const result = await handleLibraryRequest(request, {DB, BUCKET, SHARD_ATLAS_OWNER_PRIVATE: 'true'});
    await afterRequest?.(request, result);
    return result;
  };
  return {client: new LibraryClient({fetch}), fetch, sqlite, setOnline: value => {online = value;}, setAfterRequest: callback => {afterRequest = callback;}};
}

function device(t, service, {indexedDB = new IDBFactory(), storeOptions, ...options} = {}) {
  const store = new BrowserStore(indexedDB, storeOptions), sync = new BrowserLibrarySync(store, {client: service.client, ...options});
  t.after(async () => {sync.stop(); (await store.ready).close();});
  return {store, sync, indexedDB};
}
async function add(store, title = 'Integer reversal') {
  await store.request('/api/shards', 'POST', {title, tags: ['Integers'], kind: 'concept', status: 'learning',
    codeSolution: {role: 'snippet', code: 'int f(int x) {\n  return x;\n}\n'}});
  return (await store.request('/api/state')).result.shards.at(-1);
}
async function read(store) {return (await store.atomic(db => db, {readonly: true})).database;}

test('an empty browser automatically receives a complete shared collection', async t => {
  const service = cloud(), a = device(t, service), b = device(t, service);
  await add(a.store); await a.sync.run(); await b.sync.run();
  assert.equal((await b.sync.status()).state, 'synced');
  assert.deepEqual((await read(b.store)).archive, (await read(a.store)).archive);
  assert.equal((await read(b.store)).backups.length, 1);
});

test('offline outbox survives browser restart and retries the original mutation', async t => {
  const service = cloud(), a = device(t, service);
  await add(a.store); service.setOnline(false);
  // A loss after preparation/upload leaves the exact staged outbox durable.
  service.setOnline(true);
  service.setAfterRequest(request => {if (new URL(request.url).pathname.endsWith('/head')) service.setOnline(false);});
  await a.sync.run();
  const pending = (await read(a.store)).librarySync.outbox;
  assert.ok(pending?.mutationId);
  assert.equal((await a.sync.status()).state, 'offline');
  service.setAfterRequest(null); service.setOnline(true);
  const restarted = device(t, service, {indexedDB: a.indexedDB});
  await restarted.sync.run();
  assert.equal((await restarted.sync.status()).state, 'synced');
  assert.equal((await service.client.head()).commit.mutationId, pending.mutationId);
  assert.equal((await read(restarted.store)).librarySync.outbox, null);
});

test('offline changes made before the first cloud request remain local and upload after reconnect', async t => {
  const service = cloud(), a = device(t, service);
  await add(a.store); service.setOnline(false); await a.sync.run();
  assert.equal((await a.sync.status()).state, 'offline');
  assert.equal((await read(a.store)).archive.shards.length, 1);
  service.setOnline(true); await a.sync.run();
  assert.equal((await a.sync.status()).state, 'synced');
  assert.equal((await service.client.download((await service.client.head()).commit)).archive.shards.length, 1);
});

test('simultaneous tabs serialize through an IDB lease without duplicate cloud mutations', async t => {
  const service = cloud(), a = device(t, service), second = device(t, service, {indexedDB: a.indexedDB});
  await add(a.store);
  await Promise.all([a.sync.run(), second.sync.run()]);
  await second.sync.run();
  assert.equal((await service.client.history()).items.length, 1);
  assert.equal((await second.sync.status()).state, 'synced');
});

test('a local save during cloud download cannot be overwritten by a stale snapshot', async t => {
  const service = cloud(), a = device(t, service), b = device(t, service);
  await add(a.store, 'Remote'); await a.sync.run();
  let saved = false;
  service.setAfterRequest(async request => {
    if (new URL(request.url).pathname.includes('/blobs/') && request.method === 'GET' && !saved) {saved = true; await add(b.store, 'Saved during download');}
  });
  await b.sync.run();
  assert.equal((await read(b.store)).archive.shards[0].title, 'Saved during download');
  assert.equal((await b.sync.status()).state, 'pending');
  service.setAfterRequest(null); await b.sync.run();
  assert.equal((await b.sync.status()).state, 'conflict');
});

test('open unsaved UI prevents a pull, while a retained closed draft survives the eventual pull', async t => {
  const service = cloud(), a = device(t, service);
  let canApply = false;
  const b = device(t, service, {canApplyRemote: () => canApply});
  await add(a.store); await a.sync.run();
  await b.store.atomic(db => {db.drafts.editor = {title: 'Unfinished local draft'};});
  await b.sync.run();
  assert.equal((await read(b.store)).archive.shards.length, 0);
  assert.equal((await b.sync.status()).state, 'pending');
  canApply = true; await b.sync.run();
  assert.equal((await read(b.store)).archive.shards.length, 1);
  assert.equal((await read(b.store)).drafts.editor.title, 'Unfinished local draft');
});

test('independent preexisting collections require a choice and preserve a cloud conflict snapshot', async t => {
  const service = cloud(), a = device(t, service), b = device(t, service);
  await add(a.store, 'Mac'); await a.sync.run(); await add(b.store, 'Windows'); await b.sync.run();
  assert.equal((await b.sync.status()).state, 'conflict');
  assert.equal((await read(b.store)).archive.shards[0].title, 'Windows');
  const conflicts = await service.client.conflicts();
  assert.equal(conflicts.items.length, 1);
  assert.equal((await service.client.download(await service.client.commit(conflicts.items[0].id))).archive.shards[0].title, 'Windows');
});

test('choosing the cloud collection preserves a device backup and local draft', async t => {
  const service = cloud(), a = device(t, service), b = device(t, service);
  await add(a.store, 'Mac'); await a.sync.run(); await add(b.store, 'Windows'); await b.sync.run();
  await b.store.atomic(db => {db.drafts.editor = {content: 'Keep draft'};});
  await b.sync.resolve('cloud');
  const db = await read(b.store);
  assert.equal(db.archive.shards[0].title, 'Mac');
  assert.equal(db.backups.at(-1).archive.shards[0].title, 'Windows');
  assert.equal(db.drafts.editor.content, 'Keep draft');
  assert.equal((await b.sync.status()).state, 'synced');
});

test('choosing this device creates a new accepted revision without deleting the earlier cloud version', async t => {
  const service = cloud(), a = device(t, service), b = device(t, service);
  await add(a.store, 'Mac'); await a.sync.run(); const originalHead = await service.client.head();
  await add(b.store, 'Windows'); await b.sync.run(); await b.sync.resolve('device');
  assert.equal((await service.client.download((await service.client.head()).commit)).archive.shards[0].title, 'Windows');
  assert.equal((await service.client.download(await service.client.commit(originalHead.revision))).archive.shards[0].title, 'Mac');
  assert.equal((await read(b.store)).backups.at(-1).archive.shards[0].title, 'Windows');
});

test('conflict resolution requires reviewing a cloud revision that changed again', async t => {
  const service = cloud(), a = device(t, service), b = device(t, service);
  const shard = await add(a.store, 'Mac'); await a.sync.run(); await add(b.store, 'Windows'); await b.sync.run();
  await a.store.request(`/api/shards/${shard.id}`, 'PUT', {title: 'Newer Mac'}); await a.sync.run();
  await b.sync.resolve('device');
  assert.equal((await b.sync.status()).state, 'conflict');
  assert.match((await b.sync.status()).message, /changed again/);
  assert.equal((await service.client.download((await service.client.head()).commit)).archive.shards[0].title, 'Newer Mac');
});

test('unsaved UI blocks explicit conflict resolution too', async t => {
  const service = cloud(), a = device(t, service);
  let canApply = true;
  const b = device(t, service, {canApplyRemote: () => canApply});
  await add(a.store, 'Mac'); await a.sync.run(); await add(b.store, 'Windows'); await b.sync.run();
  canApply = false; await b.sync.resolve('cloud');
  assert.equal((await b.sync.status()).state, 'conflict');
  assert.equal((await read(b.store)).archive.shards[0].title, 'Windows');
});

test('portable inbox receipts without savedRecords still prevent deleted additions from resurrecting', async t => {
  const service = cloud(), a = device(t, service), b = device(t, service);
  const envelope = {format: 'shard-atlas-inbox', version: 1, batch: {requestId: 'immutable-batch', shards: [{id: 'external', title: 'Captured snippet', content: 'text', tags: []}], links: []}};
  await a.store.request('/api/drive/import', 'POST', {envelope});
  await a.store.atomic(db => {delete db.inboxReceipts[0].savedRecords;});
  const id = (await read(a.store)).archive.shards[0].id;
  await a.store.request(`/api/shards/${id}`, 'DELETE'); await a.sync.run(); await b.sync.run();
  const result = (await b.store.request('/api/drive/import', 'POST', {envelope})).result;
  assert.equal(result.receipt.replayed, true);
  assert.equal(result.receipt.currentContentMatches, false);
  assert.equal((await read(b.store)).archive.shards.length, 0);
  assert.equal((await read(b.store)).archive.trash.length, 1);
});

test('service auth failures preserve local records and report sign-in-required', async t => {
  const service = cloud(), a = device(t, service, {client: new LibraryClient({fetch: async () => new Response('<html>signin</html>')})});
  await add(a.store); await a.sync.run();
  assert.equal((await a.sync.status()).state, 'sign-in-required');
  assert.equal((await read(a.store)).archive.shards.length, 1);
});

test('public browser API exposes status, manual sync, and a complete local snapshot', async t => {
  const service = cloud(), a = device(t, service);
  await add(a.store);
  assert.equal((await a.sync.request('/api/library-sync/run', 'POST')).result.state, 'synced');
  assert.equal((await a.sync.request('/api/library-sync/status')).result.localCount, 1);
  assert.deepEqual((await a.sync.request('/api/library-sync/download')).result, libraryCapsule(await read(a.store)));
  assert.equal(await a.sync.request('/api/state'), undefined);
});

test('an edit lease in another tab blocks a clean tab from replacing their shared database', async t => {
  const service = cloud(), a = device(t, service), b = device(t, service), dirty = device(t, service, {indexedDB: b.indexedDB});
  await add(a.store, 'Cloud'); await a.sync.run();
  await dirty.sync.markEditing(true);
  await b.sync.run();
  assert.equal((await read(b.store)).archive.shards.length, 0);
  assert.equal((await b.sync.status()).state, 'pending');
  await dirty.sync.markEditing(false); await b.sync.run();
  assert.equal((await read(b.store)).archive.shards[0].title, 'Cloud');
});

test('a suspended tab saving after its edit lease expires forces a conflict against its original cloud revision', async t => {
  const service = cloud(), a = device(t, service), b = device(t, service), stale = device(t, service, {indexedDB: b.indexedDB});
  const shard = await add(a.store, 'Original'); await a.sync.run(); await b.sync.run();
  await stale.store.request('/api/state');
  await a.store.request(`/api/shards/${shard.id}`, 'PUT', {title: 'New remote edit'}); await a.sync.run();
  await b.sync.run();
  assert.equal((await read(b.store)).archive.shards[0].title, 'New remote edit');
  await stale.store.request(`/api/shards/${shard.id}`, 'PUT', {title: 'Old tab edit'});
  await stale.sync.run();
  assert.equal((await stale.sync.status()).state, 'conflict');
  assert.equal((await service.client.download((await service.client.head()).commit)).archive.shards[0].title, 'New remote edit');
  assert.ok((await read(stale.store)).backups.some(backup => backup.archive.shards[0]?.title === 'New remote edit'));
});

test('invalid remote shard fields and missing relationship endpoints never replace a browser collection', async t => {
  for (const mutation of [snapshot => {snapshot.archive.shards[0].title = 123;}, snapshot => {snapshot.archive.links.push({id: 'broken', fromId: snapshot.archive.shards[0].id, toId: 'missing', type: 'uses', note: '', createdAt: new Date().toISOString()});}]) {
    const service = cloud(), source = device(t, service), target = device(t, service);
    await add(source.store);
    const snapshot = libraryCapsule(await read(source.store)); mutation(snapshot);
    await service.client.publish(await preparePendingSnapshot(snapshot, ''));
    await target.sync.run();
    assert.equal((await read(target.store)).archive.shards.length, 0);
    assert.equal((await target.sync.status()).state, 'pending');
    assert.equal((await read(target.store)).backups.length, 0);
  }
});

test('choosing cloud preserves local-only immutable import receipts and uploads their merged history', async t => {
  const service = cloud(), a = device(t, service), b = device(t, service);
  const envelope = {format: 'shard-atlas-inbox', version: 1, batch: {requestId: 'local-only-import', shards: [{id: 'external', title: 'Old local addition', tags: []}], links: []}};
  await add(a.store, 'Cloud note'); await a.sync.run();
  await b.store.request('/api/drive/import', 'POST', {envelope});
  const id = (await read(b.store)).archive.shards[0].id;
  await b.store.request(`/api/shards/${id}`, 'DELETE');
  await b.sync.run(); await b.sync.resolve('cloud');
  assert.equal((await read(b.store)).inboxReceipts.length, 1);
  assert.equal((await b.sync.status()).state, 'pending');
  await b.sync.run();
  const shared = await service.client.download((await service.client.head()).commit);
  assert.equal(shared.contributionReceipts[0].requestId, 'local-only-import');
  const replay = (await b.store.request('/api/drive/import', 'POST', {envelope})).result.receipt;
  assert.equal(replay.replayed, true);
  assert.equal((await read(b.store)).archive.shards.length, 1);
  assert.equal((await read(b.store)).archive.shards[0].title, 'Cloud note');
});

test('different fingerprints for the same immutable import request block cloud apply', async t => {
  const service = cloud(), a = device(t, service), b = device(t, service);
  for (const [device, title] of [[a, 'Cloud'], [b, 'Local']]) {
    const envelope = {format: 'shard-atlas-inbox', version: 1, batch: {requestId: 'same-request', shards: [{id: 'external', title, tags: []}], links: []}};
    await device.store.request('/api/drive/import', 'POST', {envelope});
  }
  await a.sync.run(); await b.sync.run(); await b.sync.resolve('cloud');
  assert.equal((await read(b.store)).archive.shards[0].title, 'Local');
  assert.equal((await read(b.store)).inboxReceipts[0].receipt.requestId, 'same-request');
  assert.match((await b.sync.status()).message, /conflicting history/);
});

test('a dirty stale tab replaying another tab\'s accepted outbox does not advance its rendered revision', async t => {
  const service = cloud(), a = device(t, service), b = device(t, service);
  const stale = device(t, service, {indexedDB: b.indexedDB, canApplyRemote: () => false});
  const shard = await add(a.store, 'Original'); await a.sync.run(); await b.sync.run();
  await stale.store.request('/api/state');
  const observed = stale.store.observedRevision;
  await b.store.request('/api/state');
  await b.store.request(`/api/shards/${shard.id}`, 'PUT', {title: 'Other tab edit'});
  service.setAfterRequest(request => {if (new URL(request.url).pathname.endsWith('/head')) service.setOnline(false);});
  await b.sync.run();
  assert.ok((await read(b.store)).librarySync.outbox);
  service.setAfterRequest(null); service.setOnline(true);
  await stale.sync.run();
  assert.equal(stale.store.observedRevision, observed);
  await stale.store.request(`/api/shards/${shard.id}`, 'PUT', {title: 'Stale editor edit'});
  await stale.sync.run();
  assert.equal((await stale.sync.status()).state, 'conflict');
  assert.equal((await service.client.download((await service.client.head()).commit)).archive.shards[0].title, 'Other tab edit');
});

test('conflict resolution requires reviewing local changes made after the displayed conflict', async t => {
  const service = cloud(), a = device(t, service), b = device(t, service);
  await add(a.store, 'Cloud'); await a.sync.run(); const shard = await add(b.store, 'Local'); await b.sync.run();
  await b.store.request(`/api/shards/${shard.id}`, 'PUT', {title: 'New local edit'});
  await b.sync.resolve('cloud');
  assert.equal((await read(b.store)).archive.shards[0].title, 'New local edit');
  assert.equal((await b.sync.status()).state, 'conflict');
  assert.match((await b.sync.status()).message, /device changed again/);
  await b.sync.resolve('cloud');
  assert.equal((await read(b.store)).archive.shards[0].title, 'Cloud');
});

test('a clean hidden tab does not lease-block a visible tab, while a dirty hidden tab does', async t => {
  for (const editing of [false, true]) {
    const service = cloud(), a = device(t, service), visible = device(t, service);
    const hidden = device(t, service, {indexedDB: visible.indexedDB, canApplyRemote: () => false, isEditing: () => editing});
    await add(a.store); await a.sync.run();
    hidden.sync.start(); await hidden.sync.run();
    await visible.sync.run();
    assert.equal((await read(visible.store)).archive.shards.length, editing ? 0 : 1);
    assert.equal((await visible.sync.status()).state, editing ? 'pending' : 'synced');
    hidden.sync.stop();
  }
});

test('a discarded state read cannot advance the base of an editor that never rendered it', async t => {
  const service = cloud(), a = device(t, service), b = device(t, service);
  const stale = device(t, service, {indexedDB: b.indexedDB, storeOptions: {deferStateObservation: true}});
  const shard = await add(a.store, 'Original'); await a.sync.run(); await b.sync.run();
  stale.store.acceptState((await stale.store.request('/api/state')).database);
  const observedRevision = stale.store.observedRevision;
  await a.store.request(`/api/shards/${shard.id}`, 'PUT', {title: 'New remote edit'}); await a.sync.run(); await b.sync.run();
  // UI's refresh guard discards this read because the old editor became dirty.
  await stale.store.request('/api/state');
  assert.equal(stale.store.observedRevision, observedRevision);
  await stale.store.request(`/api/shards/${shard.id}`, 'PUT', {title: 'Old editor edit'}); await stale.sync.run();
  assert.equal((await stale.sync.status()).state, 'conflict');
  assert.equal((await service.client.download((await service.client.head()).commit)).archive.shards[0].title, 'New remote edit');
});
