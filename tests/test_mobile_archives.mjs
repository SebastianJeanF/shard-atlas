import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {emptyDatabase} from '../mobile/model.mjs';
import {handleArchives} from '../mobile/archives.mjs';

const stamp = '2026-10-19T15:00:00.000Z';
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
const clone = value => structuredClone(value);
const shard = (id, values = {}) => ({id, title: id, content: '', createdAt: stamp, updatedAt: stamp, ...values});
const link = (id, fromId, toId, values = {}) => ({id, fromId, toId, type: 'explains', createdAt: stamp, ...values});
const archive = values => ({schemaVersion: 1, shards: [], links: [], reviews: [], assets: [], revisions: [], trash: [], boards: [], ...values});
const call = (db, path, body = {}, method = 'POST') => handleArchives(db, path, method, body);
const importArchive = (db, data) => call(db, '/api/import', {data});
const preview = (db, data) => call(db, '/api/import/preview', {data});
const undo = (db, id) => call(db, `/api/imports/${id}/undo`);

function fullArchive() {
  return archive({title: 'Portable C++ atlas', extension: {original: true},
    shards: [shard('alpha', {content: '![Figure](/assets/diagram)\n[[id:beta]]', customShard: {source: 'original'}}), shard('beta')],
    links: [link('alpha-beta', 'alpha', 'beta', {note: 'A precise explanation', customLink: 'kept'})],
    assets: [{id: 'diagram', name: 'Diagram', mimeType: 'image/png', data: PNG, createdAt: stamp, customAsset: 'kept'}],
    reviews: [{id: 'recall-1', shardId: 'alpha', grade: 'good', reviewedAt: stamp, nextReviewAt: '2026-10-26T15:00:00.000Z', customReview: true}],
    revisions: [{id: 'alpha-version', shardId: 'alpha', createdAt: stamp, reason: 'saved', snapshot: shard('alpha', {content: 'Older alpha'}), customRevision: true}],
    trash: [{id: 'deleted', deletedAt: stamp, shard: shard('deleted-note', {content: '![Figure](/assets/diagram)'}),
      links: [link('deleted-to-beta', 'deleted-note', 'beta')], reviews: [{id: 'deleted-review', shardId: 'deleted-note', grade: 'hard', reviewedAt: stamp}], customTrash: true}],
    boards: [{id: 'legacy-canvas', title: 'Original Lucid board', sourceUrl: 'https://example.com/original',
      createdAt: stamp, updatedAt: stamp, items: [{shardId: 'alpha', sectionId: 'section', x: 10, y: 20, width: 280, height: 160, originalShapeId: 'lucid-1'}, {shardId: 'missing-note', x: 400}],
      sections: [{id: 'section', title: 'C++', x: 0, y: 0, width: 600, height: 400, collapsed: true, shardId: 'beta', customSection: 1}],
      viewport: {x: 4, y: 6, zoom: .8}, customBoard: true}]});
}

test('an empty collection stays empty and unrelated routes are not handled', () => {
  const db = emptyDatabase();
  assert.equal(db.archive.shards.length, 0);
  assert.equal(call(db, '/api/shards'), undefined);
  const result = importArchive(db, archive({}));
  assert.equal(result.shards.length, 0);
  assert.equal(result.importSummary.added.shards, 0);
  assert.equal(db.backups.length, 1);
});

test('full desktop archive retains stable IDs, legacy records, image bytes, source attribution, and unknown fields', () => {
  const db = emptyDatabase(), input = fullArchive();
  const result = importArchive(db, input);
  assert.equal(result.importSummary.added.shards, 2);
  assert.equal(result.importSummary.added.assets, 1);
  for (const key of ['links', 'reviews', 'trash', 'boards', 'assets']) assert.deepEqual(db.archive[key].map(item => item.id), input[key].map(item => item.id));
  assert.equal(db.archive.assets[0].data, PNG);
  assert.deepEqual(db.archive.shards[0].customShard, {source: 'original'});
  assert.equal(db.archive.boards[0].items[0].originalShapeId, 'lucid-1');
  assert.equal(db.archive.boards[0].items[1].shardId, 'missing-note');
  assert.equal(db.archive.reviews[0].customReview, true);
  assert.equal(db.archive.revisions.find(item => item.id === 'alpha-version').customRevision, true);
  assert.equal(db.archive.trash[0].customTrash, true);
  assert.equal(db.archive.boards[0].sourceUrl, 'https://example.com/original');
  assert.deepEqual(db.archive.extension, input.extension);
  assert.equal(db.archive.shards[0].reviewCount, 1);
  assert.equal(db.archive.shards[0].lastReviewedAt, stamp);
  const destination = emptyDatabase();
  importArchive(destination, db.archive);
  assert.deepEqual(destination.archive, db.archive);
});

test('preview reports missing positions, duplicate content and ID conflicts without mutating data', () => {
  const db = emptyDatabase();
  importArchive(db, archive({shards: [shard('existing', {content: 'Original'})]}));
  const before = clone(db);
  const result = preview(db, archive({shards: [shard('existing', {title: 'Changed'}), shard('same-content', {title: 'existing', content: 'Original'}), shard('image', {content: '![Missing](/assets/missing)'})],
    boards: [{id: 'board', title: 'Recovery', items: [{shardId: 'unknown'}]}]}));
  assert.equal(result.valid, true);
  assert.equal(result.skipped.shards, 1);
  assert.equal(result.added.shards, 2);
  assert.equal(result.conflicts[0].id, 'existing');
  assert.ok(result.duplicates.some(item => item.existingId === 'existing'));
  assert.ok(result.missing.some(item => item.assetId === 'missing'));
  assert.ok(result.missing.some(item => item.kind === 'boards' && item.shardId === 'unknown'));
  assert.ok(result.warnings.some(value => value.includes('saved positions')));
  assert.deepEqual(db, before);
});

test('repeated additive imports preserve existing IDs and content', () => {
  const db = emptyDatabase();
  importArchive(db, archive({shards: [shard('a', {content: 'User version'})]}));
  const original = clone(db.archive.shards[0]);
  const result = importArchive(db, archive({shards: [shard('a', {content: 'Old archive version'}), shard('b')]}));
  assert.deepEqual(db.archive.shards[0], original);
  assert.equal(result.importSummary.skipped.shards, 1);
  assert.equal(result.importSummary.added.shards, 1);
  const repeated = importArchive(db, clone(db.archive));
  assert.equal(repeated.importSummary.added.shards, 0);
});

test('all record validation and relationship constraints finish before any mutation or backup', () => {
  const inputs = [
    {schemaVersion: true, shards: []},
    archive({shards: [shard('duplicate'), shard('duplicate')]}),
    archive({shards: [shard('a')], links: [link('bad', 'a', 'missing')]}),
    archive({shards: [shard('a'), shard('b')], links: [link('one', 'a', 'b'), link('two', 'a', 'b')]}),
    archive({shards: [shard('a')], reviews: [{id: 'bad', shardId: 'missing', grade: 'good'}]}),
    archive({shards: [shard('a')], revisions: [{id: 'bad', shardId: 'a', snapshot: shard('other')}]}),
    archive({shards: [shard('a')], assets: [{id: 'bad', name: 'Bad', mimeType: 'image/png', data: 'AA=='}]}),
    archive({boards: [{id: 'bad', title: 'Invalid', items: [{shardId: 'a', sectionId: 'missing'}]}]}),
    archive({trash: [{id: 'bad', shard: shard('gone'), links: [link('bad-link', 'a', 'b')]}]}),
    archive({extension: {invalid: NaN}}),
    archive({shards: null}),
    archive({boards: [{id: 'bad', title: 'Invalid', viewport: null}]}),
    archive({shards: [shard('a')], reviews: [{id: 'bad', shardId: 'a', grade: 'good', reviewedAt: '2026-02-30T12:00:00Z'}]}),
    archive({shards: [shard('a')], reviews: [{id: 'bad', shardId: 'a', grade: 'good', reviewedAt: null}]}),
    archive({reviews: 'wrong collection type'}),
  ];
  for (const input of inputs) {
    const db = emptyDatabase(), before = clone(db);
    assert.throws(() => importArchive(db, input));
    assert.deepEqual(db, before);
    if (Number.isNaN(input.extension?.invalid)) assert.throws(() => preview(db, input), /finite JSON/);
    else assert.equal(preview(db, input).valid, false);
    assert.deepEqual(db, before);
  }
});

test('notes in trash cannot be silently recreated by import', () => {
  const db = emptyDatabase();
  importArchive(db, archive({trash: [{id: 'deletion', shard: shard('gone')}]}));
  const before = clone(db);
  assert.throws(() => importArchive(db, archive({shards: [shard('gone')]})), /already in Trash/);
  assert.deepEqual(db, before);
});

test('undo removes only unchanged records first introduced by the import and is idempotent', () => {
  const db = emptyDatabase();
  importArchive(db, archive({shards: [shard('existing')]}));
  const result = importArchive(db, archive({shards: [shard('existing', {title: 'Ignored'}), shard('new')], links: [link('new-link', 'new', 'existing')]}));
  const undone = undo(db, result.importSummary.importId);
  assert.deepEqual(db.archive.shards.map(item => item.id), ['existing']);
  assert.equal(undone.undoSummary.removed.shards, 1);
  assert.equal(undone.undoSummary.removed.links, 1);
  assert.equal(undone.undoSummary.removed.revisions, 1);
  const before = clone(db), repeated = undo(db, result.importSummary.importId);
  assert.equal(repeated.undoSummary.replayed, true);
  assert.deepEqual(db, before);
});

test('undo preserves edited knowledge, its image and history, and transitive wiki references', () => {
  const db = emptyDatabase();
  const result = importArchive(db, archive({shards: [shard('a', {content: '[[id:b]] ![Diagram](/assets/diagram)'}), shard('b', {content: '[[id:c]]'}), shard('c')],
    assets: [{id: 'diagram', name: 'Figure', mimeType: 'image/png', data: PNG, createdAt: stamp}]}));
  db.archive.shards.find(item => item.id === 'a').title = 'My edited explanation';
  const undone = undo(db, result.importSummary.importId);
  assert.deepEqual(db.archive.shards.map(item => item.id), ['a', 'b', 'c']);
  assert.equal(db.archive.revisions.length, 3);
  assert.equal(db.archive.assets.length, 1);
  assert.ok(undone.undoSummary.skipped.some(item => item.id === 'a' && item.reason === 'modified after import'));
  assert.ok(undone.undoSummary.skipped.some(item => item.id === 'b' && item.reason.includes('referenced')));
  assert.ok(undone.undoSummary.skipped.some(item => item.id === 'diagram' && item.reason.includes('retained knowledge')));
});

test('undo respects saved work in drafts, boards, outside relationships and revision snapshots', () => {
  const db = emptyDatabase();
  importArchive(db, archive({shards: [shard('existing')]}));
  const result = importArchive(db, archive({shards: [shard('drafted'), shard('on-board'), shard('linked'), shard('in-history')]}));
  db.drafts.editor = {id: 'drafted', content: 'A draft'};
  db.archive.boards.push({id: 'external-board', title: 'Personal', items: [{shardId: 'on-board'}], sections: []});
  db.archive.links.push(link('external-link', 'existing', 'linked'));
  db.archive.revisions.push({id: 'external-history', shardId: 'existing', createdAt: stamp, reason: 'edited', snapshot: shard('existing', {content: '[[id:in-history]]'})});
  undo(db, result.importSummary.importId);
  assert.equal(db.archive.shards.length, 5);
  assert.equal(db.archive.links.length, 1);
  assert.equal(db.archive.boards.length, 1);
});

test('undo preserves images referenced only in retained trash, revisions or drafts', () => {
  for (const storage of ['trash', 'revisions', 'drafts']) {
    const db = emptyDatabase();
    importArchive(db, archive({shards: [shard('existing')]}));
    const result = importArchive(db, archive({assets: [{id: 'image', name: 'Image', mimeType: 'image/png', data: PNG}]}));
    const content = '![Figure](/assets/image)';
    if (storage === 'trash') db.archive.trash.push({id: 'kept-trash', shard: shard('deleted', {content}), links: [], reviews: []});
    if (storage === 'revisions') db.archive.revisions.push({id: 'kept-revision', shardId: 'existing', snapshot: shard('existing', {content})});
    if (storage === 'drafts') db.drafts.editor = {content};
    const undone = undo(db, result.importSummary.importId);
    assert.equal(db.archive.assets.length, 1, storage);
    assert.ok(undone.undoSummary.skipped.some(item => item.kind === 'assets'));
  }
});

test('legacy review aggregates on existing notes are restored when the added reviews are undone', () => {
  const db = emptyDatabase();
  importArchive(db, archive({shards: [shard('a', {reviewCount: 12, lastReviewedAt: '2026-10-01T12:00:00.000Z', nextReviewAt: '2026-10-08T12:00:00.000Z'})]}));
  const original = clone(db.archive.shards[0]);
  const result = importArchive(db, archive({reviews: [{id: 'new-review', shardId: 'a', grade: 'good', reviewedAt: stamp}]}));
  assert.equal(db.archive.shards[0].reviewCount, 1);
  undo(db, result.importSummary.importId);
  assert.deepEqual(db.archive.shards[0], original);
});

test('import receipts expose history and undo summaries without internal fingerprints', () => {
  const db = emptyDatabase(), result = importArchive(db, archive({title: 'A named import', shards: [shard('a')]}));
  const receipt = call(db, '/api/imports', {}, 'GET').imports[0];
  assert.equal(receipt.title, 'A named import');
  assert.equal(receipt.records, undefined);
  assert.equal(receipt.reviewUpdates, undefined);
  assert.equal(receipt.id, result.importSummary.importId);
  assert.equal(result.importReceipt.id, receipt.id);
  const canonical = value => Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']' : value && typeof value === 'object' ? '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}' : JSON.stringify(value);
  const internal = db.imports.find(item => item.id === receipt.id).records.shards[0];
  assert.equal(internal.fingerprint, createHash('sha256').update(canonical(db.archive.shards[0])).digest('hex'));
  undo(db, receipt.id);
  assert.ok(call(db, '/api/imports', {}, 'GET').imports[0].undoneAt);
});

test('manual snapshots and restore preserve drafts, histories, trash and import receipts while keeping a safety snapshot', () => {
  const db = emptyDatabase();
  importArchive(db, fullArchive());
  db.drafts.editor = {id: 'alpha', content: 'Unsaved draft'};
  const saved = call(db, '/api/backup'), expectedArchive = clone(db.archive), expectedImports = clone(db.imports), expectedDrafts = clone(db.drafts);
  importArchive(db, archive({shards: [shard('later')]}));
  db.drafts.editor.content = 'New draft';
  const count = db.backups.length;
  const restored = call(db, '/api/backups/restore', {filename: saved.filename});
  assert.deepEqual(db.archive, expectedArchive);
  assert.deepEqual(db.imports, expectedImports);
  assert.deepEqual(db.drafts, expectedDrafts);
  assert.equal(db.backups.length, count + 1);
  const safety = db.backups.find(item => item.filename === restored.restoreSummary.preRestoreBackupFilename);
  assert.ok(safety.archive.shards.some(item => item.id === 'later'));
  assert.equal(safety.drafts.editor.content, 'New draft');
  const listed = call(db, '/api/backups', {}, 'GET').backups;
  assert.ok(listed.every(item => item.valid));
  assert.equal(listed[0].archive, undefined);
});

test('corrupt and unknown snapshots cannot replace knowledge or create a misleading safety snapshot', () => {
  const db = emptyDatabase();
  importArchive(db, archive({shards: [shard('a')]}));
  const snapshot = call(db, '/api/backup');
  db.backups.find(item => item.filename === snapshot.filename).archive.links.push(link('bad', 'a', 'missing'));
  const before = clone(db);
  assert.equal(call(db, '/api/backups', {}, 'GET').backups.find(item => item.filename === snapshot.filename).valid, false);
  assert.throws(() => call(db, '/api/backups/restore', {filename: snapshot.filename}), /missing shard/);
  assert.throws(() => call(db, '/api/backups/restore', {filename: '../not-a-snapshot'}), /backup list/);
  assert.deepEqual(db, before);
});

test('conflicting unknown archive metadata remains recoverable in portable exports', () => {
  const db = emptyDatabase();
  importArchive(db, archive({sourceMetadata: {version: 1}}));
  const result = importArchive(db, archive({sourceMetadata: {version: 2}, customExtension: ['all', 'retained']}));
  assert.deepEqual(db.archive.sourceMetadata, {version: 1});
  assert.deepEqual(db.archive.customExtension, ['all', 'retained']);
  const metadata = db.archive.mobileImportMetadata.find(item => item.importId === result.importSummary.importId);
  assert.deepEqual(metadata.metadata.sourceMetadata, {version: 2});
  assert.deepEqual(db.imports.at(-1).sourceMetadata.sourceMetadata, {version: 2});
});

test('the desktop Python validator accepts the complete mobile export', () => {
  const db = emptyDatabase();
  importArchive(db, fullArchive());
  const result = spawnSync('python3', ['-c',
    'import json,sys,tempfile\nfrom pathlib import Path\nfrom server import Store\nwith tempfile.TemporaryDirectory() as tmp:\n store=Store(Path(tmp)/"qa.sqlite3",seed=False,backup_on_start=False,automatic_backups=False)\n payload=json.load(sys.stdin)\n store.import_data(payload)\n assert {s["id"] for s in store.export_data()["shards"]} == {s["id"] for s in payload["shards"]}\n assert store.export_data()["assets"][0]["data"] == payload["assets"][0]["data"]\n'],
  {cwd: new URL('..', import.meta.url), input: JSON.stringify(db.archive), encoding: 'utf8'});
  assert.equal(result.status, 0, result.stderr);
});
