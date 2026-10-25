import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {CHUNK_BYTES, MAX_ARCHIVE_BYTES, PROTOCOL_VERSION, SYNC_HEADER, SyncError, sha256} from '../sync/protocol.mjs';
import {handleLibraryRequest} from '../sync/worker.mjs';
import {LibraryClient, preparePendingSnapshot} from '../sync/client.mjs';

// The D1 adapter executes the actual production SQL against SQLite. It provides
// D1's transactional batch contract without mocking individual query outcomes.
class TestD1 {
  constructor() {
    this.sqlite = new DatabaseSync(':memory:');
    this.sqlite.exec(readFileSync(new URL('../sync/schema.sql', import.meta.url), 'utf8'));
  }
  prepare(sql) {
    const execute = parameters => this.sqlite.prepare(sql).all(...parameters);
    return {bind: (...parameters) => ({first: async () => execute(parameters)[0] || null,
      all: async () => ({results: execute(parameters)}), execute: () => ({results: execute(parameters)})})};
  }
  async batch(statements) {
    this.sqlite.exec('BEGIN');
    try {const results = statements.map(statement => statement.execute()); this.sqlite.exec('COMMIT'); return results;}
    catch (error) {this.sqlite.exec('ROLLBACK'); throw error;}
  }
}

class TestR2 {
  objects = new Map();
  async head(key) {const value = this.objects.get(key); return value ? {size: value.byteLength} : null;}
  async put(key, bytes) {this.objects.set(key, new Uint8Array(bytes));}
  async get(key) {const bytes = this.objects.get(key); return bytes ? {size: bytes.byteLength, body: new Response(bytes).body} : null;}
}

function setup(options = {}) {
  const env = {DB: new TestD1(), BUCKET: new TestR2(), SHARD_ATLAS_OWNER_PRIVATE: 'true', SHARD_ATLAS_ALLOW_SERVICE_ACCESS: 'false', SHARD_ATLAS_OWNER_EMAIL: 'owner@example.test', ...options};
  let sequence = 0;
  const identity = {'oai-authenticated-user-id': 'site-owner', 'oai-authenticated-user-email': 'owner@example.test'};
  const fetch = async (url, init = {}) => handleLibraryRequest(new Request(new URL(url, 'https://atlas.example.test'), {...init, headers: {...identity, ...init.headers}}), env,
    {uuid: () => `revision-${++sequence}`, clock: () => new Date(sequence * 1000).toISOString()});
  return {env, fetch, client: new LibraryClient({fetch}), direct: async (path, init = {}) => handleLibraryRequest(new Request(`https://atlas.example.test/api/library${path}`, {headers: {[SYNC_HEADER]: String(PROTOCOL_VERSION), ...identity}, ...init}), env)};
}

const archive = () => ({schemaVersion: 1, shards: [{id: 'reverse', title: 'Reverse integer', tags: ['Integers', 'C++'], codeSolution: {code: 'int reverse(int x) {\n  return x; // exact whitespace\n}\n'}}], links: [], reviews: [], boards: [], assets: [{id: 'image', data: 'AAECAwQ=', mimeType: 'image/png'}], revisions: [{id: 'old', snapshot: {content: 'old'}}], trash: [{id: 'deleted', shard: {id: 'removed'}}]});
const capsule = () => ({format: 'shard-atlas-library', version: 1, archive: archive(), contributionReceipts: [{id: 'stable-receipt'}], drafts: {shard: {content: 'unfinished'}}, futureField: {retain: true}});

test('unrelated routes are left to the app', async () => {
  assert.equal(await handleLibraryRequest(new Request('https://atlas.example.test/index.html'), {}), null);
});

test('library fails closed without an explicit owner-private configuration', async () => {
  const {direct} = setup({SHARD_ATLAS_OWNER_PRIVATE: undefined});
  assert.equal((await direct('/head')).status, 503);
});

test('anonymous calls and wrong owners cannot read data', async () => {
  const {env} = setup();
  for (const headers of [{[SYNC_HEADER]: '1'}, {[SYNC_HEADER]: '1', 'oai-authenticated-user-id': 'other', 'oai-authenticated-user-email': 'other@example.test'}]) {
    const response = await handleLibraryRequest(new Request('https://atlas.example.test/api/library/head', {headers}), env);
    assert.equal(response.status, headers['oai-authenticated-user-id'] ? 403 : 401);
  }
});

test('owner-private service path can use platform-authenticated identity-less access', async () => {
  const {env} = setup({SHARD_ATLAS_ALLOW_SERVICE_ACCESS: 'true', SHARD_ATLAS_SERVICE_SECRET_SHA256: await sha256(new TextEncoder().encode('private-device-secret'))});
  const response = await handleLibraryRequest(new Request('https://atlas.example.test/api/library/head', {headers: {[SYNC_HEADER]: '1', 'X-Shard-Atlas-Service': 'private-device-secret'}}), env);
  assert.equal(response.status, 200);
});

test('identity-less service calls require a nonempty matching app-specific secret', async () => {
  const {env} = setup({SHARD_ATLAS_ALLOW_SERVICE_ACCESS: 'true', SHARD_ATLAS_SERVICE_SECRET_SHA256: await sha256(new TextEncoder().encode('private-device-secret'))});
  for (const secret of ['', 'wrong-device-secret']) {
    const response = await handleLibraryRequest(new Request('https://atlas.example.test/api/library/head', {headers: {[SYNC_HEADER]: '1', 'X-Shard-Atlas-Service': secret}}), env);
    assert.equal(response.status, secret ? 403 : 401);
  }
});

test('device allowlist supports independent access and revocation without legacy bypass', async () => {
  const hash = async value => sha256(new TextEncoder().encode(value));
  const {env} = setup({SHARD_ATLAS_ALLOW_SERVICE_ACCESS: 'true', SHARD_ATLAS_SERVICE_SECRET_SHA256: await hash('revoked-device'),
    SHARD_ATLAS_SERVICE_SECRET_SHA256_ALLOWLIST: JSON.stringify([await hash('mac-device'), await hash('windows-device')])});
  const request = secret => handleLibraryRequest(new Request('https://atlas.example.test/api/library/head', {headers: {[SYNC_HEADER]: '1', 'X-Shard-Atlas-Service': secret}}), env);
  assert.equal((await request('mac-device')).status, 200);
  assert.equal((await request('windows-device')).status, 200);
  assert.equal((await request('revoked-device')).status, 403);
  env.SHARD_ATLAS_SERVICE_SECRET_SHA256_ALLOWLIST = JSON.stringify([await hash('windows-device')]);
  assert.equal((await request('mac-device')).status, 403);
  assert.equal((await request('windows-device')).status, 200);
  env.SHARD_ATLAS_SERVICE_SECRET_SHA256_ALLOWLIST = '[]';
  assert.equal((await request('windows-device')).status, 403);
});

test('invalid explicit device allowlists fail closed', async () => {
  for (const value of ['bad-json', '{}', '["bad-hash"]', JSON.stringify(new Array(65).fill('a'.repeat(64)))]) {
    const {env} = setup({SHARD_ATLAS_ALLOW_SERVICE_ACCESS: 'true', SHARD_ATLAS_SERVICE_SECRET_SHA256: await sha256(new TextEncoder().encode('legacy-device')),
      SHARD_ATLAS_SERVICE_SECRET_SHA256_ALLOWLIST: value});
    const response = await handleLibraryRequest(new Request('https://atlas.example.test/api/library/head', {headers: {[SYNC_HEADER]: '1', 'X-Shard-Atlas-Service': 'legacy-device'}}), env);
    assert.equal(response.status, 503);
  }
});

test('request bodies cannot grant access and all operations require a protocol header', async () => {
  const {env, direct} = setup();
  assert.equal((await direct('/head', {headers: {'oai-authenticated-user-id': 'site-owner', 'oai-authenticated-user-email': 'owner@example.test'}})).status, 426);
  assert.equal((await handleLibraryRequest(new Request('https://atlas.example.test/api/library/commits', {method: 'POST', headers: {[SYNC_HEADER]: '1', 'content-type': 'application/json'}, body: JSON.stringify({owner: true, identity: 'site-owner'})}), env)).status, 401);
});

test('cross-origin writes are rejected before storage changes', async () => {
  const {fetch, env} = setup();
  const response = await fetch('/api/library/commits', {method: 'POST', headers: {[SYNC_HEADER]: '1', origin: 'https://other.example.test', 'content-type': 'application/json'}, body: '{}'});
  assert.equal(response.status, 403);
  assert.equal(env.DB.sqlite.prepare('SELECT count(*) AS count FROM library_commits').get().count, 0);
});

test('fresh library has no head and API responses cannot be cached', async () => {
  const {direct, client} = setup();
  const response = await direct('/head');
  assert.match(response.headers.get('cache-control'), /no-store/);
  assert.equal(response.headers.get(SYNC_HEADER), '1');
  assert.deepEqual(await client.head(), {protocolVersion: 1, revision: '', commit: null});
});

test('summary head checks return only the current revision without snapshot manifest', async () => {
  const {client, direct} = setup();
  const receipt = await client.publish(await preparePendingSnapshot(capsule(), '', 'summary-seed'));
  const response = await direct('/head?summary=1');
  assert.match(response.headers.get('cache-control'), /no-store/);
  assert.deepEqual(await response.json(), {protocolVersion: 1, revision: receipt.id});
});

test('publish and download preserve the complete archive, exact code, attachments, recovery, receipts and unknown fields', async () => {
  const {client} = setup();
  const original = capsule(), pending = await preparePendingSnapshot(original, '', 'initial');
  const receipt = await client.publish(pending);
  assert.equal(receipt.status, 'accepted');
  assert.equal(receipt.baseRevision, '');
  const head = await client.head();
  assert.equal(head.revision, receipt.id);
  assert.deepEqual(await client.download(head.commit), original);
});

test('concurrent snapshots based on the same revision preserve a conflict instead of overwriting', async () => {
  const {client} = setup();
  const first = await client.publish(await preparePendingSnapshot(capsule(), '', 'first'));
  const localA = capsule(), localB = capsule();
  localA.archive.shards[0].title = 'Windows edit';
  localB.archive.shards = []; localB.archive.trash.push({id: 'reverse', reason: 'Mac deletion'});
  const [a, b] = await Promise.all([client.publish(await preparePendingSnapshot(localA, first.id, 'a')), client.publish(await preparePendingSnapshot(localB, first.id, 'b'))]);
  assert.deepEqual([a.status, b.status].sort(), ['accepted', 'conflict']);
  const accepted = [a, b].find(item => item.status === 'accepted'), conflict = [a, b].find(item => item.status === 'conflict');
  assert.equal((await client.head()).revision, accepted.id);
  assert.equal(conflict.observedRevision, accepted.id);
  const retained = await client.download(await client.commit(conflict.id));
  assert.deepEqual(retained, conflict.mutationId === 'a' ? localA : localB);
  assert.equal((await client.conflicts()).items[0].id, conflict.id);
  assert.equal((await client.history()).items.length, 3);
});

test('accepted retries remain idempotent after newer commits', async () => {
  const {client} = setup();
  const pending = await preparePendingSnapshot(capsule(), '', 'stable');
  const initial = await client.publish(pending);
  const next = await client.publish(await preparePendingSnapshot(capsule(), initial.id, 'newer'));
  const retry = await client.publish(structuredClone(pending));
  assert.equal(retry.id, initial.id);
  assert.equal(retry.status, 'accepted');
  assert.equal((await client.head()).revision, next.id);
  assert.equal((await client.history()).items.length, 2);
});

test('a lost commit response can retry with the same mutation and recover the receipt', async () => {
  const {client, fetch} = setup();
  const pending = await preparePendingSnapshot(capsule(), '', 'lost-response');
  let dropped = false;
  const unreliable = new LibraryClient({fetch: async (url, init) => {const result = await fetch(url, init); if (url.endsWith('/commits') && !dropped) {dropped = true; throw new Error('lost response');} return result;}});
  await assert.rejects(unreliable.publish(pending), error => error.code === 'offline');
  const receipt = await client.publish(pending);
  assert.equal(receipt.status, 'accepted');
  assert.equal((await client.history()).items.length, 1);
});

test('conflict retries keep the same saved conflict and never advance the head', async () => {
  const {client} = setup();
  const winner = await client.publish(await preparePendingSnapshot(capsule(), '', 'winner'));
  const stale = await preparePendingSnapshot(capsule(), '', 'stale');
  const conflict = await client.publish(stale), retry = await client.publish(stale);
  assert.equal(retry.id, conflict.id);
  assert.equal(retry.status, 'conflict');
  assert.equal((await client.head()).revision, winner.id);
  assert.equal((await client.conflicts()).items.length, 1);
});

test('reusing an operation ID for different bytes is rejected', async () => {
  const {client} = setup();
  await client.publish(await preparePendingSnapshot(capsule(), '', 'same'));
  const changed = capsule(); changed.archive.shards[0].title = 'different';
  await assert.rejects(client.publish(await preparePendingSnapshot(changed, '', 'same')), error => error.status === 409 && error.code === 'mutation_reused');
  assert.equal((await client.history()).items.length, 1);
});

test('missing blobs cannot become an accepted head', async () => {
  const {fetch, client} = setup();
  const pending = await preparePendingSnapshot(capsule(), '', 'missing');
  const result = await fetch('/api/library/commits', {method: 'POST', headers: {[SYNC_HEADER]: '1', 'content-type': 'application/json'}, body: JSON.stringify(pending)});
  assert.equal(result.status, 409);
  assert.equal((await result.json()).code, 'missing_chunk');
  assert.equal((await client.head()).revision, '');
});

test('upload digest mismatch is rejected without saving the blob', async () => {
  const {fetch, env} = setup();
  const response = await fetch(`/api/library/blobs/${'a'.repeat(64)}`, {method: 'PUT', headers: {[SYNC_HEADER]: '1'}, body: 'incorrect'});
  assert.equal(response.status, 422);
  assert.equal(env.BUCKET.objects.size, 0);
});

test('bounded upload rejects oversized chunked transfers without Content-Length', async () => {
  const {env} = setup();
  const body = new ReadableStream({start(controller) {controller.enqueue(new Uint8Array(CHUNK_BYTES)); controller.enqueue(new Uint8Array(1)); controller.close();}});
  const response = await handleLibraryRequest(new Request(`https://atlas.example.test/api/library/blobs/${'a'.repeat(64)}`, {method: 'PUT', duplex: 'half', headers: {[SYNC_HEADER]: '1', 'oai-authenticated-user-id': 'owner', 'oai-authenticated-user-email': 'owner@example.test'}, body}), env);
  assert.equal(response.status, 413);
  assert.equal(env.BUCKET.objects.size, 0);
});

test('declared oversized body is rejected before reading it', async () => {
  const {fetch} = setup();
  const response = await fetch(`/api/library/blobs/${'b'.repeat(64)}`, {method: 'PUT', headers: {[SYNC_HEADER]: '1', 'content-length': String(CHUNK_BYTES + 1)}, body: 'small'});
  assert.equal(response.status, 413);
});

test('manifests reject incompatible versions, oversized archives and incorrect lengths', async () => {
  const {fetch} = setup();
  const base = await preparePendingSnapshot(capsule(), '', 'invalid');
  for (const [change, status] of [[{archiveVersion: 2}, 426], [{protocolVersion: 0}, 426], [{bytes: MAX_ARCHIVE_BYTES + 1}, 413], [{bytes: base.manifest.bytes + 1}, 400]]) {
    const response = await fetch('/api/library/commits', {method: 'POST', headers: {[SYNC_HEADER]: '1', 'content-type': 'application/json'}, body: JSON.stringify({mutationId: 'invalid', baseRevision: '', manifest: {...base.manifest, ...change}})});
    assert.equal(response.status, status);
  }
});

test('multi-chunk archives are reconstructed and verified', async () => {
  const {client} = setup();
  const original = capsule(); original.archive.shards[0].content = 'x'.repeat(CHUNK_BYTES + 23);
  const pending = await preparePendingSnapshot(original, '', 'large');
  assert.equal(pending.chunks.length, 2);
  const receipt = await client.publish(pending);
  assert.deepEqual(await client.download(receipt), original);
});

test('download corruption cannot replace a local collection', async () => {
  const {client, env} = setup();
  const receipt = await client.publish(await preparePendingSnapshot(capsule(), '', 'safe'));
  const [key, bytes] = env.BUCKET.objects.entries().next().value;
  bytes[0] ^= 1; env.BUCKET.objects.set(key, bytes);
  await assert.rejects(client.download(receipt), error => error.code === 'digest_mismatch');
});

test('corrupt durable outbox data is rejected before uploading', async () => {
  const {client, env} = setup();
  const pending = await preparePendingSnapshot(capsule(), '', 'corrupt');
  pending.chunks[0].data[0] ^= 1;
  await assert.rejects(client.publish(pending), error => error.code === 'invalid_outbox');
  assert.equal(env.BUCKET.objects.size, 0);
});

test('HTML authentication redirects are handled as sign-in requirements', async () => {
  const client = new LibraryClient({fetch: async () => new Response('<html>sign in</html>', {headers: {'content-type': 'text/html'}})});
  await assert.rejects(client.head(), error => error.status === 401 && error.code === 'sign_in_required');
});

test('SQLite transaction failure leaves both the receipt and head unchanged', async () => {
  const {client, env} = setup();
  env.DB.sqlite.exec("CREATE TRIGGER reject_head BEFORE UPDATE ON library_heads BEGIN SELECT RAISE(ABORT, 'test failure'); END");
  await assert.rejects(client.publish(await preparePendingSnapshot(capsule(), '', 'failure')), error => error.status === 503);
  assert.equal(env.DB.sqlite.prepare('SELECT count(*) AS count FROM library_commits').get().count, 0);
  assert.equal((await client.head()).revision, '');
});

test('history pagination is bounded and includes older recoverable snapshots', async () => {
  const {client} = setup();
  const pending = await preparePendingSnapshot(capsule(), '', 'seed');
  let base = '';
  for (let i = 0; i < 53; i++) base = (await client.publish({...pending, baseRevision: base, mutationId: `operation-${i}`})).id;
  const first = await client.history();
  assert.equal(first.items.length, 50);
  const second = await client.history(first.nextCursor);
  assert.equal(second.items.length, 3);
  assert.equal(second.nextCursor, null);
  assert.deepEqual(await client.download(await client.commit(second.items[2].id)), capsule());
});

test('capsules must include all archive sections and supported archive version', async () => {
  const partial = capsule(); delete partial.archive.revisions;
  await assert.rejects(preparePendingSnapshot(partial, ''), error => error.code === 'invalid_snapshot');
  await assert.rejects(preparePendingSnapshot({...capsule(), version: 999}, ''), error => error.code === 'incompatible_version');
});

test('digest helper uses exact UTF-8 bytes', async () => {
  assert.equal(await sha256(new TextEncoder().encode('abc')), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});
