import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {AtlasEditError, CLOUD_EDIT_LIMITS, editCloudKnowledge, validateCloudEditArguments} from '../hosting/lib/atlas-edits.mjs';
import {contributeCloudKnowledge, withCloudMutationStorage} from '../hosting/lib/atlas-contributions.mjs';
import {LibraryStorage} from '../sync/storage.mjs';
import {preparePendingSnapshot} from '../sync/client.mjs';
import {sha256} from '../sync/protocol.mjs';
import {validateLink, validateShard} from '../web/model.mjs';
import {fingerprint} from '../web/archives.mjs';

const STAMP = '2026-10-25T12:00:00.000Z';
const CODE = '\nint exact(int x) {\r\n\treturn x; // literal [[id:base]]\r\n}\r\n';
const clone = value => JSON.parse(JSON.stringify(value));
const note = (id, extra = {}) => validateShard({id, title: id + ' reference', content: 'Original explanation.', tags: ['C++'], createdAt: STAMP, updatedAt: STAMP, ...extra}, {imported: true});
function original() {
  const base = note('base', {codeSolution: {role: 'problem', code: CODE, purpose: 'Keep this purpose.', approaches: [
    {id: 'first', title: 'First saved variant', code: CODE, timeComplexity: 'O(1)'},
    {id: 'second', title: 'Second saved variant', code: 'return 2;'}]},
  verification: {status: 'unverified', note: 'Keep this verification.', sourceUrl: 'https://example.com/source', sourceLocation: 'Example', checkedAt: '2026-10-25'}});
  delete base.prompt;
  base.futureShard = {preserve: ['unknown', {exact: true}]};
  const link = validateLink({id: 'saved-link', fromId: 'base', toId: 'other', fromApproachId: 'first', type: 'uses', note: 'Original connection.', createdAt: STAMP}, {imported: true});
  link.futureLink = {original: true};
  return {format: 'shard-atlas-library', version: 1, futureCapsule: {preserve: 'exact'}, archive: {schemaVersion: 1,
    shards: [base, note('other'), note('third')], links: [link], assets: [{id: 'image', opaqueFixture: 'Keep image bytes untouched.'}],
    revisions: [{id: 'old-revision', shardId: 'base', createdAt: STAMP, reason: 'legacy', snapshot: {id: 'base', title: 'Legacy partial snapshot'}}],
    reviews: [{id: 'review', shardId: 'base', grade: 'good'}], boards: [{id: 'board', preserve: 'legacy'}],
    trash: [{id: 'trash', shard: {id: 'deleted', title: 'Deleted record'}, links: [{id: 'trash-link', fromId: 'base', toId: 'deleted', fromApproachId: 'second'}], reviews: []}],
    futureArchive: {keep: ['unchanged']}}, contributionReceipts: []};
}
const batch = (requestId = 'edit-request') => ({requestId, shards: [{id: 'base', changes: {content: 'Edited explanation.', codeSolution: {code: CODE + '// changed\r\n'}}}],
  links: [{id: 'saved-link', changes: {note: 'Edited connection.'}}]});

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
  const BUCKET = {async get(key) {const data = objects.get(key); return data ? {size: data.byteLength, body: new Response(data).body} : null;},
    async head(key) {return objects.has(key) ? {size: objects.get(key).byteLength} : null;},
    async put(key, data) {if (controls.failPut) throw new Error('PRIVATE_BUCKET_KEY'); calls.puts++; objects.set(key, new Uint8Array(data));}};
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
    return JSON.parse(Buffer.concat(manifest.chunks.map(chunk => objects.get('libraries/owner/blobs/' + chunk.sha256))).toString('utf8'));
  }
  const seed = async (capsule = original()) => (await publish(capsule)).id;
  return {env, sqlite, objects, storage, controls, calls, publish, read, seed};
}
async function rejects(action, code) {
  await assert.rejects(action, error => {
    assert.ok(error instanceof AtlasEditError); assert.equal(error.code, code);
    assert.ok(error.message.length < 350); assert.doesNotMatch(error.message, /PRIVATE_|SELECT |libraries\//);
    return true;
  });
}

test('atomic sparse edits preserve unknown fields, all recovery records and exact before/after history', async t => {
  const f = fixture(t), before = original(), expectedRevision = await f.seed(before);
  const receipt = await editCloudKnowledge(f.env, {batch: batch(), expectedRevision});
  assert.equal(receipt.operation, 'edit'); assert.equal(receipt.verified, true); assert.equal(receipt.originalSaveVerified, true);
  assert.deepEqual(receipt.edited, {shards: 1, links: 1}); assert.deepEqual(receipt.unchanged, {shards: 0, links: 0});
  assert.equal(receipt.currentRevision, receipt.acceptedRevision); assert.equal(receipt.replayed, false);
  const after = await f.read(), shard = after.archive.shards[0];
  assert.equal(shard.content, 'Edited explanation.'); assert.equal(shard.codeSolution.code, CODE + '// changed\r\n');
  assert.equal(shard.codeSolution.purpose, before.archive.shards[0].codeSolution.purpose);
  assert.deepEqual(shard.codeSolution.approaches, before.archive.shards[0].codeSolution.approaches);
  assert.deepEqual(shard.futureShard, before.archive.shards[0].futureShard); assert.equal(Object.hasOwn(shard, 'prompt'), false);
  assert.equal(shard.createdAt, STAMP); assert.notEqual(shard.updatedAt, STAMP);
  for (const key of ['assets', 'reviews', 'boards', 'trash', 'futureArchive']) assert.deepEqual(after.archive[key], before.archive[key]);
  assert.deepEqual(after.futureCapsule, before.futureCapsule); assert.deepEqual(after.archive.shards.slice(1), before.archive.shards.slice(1));
  assert.deepEqual(after.archive.revisions[0], before.archive.revisions[0]); assert.equal(after.archive.revisions.length, before.archive.revisions.length + 2);
  assert.deepEqual(after.archive.revisions.at(-2).snapshot, before.archive.shards[0]);
  assert.deepEqual(after.archive.revisions.at(-1).snapshot, shard);
  assert.equal(after.archive.links[0].createdAt, STAMP); assert.deepEqual(after.archive.links[0].futureLink, before.archive.links[0].futureLink);
  const entry = after.contributionReceipts[0];
  assert.deepEqual(entry.receipt.added, {shards: 0, links: 0});
  assert.doesNotThrow(() => `${entry.receipt.added.shards} notes · ${entry.receipt.added.links} connections`, 'The pre-M4 browser history renderer remains safe.');
  assert.deepEqual(entry.beforeRecords, [{kind: 'links', id: 'saved-link', record: before.archive.links[0]}]);
  assert.deepEqual(receipt.shardRevisions, entry.receipt.shardRevisions); assert.equal(receipt.shardRevisions.length, 1);
  assert.equal(receipt.shardRevisions[0].beforeRevisionId, after.archive.revisions.at(-2).id);
  assert.doesNotMatch(JSON.stringify(receipt), /futureShard|futureLink|opaqueFixture|Original explanation/);
  assert.deepEqual(await f.read(expectedRevision), before, 'The complete pre-edit accepted snapshot remains immutable.');
});

test('approach patches retain omitted code and original order, append explicit new IDs, and merge objects sparsely', async t => {
  const f = fixture(t), before = original(), expectedRevision = await f.seed(before), value = batch();
  value.shards[0].changes = {verification: {note: 'Updated verification only.'}, codeSolution: {approaches: [
    {id: 'second', summary: 'Updated second.'}, {id: 'first', code: CODE + '// first\r\n'}, {id: 'new-approach', title: 'Third variant', code: '\r\nreturn 3;\r\n'}]}};
  await editCloudKnowledge(f.env, {batch: value, expectedRevision});
  const shard = (await f.read()).archive.shards[0];
  assert.deepEqual(shard.codeSolution.approaches.map(item => item.id), ['first', 'second', 'new-approach']);
  assert.equal(shard.codeSolution.approaches[0].title, before.archive.shards[0].codeSolution.approaches[0].title);
  assert.equal(shard.codeSolution.approaches[0].timeComplexity, 'O(1)'); assert.equal(shard.codeSolution.approaches[1].code, 'return 2;');
  assert.equal(shard.codeSolution.approaches[2].code, '\r\nreturn 3;\r\n');
  assert.deepEqual(shard.verification, {...before.archive.shards[0].verification, note: 'Updated verification only.'});
});

test('[] and identity-only approach patches are no-ops, while ordinary arrays replace explicitly', async t => {
  const f = fixture(t), before = original(), expectedRevision = await f.seed(before), value = batch();
  value.links = []; value.shards[0].changes = {codeSolution: {approaches: []}};
  const receipt = await editCloudKnowledge(f.env, {batch: value, expectedRevision});
  assert.deepEqual(receipt.edited, {shards: 0, links: 0}); assert.deepEqual(receipt.unchanged, {shards: 1, links: 0});
  let after = await f.read(); assert.deepEqual(after.archive, before.archive); assert.deepEqual(receipt.shardRevisions, []);
  const second = {requestId: 'identity-only', shards: [{id: 'base', changes: {codeSolution: {approaches: [{id: 'first'}]}}}], links: []};
  assert.equal((await editCloudKnowledge(f.env, {batch: second, expectedRevision: receipt.acceptedRevision})).edited.shards, 0);
  const third = {requestId: 'replace-tags', shards: [{id: 'base', changes: {tags: []}}], links: []};
  await editCloudKnowledge(f.env, {batch: third, expectedRevision: await f.storage.head()});
  after = await f.read(); assert.deepEqual(after.archive.shards[0].tags, []); assert.equal(after.archive.shards[0].codeSolution.approaches.length, 2);
});

test('title-only edits preserve raw optional omissions and sparse validation retains existing cross-field context', async t => {
  const f = fixture(t), before = original(), expectedRevision = await f.seed(before);
  const value = {requestId: 'title-only', shards: [{id: 'base', changes: {title: 'A revised title'}}], links: []};
  await editCloudKnowledge(f.env, {batch: value, expectedRevision});
  let current = await f.read();
  const {title, updatedAt, ...remaining} = current.archive.shards[0];
  const {title: oldTitle, updatedAt: oldStamp, ...oldRemaining} = before.archive.shards[0];
  assert.equal(title, 'A revised title'); assert.deepEqual(remaining, oldRemaining); assert.equal(Object.hasOwn(remaining, 'prompt'), false);
  const contextual = {requestId: 'context-only', shards: [{id: 'base', changes: {verification: {status: 'source-checked'}}}], links: []};
  await editCloudKnowledge(f.env, {batch: contextual, expectedRevision: await f.storage.head()});
  current = await f.read(); assert.equal(current.archive.shards[0].verification.status, 'source-checked');
  assert.equal(current.archive.shards[0].verification.note, before.archive.shards[0].verification.note);
  current.archive.links[0] = validateLink({...current.archive.links[0], type: 'alternative_to', fromId: 'base', toId: 'base', fromApproachId: 'first', toApproachId: 'second'}, {imported: true});
  await f.publish(current);
  const endpoints = {requestId: 'same-endpoint', shards: [], links: [{id: 'saved-link', changes: {fromId: 'base', toId: 'base'}}]};
  assert.equal((await editCloudKnowledge(f.env, {batch: endpoints, expectedRevision: await f.storage.head()})).unchanged.links, 1);
});

test('invalid, immutable, unsafe and oversized patches are rejected before storage access', async () => {
  const invalid = [null, {}, {batch: batch()}, {batch: {...batch(), shards: []}, expectedRevision: 17}];
  for (const changes of [{}, {id: 'changed'}, {createdAt: STAMP}, {reviewCount: 5}, {lastReviewedAt: STAMP}, {assets: []}, {delete: true},
    {futureExtension: true}, {title: 3}, {content: null}, {codeSolution: {}}, {codeSolution: {approaches: [{}]}},
    {codeSolution: {approaches: [{id: 'first'}, {id: 'first'}]}}, {verification: {unknown: 'x'}}, {sources: [{url: 'https://example.com', secret: 'x'}]},
    JSON.parse('{"codeSolution":{"constructor":{"polluted":true}}}')]) invalid.push({batch: {requestId: 'bad', shards: [{id: 'base', changes}], links: []}, expectedRevision: 'revision'});
  invalid.push({batch: {requestId: 'empty', shards: [], links: []}, expectedRevision: 'revision'});
  invalid.push({batch: {requestId: 'missing-links', shards: []}, expectedRevision: 'revision'});
  invalid.push({batch: {requestId: 'duplicate-patch', shards: [batch().shards[0], batch().shards[0]], links: []}, expectedRevision: 'revision'});
  for (const args of invalid) await rejects(() => editCloudKnowledge(null, args), 'invalid_edit');
  const huge = batch(); huge.shards[0].changes.content = 'x'.repeat(CLOUD_EDIT_LIMITS.batchBytes);
  await rejects(() => editCloudKnowledge(null, {batch: huge, expectedRevision: 'revision'}), 'edit_too_large');
  assert.doesNotThrow(() => validateCloudEditArguments({batch: {requestId: 'shape', shards: [{id: 'base', changes: {codeSolution: {approaches: [{id: 'first'}]}}}], links: []}, expectedRevision: 'revision'}));
});

test('exact retries and a lost publication reply use one durable accepted mutation', async t => {
  const f = fixture(t), expectedRevision = await f.seed(), value = batch();
  f.controls.loseNextReply = true;
  await rejects(() => editCloudKnowledge(f.env, {batch: value, expectedRevision}), 'save_outcome_unknown');
  const head = await f.storage.head(), writes = {...f.calls};
  const receipt = await editCloudKnowledge(f.env, {batch: value, expectedRevision: 'different-stale-revision'});
  assert.equal(receipt.replayed, true); assert.equal(receipt.verified, true); assert.equal(receipt.acceptedRevision, head);
  assert.deepEqual(f.calls, writes); assert.equal((await f.read()).archive.revisions.length, 3);
  const changed = clone(value); changed.shards[0].changes.content += ' ';
  await rejects(() => editCloudKnowledge(f.env, {batch: changed, expectedRevision: head}), 'request_id_reused');
});

test('publication accepted before readback fails is reported as unknown and safely replayed', async t => {
  const f = fixture(t), expectedRevision = await f.seed(); f.controls.failReadback = true;
  await rejects(() => editCloudKnowledge(f.env, {batch: batch(), expectedRevision}), 'save_outcome_unknown');
  f.controls.failReads = false;
  assert.equal((await editCloudKnowledge(f.env, {batch: batch(), expectedRevision})).replayed, true);
});

test('accepted replay preserves later edits and deleted records even when the portable receipt was removed', async t => {
  const f = fixture(t), expectedRevision = await f.seed(), value = batch();
  const first = await editCloudKnowledge(f.env, {batch: value, expectedRevision});
  const newer = await f.read(); newer.archive.shards[0].content = 'A later human edit.';
  newer.archive.links = []; newer.contributionReceipts = [];
  await f.publish(newer); const head = await f.storage.head(), calls = {...f.calls};
  const replay = await editCloudKnowledge(f.env, {batch: value, expectedRevision});
  assert.equal(replay.acceptedRevision, first.acceptedRevision); assert.equal(replay.currentRevision, head);
  assert.equal(replay.verified, false); assert.equal(replay.originalSaveVerified, true); assert.equal(replay.currentContentMatches, false);
  assert.deepEqual(replay.changedShardIds, ['base']); assert.deepEqual(replay.missingLinkIds, ['saved-link']);
  assert.deepEqual(await f.read(), newer); assert.deepEqual(f.calls, calls);
  newer.archive.shards = newer.archive.shards.filter(item => item.id !== 'base'); newer.archive.trash = [];
  await f.publish(newer);
  assert.deepEqual((await editCloudKnowledge(f.env, {batch: value, expectedRevision})).missingShardIds, ['base']);
});

test('additions and edits share the durable request-ID namespace in both directions', async t => {
  const f = fixture(t), expectedRevision = await f.seed();
  await editCloudKnowledge(f.env, {batch: batch('same-request'), expectedRevision});
  let current = await f.read(); current.contributionReceipts = []; await f.publish(current);
  const addition = {requestId: 'same-request', shards: [{id: 'new', title: 'New', content: 'New technical note.', tags: []}], links: []};
  await assert.rejects(() => contributeCloudKnowledge(f.env, {batch: addition, expectedRevision: ''}), error => error.code === 'request_id_reused');
  const other = {...addition, requestId: 'another-request'};
  await contributeCloudKnowledge(f.env, {batch: other, expectedRevision: await f.storage.head()});
  current = await f.read(); current.contributionReceipts = []; await f.publish(current);
  const reviewed = await f.storage.head();
  await rejects(() => editCloudKnowledge(f.env, {batch: batch('another-request'), expectedRevision: reviewed}), 'request_id_reused');
});

test('a portable Drive receipt with the same request ID is never treated as an edit', async t => {
  const f = fixture(t), capsule = original();
  capsule.contributionReceipts.push({requestId: batch().requestId, fingerprint: 'a'.repeat(64), receipt: {requestId: batch().requestId, shards: [], links: []}});
  const expectedRevision = await f.seed(capsule), calls = {...f.calls};
  await rejects(() => editCloudKnowledge(f.env, {batch: batch(), expectedRevision}), 'request_id_reused'); assert.deepEqual(f.calls, calls);
});

test('stale base, missing target, dangling endpoints and duplicate final relationships cause no publication', async t => {
  const f = fixture(t), capsule = original();
  capsule.archive.links.push(validateLink({id: 'other-link', fromId: 'base', toId: 'third', fromApproachId: 'first', type: 'uses', createdAt: STAMP}, {imported: true}));
  const expectedRevision = await f.seed(capsule), calls = {...f.calls};
  await rejects(() => editCloudKnowledge(f.env, {batch: batch(), expectedRevision: 'old-revision'}), 'cloud_library_changed');
  const cases = [
    {requestId: 'missing', shards: [{id: 'missing', changes: {title: 'Missing'}}], links: []},
    {requestId: 'dangling', shards: [], links: [{id: 'saved-link', changes: {toId: 'missing'}}]},
    {requestId: 'missing-approach', shards: [], links: [{id: 'saved-link', changes: {fromApproachId: 'absent'}}]},
    {requestId: 'duplicate', shards: [], links: [{id: 'saved-link', changes: {toId: 'third'}}]},
  ];
  for (const value of cases) await rejects(() => editCloudKnowledge(f.env, {batch: value, expectedRevision}), 'edit_conflict');
  assert.deepEqual(f.calls, calls); assert.deepEqual(await f.read(), capsule);
});

test('new approaches require explicit title and nonempty code before any snapshot upload', async t => {
  const f = fixture(t), expectedRevision = await f.seed(), calls = {...f.calls};
  for (const approach of [{id: 'new'}, {id: 'new', title: 'New'}, {id: 'new', title: '', code: 'return 1;'}, {id: 'new', title: 'New', code: '  '}]) {
    const value = {requestId: 'invalid-approach', shards: [{id: 'base', changes: {codeSolution: {approaches: [approach]}}}], links: []};
    await rejects(() => editCloudKnowledge(f.env, {batch: value, expectedRevision}), 'invalid_edit');
  }
  assert.deepEqual(f.calls, calls);
});

test('a concurrent CAS winner is preserved and the conflicted request remains review-only', async t => {
  const f = fixture(t), expectedRevision = await f.seed(), winner = original(); winner.archive.shards[0].content = 'Concurrent winner.';
  f.controls.beforeBatch = () => f.publish(winner);
  await rejects(() => editCloudKnowledge(f.env, {batch: batch(), expectedRevision}), 'request_conflicted');
  const head = await f.storage.head(), writes = {...f.calls}; assert.deepEqual(await f.read(), winner);
  await rejects(() => editCloudKnowledge(f.env, {batch: batch(), expectedRevision: head}), 'request_conflicted');
  assert.deepEqual(f.calls, writes);
  const retained = await f.storage.history({conflicts: true}); assert.equal(retained.items.length, 1);
});

test('symmetric alternatives are canonicalized without changing stable IDs or creation times', async t => {
  const f = fixture(t), expectedRevision = await f.seed(), value = {requestId: 'canonical', shards: [],
    links: [{id: 'saved-link', changes: {type: 'alternative_to', fromId: 'other', toId: 'base', fromApproachId: '', toApproachId: 'first'}}]};
  await editCloudKnowledge(f.env, {batch: value, expectedRevision});
  const link = (await f.read()).archive.links[0];
  assert.equal(link.id, 'saved-link'); assert.equal(link.createdAt, STAMP); assert.equal(link.fromId, 'base'); assert.equal(link.toId, 'other');
  assert.equal(link.fromApproachId, 'first'); assert.equal(link.toApproachId, '');
});

test('note-only and unchanged identity patches retain legacy alternative orientation and omitted endpoint fields', async t => {
  const f = fixture(t), capsule = original();
  capsule.archive.links[0] = {id: 'saved-link', fromId: 'other', toId: 'base', toApproachId: 'first', type: 'alternative_to', note: 'Legacy explanation.', createdAt: STAMP};
  const expectedRevision = await f.seed(capsule);
  const value = {requestId: 'legacy-note-only', shards: [], links: [{id: 'saved-link', changes: {note: 'New explanation only.'}}]};
  const receipt = await editCloudKnowledge(f.env, {batch: value, expectedRevision});
  let saved = await f.read();
  assert.deepEqual(saved.archive.links[0], {...capsule.archive.links[0], note: 'New explanation only.'});
  assert.equal(Object.hasOwn(saved.archive.links[0], 'fromApproachId'), false);
  assert.equal((await editCloudKnowledge(f.env, {batch: value, expectedRevision})).currentContentMatches, true);
  const noOp = {requestId: 'legacy-identity-no-op', shards: [], links: [{id: 'saved-link', changes: {fromId: 'other', fromApproachId: ''}}]};
  const next = await editCloudKnowledge(f.env, {batch: noOp, expectedRevision: receipt.acceptedRevision});
  assert.equal(next.unchanged.links, 1); assert.equal(next.edited.links, 0);
  saved = await f.read(); assert.deepEqual(saved.archive.links[0], {...capsule.archive.links[0], note: 'New explanation only.'});
});

test('changing a directed edge to an alternative moves an approach into its previously omitted counterpart', async t => {
  const f = fixture(t), capsule = original();
  capsule.archive.shards.push(note('aaa'));
  capsule.archive.links[0] = {id: 'saved-link', fromId: 'base', toId: 'aaa', fromApproachId: 'first', type: 'uses', note: 'Keep explained meaning.', createdAt: STAMP};
  const expectedRevision = await f.seed(capsule);
  const value = {requestId: 'change-type-only', shards: [], links: [{id: 'saved-link', changes: {type: 'alternative_to'}}]};
  const receipt = await editCloudKnowledge(f.env, {batch: value, expectedRevision});
  assert.equal(receipt.verified, true);
  const saved = await f.read(), link = saved.archive.links[0];
  assert.equal(link.fromId, 'aaa'); assert.equal(link.toId, 'base'); assert.equal(link.fromApproachId, ''); assert.equal(link.toApproachId, 'first');
  assert.equal(link.id, 'saved-link'); assert.equal(link.createdAt, STAMP); assert.equal(link.note, 'Keep explained meaning.');
  assert.deepEqual(saved.contributionReceipts[0].beforeRecords[0].record, capsule.archive.links[0]);
  assert.equal((await editCloudKnowledge(f.env, {batch: value, expectedRevision})).currentContentMatches, true);
});

test('receipt and outgoing snapshot capacities fail before object or database writes', async t => {
  for (const mode of ['snapshot', 'receipts']) {
    const f = fixture(t), capsule = original();
    if (mode === 'snapshot') {
      capsule.padding = '';
      capsule.padding = 'x'.repeat(CLOUD_EDIT_LIMITS.snapshotBytes - new TextEncoder().encode(JSON.stringify(capsule)).byteLength - 1);
    } else capsule.contributionReceipts.push({requestId: 'old-request', fingerprint: 'a'.repeat(64),
      receipt: {requestId: 'old-request', shards: [], links: []}, privatePadding: 'x'.repeat(8 * 1024 * 1024 - 1000)});
    const expectedRevision = await f.seed(capsule), calls = {...f.calls};
    await rejects(() => editCloudKnowledge(f.env, {batch: batch('capacity-' + mode), expectedRevision}), 'cloud_snapshot_too_large');
    assert.deepEqual(f.calls, calls); assert.equal(await f.storage.head(), expectedRevision);
  }
});

test('appended history cannot exceed the archive record limit even when its bytes fit the hosted cap', async t => {
  const f = fixture(t), capsule = original();
  capsule.archive.revisions = Array.from({length: 100_000}, (_, index) => ({id: 'r' + index, shardId: 'base', createdAt: '2026-01-01T00:00Z', reason: 'old', snapshot: {id: 'base', title: 'Old'}}));
  assert.ok(new TextEncoder().encode(JSON.stringify(capsule)).byteLength < CLOUD_EDIT_LIMITS.snapshotBytes);
  const expectedRevision = await f.seed(capsule), calls = {...f.calls};
  await rejects(() => editCloudKnowledge(f.env, {batch: batch('history-capacity'), expectedRevision}), 'cloud_snapshot_too_large');
  assert.deepEqual(f.calls, calls); assert.equal(await f.storage.head(), expectedRevision);
});

test('additions and edits use one bounded per-binding full-capsule queue', async t => {
  const f = fixture(t), expectedRevision = await f.seed();
  let release; const gate = new Promise(resolve => {release = resolve;});
  const waiting = Array.from({length: 4}, () => withCloudMutationStorage(f.env, () => gate));
  await rejects(() => editCloudKnowledge(f.env, {batch: batch(), expectedRevision}), 'cloud_busy');
  await assert.rejects(() => contributeCloudKnowledge(f.env, {batch: {requestId: 'add-queue', shards: [{id: 'new', title: 'New', content: '', tags: []}], links: []}, expectedRevision}), error => error.code === 'cloud_busy');
  release(); await Promise.all(waiting);
  assert.equal((await editCloudKnowledge(f.env, {batch: batch(), expectedRevision})).verified, true);
});

test('invalid cloud bytes and provider failures expose only fixed safe errors', async t => {
  const f = fixture(t), expectedRevision = await f.seed();
  f.controls.failReads = true;
  await rejects(() => editCloudKnowledge(f.env, {batch: batch(), expectedRevision}), 'cloud_library_unavailable');
  f.controls.failReads = false; f.controls.failPut = true;
  await rejects(() => editCloudKnowledge(f.env, {batch: batch(), expectedRevision}), 'cloud_library_unavailable');
  f.controls.failPut = false;
  const key = f.objects.keys().next().value, data = f.objects.get(key); data[0] ^= 1;
  await rejects(() => editCloudKnowledge(f.env, {batch: batch(), expectedRevision}), 'cloud_library_invalid');
});
