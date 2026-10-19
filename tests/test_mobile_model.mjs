import test from 'node:test';
import assert from 'node:assert/strict';
import {copy, emptyDatabase, handleCore, publicState, recordId, saveBackup, validateAsset, validateLink, validateShard} from '../mobile/model.mjs';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
const STAMP = '2024-02-29T12:34:56.789Z';
const call = (db, path, method = 'GET', data = {}) => handleCore(db, path, method, data);
const add = (db, title, fields = {}) => {
  const state = call(db, '/api/shards', 'POST', {title, ...fields});
  return state.shards.at(-1);
};
const errorWith = (run, status, message) => assert.throws(run, error => error.status === status && (!message || error.message.includes(message)));

test('a new phone collection remains empty; public state and exports are detached', () => {
  const db = emptyDatabase();
  assert.deepEqual(Object.keys(db).sort(), ['archive', 'backups', 'drafts', 'imports']);
  assert.deepEqual(call(db, '/api/export'), {schemaVersion: 1, shards: [], links: [], boards: [], reviews: [], assets: [], revisions: [], trash: []});
  assert.equal(call(db, '/api/health').storageMode, 'browser-local');
  const state = call(db, '/api/state');
  assert.equal('revisions' in state, false);
  state.shards.push({id: 'outside'});
  assert.deepEqual(db.archive.shards, []);
  assert.deepEqual(call(db, '/api/data'), publicState(db));
  assert.equal(call(db, '/api/unknown'), undefined);
  assert.equal(call(db, '/api/reviews', 'POST', {}), undefined);
});

test('stable IDs and imported source extensions survive edits without writable identity fields', () => {
  const db = emptyDatabase();
  const imported = validateShard({id: 'lucid:cpp.type', title: '  Original  ', content: 'T::value_type', createdAt: STAMP, updatedAt: STAMP, reviewCount: 2, nextReviewAt: STAMP, sourceUrl: 'https://example.com/source', sourceMetadata: {documentId: 'doc:1'}, sources: [{url: 'https://example.com', lucidPageId: 'page:2'}]}, {imported: true});
  db.archive.shards.push(imported);
  const edited = call(db, '/api/shards/lucid%3Acpp.type', 'PUT', {title: 'Edited', id: 'replace-me', createdAt: '2026-01-01T00:00:00Z', reviewCount: 0, customInjected: 'ignore'}).shards[0];
  assert.equal(edited.id, 'lucid:cpp.type');
  assert.equal(edited.createdAt, STAMP);
  assert.equal(edited.reviewCount, 2);
  assert.equal(edited.nextReviewAt, STAMP);
  assert.deepEqual(edited.sourceMetadata, {documentId: 'doc:1'});
  assert.equal(edited.sources[0].lucidPageId, 'page:2');
  assert.equal(edited.sources[0].url, 'https://example.com');
  assert.equal('customInjected' in edited, false);
  assert.equal(db.archive.revisions[0].reason, 'edited');
  edited.sourceMetadata.documentId = 'mutated outside';
  assert.equal(db.archive.shards[0].sourceMetadata.documentId, 'doc:1');
  const clean = validateShard({title: 'new', id: 'ignored', arbitrary: 'ignored'});
  assert.notEqual(clean.id, 'ignored');
  assert.equal('arbitrary' in clean, false);
});

test('the normalized editor payload saves exact code with source and fact metadata', () => {
  const db = emptyDatabase();
  const code = '```cpp\nstd::string s = "<&>";\nauto value = T::value_type{}; // π\n```';
  const payload = {title: 'Type aliases', content: code, prompt: '', tags: ['C++', 'Types'], kind: 'concept', status: 'learning', sourceUrl: '', languageVersion: 'C++98', eventDate: '', evidenceStatus: 'corroborated', sources: [{url: 'https://example.com/paper', title: 'Source', publishedDate: '2024', accessedDate: '2026-10-19', note: 'Section 4', sourceId: 'lucid:source-1'}], publicationDate: '', verifiedDate: '', eventType: '', entities: [], entityType: '', inbox: false, facts: [{label: 'Introduced', value: '1998', unit: 'year', sourceUrl: 'https://example.com/paper', asOf: '2026-10', originalText: 'Kept verbatim'}]};
  const shard = call(db, '/api/shards', 'POST', payload).shards[0];
  assert.equal(shard.content, code);
  assert.deepEqual(shard.sources, payload.sources);
  assert.deepEqual(shard.facts, payload.facts);
  assert.equal(shard.inbox, false);
  call(db, `/api/shards/${shard.id}`, 'PUT', {title: 'Updated title'});
  assert.deepEqual(db.archive.shards[0].sources, payload.sources);
  assert.deepEqual(db.archive.shards[0].facts, payload.facts);
});

test('shard CRUD keeps detached revision snapshots and backs up before restoring a version', () => {
  const db = emptyDatabase();
  db.drafts.editor = {values: {title: 'recoverable'}};
  const shard = add(db, 'First', {content: 'Before', tags: ['C++']});
  assert.equal(db.drafts.editor, undefined);
  const originalRevision = db.archive.revisions[0];
  call(db, `/api/shards/${shard.id}`, 'PUT', {title: 'Second', content: 'After'});
  assert.equal(originalRevision.snapshot.content, 'Before');
  assert.equal(db.archive.revisions.length, 2);
  const history = call(db, `/api/shards/${shard.id}/revisions`).revisions;
  assert.deepEqual(history.map(item => item.snapshot.title), ['Second', 'First']);
  db.drafts.editor = {values: {content: 'Unfinished'}};
  call(db, `/api/shards/${shard.id}/restore`, 'POST', {revisionId: originalRevision.id});
  assert.equal(db.archive.shards[0].title, 'First');
  assert.equal(db.archive.shards[0].id, shard.id);
  assert.equal(db.archive.revisions.at(-1).reason, 'revision restored');
  assert.equal(db.backups.length, 1);
  assert.equal(db.backups[0].archive.shards[0].title, 'Second');
  assert.deepEqual(db.backups[0].drafts.editor, {values: {content: 'Unfinished'}});
  const before = copy(db);
  errorWith(() => call(db, `/api/shards/${shard.id}/restore`, 'POST', {revisionId: 'missing'}), 404);
  assert.deepEqual(db, before);
});

test('delete and restore two connected shards in either order recovers typed edges, reviews, and legacy boards', () => {
  const db = emptyDatabase();
  const a = add(db, 'A');
  const b = add(db, 'B');
  const state = call(db, '/api/links', 'POST', {fromId: a.id, toId: b.id, type: 'explains', note: 'A explains B'});
  const link = state.links[0];
  const review = {id: 'legacy-review', shardId: a.id, grade: 'good', reviewedAt: STAMP, nextReviewAt: STAMP, legacy: true};
  db.archive.reviews.push(review);
  db.archive.boards.push({id: 'legacy-board', items: [{shardId: a.id}], extension: 'retained'});
  call(db, `/api/shards/${a.id}`, 'DELETE');
  assert.equal(db.backups[0].archive.shards.length, 2);
  assert.deepEqual(db.backups[0].archive.links, [link]);
  assert.equal(db.archive.links.length, 0);
  assert.equal(db.archive.reviews.length, 0);
  assert.equal(db.archive.boards[0].items[0].shardId, a.id);
  const trashA = db.archive.trash[0];
  call(db, `/api/shards/${b.id}`, 'DELETE');
  const trashB = db.archive.trash[1];
  assert.equal(db.archive.shards.length, 0);
  assert.equal(db.backups.length, 2);
  const first = call(db, `/api/trash/${trashA.id}/restore`, 'POST');
  assert.deepEqual(first.restoreSummary, {restoredLinks: 0, skippedLinks: 1});
  assert.deepEqual(db.archive.reviews, [review]);
  assert.deepEqual(db.archive.trash[0].links, [link]);
  const second = call(db, `/api/trash/${trashB.id}/restore`, 'POST');
  assert.deepEqual(second.restoreSummary, {restoredLinks: 1, skippedLinks: 0});
  assert.deepEqual(db.archive.links, [link]);
  assert.equal(db.archive.trash.length, 0);
  assert.deepEqual(db.archive.boards[0], {id: 'legacy-board', items: [{shardId: a.id}], extension: 'retained'});
  assert.equal(db.archive.revisions.at(-1).reason, 'restored from trash');
});

test('invalid edits, dangling relationships, self-links, and duplicate edges leave storage unchanged', () => {
  const db = emptyDatabase();
  const a = add(db, 'A');
  const b = add(db, 'B');
  const c = add(db, 'C');
  let before = copy(db);
  errorWith(() => call(db, `/api/shards/${a.id}`, 'PUT', {title: ''}), 400);
  assert.deepEqual(db, before);
  errorWith(() => call(db, '/api/links', 'POST', {fromId: a.id, toId: 'missing'}), 400);
  errorWith(() => call(db, '/api/links', 'POST', {fromId: a.id, toId: a.id}), 400);
  call(db, '/api/links', 'POST', {fromId: a.id, toId: b.id, type: 'depends_on'});
  call(db, '/api/links', 'POST', {fromId: a.id, toId: c.id, type: 'depends_on'});
  before = copy(db);
  errorWith(() => call(db, '/api/links', 'POST', {fromId: a.id, toId: b.id, type: 'depends_on'}), 409);
  errorWith(() => call(db, `/api/links/${db.archive.links[1].id}`, 'PUT', {toId: b.id}), 409);
  assert.deepEqual(db, before);
  const original = db.archive.links[0];
  call(db, `/api/links/${original.id}`, 'PUT', {id: 'ignored', createdAt: STAMP, note: 'refined'});
  assert.equal(db.archive.links[0].id, original.id);
  assert.equal(db.archive.links[0].createdAt, original.createdAt);
  assert.equal(db.archive.links[0].note, 'refined');
  call(db, `/api/links/${original.id}`, 'DELETE');
  assert.equal(db.backups.length, 1);
  assert.equal(db.backups[0].archive.links.length, 2);
  assert.equal(db.archive.links.length, 1);
  errorWith(() => call(db, '/api/links/missing', 'DELETE'), 404);
});

test('renaming a topic deduplicates memberships and records only affected revisions', () => {
  const db = emptyDatabase();
  const a = add(db, 'A', {tags: ['old', 'new', 'C++']});
  add(db, 'B', {tags: ['C++']});
  const result = call(db, '/api/tags/rename', 'PUT', {from: ' old ', to: ' new '});
  assert.deepEqual(result.shards.find(item => item.id === a.id).tags, ['new', 'C++']);
  assert.equal(db.archive.revisions.length, 3);
  assert.equal(db.archive.revisions.at(-1).reason, 'topic renamed');
  call(db, '/api/tags/rename', 'PUT', {from: 'new', to: 'new'});
  assert.equal(db.archive.revisions.length, 3);
  errorWith(() => call(db, '/api/tags/rename', 'PUT', null), 400);
});

test('recoverable drafts are detached, bounded JSON and explicit deletion creates a safety copy', () => {
  const db = emptyDatabase();
  const draft = {values: {title: 'Unfinished'}, updatedAt: STAMP};
  const result = call(db, '/api/drafts/editor', 'PUT', {draft});
  assert.equal(result.ok, true);
  assert.deepEqual(result.shards, []);
  draft.values.title = 'outside mutation';
  assert.equal(db.drafts.editor.values.title, 'Unfinished');
  assert.equal(call(db, '/api/drafts').drafts.connection, null);
  errorWith(() => call(db, '/api/drafts/unknown', 'PUT', {draft: {}}), 400);
  errorWith(() => call(db, '/api/drafts/editor', 'PUT', {draft: []}), 400);
  errorWith(() => call(db, '/api/drafts/editor', 'PUT', {draft: {count: Infinity}}), 400);
  errorWith(() => call(db, '/api/drafts/editor', 'PUT', {draft: {content: 'x'.repeat(250_001)}}), 413);
  call(db, '/api/drafts/editor', 'DELETE');
  assert.equal(db.drafts.editor, undefined);
  assert.equal(db.backups[0].drafts.editor.values.title, 'Unfinished');
  call(db, '/api/drafts/editor', 'DELETE');
  assert.equal(db.backups.length, 1);
});

test('raster assets retain portable data while API state excludes image bytes', () => {
  const db = emptyDatabase();
  const result = call(db, '/api/assets', 'POST', {name: 'tiny.png', mimeType: 'image/png', data: PNG});
  assert.equal(result.url, `/assets/${result.id}`);
  assert.equal(result.mimeType, 'image/png');
  assert.equal(result.data, undefined);
  assert.equal(result.assets[0].data, undefined);
  const exported = call(db, '/api/export');
  assert.equal(exported.assets[0].data, PNG);
  assert.equal(exported.assets[0].id, result.id);
  const imported = validateAsset({...exported.assets[0], source: {page: 5}}, {imported: true});
  assert.equal(imported.id, result.id);
  assert.deepEqual(imported.source, {page: 5});
  assert.equal(call(db, `/api/assets/${result.id}/text`, 'POST').available, false);
  errorWith(() => call(db, '/api/assets/missing/text', 'POST'), 404);
  for (const mimeType of ['image/svg+xml', 'text/html', 'application/octet-stream']) errorWith(() => validateAsset({mimeType, data: PNG}), 400);
  errorWith(() => validateAsset({mimeType: 'image/png', data: btoa('<svg>active</svg>')}), 400);
  errorWith(() => validateAsset({mimeType: 'image/jpeg', data: PNG}), 400);
  errorWith(() => validateAsset({mimeType: 'image/png', data: '!!!!'}), 400);
  errorWith(() => validateAsset({mimeType: 'image/png', data: PNG, name: null}), 400);
  const huge = Buffer.from(PNG, 'base64');
  huge.writeUInt32BE(16385, 16);
  errorWith(() => validateAsset({mimeType: 'image/png', data: huge.toString('base64')}), 400);
});

test('safety backups include every archive section, receipts and drafts without aliasing or pruning', () => {
  const db = emptyDatabase();
  add(db, 'A');
  call(db, '/api/assets', 'POST', {mimeType: 'image/png', data: PNG});
  db.archive.customArchiveMetadata = {source: 'legacy'};
  db.imports.push({id: 'receipt:1', sourceMetadata: {name: 'original'}});
  db.drafts.editor = {values: {title: 'draft'}};
  const backup = saveBackup(db);
  assert.ok(backup.size > 0);
  assert.equal(backup.shardCount, 1);
  assert.equal(backup.valid, true);
  assert.match(backup.filename, /^shards-mobile-.*\.json$/);
  assert.equal(backup.archive.assets[0].data, PNG);
  db.archive.shards[0].title = 'changed';
  db.archive.customArchiveMetadata.source = 'changed';
  db.drafts.editor.values.title = 'changed';
  db.imports[0].sourceMetadata.name = 'changed';
  assert.equal(backup.archive.shards[0].title, 'A');
  assert.equal(backup.archive.customArchiveMetadata.source, 'legacy');
  assert.equal(backup.drafts.editor.values.title, 'draft');
  assert.equal(backup.imports[0].sourceMetadata.name, 'original');
  saveBackup(db);
  assert.equal(db.backups.length, 2);
  assert.notEqual(db.backups[0].filename, db.backups[1].filename);
});

test('validation rejects incompatible types, invalid calendar dates and unsafe source URLs', () => {
  for (const id of ['', '_wrong', '../escape', 'space id', 'x'.repeat(101), null, 5]) errorWith(() => recordId(id), 400);
  assert.equal(recordId('lucid:page-1_note.2'), 'lucid:page-1_note.2');
  for (const patch of [{kind: 'unknown'}, {status: 'unknown'}, {tags: ['a', ' a ']}, {tags: Array(51).fill('a')}, {content: null}, {prompt: 5}, {sourceUrl: null}, {eventDate: '2025-02-29'}, {eventDate: '2024-13'}, {eventDate: '0000'}, {evidenceStatus: 'certain'}, {inbox: 0}, {sources: [{url: 'javascript:alert(1)'}]}, {sources: [{title: null}]}, {facts: [{label: ''}]}]) errorWith(() => validateShard({title: 'valid', ...patch}), 400);
  for (const url of ['javascript:alert(1)', 'data:text/html,hello', 'https://user:secret@example.com/', 'https://example.com/a b', 'https:\\example.com']) errorWith(() => validateShard({title: 'valid', sourceUrl: url}), 400);
  for (const patch of [{id: '../bad'}, {createdAt: '2026-01-01'}, {createdAt: '2026-02-30T00:00:00Z'}, {createdAt: '2026-01-01T24:00:00Z'}, {createdAt: null}, {reviewCount: true}, {reviewCount: -1}, {reviewCount: 1.5}]) errorWith(() => validateShard({id: 'stable', title: 'valid', ...patch}, {imported: true}), 400);
  assert.equal(validateShard({title: 'leap', eventDate: '2024-02-29'}).eventDate, '2024-02-29');
  errorWith(() => validateLink({fromId: 'A', toId: 'B', type: null}), 400);
  errorWith(() => validateLink({fromId: 'A', toId: 'B', note: null}), 400);
  errorWith(() => validateShard(null), 400);
});
