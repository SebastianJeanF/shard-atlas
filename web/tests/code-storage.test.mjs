import test from 'node:test';
import assert from 'node:assert/strict';
import {IDBFactory} from 'fake-indexeddb';
import {emptyDatabase, handleCore, linkKey, validateCodeSolution, validateLink, validateShard} from '../../web-dist/model.mjs';
import {handleArchives} from '../../web-dist/archives.mjs';
import {importInbox} from '../../web-dist/inbox.mjs';
import {BrowserStore} from '../../web-dist/persistence.mjs';

const source = '\n  #include <vector>\r\nint main() {\r\n\t// [[id:alias]] stays literal.\r\n  return 0;\r\n}\r\n\n';
const problem = (id = 'problem') => ({id, title: 'Course ordering', content: 'A directed acyclic graph.', codeSolution: {role: 'problem', aliases: ['course ordering', 'toposort'], purpose: 'Choose an order.', approaches: [{id: 'kahn', title: 'Kahn', code: source, headers: ['<queue>'], timeComplexity: 'O(V+E)', spaceComplexity: 'O(V)', assumptions: ['Valid indices'], pitfalls: ['Cycles']}, {id: 'dfs', title: 'DFS', summary: 'Postorder', code: ' void visit() {}\n'}]}});
const snippet = (id = 'snippet', code = source) => ({id, title: 'A reusable helper', content: 'Returns a helper result.', tags: ['C++'], codeSolution: {role: 'snippet', code, headers: ['<vector>'], aliases: ['helper'], timeComplexity: 'O(1)', spaceComplexity: 'O(1)'}});
const envelope = (requestId, shards = [], links = []) => ({format: 'shard-atlas-inbox', version: 1, batch: {requestId, shards, links}});
const archive = (shards = [], links = [], extra = {}) => ({schemaVersion: 1, shards, links, ...extra});
const seeded = () => {const db = emptyDatabase(); db.archive.shards = [validateShard(problem(), {imported: true}), validateShard(snippet(), {imported: true})]; return db;};
const edge = (extra = {}) => ({id: 'uses-kahn', fromId: 'problem', toId: 'snippet', type: 'uses', fromApproachId: 'kahn', note: 'Queue processing', scope: 'Kahn approach', evidence: 'Uses this helper', sourceUrl: 'https://example.com/queue', sourceLocation: 'Queue step', ...extra});

test('create, edit, revisions, drafts and export preserve exact code and normalize optional defaults', () => {
  const db = emptyDatabase(); handleCore(db, '/api/shards', 'POST', snippet()); const id = db.archive.shards[0].id;
  assert.equal(db.archive.shards[0].codeSolution.code, source); assert.deepEqual(db.archive.shards[0].codeSolution.approaches, []);
  handleCore(db, '/api/shards/' + id, 'PUT', {title: 'Renamed helper'}); assert.equal(db.archive.shards[0].codeSolution.code, source);
  const changed = {role: 'snippet', code: '\treturn 9;\r\n', headers: [' <vector> ', '<vector>']};
  handleCore(db, '/api/shards/' + id, 'PUT', {codeSolution: changed});
  assert.equal(db.archive.shards[0].codeSolution.code, changed.code); assert.deepEqual(db.archive.shards[0].codeSolution.headers, ['<vector>']);
  assert.equal(db.archive.revisions[1].snapshot.codeSolution.code, source);
  handleCore(db, '/api/drafts/editor', 'PUT', {draft: {editingId: id, codeSolution: problem().codeSolution}});
  assert.equal(db.drafts.editor.codeSolution.approaches[0].code, source);
  assert.equal(handleCore(db, '/api/export').shards[0].codeSolution.code, changed.code);
});

test('missing approach IDs receive stable Mac-compatible UUIDv5 IDs with Unicode and CRLF source', () => {
  const input = {approaches: [{title: 'Kahn α', summary: 'Queue each zero in-degree vertex.', code: '  int α = 1;\r\n'}]};
  assert.equal(validateCodeSolution(input).approaches[0].id, 'approach-63dae902-bca8-58fa-809f-891bc6fe846a');
  assert.equal(validateCodeSolution({approaches: [{}]}).approaches[0].id, 'approach-d0c2452a-d213-531c-8351-564e010fadf8');
});

test('malformed metadata rejects direct and inbox writes before any mutation', () => {
  for (const codeSolution of [null, [], {unknown: true}, {role: 'quiz'}, {code: 2}, {code: 'x'.repeat(100001)}, {headers: [null]}, {aliases: ['']}, {assumptions: [2]}, {approaches: [null]}, {approaches: [{id: 'bad id'}]}, {approaches: [{id: 'a'}, {id: 'a'}]}, {approaches: [{title: 'x', unknown: true}]}]) {
    const db = emptyDatabase(), before = JSON.stringify(db);
    assert.throws(() => handleCore(db, '/api/shards', 'POST', {title: 'Bad input', codeSolution}));
    assert.throws(() => importInbox(db, envelope('invalid', [{id: 'bad', title: 'Bad input', codeSolution}])));
    assert.equal(JSON.stringify(db), before);
  }
});

test('one thousand topic memberships survive direct saves, archives and inbox imports', () => {
  const tags = Array.from({length: 1000}, (_, i) => 'Topic ' + i), note = {...snippet('many'), tags};
  const db = emptyDatabase(); handleCore(db, '/api/shards', 'POST', note); assert.deepEqual(db.archive.shards[0].tags, tags);
  const other = emptyDatabase(); handleArchives(other, '/api/import', 'POST', {data: archive([note])}); assert.deepEqual(other.archive.shards[0].tags, tags);
  const inbox = emptyDatabase(); importInbox(inbox, envelope('many', [note])); assert.deepEqual(inbox.archive.shards[0].tags, tags);
});

test('matching title and prose do not collapse different code solutions or overwrite an existing ID', () => {
  const db = emptyDatabase(), receipt = importInbox(db, envelope('two', [snippet('a', 'int a = 1;\n'), snippet('b', 'int a = 2;\n')]));
  assert.equal(receipt.added.shards, 2); assert.equal(receipt.idMap.b, 'b'); const before = JSON.stringify(db);
  const preview = handleArchives(db, '/api/import/preview', 'POST', {data: archive([snippet('c', 'int a = 3;\n')])});
  assert.equal(preview.valid, true); assert.equal(preview.duplicates.length, 0);
  assert.throws(() => importInbox(db, envelope('collision', [snippet('a', 'int a = 3;\n')])), /different content/); assert.equal(JSON.stringify(db), before);
});

test('typed links retain approach identity, evidence, direction and independent scoped edges on edits', () => {
  const db = seeded(); handleCore(db, '/api/links', 'POST', edge()); const saved = db.archive.links[0];
  for (const field of ['fromApproachId', 'scope', 'evidence', 'sourceUrl', 'sourceLocation']) assert.equal(saved[field], edge()[field]);
  handleCore(db, '/api/links/' + saved.id, 'PUT', {fromApproachId: 'dfs', evidence: 'Uses helper in DFS'});
  assert.equal(db.archive.links[0].fromApproachId, 'dfs'); assert.equal(db.archive.links[0].scope, 'Kahn approach'); assert.equal(db.archive.links[0].evidence, 'Uses helper in DFS');
  handleCore(db, '/api/links', 'POST', edge()); handleCore(db, '/api/links', 'POST', edge({type: 'implements'})); assert.equal(db.archive.links.length, 3);
});

test('symmetric alternatives canonicalize distinct approach endpoints and reject reversed duplicate creation', () => {
  const db = seeded(), alt = edge({type: 'alternative_to', fromId: 'problem', toId: 'problem', fromApproachId: 'kahn', toApproachId: 'dfs'});
  handleCore(db, '/api/links', 'POST', alt); assert.equal(db.archive.links[0].fromApproachId, 'dfs'); assert.equal(db.archive.links[0].toApproachId, 'kahn');
  const reversed = {...alt, fromApproachId: 'dfs', toApproachId: 'kahn'}; assert.equal(linkKey(alt), linkKey(reversed)); assert.throws(() => handleCore(db, '/api/links', 'POST', reversed), /already exists/);
  for (const invalid of [edge({toId: 'problem'}), {...alt, toApproachId: 'kahn'}, {...alt, fromApproachId: ''}]) assert.throws(() => validateLink(invalid, {imported: true}), /different shards/);
});

test('missing approach references reject creation and both import formats atomically', () => {
  const db = seeded(), before = JSON.stringify(db), bad = edge({fromApproachId: 'missing'});
  assert.throws(() => handleCore(db, '/api/links', 'POST', bad), /missing solution approach/);
  assert.throws(() => handleArchives(db, '/api/import', 'POST', {data: archive([], [bad])}), /missing solution approach/);
  assert.throws(() => importInbox(db, envelope('bad-edge', [], [bad])), /missing solution approach/); assert.equal(JSON.stringify(db), before);
});

test('active and Trash connections protect approaches against deletion and revision restores', () => {
  const db = seeded(); handleCore(db, '/api/shards/problem', 'PUT', {codeSolution: {...problem().codeSolution, approaches: []}}); const old = db.archive.revisions.at(-1).id;
  handleCore(db, '/api/shards/problem', 'PUT', {codeSolution: problem().codeSolution}); handleCore(db, '/api/links', 'POST', edge()); let before = JSON.stringify(db);
  assert.throws(() => handleCore(db, '/api/shards/problem', 'PUT', {codeSolution: {role: 'problem'}}), /remove a solution approach/);
  assert.throws(() => handleCore(db, '/api/shards/problem/restore', 'POST', {revisionId: old}), /remove a solution approach/); assert.equal(JSON.stringify(db), before);
  handleCore(db, '/api/shards/snippet', 'DELETE'); before = JSON.stringify(db);
  assert.throws(() => handleCore(db, '/api/shards/problem', 'PUT', {codeSolution: {role: 'problem'}}), /remove a solution approach/); assert.equal(JSON.stringify(db), before);
  handleCore(db, '/api/trash/' + db.archive.trash[0].id + '/restore', 'POST'); assert.equal(db.archive.links[0].fromApproachId, 'kahn');
});

test('archive preview, import, revisions, Trash, backups and restores keep exact code and scoped links', () => {
  const db = emptyDatabase(), data = archive([problem(), snippet()], [edge()]); assert.equal(handleArchives(db, '/api/import/preview', 'POST', {data}).valid, true);
  handleArchives(db, '/api/import', 'POST', {data}); assert.equal(db.archive.shards[0].codeSolution.approaches[0].code, source); assert.equal(db.archive.revisions[0].snapshot.codeSolution.approaches[0].code, source);
  const snapshot = handleArchives(db, '/api/backup', 'POST'); handleCore(db, '/api/shards/snippet', 'DELETE');
  const other = emptyDatabase(); handleArchives(other, '/api/import', 'POST', {data: handleCore(db, '/api/export')}); assert.equal(other.archive.trash[0].shard.codeSolution.code, source);
  handleCore(other, '/api/trash/' + other.archive.trash[0].id + '/restore', 'POST'); assert.equal(other.archive.links[0].fromApproachId, 'kahn');
  handleArchives(db, '/api/backups/restore', 'POST', {filename: snapshot.filename}); assert.equal(db.archive.links[0].fromApproachId, 'kahn'); assert.equal(db.archive.shards.find(item => item.id === 'snippet').codeSolution.code, source);
});

test('archive endpoint validation uses the existing IDs an additive import will actually preserve', () => {
  const db = seeded(), before = JSON.stringify(db), incoming = problem(); incoming.codeSolution.approaches.push({id: 'new-unsaved', title: 'Incoming only'});
  const data = archive([incoming], [edge({fromApproachId: 'new-unsaved'})]); assert.equal(handleArchives(db, '/api/import/preview', 'POST', {data}).valid, false);
  assert.throws(() => handleArchives(db, '/api/import', 'POST', {data}), /missing solution approach/); assert.equal(JSON.stringify(db), before);
});

test('inbox ID remapping updates prose and endpoints while preserving code, headers, aliases and approach IDs', () => {
  const db = seeded(), alias = snippet('alias'), incoming = problem('new-problem'); incoming.codeSolution.purpose = 'Use [[id:alias]]'; incoming.codeSolution.approaches[0].summary = 'See [[id:alias]]'; incoming.codeSolution.approaches[0].headers = ['<vector>', '[[id:alias]]']; incoming.codeSolution.aliases.push('[[id:alias]]');
  const value = envelope('mapping', [alias, incoming], [edge({fromId: 'new-problem', toId: 'alias'})]), receipt = importInbox(db, value), saved = db.archive.shards.find(item => item.id === 'new-problem');
  assert.equal(receipt.idMap.alias, 'snippet'); assert.equal(saved.codeSolution.purpose, 'Use [[id:snippet]]'); assert.equal(saved.codeSolution.approaches[0].summary, 'See [[id:snippet]]'); assert.equal(saved.codeSolution.approaches[0].code, source); assert.deepEqual(saved.codeSolution.approaches[0].headers, ['<vector>', '[[id:alias]]']); assert.ok(saved.codeSolution.aliases.includes('[[id:alias]]'));
  assert.equal(receipt.links[0].fromApproachId, 'kahn'); assert.equal(db.archive.links[0].toId, 'snippet'); assert.equal(importInbox(db, value).currentContentMatches, true);
});

test('inbox re-canonicalizes alternative links after duplicate shard ID remapping', () => {
  const db = seeded(), alt = edge({id: 'alt', fromId: 'z-alias', toId: 'problem', type: 'alternative_to', fromApproachId: 'kahn', toApproachId: 'dfs'}), receipt = importInbox(db, envelope('alternative', [problem('z-alias')], [alt]));
  assert.equal(receipt.idMap['z-alias'], 'problem'); assert.equal(receipt.links[0].fromApproachId, 'dfs'); assert.equal(receipt.links[0].toApproachId, 'kahn');
  const reverse = edge({id: 'reverse-alt', fromId: 'problem', toId: 'problem', type: 'alternative_to', fromApproachId: 'kahn', toApproachId: 'dfs'}); assert.equal(importInbox(db, envelope('reverse', [], [reverse])).skipped.links, 1); assert.equal(db.archive.links.length, 1);
});

test('archive import distinguishes approach-scoped edges and rejects reversed duplicate alternatives', () => {
  const db = emptyDatabase(); handleArchives(db, '/api/import', 'POST', {data: archive([problem(), snippet()], [edge(), edge({id: 'dfs-edge', fromApproachId: 'dfs'})])}); assert.equal(db.archive.links.length, 2);
  const alt = edge({id: 'alt', fromId: 'problem', toId: 'problem', type: 'alternative_to', fromApproachId: 'kahn', toApproachId: 'dfs'}), reverse = {...alt, id: 'reverse', fromApproachId: 'dfs', toApproachId: 'kahn'};
  assert.throws(() => handleArchives(emptyDatabase(), '/api/import', 'POST', {data: archive([problem()], [alt, reverse])}), /duplicate relationship/);
});

test('import undo retains code referenced by a later saved approach connection', () => {
  const db = emptyDatabase(), result = handleArchives(db, '/api/import', 'POST', {data: archive([problem(), snippet()])}); handleCore(db, '/api/links', 'POST', edge());
  const undo = handleArchives(db, '/api/imports/' + result.importSummary.importId + '/undo', 'POST'); assert.equal(undo.undoSummary.removed.shards, 0); assert.equal(db.archive.shards[0].codeSolution.approaches[0].code, source); assert.equal(db.archive.links[0].fromApproachId, 'kahn');
});

test('rich metadata and experiment edits preserve source, history and the unfinished note draft', () => {
  const db = seeded(), experiment = {id: 'gradient', title: 'Quadratic', type: 'gradient-descent', algorithmVersion: 1, config: {a: 4, b: 0, c: 1, startX: 3, startY: 2, learningRate: .2, maxIterations: 100, tolerance: 1e-8}};
  handleCore(db, '/api/shards/problem', 'PUT', {subjects: ['Algorithms'], notation: [{symbol: 'V', meaning: 'Number of vertices'}], experiments: [experiment]}); handleCore(db, '/api/drafts/editor', 'PUT', {draft: {editingId: 'problem', title: 'Unfinished change'}}); const draft = structuredClone(db.drafts.editor);
  const revised = {...experiment, config: {...experiment.config, learningRate: .1}}; handleCore(db, '/api/shards/problem/experiments/gradient', 'PUT', {experiment: revised});
  assert.equal(db.archive.shards[0].experiments[0].config.learningRate, .1); assert.equal(db.archive.shards[0].codeSolution.approaches[0].code, source); assert.deepEqual(db.archive.shards[0].subjects, ['Algorithms']); assert.deepEqual(db.drafts.editor, draft); assert.equal(db.archive.revisions.at(-2).snapshot.experiments[0].config.learningRate, .2);
  const before = JSON.stringify(db); assert.throws(() => handleCore(db, '/api/shards/problem/experiments/gradient', 'PUT', {experiment: {...revised, config: {...revised.config, learningRate: -2}}})); assert.equal(JSON.stringify(db), before);
});

test('existing IndexedDB v1 opens without reseeding, preserves legacy extensions, and shares code across tabs', async () => {
  const idb = new IDBFactory(), first = new BrowserStore(idb), database = await first.ready, legacy = emptyDatabase(); legacy.archive.shards = [{id: 'legacy', title: 'Existing note', content: 'Keep me', tags: ['My topic'], customField: {original: true}}]; legacy.archive.boards = [{id: 'legacy-board', title: 'Retired board', items: []}]; legacy.drafts.editor = {title: 'Unfinished earlier note'};
  await new Promise((resolve, reject) => {const transaction = database.transaction('collection', 'readwrite'); transaction.objectStore('collection').put(legacy, 'atlas'); transaction.oncomplete = resolve; transaction.onerror = reject;});
  const second = new BrowserStore(idb), state = (await second.request('/api/state')).result; assert.equal(state.shards.length, 1); assert.equal(state.shards[0].content, 'Keep me'); assert.deepEqual((await second.request('/api/drafts')).result.drafts.editor, legacy.drafts.editor);
  await second.request('/api/shards/legacy', 'PUT', {codeSolution: snippet().codeSolution}); const restored = (await first.request('/api/export')).result; assert.equal(restored.shards[0].codeSolution.code, source); assert.deepEqual(restored.shards[0].customField, {original: true}); assert.equal(restored.boards[0].id, 'legacy-board');
  await second.request('/api/drive/import', 'POST', {envelope: envelope('phone-code', [problem(), snippet()], [edge()])}); const saved = (await first.request('/api/state')).database; assert.equal(saved.archive.links[0].fromApproachId, 'kahn'); const before = JSON.stringify(saved);
  await assert.rejects(second.request('/api/shards/problem', 'PUT', {codeSolution: {role: 'problem'}}), /remove a solution approach/); assert.equal(JSON.stringify((await first.request('/api/state')).database), before); database.close(); (await second.ready).close();
});
