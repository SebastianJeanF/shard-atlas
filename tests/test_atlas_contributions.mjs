import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {AtlasContributionError, CLOUD_CONTRIBUTION_LIMITS, contributeCloudKnowledge, validateCloudContributionArguments} from '../hosting/lib/atlas-contributions.mjs';
import {LibraryStorage} from '../sync/storage.mjs';
import {preparePendingSnapshot} from '../sync/client.mjs';
import {sha256} from '../sync/protocol.mjs';
import {emptyDatabase, validateShard} from '../web/model.mjs';
import {fingerprint} from '../web/archives.mjs';
import {importInbox} from '../web/inbox.mjs';

const STAMP = '2026-10-25T12:00:00.000Z';
const CODE = '\n#include <vector>\r\nint identity(int x) {\r\n\treturn x; // [[id:alias]] literal\r\n}\r\n';
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jR7sAAAAASUVORK5CYII=';
const clone = value => JSON.parse(JSON.stringify(value));
const normalized = value => validateShard({...value, createdAt: STAMP, updatedAt: STAMP}, {imported: true});
function originalCapsule() {
  return {format: 'shard-atlas-library', version: 1, futureCapsule: {untouched: ['preserve', {missingMeansMissing: true}]},
    archive: {schemaVersion: 1,
      shards: [normalized({id: 'base', title: 'Existing reference', content: 'Keep this exact explanation.', tags: ['C++'],
        courses: [{courseCode: 'TEST 1000', context: 'Existing course context'}],
        codeSolution: {role: 'snippet', code: CODE, approaches: [{id: 'base-approach', title: 'Existing approach', code: CODE}]}})],
      links: [], reviews: [{id: 'review', shardId: 'base', grade: 'good', reviewedAt: STAMP, nextReviewAt: STAMP}],
      boards: [{id: 'board', title: 'Legacy recovery', items: [], sections: [], viewport: {x: 0, y: 0, zoom: 1}, createdAt: STAMP, updatedAt: STAMP}],
      assets: [{id: 'asset', name: 'Test pixel', mimeType: 'image/png', data: PNG, createdAt: STAMP}],
      revisions: [{id: 'old-version', shardId: 'base', createdAt: STAMP, reason: 'historical', snapshot: {id: 'base', title: 'Old reference', content: 'Do not normalize recovery fields.'}}],
      trash: [{id: 'trash', deletedAt: STAMP, shard: {id: 'removed', title: 'Deleted reference', content: 'Do not resurrect.'}, links: [], reviews: []}],
      futureArchive: {preserve: {exact: 17}}}, contributionReceipts: []};
}
function batch(requestId = 'request-one') {
  return {requestId, shards: [{id: 'new', title: 'New technical explanation', content: 'A self-contained synthetic fixture.', tags: ['c++', 'Algorithms'],
    codeSolution: {role: 'problem', code: CODE, approaches: [{id: 'new-approach', title: 'New approach', code: CODE}]}}],
    links: [{id: 'new-link', fromId: 'new', toId: 'base', type: 'uses', fromApproachId: 'new-approach', toApproachId: 'base-approach', note: 'The fixture uses the saved implementation.'}]};
}

function fixture(t) {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('../sync/schema.sql', import.meta.url), 'utf8'));
  t.after(() => sqlite.close());
  const objects = new Map(), controls = {beforeBatch: null, loseNextReply: false, failReads: false, failReadback: false, failPut: false};
  const calls = {batches: 0, puts: 0};
  const DB = {prepare(sql) {return {bind(...parameters) {return {
    async first() {if (controls.failReads) throw new Error('PRIVATE_SQL_EXCEPTION'); return sqlite.prepare(sql).get(...parameters) || null;},
    async all() {return {results: sqlite.prepare(sql).all(...parameters)};},
    execute() {return {results: sqlite.prepare(sql).all(...parameters)};},
  };}};}, async batch(statements) {
    const before = controls.beforeBatch; controls.beforeBatch = null;
    if (before) await before();
    calls.batches++; sqlite.exec('BEGIN');
    let result;
    try {result = statements.map(statement => statement.execute()); sqlite.exec('COMMIT');}
    catch (error) {sqlite.exec('ROLLBACK'); throw error;}
    if (controls.failReadback) {controls.failReadback = false; controls.failReads = true;}
    if (controls.loseNextReply) {controls.loseNextReply = false; throw new Error('PRIVATE_LOST_RESPONSE');}
    return result;
  }};
  const BUCKET = {async get(key) {const bytes = objects.get(key); return bytes ? {size: bytes.byteLength, body: new Response(bytes).body} : null;},
    async head(key) {return objects.has(key) ? {size: objects.get(key).byteLength} : null;},
    async put(key, bytes) {if (controls.failPut) throw new Error('PRIVATE_OBJECT_KEY'); calls.puts++; objects.set(key, new Uint8Array(bytes));}};
  const env = {DB, BUCKET}, storage = new LibraryStorage(DB, BUCKET);
  let sequence = 0;
  async function publish(capsule, {baseRevision, mutationId} = {}) {
    baseRevision ??= await storage.head(); mutationId ??= 'fixture-' + ++sequence;
    const pending = await preparePendingSnapshot(capsule, baseRevision, mutationId);
    for (const chunk of pending.chunks) await storage.putBlob(chunk.sha256, chunk.data);
    return storage.publish({id: 'fixture-revision-' + ++sequence, mutationId, baseRevision,
      fingerprint: await sha256(new TextEncoder().encode(JSON.stringify({baseRevision, manifest: pending.manifest}))), manifest: pending.manifest, createdAt: STAMP});
  }
  async function read(revision) {
    revision ??= await storage.head();
    const commit = await storage.commit(revision), manifest = JSON.parse(commit.manifest);
    const chunks = manifest.chunks.map(chunk => objects.get('libraries/owner/blobs/' + chunk.sha256));
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }
  const seed = async (capsule = originalCapsule()) => (await publish(capsule)).id;
  return {env, sqlite, objects, storage, controls, calls, publish, read, seed};
}

async function rejects(action, code) {
  await assert.rejects(action, error => {
    assert.ok(error instanceof AtlasContributionError); assert.equal(error.code, code);
    assert.ok(error.message.length < 350); assert.doesNotMatch(error.message, /PRIVATE_|SELECT |libraries\//);
    return true;
  });
}

test('atomic cloud addition preserves all existing portable records, recovery fields and unknown extensions exactly', async t => {
  const f = fixture(t), before = originalCapsule(), expectedRevision = await f.seed(before);
  const receipt = await contributeCloudKnowledge(f.env, {batch: batch(), expectedRevision});
  assert.equal(receipt.verified, true); assert.equal(receipt.currentContentMatches, true); assert.equal(receipt.replayed, false);
  assert.equal(receipt.originalSaveVerified, true); assert.equal(receipt.currentRevision, receipt.acceptedRevision);
  assert.deepEqual(receipt.added, {shards: 1, links: 1});
  const saved = await f.read();
  for (const key of ['reviews', 'boards', 'assets', 'trash', 'futureArchive']) assert.deepEqual(saved.archive[key], before.archive[key]);
  assert.deepEqual(saved.archive.shards[0], before.archive.shards[0]);
  assert.deepEqual(saved.archive.revisions[0], before.archive.revisions[0]);
  assert.deepEqual(saved.futureCapsule, before.futureCapsule);
  assert.equal(saved.archive.shards[1].codeSolution.code, CODE);
  assert.equal(saved.archive.shards[1].codeSolution.approaches[0].code, CODE);
  assert.deepEqual(saved.archive.shards[1].tags, ['C++', 'Algorithms']);
  assert.equal(saved.archive.links[0].fromApproachId, 'new-approach'); assert.equal(saved.archive.links[0].toApproachId, 'base-approach');
  assert.equal(saved.archive.revisions[1].reason, 'ai-contribution');
  const entry = saved.contributionReceipts[0];
  assert.equal(entry.requestId, batch().requestId); assert.equal(entry.fingerprint, fingerprint(batch()));
  assert.equal(entry.savedRecords.length, 2);
  assert.deepEqual(await f.read(expectedRevision), before, 'The previous accepted cloud copy remains recoverable.');
});

test('empty cloud can be initialized additively with the explicitly reviewed empty revision', async t => {
  const f = fixture(t), value = batch(); value.links = [];
  const receipt = await contributeCloudKnowledge(f.env, {batch: value, expectedRevision: ''});
  assert.equal(receipt.verified, true); assert.equal((await f.read()).archive.shards.length, 1);
});

test('exact retries and lost replies reuse the durable request receipt without another accepted revision', async t => {
  const f = fixture(t), expectedRevision = await f.seed();
  f.controls.loseNextReply = true;
  await rejects(() => contributeCloudKnowledge(f.env, {batch: batch(), expectedRevision}), 'save_outcome_unknown');
  const head = await f.storage.head(), puts = f.calls.puts, writes = f.calls.batches;
  const result = await contributeCloudKnowledge(f.env, {batch: batch(), expectedRevision});
  assert.equal(result.replayed, true); assert.equal(result.verified, true); assert.equal(result.acceptedRevision, head);
  assert.equal(f.calls.puts, puts); assert.equal(f.calls.batches, writes);
  assert.equal((await f.read()).archive.shards.filter(record => record.id === 'new').length, 1);
});

test('successful publish followed by failed readback reports an unknown save outcome and an exact retry recovers it', async t => {
  const f = fixture(t), expectedRevision = await f.seed(); f.controls.failReadback = true;
  await rejects(() => contributeCloudKnowledge(f.env, {batch: batch(), expectedRevision}), 'save_outcome_unknown');
  f.controls.failReads = false;
  const receipt = await contributeCloudKnowledge(f.env, {batch: batch(), expectedRevision});
  assert.equal(receipt.replayed, true); assert.equal(receipt.verified, true);
});

test('request ID reuse rejects even normalized-looking payload differences and never changes the cloud', async t => {
  const f = fixture(t), expectedRevision = await f.seed();
  await contributeCloudKnowledge(f.env, {batch: batch(), expectedRevision});
  const head = await f.storage.head(), puts = f.calls.puts;
  const changed = batch(); changed.shards[0].tags[0] = 'C++';
  await rejects(() => contributeCloudKnowledge(f.env, {batch: changed, expectedRevision}), 'request_id_reused');
  assert.equal(await f.storage.head(), head); assert.equal(f.calls.puts, puts);
});

test('replay after later edits/deletions and receipt removal preserves the current library and reports differences', async t => {
  const f = fixture(t), expectedRevision = await f.seed();
  const first = await contributeCloudKnowledge(f.env, {batch: batch(), expectedRevision});
  const later = await f.read(); later.archive.shards.find(record => record.id === 'new').content = 'A later user edit.';
  later.archive.links = []; later.contributionReceipts = [];
  await f.publish(later);
  const head = await f.storage.head(), writes = f.calls.batches;
  const receipt = await contributeCloudKnowledge(f.env, {batch: batch(), expectedRevision});
  assert.equal(receipt.replayed, true); assert.equal(receipt.currentContentMatches, false); assert.equal(receipt.originalSaveVerified, true);
  assert.deepEqual(receipt.changedShardIds, ['new']); assert.deepEqual(receipt.missingLinkIds, ['new-link']);
  assert.equal(receipt.acceptedRevision, first.acceptedRevision); assert.equal(receipt.currentRevision, head);
  assert.equal(f.calls.batches, writes); assert.deepEqual(await f.read(), later);
});

test('stale reviewed revisions fail before uploading or writing', async t => {
  const f = fixture(t), old = await f.seed(); await f.publish(originalCapsule());
  const puts = f.calls.puts, writes = f.calls.batches, head = await f.storage.head();
  await rejects(() => contributeCloudKnowledge(f.env, {batch: batch(), expectedRevision: old}), 'cloud_library_changed');
  assert.equal(f.calls.puts, puts); assert.equal(f.calls.batches, writes); assert.equal(await f.storage.head(), head);
});

test('concurrent cloud changes win CAS without partial insertion; the losing request stays explicitly conflicted', async t => {
  const f = fixture(t), expectedRevision = await f.seed();
  const other = originalCapsule(); other.futureCapsule.otherAcceptedChange = true;
  f.controls.beforeBatch = () => f.publish(other);
  await rejects(() => contributeCloudKnowledge(f.env, {batch: batch(), expectedRevision}), 'request_conflicted');
  assert.deepEqual(await f.read(), other);
  const writes = f.calls.batches, puts = f.calls.puts;
  await rejects(async () => contributeCloudKnowledge(f.env, {batch: batch(), expectedRevision: await f.storage.head()}), 'request_conflicted');
  assert.equal(f.calls.batches, writes); assert.equal(f.calls.puts, puts);
  assert.equal(f.sqlite.prepare("SELECT count(*) AS n FROM library_commits WHERE status='conflict'").get().n, 1);
});

test('simultaneous identical requests are idempotent despite independent generated timestamps and revision IDs', async t => {
  const f = fixture(t), expectedRevision = await f.seed();
  const results = await Promise.all([contributeCloudKnowledge(f.env, {batch: batch(), expectedRevision}), contributeCloudKnowledge(f.env, {batch: batch(), expectedRevision})]);
  assert.equal(results[0].acceptedRevision, results[1].acceptedRevision);
  assert.ok(results.every(receipt => receipt.verified));
  assert.equal(f.sqlite.prepare("SELECT count(*) AS n FROM library_commits WHERE status='accepted'").get().n, 2);
});

test('large snapshot work is serialized per binding pair and queued request count is bounded', async t => {
  const f = fixture(t), expectedRevision = await f.seed();
  let release, started;
  const gate = new Promise(resolve => {release = resolve;});
  const began = new Promise(resolve => {started = resolve;});
  f.controls.beforeBatch = async () => {started(); await gate;};
  const first = contributeCloudKnowledge(f.env, {batch: batch(), expectedRevision});
  await began;
  const queued = Array.from({length: 3}, () => contributeCloudKnowledge(f.env, {batch: batch(), expectedRevision}));
  await rejects(() => contributeCloudKnowledge(f.env, {batch: batch(), expectedRevision}), 'cloud_busy');
  release();
  const result = await Promise.all([first, ...queued]);
  assert.equal(result.filter(receipt => !receipt.replayed).length, 1);
  assert.ok(result.every(receipt => receipt.verified));
});

test('duplicates reuse actual IDs and remap explained links while preserving code literals and existing notes', async t => {
  const f = fixture(t), original = originalCapsule(), expectedRevision = await f.seed(original);
  const value = batch('duplicate-request');
  value.shards = [{id: 'alias', title: original.archive.shards[0].title, content: original.archive.shards[0].content, tags: ['NEW METADATA MUST NOT OVERWRITE'], codeSolution: clone(original.archive.shards[0].codeSolution)},
    {id: 'new', title: 'Complementary explanation', content: 'See [[id:alias|reference]].\r\n~~~cpp\r\n// [[id:alias]]\r\n~~~\r\nLiteral `[[id:alias]]`.\r\n', tags: ['C++'], codeSolution: {role: 'snippet', code: CODE}}];
  value.links = [{id: 'new-link', fromId: 'new', toId: 'alias', type: 'explains', note: 'Complementary mechanism.'}];
  const receipt = await contributeCloudKnowledge(f.env, {batch: value, expectedRevision});
  assert.deepEqual(receipt.added, {shards: 1, links: 1}); assert.equal(receipt.idMap.alias, 'base');
  const current = await f.read(), note = current.archive.shards.find(record => record.id === 'new');
  assert.deepEqual(current.archive.shards[0], original.archive.shards[0]);
  assert.match(note.content, /See \[\[id:base\|reference\]\]/);
  assert.match(note.content, /\/\/ \[\[id:alias\]\]/); assert.match(note.content, /`\[\[id:alias\]\]`/);
  assert.equal(note.codeSolution.code, CODE); assert.equal(current.archive.links[0].toId, 'base');
});

test('safe contribution planner matches existing browser duplicate, tag and relationship outcomes', async t => {
  const f = fixture(t), original = originalCapsule(), expectedRevision = await f.seed(original), value = batch();
  const browser = emptyDatabase(); browser.archive = clone(original.archive);
  const expected = importInbox(browser, {format: 'shard-atlas-inbox', version: 1, batch: clone(value)});
  const actual = await contributeCloudKnowledge(f.env, {batch: value, expectedRevision});
  for (const key of ['added', 'skipped', 'shards', 'links', 'idMap']) assert.deepEqual(actual[key], expected[key]);
  const current = await f.read(), left = current.archive.shards.find(record => record.id === 'new'), right = browser.archive.shards.find(record => record.id === 'new');
  for (const key of ['createdAt', 'updatedAt']) {delete left[key]; delete right[key];}
  assert.deepEqual(left, right);
});

test('portable receipt copied into another cloud remains replay-safe without a durable MCP mutation row', async t => {
  const source = fixture(t), expectedRevision = await source.seed();
  await contributeCloudKnowledge(source.env, {batch: batch(), expectedRevision});
  const saved = await source.read(), destination = fixture(t), destinationHead = await destination.seed(saved);
  const puts = destination.calls.puts;
  const receipt = await contributeCloudKnowledge(destination.env, {batch: batch(), expectedRevision: 'old-reviewed-revision'});
  assert.equal(receipt.replayed, true); assert.equal(receipt.verified, true); assert.equal(receipt.currentRevision, destinationHead);
  assert.equal(destination.calls.puts, puts);
});

test('legacy native receipts without saved-record fingerprints still verify current content and preserve later changes', async t => {
  const source = fixture(t), expectedRevision = await source.seed();
  await contributeCloudKnowledge(source.env, {batch: batch(), expectedRevision});
  const saved = await source.read(); delete saved.contributionReceipts[0].savedRecords;
  const destination = fixture(t); await destination.seed(saved);
  assert.equal((await contributeCloudKnowledge(destination.env, {batch: batch(), expectedRevision: 'old-base'})).verified, true);
  saved.archive.shards.find(record => record.id === 'new').courses = [{courseCode: 'LATER 2000'}];
  await destination.publish(saved);
  const receipt = await contributeCloudKnowledge(destination.env, {batch: batch(), expectedRevision: 'old-base'});
  assert.equal(receipt.currentContentMatches, false); assert.deepEqual(receipt.changedShardIds, ['new']);
});

test('receipt output excludes arbitrary extensions and corrupt fingerprints cannot claim a verified replay', async t => {
  const source = fixture(t), expectedRevision = await source.seed();
  await contributeCloudKnowledge(source.env, {batch: batch(), expectedRevision});
  const saved = await source.read(), entry = saved.contributionReceipts[0];
  entry.receipt.privateToken = 'PRIVATE_TOKEN'; entry.receipt.added.privateToken = 'PRIVATE_TOKEN';
  const destination = fixture(t); await destination.seed(saved);
  const safe = await contributeCloudKnowledge(destination.env, {batch: batch(), expectedRevision: 'old-base'});
  assert.doesNotMatch(JSON.stringify(safe), /PRIVATE_TOKEN|privateToken/);
  entry.savedRecords[1] = clone(entry.savedRecords[0]);
  await destination.publish(saved);
  await rejects(() => contributeCloudKnowledge(destination.env, {batch: batch(), expectedRevision: 'old-base'}), 'cloud_library_invalid');
});

test('invalid batches, edits, deletions, assets, unknown fields and oversized requests are rejected before storage access', async () => {
  const noAccess = new Proxy({}, {get() {throw new Error('Storage must not be accessed');}});
  const variants = [
    args => {delete args.expectedRevision;}, args => {args.expectedRevision = 'bad/path';}, args => {args.extra = true;},
    args => {args.batch.assets = [];}, args => {args.batch.edits = [];}, args => {args.batch.deletedIds = [];},
    args => {args.batch.shards[0].unknown = 'no';}, args => {args.batch.shards[0].createdAt = STAMP;},
    args => {delete args.batch.shards[0].tags;}, args => {delete args.batch.links[0].id;},
    args => {args.batch.shards.push(clone(args.batch.shards[0]));}, args => {args.batch.links[0].type = 'not-a-type';},
    args => {args.batch.shards[0].codeSolution.code = 17;},
    args => {args.batch.shards = Array.from({length: 21}, (_, index) => ({id: 'note-' + index, title: 'Fixture', content: '', tags: []}));},
    args => {args.batch.links = Array.from({length: 101}, (_, index) => ({id: 'link-' + index, fromId: 'new', toId: 'base', type: 'uses'}));},
  ];
  for (const change of variants) {
    const args = {batch: batch(), expectedRevision: ''}; change(args);
    await rejects(() => contributeCloudKnowledge(noAccess, args), 'invalid_contribution');
  }
  const large = {batch: batch(), expectedRevision: ''};
  large.batch.shards = Array.from({length: 4}, (_, index) => ({id: 'large-' + index, title: 'Large fixture', content: 'x'.repeat(80_000), tags: []}));
  await rejects(() => contributeCloudKnowledge(noAccess, large), 'contribution_too_large');
  const args = {batch: batch(), expectedRevision: ''};
  assert.equal(validateCloudContributionArguments(args).batch, args.batch);
});

test('ID conflicts, deleted identities and dangling approach references reject the entire batch without writes', async t => {
  for (const variant of ['id-conflict', 'deleted-id', 'dangling-approach', 'self-link-after-reuse']) await t.test(variant, async t => {
    const f = fixture(t), original = originalCapsule(), expectedRevision = await f.seed(original), value = batch();
    if (variant === 'id-conflict') value.shards[0].id = 'base';
    if (variant === 'deleted-id') value.shards[0].id = 'removed';
    if (variant === 'dangling-approach') value.links[0].fromApproachId = 'missing';
    if (variant === 'self-link-after-reuse') {
      value.shards[0] = {id: 'new', title: original.archive.shards[0].title, content: original.archive.shards[0].content, tags: [], codeSolution: original.archive.shards[0].codeSolution};
      value.links[0].fromApproachId = ''; value.links[0].toApproachId = '';
    }
    const puts = f.calls.puts, writes = f.calls.batches;
    await rejects(() => contributeCloudKnowledge(f.env, {batch: value, expectedRevision}), 'contribution_conflict');
    assert.equal(f.calls.puts, puts); assert.equal(f.calls.batches, writes); assert.deepEqual(await f.read(), original);
  });
});

test('malformed current snapshots fail without publishing and provider errors never expose private details', async t => {
  const f = fixture(t), expectedRevision = await f.seed();
  const row = await f.storage.commit(expectedRevision), manifest = JSON.parse(row.manifest);
  const tooLarge = {...manifest, bytes: CLOUD_CONTRIBUTION_LIMITS.snapshotBytes + 1,
    chunks: Array.from({length: 5}, (_, index) => ({sha256: 'a'.repeat(64), bytes: index === 4 ? 1 : 4 * 1024 * 1024}))};
  f.sqlite.prepare('UPDATE library_commits SET manifest=? WHERE id=?').run(JSON.stringify(tooLarge), expectedRevision);
  await rejects(() => contributeCloudKnowledge(f.env, {batch: batch(), expectedRevision}), 'cloud_library_invalid');
  f.sqlite.prepare('UPDATE library_commits SET manifest=? WHERE id=?').run(row.manifest, expectedRevision);
  f.objects.delete('libraries/owner/blobs/' + manifest.chunks[0].sha256);
  await rejects(() => contributeCloudKnowledge(f.env, {batch: batch(), expectedRevision}), 'cloud_library_invalid');
  f.controls.failReads = true;
  await rejects(() => contributeCloudKnowledge(f.env, {batch: batch(), expectedRevision}), 'cloud_library_unavailable');
});

test('outgoing snapshot capacity is checked before any uploaded objects or cloud writes', async t => {
  const f = fixture(t), original = originalCapsule();
  const initialBytes = new TextEncoder().encode(JSON.stringify(original)).byteLength;
  original.futureCapsule.padding = 'x'.repeat(CLOUD_CONTRIBUTION_LIMITS.snapshotBytes - initialBytes - 400_000);
  const expectedRevision = await f.seed(original), puts = f.calls.puts, writes = f.calls.batches;
  const value = {requestId: 'capacity-request', shards: Array.from({length: 3}, (_, index) => ({id: 'large-note-' + index,
    title: 'Capacity fixture ' + index, content: 'y'.repeat(80_000), tags: []})), links: []};
  await rejects(() => contributeCloudKnowledge(f.env, {batch: value, expectedRevision}), 'cloud_snapshot_too_large');
  assert.equal(await f.storage.head(), expectedRevision); assert.equal(f.calls.puts, puts); assert.equal(f.calls.batches, writes);
});

test('explicit invalid receipt collections are rejected rather than silently normalized', async t => {
  const f = fixture(t), original = originalCapsule(); original.contributionReceipts = null;
  const expectedRevision = await f.seed(original), puts = f.calls.puts;
  await rejects(() => contributeCloudKnowledge(f.env, {batch: batch(), expectedRevision}), 'cloud_library_invalid');
  assert.equal(f.calls.puts, puts);
});
