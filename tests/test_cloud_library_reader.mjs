import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {CloudLibraryReadError, MAX_READ_ONLY_SNAPSHOT_BYTES, readCloudLibrary} from '../hosting/lib/cloud-library-reader.mjs';
import {CHUNK_BYTES, sha256} from '../sync/protocol.mjs';
import {preparePendingSnapshot} from '../sync/client.mjs';

const STAMP = '2026-10-25T12:00:00.000Z';
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jR7sAAAAASUVORK5CYII=';
const code = '\n#include <vector>\r\nint identity(int x) {\r\n\treturn x; // exact C++\r\n}\r\n';
function capsule(title = 'Current concept') {
  return {format: 'shard-atlas-library', version: 1, serviceSecret: 'TOP_LEVEL_PRIVATE_VALUE',
    archive: {schemaVersion: 1,
      shards: [{id: 'current-note', title, content: 'A supported explanation.', tags: ['C++'],
        codeSolution: {role: 'snippet', code, approaches: [{id: 'identity', title: 'Identity', code}]}},
      {id: 'related-note', title: 'Related concept', content: 'A different explanation.', tags: ['C++']}],
      links: [{id: 'current-link', fromId: 'current-note', toId: 'related-note', type: 'related_to', note: 'An explained connection.'}],
      reviews: [], boards: [], assets: [{id: 'image', mimeType: 'image/png', data: PNG}],
      revisions: [{id: 'old-note', shardId: 'current-note', createdAt: STAMP, reason: 'edited',
        snapshot: {id: 'current-note', title: 'Old explanation', content: 'RECOVERY_PRIVATE_VALUE', tags: []}}],
      trash: [{id: 'deleted-note', deletedAt: STAMP, shard: {id: 'deleted', title: 'Deleted concept', content: 'TRASH_PRIVATE_VALUE', tags: []}, links: [], reviews: []}]},
    contributionReceipts: [], drafts: {content: 'DRAFT_PRIVATE_VALUE'}, settings: {token: 'SETTINGS_PRIVATE_VALUE'}};
}

function fixture(t) {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('../sync/schema.sql', import.meta.url), 'utf8'));
  t.after(() => sqlite.close());
  const objects = new Map(), calls = {head: 0, commit: 0, blobs: 0};
  const controls = {onHead: null, onBlob: null, failHead: false, failBlob: false};
  const DB = {prepare(sql) {
    assert.match(sql, /^SELECT /, 'The production reader must never issue a write statement.');
    return {bind(...parameters) {return {async first() {
      if (sql.includes('library_heads')) {
        calls.head++;
        if (controls.failHead) throw new Error('SECRET_DATABASE_STATEMENT_WITH_PRIVATE_KEY');
        await controls.onHead?.(calls.head);
      } else calls.commit++;
      return sqlite.prepare(sql).get(...parameters) || null;
    }};}};
  }, batch() {throw new Error('No database mutations are allowed.');}};
  const BUCKET = {async get(key) {
    calls.blobs++;
    if (controls.failBlob) throw new Error('PRIVATE_STORAGE_OBJECT_KEY');
    await controls.onBlob?.(key, calls.blobs);
    const bytes = objects.get(key);
    return bytes ? {size: bytes.byteLength, body: new Response(bytes).body} : null;
  }, put() {throw new Error('No object writes are allowed.');}};
  const env = {DB, BUCKET};
  const setHead = revision => sqlite.prepare('INSERT OR REPLACE INTO library_heads(library_id,revision) VALUES (?,?)').run('owner', revision);
  async function seed(value = capsule(), revision = 'revision-1', {makeHead = true, bytes, status = 'accepted', libraryId = 'owner'} = {}) {
    const pending = bytes ? null : await preparePendingSnapshot(value, '', revision);
    const raw = bytes || new TextEncoder().encode(JSON.stringify(value));
    const chunks = [];
    for (let offset = 0; offset < raw.byteLength; offset += CHUNK_BYTES) {
      const data = raw.slice(offset, offset + CHUNK_BYTES), hash = await sha256(data);
      chunks.push({sha256: hash, bytes: data.byteLength}); objects.set('libraries/owner/blobs/' + hash, data);
    }
    const manifest = pending?.manifest || {protocolVersion: 1, archiveVersion: 1, format: 'shard-atlas-library-json',
      sha256: await sha256(raw), bytes: raw.byteLength, chunks};
    sqlite.prepare('INSERT INTO library_commits(id,library_id,mutation_id,base_revision,fingerprint,manifest,status,observed_revision,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(revision, libraryId, revision, '', '0'.repeat(64), JSON.stringify(manifest), status, '', STAMP);
    if (makeHead) setHead(revision);
    return {manifest, raw};
  }
  return {env, sqlite, objects, calls, controls, seed, setHead};
}

async function rejected(action, code) {
  await assert.rejects(action, error => {
    assert.ok(error instanceof CloudLibraryReadError);
    assert.equal(error.code, code);
    assert.ok(error.message.length < 300);
    assert.doesNotMatch(error.message, /PRIVATE|SECRET|SELECT|libraries\/|serviceSecret/);
    return true;
  });
}

test('verified current cloud reads preserve exact present notes and omit recovery, settings, credentials and images', async t => {
  const f = fixture(t), original = capsule(), {manifest} = await f.seed(original);
  const result = await readCloudLibrary(f.env);
  assert.deepEqual(result.archive, {shards: original.archive.shards, links: original.archive.links});
  assert.equal(result.archive.shards[0].codeSolution.code, code);
  assert.equal(result.revision, 'revision-1'); assert.equal(result.snapshotHash, manifest.sha256);
  assert.equal(result.acceptedAt, STAMP); assert.ok(Number.isFinite(Date.parse(result.checkedAt)));
  assert.deepEqual(Object.keys(result).sort(), ['acceptedAt', 'archive', 'checkedAt', 'revision', 'snapshotHash']);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_VALUE|data:image|contributionReceipts|revisions|trash|drafts|settings/);
  assert.equal(f.calls.head, 2); assert.equal(f.calls.commit, 1);
});

test('empty cloud is explicit and is confirmed with two fresh head reads without object access', async t => {
  const f = fixture(t), result = await readCloudLibrary(f.env);
  assert.deepEqual(result.archive, {shards: [], links: []});
  assert.equal(result.revision, ''); assert.equal(result.snapshotHash, null); assert.equal(result.acceptedAt, null);
  assert.equal(f.calls.head, 2); assert.equal(f.calls.commit, 0); assert.equal(f.calls.blobs, 0);
});

test('single-flight and immutable cache avoid repeated snapshot decoding while every call verifies both live heads', async t => {
  const f = fixture(t); await f.seed();
  const values = await Promise.all(Array.from({length: 5}, () => readCloudLibrary(f.env)));
  assert.equal(f.calls.commit, 1); assert.equal(f.calls.blobs, 1); assert.equal(f.calls.head, 10);
  assert.throws(() => {values[0].archive.shards[0].content = 'Mutated';}, TypeError);
  assert.throws(() => {values[0].archive.shards.push({});}, TypeError);
  const cached = await readCloudLibrary(f.env);
  assert.equal(cached.archive.shards[0].content, 'A supported explanation.');
  assert.equal(f.calls.commit, 1); assert.equal(f.calls.blobs, 1); assert.equal(f.calls.head, 12);
  await f.seed(capsule('New saved explanation'), 'revision-2');
  const latest = await readCloudLibrary(f.env);
  assert.equal(latest.revision, 'revision-2'); assert.equal(latest.archive.shards[0].title, 'New saved explanation');
  assert.equal(f.calls.commit, 2); assert.equal(f.calls.blobs, 2);
});

test('cache entries are isolated by storage binding pair and never provide stale fallback on failures', async t => {
  const first = fixture(t), second = fixture(t);
  await first.seed(capsule('First private library')); await second.seed(capsule('Second private library'));
  assert.equal((await readCloudLibrary(first.env)).archive.shards[0].title, 'First private library');
  assert.equal((await readCloudLibrary(second.env)).archive.shards[0].title, 'Second private library');
  first.controls.failHead = true;
  await rejected(() => readCloudLibrary(first.env), 'read_only_storage_unavailable');
  first.controls.failHead = false;
  await first.seed(capsule('Newest unavailable snapshot'), 'revision-2'); first.controls.failBlob = true;
  await rejected(() => readCloudLibrary(first.env), 'read_only_storage_unavailable');
});

test('concurrent reads of changing revisions serialize snapshot loads and return only the final current revision', async t => {
  const f = fixture(t); await f.seed(); await f.seed(capsule('Next current revision'), 'revision-2', {makeHead: false});
  let releaseFirst, firstStarted;
  const gate = new Promise(resolve => {releaseFirst = resolve;});
  const started = new Promise(resolve => {firstStarted = resolve;});
  f.controls.onBlob = async (_key, count) => {if (count === 1) {firstStarted(); await gate;}};
  const first = readCloudLibrary(f.env);
  await started; f.setHead('revision-2');
  const waiting = Array.from({length: 4}, () => readCloudLibrary(f.env));
  releaseFirst();
  const results = await Promise.all([first, ...waiting]);
  assert.ok(results.every(result => result.revision === 'revision-2'));
  assert.equal(f.calls.commit, 2); assert.equal(f.calls.blobs, 2);
});

test('head change during load or cached use retries one complete current revision', async t => {
  const f = fixture(t); await f.seed(); await f.seed(capsule('Newer revision'), 'revision-2', {makeHead: false});
  f.controls.onBlob = () => {f.setHead('revision-2'); f.controls.onBlob = null;};
  const changed = await readCloudLibrary(f.env);
  assert.equal(changed.revision, 'revision-2'); assert.equal(changed.archive.shards[0].title, 'Newer revision');
  await f.seed(capsule('Newest revision'), 'revision-3', {makeHead: false});
  f.controls.onHead = count => {if (count === f.calls.head && count === 6) f.setHead('revision-3');};
  const cachedChanged = await readCloudLibrary(f.env);
  assert.equal(cachedChanged.revision, 'revision-3'); assert.equal(cachedChanged.archive.shards[0].title, 'Newest revision');
});

test('continually moving heads return an explicit retry error instead of a mixed or stale result', async t => {
  const f = fixture(t); await f.seed(); await f.seed(capsule('Second revision'), 'revision-2', {makeHead: false});
  f.controls.onHead = count => {if (count % 2 === 0) f.setHead(count === 2 ? 'revision-2' : 'revision-1');};
  await rejected(() => readCloudLibrary(f.env), 'read_only_library_changed');
});

test('16 MiB reader cap rejects before object access and does not change the synchronization protocol limit', async t => {
  const f = fixture(t); const {manifest} = await f.seed();
  const tooBig = {...manifest, bytes: MAX_READ_ONLY_SNAPSHOT_BYTES + 1,
    chunks: Array.from({length: 5}, (_, index) => ({sha256: 'a'.repeat(64), bytes: index === 4 ? 1 : CHUNK_BYTES}))};
  f.sqlite.prepare('UPDATE library_commits SET manifest=? WHERE id=?').run(JSON.stringify(tooBig), 'revision-1');
  await rejected(() => readCloudLibrary(f.env), 'read_only_snapshot_too_large');
  assert.equal(f.calls.blobs, 0);
});

test('multi-chunk snapshots are fully assembled, hashed and checked before returning current notes', async t => {
  const f = fixture(t), value = capsule(); value.discardedPadding = 'x'.repeat(CHUNK_BYTES + 50);
  const {manifest} = await f.seed(value);
  assert.equal(manifest.chunks.length, 2);
  const result = await readCloudLibrary(f.env);
  assert.equal(result.archive.shards[0].title, value.archive.shards[0].title);
  assert.equal(f.calls.blobs, 2); assert.equal(result.discardedPadding, undefined);
});

test('missing, conflicting, mismatched-library and mismatched-head commits fail closed', async t => {
  for (const variant of ['missing', 'conflict', 'other-library', 'bad-created-at', 'unbounded-created-at', 'non-ISO-created-at', 'invalid-head']) {
    await t.test(variant, async t => {
      const f = fixture(t); await f.seed();
      if (variant === 'missing') f.sqlite.prepare('DELETE FROM library_commits').run();
      if (variant === 'conflict') f.sqlite.prepare("UPDATE library_commits SET status='conflict'").run();
      if (variant === 'other-library') f.sqlite.prepare("UPDATE library_commits SET library_id='other'").run();
      if (variant === 'bad-created-at') f.sqlite.prepare("UPDATE library_commits SET created_at='invalid'").run();
      if (variant === 'unbounded-created-at') f.sqlite.prepare('UPDATE library_commits SET created_at=?').run('2026-10-25T12:00:00.' + '0'.repeat(100) + 'Z');
      if (variant === 'non-ISO-created-at') f.sqlite.prepare("UPDATE library_commits SET created_at='October 25, 2026'").run();
      if (variant === 'invalid-head') f.setHead('bad/private/key');
      await rejected(() => readCloudLibrary(f.env), 'read_only_snapshot_invalid');
      assert.equal(f.calls.blobs, 0);
    });
  }
});

test('truncation, object-size, chunk-digest and whole-snapshot-digest corruption never return records', async t => {
  for (const variant of ['missing', 'truncated', 'corrupt', 'whole-digest']) {
    await t.test(variant, async t => {
      const f = fixture(t), {manifest, raw} = await f.seed(), key = 'libraries/owner/blobs/' + manifest.chunks[0].sha256;
      if (variant === 'missing') f.objects.delete(key);
      if (variant === 'truncated') f.objects.set(key, raw.slice(0, -1));
      if (variant === 'corrupt') {const changed = raw.slice(); changed[20] ^= 1; f.objects.set(key, changed);}
      if (variant === 'whole-digest') f.sqlite.prepare('UPDATE library_commits SET manifest=?').run(JSON.stringify({...manifest, sha256: 'a'.repeat(64)}));
      await rejected(() => readCloudLibrary(f.env), 'read_only_snapshot_invalid');
    });
  }
});

test('lying object sizes cannot turn a bounded chunk into an unbounded stream', async t => {
  const f = fixture(t), {manifest, raw} = await f.seed();
  f.env.BUCKET.get = async () => ({size: manifest.chunks[0].bytes, body: new Response(new Uint8Array(raw.byteLength + 1)).body});
  await rejected(() => readCloudLibrary(f.env), 'read_only_snapshot_invalid');
});

test('invalid UTF-8, JSON, protocol, archive schema and record relationships return sanitized failures', async t => {
  const values = [
    {name: 'UTF8', bytes: new Uint8Array([0xff, 0xfe])},
    {name: 'JSON', bytes: new TextEncoder().encode('{invalid private JSON')},
    {name: 'protocol', change: f => f.sqlite.prepare('UPDATE library_commits SET manifest=?').run(JSON.stringify({protocolVersion: 999}))},
    {name: 'schema', changeValue: value => {value.archive.schemaVersion = 999;}},
    {name: 'missing archive category', changeValue: value => {delete value.archive.trash;}},
    {name: 'bad relationship', changeValue: value => {value.archive.links[0].toId = 'not-present';}},
    {name: 'duplicate record IDs', changeValue: value => {value.archive.shards.push(value.archive.shards[0]);}},
    {name: 'invalid current note field', changeValue: value => {value.archive.shards[0].tags = [17];}},
    {name: 'invalid current note content', changeValue: value => {value.archive.shards[0].content = 17;}},
    {name: 'invalid current code metadata', changeValue: value => {value.archive.shards[0].codeSolution.approaches[0].code = 17;}},
    {name: 'invalid current role', changeValue: value => {value.archive.shards[0].codeSolution.role = 'unknown-role';}},
    {name: 'dangling approach', changeValue: value => {value.archive.links[0].fromApproachId = 'missing-approach';}},
    {name: 'semantic duplicate relationships', changeValue: value => {value.archive.links.push({...value.archive.links[0], id: 'different-id'});}},
  ];
  for (const variant of values) await t.test(variant.name, async t => {
    const f = fixture(t), value = capsule(); variant.changeValue?.(value);
    // preparePendingSnapshot correctly rejects unsupported capsule schemas, so
    // seed the encoded bytes directly for malformed-snapshot tests.
    await f.seed(value, 'revision-1', {bytes: variant.bytes || new TextEncoder().encode(JSON.stringify(value))});
    variant.change?.(f);
    await rejected(() => readCloudLibrary(f.env), 'read_only_snapshot_invalid');
  });
});

test('unreturned historical and image payloads are not interpreted or exposed by current-note reads', async t => {
  const f = fixture(t), value = capsule();
  value.archive.revisions = [{privateRecoveryPayload: 'RECOVERY_PRIVATE_VALUE', snapshot: {id: 'not-a-current-id'}}];
  value.archive.assets = [{privateImagePayload: 'IMAGE_PRIVATE_VALUE', data: 'invalid-base64-is-not-read'}];
  value.archive.trash = [{privateTrashPayload: 'TRASH_PRIVATE_VALUE'}];
  await f.seed(value);
  const result = await readCloudLibrary(f.env);
  assert.deepEqual(result.archive, {shards: value.archive.shards, links: value.archive.links});
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_VALUE|privateRecovery|privateImage|privateTrash/);
});

test('missing bindings and opaque provider errors produce bounded known errors only', async () => {
  await rejected(() => readCloudLibrary({}), 'read_only_storage_unavailable');
  await rejected(() => readCloudLibrary({DB: {prepare() {throw new Error('SECRET_SQL');}}, BUCKET: {get() {throw new Error('SECRET_KEY');}}}), 'read_only_storage_unavailable');
});
