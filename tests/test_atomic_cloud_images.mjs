import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {contributeCloudKnowledge, validateCloudContributionArguments} from '../hosting/lib/atlas-contributions.mjs';
import {editCloudKnowledge, validateCloudEditArguments} from '../hosting/lib/atlas-edits.mjs';
import {attachImagesToContent, validateImageAttachments} from '../hosting/lib/cloud-image-attachments.mjs';
import {ingestRemoteImage} from '../hosting/lib/image-uploads.mjs';
import {scopeEnvironment} from '../hosting/lib/cloud-library-context.mjs';
import {readCloudLibrary} from '../hosting/lib/cloud-library-reader.mjs';
import {verifyImageWorkflow} from '../hosting/lib/image-workflow-verification.mjs';
import {LibraryStorage} from '../sync/storage.mjs';
import {preparePendingSnapshot} from '../sync/client.mjs';
import {sha256} from '../sync/protocol.mjs';
import {validateShard} from '../web/model.mjs';

const STAMP = '2026-10-25T12:00:00.000Z', OWNER = 'fixture-owner';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jR7sAAAAASUVORK5CYII=', 'base64');
const CODE = '\r\nint exact(int x) {\r\n\treturn x; // {{image:literal}}\r\n}\r\n';
function original() {
  const shard = validateShard({id: 'base', title: 'Existing shard', content: 'Exact explanation.\r\n\r\n```cpp\r\n' + CODE + '```\r\n', tags: ['C++'],
    codeSolution: {role: 'snippet', code: CODE}, createdAt: STAMP, updatedAt: STAMP}, {imported: true});
  delete shard.prompt; shard.futureField = {preserve: ['exact']};
  return {format: 'shard-atlas-library', version: 1, futureCapsule: {keep: true}, archive: {schemaVersion: 1, shards: [shard],
    links: [], reviews: [{id: 'review', shardId: 'base', grade: 'good'}], boards: [], assets: [], revisions: [], trash: [], futureArchive: {keep: true}}, contributionReceipts: []};
}
function fixture(t) {
  const sqlite = new DatabaseSync(':memory:'); sqlite.exec(readFileSync(new URL('../sync/schema.sql', import.meta.url), 'utf8')); t.after(() => sqlite.close());
  const objects = new Map(), controls = {beforeBatch: null, loseNextReply: false, failPut: false}, calls = {puts: 0, batches: 0, uploadReads: 0};
  const DB = {prepare(sql) {return {bind(...parameters) {return {
    async first() {if (sql.includes('image_uploads')) calls.uploadReads++; return sqlite.prepare(sql).get(...parameters) ?? null;},
    async all() {return {results: sqlite.prepare(sql).all(...parameters)};},
    async run() {return {meta: {changes: sqlite.prepare(sql).run(...parameters).changes}};},
    execute() {return {results: sqlite.prepare(sql).all(...parameters)};},
  };}};}, async batch(statements) {
    const before = controls.beforeBatch; controls.beforeBatch = null; if (before) await before(); calls.batches++; sqlite.exec('BEGIN');
    let result; try {result = statements.map(statement => statement.execute()); sqlite.exec('COMMIT');} catch (error) {sqlite.exec('ROLLBACK'); throw error;}
    if (controls.loseNextReply) {controls.loseNextReply = false; throw Error('PRIVATE_LOST_REPLY');} return result;
  }};
  const BUCKET = {async get(key) {const data = objects.get(key); return data ? {size: data.length, body: new Response(data).body} : null;},
    async head(key) {return objects.has(key) ? {size: objects.get(key).length} : null;},
    async put(key, data) {if (controls.failPut) throw Error('PRIVATE_OBJECT'); calls.puts++; objects.set(key, new Uint8Array(data));}};
  const env = {DB, BUCKET}, storage = new LibraryStorage(DB, BUCKET); let sequence = 0;
  async function publish(capsule, baseRevision) {
    baseRevision ??= await storage.head(); const mutationId = 'fixture-mutation-' + ++sequence, pending = await preparePendingSnapshot(capsule, baseRevision, mutationId);
    for (const chunk of pending.chunks) await storage.putBlob(chunk.sha256, chunk.data);
    return storage.publish({id: 'fixture-revision-' + ++sequence, mutationId, baseRevision, manifest: pending.manifest,
      fingerprint: await sha256(new TextEncoder().encode(JSON.stringify({baseRevision, manifest: pending.manifest}))), createdAt: STAMP});
  }
  async function read(revision, selectedStorage = storage) {
    const row = await selectedStorage.commit(revision ?? await selectedStorage.head());
    return JSON.parse(Buffer.concat(JSON.parse(row.manifest).chunks.map(chunk => objects.get('libraries/' + selectedStorage.libraryId + '/blobs/' + chunk.sha256))).toString('utf8'));
  }
  async function stage(requestId = 'upload-one', name = 'Original diagram.png') {
    return ingestRemoteImage(env, {requestId, file: {file_id: 'file-' + requestId, file_name: name, mime_type: 'image/png', download_url: 'https://files.oaiusercontent.com/fixture'}},
      {ownerId: OWNER, fetch: async () => new Response(PNG)});
  }
  return {env, sqlite, objects, storage, controls, calls, publish, read, stage, seed: async capsule => (await publish(capsule ?? original())).id};
}
const descriptor = (upload, shardId = 'new', extra = {}) => ({shardId, uploadId: upload.uploadId, caption: 'Caption [exact] \\ chars', ...extra});
const addition = (upload, requestId = 'add-image') => ({requestId, shards: [{id: 'new', title: 'New shard', content: 'New exact explanation.', tags: [], codeSolution: {role: 'snippet', code: CODE}}], links: [], images: [descriptor(upload)]});
const edit = (upload, requestId = 'edit-image', extra = {}) => ({requestId, shards: [{id: 'base', changes: {}}], links: [], images: [descriptor(upload, 'base', extra)]});
const save = (f, kind, batch, expectedRevision) => (kind === 'add' ? contributeCloudKnowledge : editCloudKnowledge)(f.env, {batch, expectedRevision}, {ownerId: OWNER});
const rejectsCode = (action, code) => assert.rejects(action, error => error.code === code && !/PRIVATE_|SELECT|image-uploads\//.test(error.message));

test('attachment validation binds explicit targets and allows only image-targeted empty shard edits', () => {
  const upload = {uploadId: 'image-upload-' + 'a'.repeat(64)}, valid = edit(upload);
  assert.equal(validateCloudEditArguments({batch: valid, expectedRevision: ''}).batch, valid);
  assert.throws(() => validateCloudEditArguments({batch: {...valid, images: []}, expectedRevision: ''}));
  assert.throws(() => validateCloudContributionArguments({batch: {...addition(upload), images: [descriptor(upload, 'base')]}, expectedRevision: ''}));
  for (const extra of [{placement: 'middle'}, {placement: 'placeholder'}, {placeholder: '{{image:x}}'}, {caption: 'two\nlines'}, {unexpected: true}]) {
    assert.throws(() => validateImageAttachments([descriptor(upload, 'base', extra)], ['base']));
  }
});

test('ordered placements preserve exact text and replace one explicit placeholder outside literal code', () => {
  const source = 'Before\r\n`{{image:literal}}`\r\n~~~cpp\r\n{{image:literal}}\r\n~~~\r\n{{image:slot}}\r\nAfter';
  const image = {assetId: 'image-a', caption: 'a [bracket] \\ slash', placement: 'placeholder', placeholder: '{{image:slot}}'};
  const result = attachImagesToContent(source, [image, {...image, assetId: 'image-b', caption: 'first', placement: 'append'}, {...image, assetId: 'image-c', caption: 'second', placement: 'append'}]);
  assert.equal(result, source.replace('{{image:slot}}', '![a \\[bracket\\] \\\\ slash](/assets/image-a)') + '\n\n![first](/assets/image-b)\n\n![second](/assets/image-c)');
  for (const content of ['`{{image:slot}}`', '    {{image:slot}}', '```\n{{image:slot}}\n```', '{{image:slot}} {{image:slot}}']) assert.throws(() => attachImagesToContent(content, [image]));
});

test('new shard and image bytes commit together and preserve all unrelated portable data', async t => {
  const f = fixture(t), before = original(), expectedRevision = await f.seed(before), upload = await f.stage(), batch = addition(upload);
  const receipt = await save(f, 'add', batch, expectedRevision), after = await f.read();
  assert.equal(receipt.verified, true); assert.equal(receipt.images[0].assetId, upload.assetId); assert.equal(after.archive.assets.length, 1);
  assert.equal(after.archive.assets[0].data, PNG.toString('base64')); assert.equal(after.archive.assets[0].name, 'Original diagram.png');
  assert.equal(after.archive.shards[1].content, batch.shards[0].content + '\n\n![Caption \\[exact\\] \\\\ chars](/assets/' + upload.assetId + ')');
  assert.equal(after.archive.shards[1].codeSolution.code, CODE);
  assert.deepEqual(after.archive.shards[0], before.archive.shards[0]); assert.deepEqual(after.archive.reviews, before.archive.reviews);
  assert.deepEqual(after.futureCapsule, before.futureCapsule); assert.deepEqual(after.archive.futureArchive, before.archive.futureArchive);
  assert.deepEqual(after.archive.revisions.at(-1).snapshot, after.archive.shards[1]);
  assert.doesNotMatch(JSON.stringify(receipt), /download_url|oaiusercontent|image-uploads\/|dataHash/);
  assert.deepEqual(await f.read(expectedRevision), before);
});

test('image-only edit saves exact before/after history while preserving omitted fields and literal code', async t => {
  const f = fixture(t), before = original(), expectedRevision = await f.seed(before), upload = await f.stage();
  const receipt = await save(f, 'edit', edit(upload), expectedRevision), after = await f.read(), shard = after.archive.shards[0];
  assert.deepEqual(receipt.edited, {shards: 1, links: 0}); assert.equal(receipt.verified, true);
  assert.equal(shard.codeSolution.code, CODE); assert.equal(Object.hasOwn(shard, 'prompt'), false); assert.deepEqual(shard.futureField, before.archive.shards[0].futureField);
  assert.equal(shard.content.slice(0, before.archive.shards[0].content.length), before.archive.shards[0].content);
  assert.deepEqual(after.archive.revisions.at(-2).snapshot, before.archive.shards[0]); assert.deepEqual(after.archive.revisions.at(-1).snapshot, shard);
});

for (const kind of ['add', 'edit']) test(kind + ' retry recovers a lost reply without staging access or duplicate attachment', async t => {
  const f = fixture(t), expectedRevision = await f.seed(), upload = await f.stage(), batch = kind === 'add' ? addition(upload) : edit(upload);
  f.controls.loseNextReply = true; await rejectsCode(() => save(f, kind, batch, expectedRevision), 'save_outcome_unknown');
  const accepted = await f.storage.head(), before = await f.read(), writes = f.calls.batches, puts = f.calls.puts, reads = f.calls.uploadReads;
  f.sqlite.exec('DELETE FROM image_uploads'); for (const key of f.objects.keys()) if (key.startsWith('image-uploads/')) f.objects.delete(key);
  const receipt = await save(f, kind, batch, expectedRevision);
  assert.equal(receipt.replayed, true); assert.equal(receipt.verified, true); assert.equal(await f.storage.head(), accepted);
  assert.deepEqual(await f.read(), before); assert.equal(f.calls.batches, writes); assert.equal(f.calls.puts, puts); assert.equal(f.calls.uploadReads, reads);
  const changed = structuredClone(batch); changed.images[0].caption += ' changed';
  await rejectsCode(() => save(f, kind, changed, accepted), 'request_id_reused');
});

test('missing upload, wrong owner, stale revision, and invalid placement publish no partial shard or image', async t => {
  const f = fixture(t), before = original(), expectedRevision = await f.seed(before), upload = await f.stage();
  const puts = f.calls.puts, writes = f.calls.batches, reads = f.calls.uploadReads;
  await rejectsCode(() => save(f, 'edit', edit(upload), ''), 'cloud_library_changed'); assert.equal(f.calls.uploadReads, reads);
  await rejectsCode(() => editCloudKnowledge(f.env, {batch: edit(upload), expectedRevision}, {ownerId: 'another-owner'}), 'image_upload_unavailable');
  await rejectsCode(() => save(f, 'edit', edit({uploadId: 'image-upload-' + 'f'.repeat(64)}), expectedRevision), 'image_upload_unavailable');
  await rejectsCode(() => save(f, 'edit', edit(upload, 'bad-placeholder', {placement: 'placeholder', placeholder: '{{image:literal}}'}), expectedRevision), 'image_attachment_invalid');
  assert.equal(await f.storage.head(), expectedRevision); assert.equal(f.calls.puts, puts); assert.equal(f.calls.batches, writes); assert.deepEqual(await f.read(), before);
});

test('add attachments cannot modify or duplicate an existing shard and stable image bytes reuse saved metadata', async t => {
  const f = fixture(t), before = original(), expectedRevision = await f.seed(before), upload = await f.stage();
  const duplicate = addition(upload), base = before.archive.shards[0]; duplicate.shards[0] = {id: 'new', title: base.title, content: base.content, tags: [], codeSolution: base.codeSolution};
  await rejectsCode(() => save(f, 'add', duplicate, expectedRevision), 'image_attachment_invalid');
  const receipt = await save(f, 'add', addition(upload), expectedRevision), next = await f.stage('upload-two', 'Renamed same diagram.png');
  await save(f, 'edit', edit(next), receipt.currentRevision); const after = await f.read();
  assert.equal(after.archive.assets.length, 1); assert.equal(after.archive.assets[0].name, upload.name); assert.equal(after.archive.assets[0].data, PNG.toString('base64'));
});

test('a concurrent accepted library wins without partial image references and the losing retry stays conflicted', async t => {
  const f = fixture(t), before = original(), expectedRevision = await f.seed(before), upload = await f.stage(), batch = edit(upload);
  const winner = structuredClone(before); winner.archive.shards[0].content = 'Concurrent winner.';
  f.controls.beforeBatch = async () => f.publish(winner, expectedRevision);
  await rejectsCode(() => save(f, 'edit', batch, expectedRevision), 'request_conflicted');
  assert.deepEqual(await f.read(), winner); const writes = f.calls.batches;
  await rejectsCode(() => save(f, 'edit', batch, expectedRevision), 'request_conflicted'); assert.equal(f.calls.batches, writes);
});

test('replay after later deletion reports missing images and preserves current records without reattaching', async t => {
  const f = fixture(t), expectedRevision = await f.seed(), upload = await f.stage(), batch = edit(upload);
  await save(f, 'edit', batch, expectedRevision); const later = await f.read();
  later.archive.shards[0].content = 'Later intentional edit.'; later.archive.assets = []; later.contributionReceipts = [];
  await f.publish(later); const head = await f.storage.head(), writes = f.calls.batches, puts = f.calls.puts;
  f.sqlite.exec('DELETE FROM image_uploads'); const receipt = await save(f, 'edit', batch, expectedRevision);
  assert.equal(receipt.replayed, true); assert.equal(receipt.verified, false); assert.equal(receipt.originalSaveVerified, true);
  assert.deepEqual(receipt.changedShardIds, ['base']); assert.deepEqual(receipt.missingAssetIds, [upload.assetId]);
  assert.equal(await f.storage.head(), head); assert.equal(f.calls.batches, writes); assert.equal(f.calls.puts, puts); assert.deepEqual(await f.read(), later);
});

test('image attachments work above the former whole-snapshot limit without altering existing image strings', async t => {
  const f = fixture(t), before = original(), data = Buffer.alloc(7 * 1024 * 1024, 13).toString('base64');
  before.archive.assets = ['large-one', 'large-two'].map(id => ({id, name: id + '.png', mimeType: 'image/png', size: 7 * 1024 * 1024, createdAt: STAMP, data}));
  const expectedRevision = await f.seed(before), upload = await f.stage();
  const receipt = await save(f, 'edit', edit(upload), expectedRevision), after = await f.read();
  assert.equal(receipt.verified, true); assert.equal(after.archive.assets.length, 3);
  assert.deepEqual(after.archive.assets.slice(0, 2), before.archive.assets); assert.equal(after.archive.assets[2].data, PNG.toString('base64'));
});

test('identical staged bytes reuse a size-less legacy image without changing its metadata', async t => {
  const f = fixture(t), before = original(), assetId = 'image-' + await sha256(PNG);
  const asset = {id: assetId, name: 'Original legacy filename.png', mimeType: 'image/png', data: PNG.toString('base64'), createdAt: STAMP, futureImage: {exact: true}};
  before.archive.assets = [asset]; const expectedRevision = await f.seed(before), upload = await f.stage();
  const receipt = await save(f, 'edit', edit(upload), expectedRevision), after = await f.read();
  assert.equal(receipt.verified, true); assert.deepEqual(after.archive.assets, [asset]); assert.equal(Object.hasOwn(after.archive.assets[0], 'size'), false);
});

test('changed bytes under a saved image ID are reported on replay without overwriting the later image', async t => {
  const f = fixture(t), expectedRevision = await f.seed(), upload = await f.stage(), batch = edit(upload);
  await save(f, 'edit', batch, expectedRevision); const later = await f.read(), changed = Buffer.from(PNG); changed[changed.length - 1] ^= 1;
  later.archive.assets[0].data = changed.toString('base64'); await f.publish(later);
  const head = await f.storage.head(), writes = f.calls.batches, receipt = await save(f, 'edit', batch, expectedRevision);
  assert.equal(receipt.verified, false); assert.deepEqual(receipt.changedAssetIds, [upload.assetId]); assert.deepEqual(receipt.changedShardIds, []);
  assert.equal(await f.storage.head(), head); assert.equal(f.calls.batches, writes); assert.deepEqual(await f.read(), later);
});

test('an immutable chunk upload failure preserves the original live shard and image collection', async t => {
  const f = fixture(t), before = original(), expectedRevision = await f.seed(before), upload = await f.stage();
  const writes = f.calls.batches; f.controls.failPut = true;
  await rejectsCode(() => save(f, 'edit', edit(upload), expectedRevision), 'cloud_library_unavailable');
  assert.equal(await f.storage.head(), expectedRevision); assert.equal(f.calls.batches, writes); assert.deepEqual(await f.read(), before);
});

test('internal image verification namespaces isolate writes, durable retries and read caches from the owner library', async t => {
  const f = fixture(t), before = original(), ownerHead = await f.seed(before), upload = await f.stage();
  const namespace = 'qa-image-' + await sha256(new TextEncoder().encode('isolated image workflow test'));
  const scoped = scopeEnvironment(f.env, namespace), qaStorage = new LibraryStorage(f.env.DB, f.env.BUCKET, namespace);
  const ownerRead = await readCloudLibrary(f.env); assert.equal(ownerRead.revision, ownerHead);
  const addReceipt = await contributeCloudKnowledge(scoped, {batch: addition(upload, 'same-request'), expectedRevision: ''}, {ownerId: OWNER});
  const qaBatch = {requestId: 'scoped-edit', shards: [{id: 'new', changes: {title: 'Isolated verification title'}}], links: [], images: [descriptor(upload, 'new')]};
  const editReceipt = await editCloudKnowledge(scoped, {batch: qaBatch, expectedRevision: addReceipt.currentRevision}, {ownerId: OWNER});
  assert.equal(editReceipt.verified, true); assert.notEqual(await qaStorage.head(), ownerHead);
  const qaRead = await readCloudLibrary(scoped), ownerAgain = await readCloudLibrary(f.env), qaAgain = await readCloudLibrary(scoped);
  assert.deepEqual(ownerAgain.archive, ownerRead.archive); assert.equal(ownerAgain.revision, ownerHead);
  assert.equal(qaRead.archive.shards.length, 1); assert.equal(qaRead.archive.shards[0].title, 'Isolated verification title'); assert.deepEqual(qaAgain.archive, qaRead.archive);
  assert.equal((await f.read(undefined, qaStorage)).archive.assets.length, 1); assert.equal(await f.storage.head(), ownerHead); assert.deepEqual(await f.read(), before);
  const ownerBatch = addition(upload, 'same-request'); ownerBatch.shards[0].id = 'owner-new'; ownerBatch.images[0].shardId = 'owner-new';
  const ownerReceipt = await contributeCloudKnowledge(f.env, {batch: ownerBatch, expectedRevision: ownerHead}, {ownerId: OWNER});
  assert.equal(ownerReceipt.replayed, false, 'The isolated request ID must not reserve the owner library request namespace.');
});

test('the real image workflow verifier stages, saves, reads and safely repeats in its fixed private QA library', async t => {
  const f = fixture(t), before = original(), ownerHead = await f.seed(before), upload = await f.stage();
  const input = {requestId: 'real-workflow-check', uploadId: upload.uploadId};
  const result = await verifyImageWorkflow(f.env, input, {ownerId: OWNER});
  assert.deepEqual(result, {verified: true, isolatedTestLibrary: true, personalLibraryUnchanged: true, exactImageBytes: true,
    newShardImage: true, existingShardImage: true, idempotentRetries: true, assetId: upload.assetId, sha256: await sha256(PNG), bytes: PNG.length, readOnly: false});
  const namespace = 'qa-image-' + await sha256(new TextEncoder().encode(OWNER)), qaStorage = new LibraryStorage(f.env.DB, f.env.BUCKET, namespace);
  const qaHead = await qaStorage.head(), qa = await f.read(undefined, qaStorage), writes = f.calls.batches, puts = f.calls.puts;
  assert.equal(qa.archive.shards.length, 2); assert.equal(qa.archive.assets.length, 1); assert.equal(qa.archive.assets[0].data, PNG.toString('base64'));
  for (const shard of qa.archive.shards) assert.equal(shard.content.split('/assets/' + upload.assetId).length - 1, 1);
  assert.deepEqual(await verifyImageWorkflow(f.env, input, {ownerId: OWNER}), result);
  assert.equal(await qaStorage.head(), qaHead); assert.equal(f.calls.batches, writes); assert.equal(f.calls.puts, puts);
  assert.equal(await f.storage.head(), ownerHead); assert.deepEqual(await f.read(), before);
  assert.doesNotMatch(JSON.stringify(result), /uploadId|download_url|oaiusercontent|image-uploads\/|Original explanation|futureField/);
});

test('the real verifier rejects another owner upload without publishing any QA or owner library data', async t => {
  const f = fixture(t), before = original(), ownerHead = await f.seed(before), upload = await f.stage(), writes = f.calls.batches, puts = f.calls.puts;
  await rejectsCode(() => verifyImageWorkflow(f.env, {requestId: 'cross-owner-check', uploadId: upload.uploadId}, {ownerId: 'different-owner'}), 'image_upload_unavailable');
  const namespace = 'qa-image-' + await sha256(new TextEncoder().encode('different-owner'));
  assert.equal(await new LibraryStorage(f.env.DB, f.env.BUCKET, namespace).head(), '');
  assert.equal(f.calls.batches, writes); assert.equal(f.calls.puts, puts); assert.equal(await f.storage.head(), ownerHead); assert.deepEqual(await f.read(), before);
});

test('the real verifier rejects a changed upload under the same verification request without rewriting accepted data', async t => {
  const f = fixture(t), before = original(), ownerHead = await f.seed(before), upload = await f.stage(), requestId = 'immutable-workflow-request';
  await verifyImageWorkflow(f.env, {requestId, uploadId: upload.uploadId}, {ownerId: OWNER});
  const other = await f.stage('different-upload', 'Same bytes with another upload.png'), namespace = 'qa-image-' + await sha256(new TextEncoder().encode(OWNER));
  const qaStorage = new LibraryStorage(f.env.DB, f.env.BUCKET, namespace), qaHead = await qaStorage.head(), saved = await f.read(undefined, qaStorage), writes = f.calls.batches, puts = f.calls.puts;
  await rejectsCode(() => verifyImageWorkflow(f.env, {requestId, uploadId: other.uploadId}, {ownerId: OWNER}), 'request_id_reused');
  assert.equal(await qaStorage.head(), qaHead); assert.deepEqual(await f.read(undefined, qaStorage), saved); assert.equal(f.calls.batches, writes); assert.equal(f.calls.puts, puts);
  assert.equal(await f.storage.head(), ownerHead); assert.deepEqual(await f.read(), before);
});
