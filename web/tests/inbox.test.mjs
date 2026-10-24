import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {IDBFactory} from 'fake-indexeddb';
import {emptyDatabase, handleCore} from '../../web-dist/model.mjs';
import {fingerprint, handleArchives} from '../../web-dist/archives.mjs';
import {handleInbox, importInbox, parseInboxJSON, validateInboxEnvelope} from '../../web-dist/inbox.mjs';
import {BrowserStore} from '../../web-dist/persistence.mjs';
import {DriveInboxClient, DRIVE_SCOPE, readBoundedText} from '../../web-dist/drive-client.mjs';
import {resolveDriveSettings} from '../../web-dist/drive-ui.mjs';

const batch = (requestId = 'capture-1', shards = [{id: 'note-1', title: 'A note', content: 'The explanation', tags: ['C++']}], links = []) => ({format: 'shard-atlas-inbox', version: 1, batch: {requestId, shards, links}});
const json = (data, status = 200) => new Response(JSON.stringify(data), {status, headers: {'Content-Type': 'application/json'}});
const canonical = value => Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']' : value && typeof value === 'object' ? '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}' : JSON.stringify(value);

test('receipts fingerprint exact raw finite JSON using SHA256, independent of key order', () => {
  const value = batch(), original = JSON.stringify(value), db = emptyDatabase();
  const receipt = importInbox(db, value);
  assert.equal(JSON.stringify(value), original);
  assert.equal(db.inboxReceipts[0].fingerprint, createHash('sha256').update(canonical(value.batch)).digest('hex'));
  assert.equal(fingerprint(value.batch), db.inboxReceipts[0].fingerprint);
  const reordered = {batch: {links: [], shards: value.batch.shards, requestId: 'capture-1'}, version: 1, format: 'shard-atlas-inbox'};
  assert.equal(importInbox(db, reordered).replayed, true);
  assert.equal(db.archive.shards.length, 1); assert.equal(db.inboxReceipts.length, 1); assert.equal(db.backups.length, 1);
  assert.equal(receipt.verified, true);
});

test('changed content under a request ID is rejected atomically', () => {
  const db = emptyDatabase(); importInbox(db, batch()); const before = JSON.stringify(db);
  const changed = batch(); changed.batch.shards[0].tags = ['Different'];
  assert.throws(() => importInbox(db, changed), /requestId.*different content/);
  assert.equal(JSON.stringify(db), before);
});

test('replays preserve later edits and deletions and report current state', () => {
  const db = emptyDatabase(), value = batch(); importInbox(db, value);
  handleCore(db, '/api/shards/note-1', 'PUT', {content: 'My later edit'});
  const edited = importInbox(db, value);
  assert.equal(db.archive.shards[0].content, 'My later edit'); assert.equal(edited.currentContentMatches, false);
  handleCore(db, '/api/shards/note-1', 'DELETE');
  const deleted = importInbox(db, value);
  assert.equal(db.archive.shards.length, 0); assert.deepEqual(deleted.missingShardIds, ['note-1']);
  assert.match(deleted.warning, /preserved/);
  assert.throws(() => importInbox(db, batch('new-capture')), /Trash/);
});

test('an ID collision rejects the complete batch, including preceding fresh records', () => {
  const db = emptyDatabase(); importInbox(db, batch()); const before = JSON.stringify(db);
  const value = batch('capture-2', [{id: 'fresh', title: 'Fresh', content: 'New'}, {id: 'note-1', title: 'Collision', content: 'Changed'}]);
  assert.throws(() => importInbox(db, value), /already belongs to different content/);
  assert.equal(JSON.stringify(db), before);
});

test('content dedupe remaps typed links, prose references, and comparison IDs, preserving exact code', () => {
  const db = emptyDatabase(); importInbox(db, batch());
  const value = batch('capture-2', [
    {id: 'alias', title: '  a   note ', content: 'The explanation'},
    {id: 'new', title: 'New idea', content: 'See [[id:alias]]. `[[id:alias]]`\n```\n[[id:alias]]\n```', comparisons: [{title: 'Compare', alternatives: [{name: 'A', shardId: 'alias'}, {name: 'B'}]}]},
  ], [{id: 'relationship', fromId: 'new', toId: 'alias', type: 'example_of', note: 'A concrete example', scope: 'C++', sourceLocation: 'Section 2'}]);
  const receipt = importInbox(db, value);
  assert.equal(receipt.idMap.alias, 'note-1'); assert.equal(receipt.added.shards, 1);
  const note = db.archive.shards.find(item => item.id === 'new');
  assert.equal(note.content, 'See [[id:note-1]]. `[[id:alias]]`\n```\n[[id:alias]]\n```');
  assert.equal(note.comparisons[0].alternatives[0].shardId, 'note-1');
  assert.equal(db.archive.links[0].toId, 'note-1'); assert.equal(db.archive.links[0].scope, 'C++');
  assert.equal(importInbox(db, value).currentContentMatches, true);
});

test('same-ID relationships with changed context fail; semantic duplicate links reuse existing content', () => {
  const db = emptyDatabase();
  const first = batch('first', [{id: 'a', title: 'A'}, {id: 'b', title: 'B'}], [{id: 'ab', fromId: 'a', toId: 'b', note: 'Original', evidence: 'Observed'}]);
  importInbox(db, first);
  assert.throws(() => importInbox(db, batch('second', [], [{id: 'ab', fromId: 'a', toId: 'b', note: 'Changed'}])), /different content/);
  const reused = importInbox(db, batch('third', [], [{id: 'another', fromId: 'a', toId: 'b', note: 'Different reason'}]));
  assert.equal(reused.skipped.links, 1); assert.equal(db.archive.links[0].note, 'Original');
});

test('missing endpoints and self-links after dedupe are rejected before saving', () => {
  const db = emptyDatabase();
  assert.throws(() => importInbox(db, batch('missing', [{id: 'a', title: 'A'}], [{id: 'link', fromId: 'a', toId: 'missing'}])), /missing shard/);
  assert.equal(db.archive.shards.length, 0);
  assert.throws(() => importInbox(db, batch('self', [{id: 'a', title: 'A'}, {id: 'b', title: 'a'}], [{id: 'link', fromId: 'a', toId: 'b'}])), /self-link/);
});

test('strict transport rejects archives, unsupported fields, absent link IDs, null lists and nonfinite JSON', () => {
  for (const invalid of [{schemaVersion: 1, shards: []}, {...batch(), version: 2}, {...batch(), extra: true}, batch('x', [], [{fromId: 'a', toId: 'b'}]), batch('x', null), batch('x', [{id: 'a', title: 'A', createdAt: '2026-10-22T00:00:00Z'}]), batch('x', [{id: 'a', title: 'A', prompt: 'Recall'}]), batch('x', [{id: 'a', title: 'A', courses: [{position: NaN}]}])]) {
    const db = emptyDatabase(); assert.throws(() => importInbox(db, invalid)); assert.equal(db.archive.shards.length, 0); assert.equal(db.backups.length, 0);
  }
});

test('UTF8 BOM parses; duplicate keys, malformed JSON, nonfinite numbers, and excessive nesting fail', () => {
  assert.deepEqual(parseInboxJSON('\uFEFF' + JSON.stringify(batch())), batch());
  for (const invalid of ['{"x":1,"x":2}', '{"x":1,"\\u0078":2}', '{"x":NaN}', '{"x":1e999}', '[1,]', '{"x":1,}', 'true false', '"unterminated', '['.repeat(66) + '1' + ']'.repeat(66)]) assert.throws(() => parseInboxJSON(invalid));
  assert.deepEqual(parseInboxJSON('{"__proto__":{"safe":true},"array":[false,null,1.2e2]}').array, [false, null, 120]);
});

test('rich course, notation, verification, and experiment metadata survives exactly; malformed values fail', () => {
  const extra = {subjects: ['Optimization'], assumptions: ['Fixed step'], courses: [{courseCode: 'CS4789', position: 4}], notation: [{symbol: 'x', meaning: 'current input'}], verification: {status: 'source-checked', note: 'Compared definition', sourceLocation: 'Notes 4'}, experiments: [{id: 'experiment', title: 'Quadratic', type: 'gradient-descent', algorithmVersion: 1, config: {a: 4, b: 0, c: 1, startX: 3, startY: 2, learningRate: .2, maxIterations: 100, tolerance: 1e-8}}]};
  const db = emptyDatabase(); importInbox(db, batch('rich', [{id: 'rich', title: 'Rich note', ...extra}]));
  for (const [key, value] of Object.entries(extra)) assert.deepEqual(db.archive.shards[0][key], value);
  for (const invalid of [{subjects: {}}, {assumptions: [2]}, {courses: [{}]}, {notation: [{symbol: 'x'}]}, {perspectives: [false]}, {walkthroughs: [{title: 'Missing steps'}]}, {comparisons: [{title: 'One alternative', alternatives: [{name: 'A'}]}]}, {learningLog: [{prompt: 'Resolved?', status: 'resolved'}]}, {verification: {status: 'source-checked'}}, {experiments: [{...extra.experiments[0], algorithmVersion: 2}]}, {experiments: [{...extra.experiments[0], config: {...extra.experiments[0].config, b: 10}}]}]) {
    assert.throws(() => importInbox(emptyDatabase(), batch('invalid', [{id: 'invalid', title: 'Invalid', ...invalid}])));
  }
});

test('cumulative record limit is enforced before any addition or receipt', () => {
  const db = emptyDatabase(); db.archive.revisions = Array.from({length: 100_000}, (_, index) => ({id: 'revision-' + index}));
  const before = JSON.stringify(db);
  assert.throws(() => importInbox(db, batch()), /portable archive capacity/);
  assert.equal(JSON.stringify(db), before);
});

test('local recovery snapshots restore inbox receipts alongside notes', () => {
  const db = emptyDatabase(), value = batch(); importInbox(db, value);
  const snapshot = handleArchives(db, '/api/backup', 'POST');
  handleCore(db, '/api/shards/note-1', 'PUT', {content: 'Later'});
  handleArchives(db, '/api/backups/restore', 'POST', {filename: snapshot.filename});
  assert.equal(db.archive.shards[0].content, 'The explanation'); assert.equal(db.inboxReceipts.length, 1);
  assert.equal(importInbox(db, value).replayed, true);
  assert.equal(Object.hasOwn(handleCore(db, '/api/export'), 'inboxReceipts'), false);
});

test('real IndexedDB transactions serialize two tabs; receipt and content commit once', async () => {
  const idb = new IDBFactory(), first = new BrowserStore(idb), second = new BrowserStore(idb);
  const results = await Promise.all([first.request('/api/drive/import', 'POST', {envelope: batch()}), second.request('/api/drive/import', 'POST', {envelope: batch()})]);
  assert.deepEqual(results.map(result => result.result.receipt.replayed).sort(), [false, true]);
  const {database} = await first.request('/api/state');
  assert.equal(database.archive.shards.length, 1); assert.equal(database.inboxReceipts.length, 1); assert.equal(database.backups.length, 1);
  const invalid = batch('collision', [{id: 'fresh', title: 'Fresh'}, {id: 'note-1', title: 'Different'}]);
  await assert.rejects(second.request('/api/drive/import', 'POST', {envelope: invalid}), /different content/);
  assert.equal((await first.request('/api/state')).database.archive.shards.length, 1);
});

test('aborting IndexedDB put leaves both notes and receipt absent', async () => {
  const idb = new IDBFactory(), store = new BrowserStore(idb), database = await store.ready;
  const transaction = database.transaction.bind(database);
  database.transaction = (...arguments_) => {
    const result = transaction(...arguments_);
    if (arguments_[1] === 'readwrite') {
      const objectStore = result.objectStore.bind(result);
      result.objectStore = (...values) => {const collection = objectStore(...values); collection.put = () => {throw new DOMException('Full', 'QuotaExceededError');}; return collection;};
    }
    return result;
  };
  await assert.rejects(store.request('/api/drive/import', 'POST', {envelope: batch()}));
  const saved = (await store.request('/api/state')).database;
  assert.equal(saved.archive.shards.length, 0); assert.equal(saved.inboxReceipts.length, 0);
});

const settings = {clientId: '123-public.apps.googleusercontent.com', folderId: 'folder1234567890', expectedEmail: 'owner@example.org'};
test('a newly deployed OAuth client activates a device with earlier blank settings', () => {
  for (const clientId of ['', '   ']) {
    const resolved = resolveDriveSettings(settings, {clientId, folderId: 'customfolder12345', expectedEmail: ''});
    assert.equal(resolved.clientId, settings.clientId);
    assert.equal(resolved.folderId, 'customfolder12345');
    assert.equal(resolved.expectedEmail, '');
  }
  assert.equal(resolveDriveSettings({}, {clientId: ''}).clientId, '');
  assert.equal(resolveDriveSettings(settings, {clientId: '456-custom.apps.googleusercontent.com'}).clientId, '456-custom.apps.googleusercontent.com');
});

const metadata = (id = 'file1234567890', name = 'capture.json', size = JSON.stringify(batch()).length) => ({id, name, mimeType: 'application/json', size: String(size), parents: [settings.folderId], trashed: false});
function googleMock({email = settings.expectedEmail, denied = false, popup = '', lifetime = 3600} = {}) {
  return {accounts: {oauth2: {hasGrantedAllScopes: response => response.scope === DRIVE_SCOPE, initTokenClient: config => ({requestAccessToken() {
    if (popup) config.error_callback({type: popup});
    else config.callback(denied ? {error: 'access_denied'} : {access_token: 'secret-never-store', expires_in: lifetime, scope: DRIVE_SCOPE});
  }})}}};
}
function transport(handler, {email = settings.expectedEmail} = {}) {
  return async (input, options) => {
    const url = new URL(input);
    assert.equal(url.origin, 'https://www.googleapis.com'); assert.equal(options.method, 'GET'); assert.equal(options.credentials, 'omit');
    assert.equal(options.headers.Authorization, 'Bearer secret-never-store');
    if (url.pathname.endsWith('/about')) return json({user: {emailAddress: email}});
    if (url.pathname.endsWith('/files/' + settings.folderId)) return json({id: settings.folderId, name: 'Inbox', mimeType: 'application/vnd.google-apps.folder'});
    return handler(url, options);
  };
}

test('Drive authorization verifies account and folder, credentials remain outside persistent data', async () => {
  const client = new DriveInboxClient(settings, {fetch: transport(() => json({files: []}))});
  await client.connect(googleMock()); assert.equal(client.connected, true); assert.equal(client.email, settings.expectedEmail);
  assert.equal(JSON.stringify(client).includes('secret-never-store'), false);
  client.disconnect(); assert.equal(client.connected, false); assert.equal(client.email, '');
  const wrong = new DriveInboxClient(settings, {fetch: transport(() => json({}), {email: 'wrong@example.com'})});
  await assert.rejects(wrong.connect(googleMock()), /Use owner/); assert.equal(wrong.connected, false);
});

test('popup failures, cancellation, denied scopes, and invalid configuration show actionable errors', async () => {
  for (const [options, message] of [[{popup: 'popup_failed_to_open'}, /blocked/], [{popup: 'popup_closed'}, /closed/], [{denied: true}, /declined/]]) {
    const client = new DriveInboxClient(settings, {fetch: transport(() => json({}))});
    await assert.rejects(client.connect(googleMock(options)), message); assert.equal(client.connected, false);
  }
  assert.throws(() => new DriveInboxClient({...settings, folderId: "folder' or true"}), /folder ID/);
  const missing = new DriveInboxClient({...settings, clientId: ''}); await assert.rejects(missing.connect(googleMock()), /client ID/);
});

test('Drive follows empty intermediate pages and keeps all queries restricted to the inbox', async () => {
  const seen = [];
  const client = new DriveInboxClient(settings, {fetch: transport(url => {
    seen.push(url); assert.equal(url.searchParams.get('q'), `'${settings.folderId}' in parents and trashed = false`);
    return json(url.searchParams.get('pageToken') ? {files: [metadata()]} : {files: [], nextPageToken: 'next'});
  })});
  await client.connect(googleMock()); const files = await client.listFiles();
  assert.equal(files.length, 1); assert.equal(seen.length, 2); assert.equal(seen[1].searchParams.get('pageToken'), 'next');
});

test('sync isolates malformed files and imports valid batches, then replay preserves local edits', async () => {
  const db = emptyDatabase(), value = batch(), good = metadata('good1234567890'), bad = metadata('bad1234567890', 'bad.json', 20);
  const client = new DriveInboxClient(settings, {fetch: transport(url => {
    if (url.pathname.endsWith('/files')) return json({files: [bad, good]});
    const file = url.pathname.includes(bad.id) ? bad : good;
    if (!url.searchParams.has('alt')) return json(file);
    return new Response(file.id === bad.id ? '{"broken":' : JSON.stringify(value));
  })});
  await client.connect(googleMock());
  const run = await client.sync({importBatch: (envelope, file) => importInbox(db, envelope, file)});
  assert.deepEqual(run.files.map(file => file.status), ['error', 'imported']); assert.equal(db.archive.shards.length, 1);
  db.archive.shards[0].content = 'Edited on phone';
  const retry = await client.sync({importBatch: (envelope, file) => importInbox(db, envelope, file)});
  assert.equal(retry.files[1].status, 'replayed'); assert.match(retry.files[1].warning, /preserved/); assert.equal(db.archive.shards[0].content, 'Edited on phone');
});

test('Drive rejects moved files, shortcuts, oversize metadata, and duplicate pagination tokens', async () => {
  for (const change of [{parents: ['another-folder']}, {mimeType: 'application/vnd.google-apps.shortcut'}, {size: String(9 * 1024 * 1024)}]) {
    let imported = 0;
    const client = new DriveInboxClient(settings, {fetch: transport(url => json(url.pathname.endsWith('/files') ? {files: [metadata()]} : {...metadata(), ...change}))});
    await client.connect(googleMock()); const result = await client.sync({importBatch: () => {imported++;}});
    assert.equal(imported, 0); assert.equal(result.files[0].status, 'error');
  }
  const repeated = new DriveInboxClient(settings, {fetch: transport(() => json({files: [], nextPageToken: 'same'}))});
  await repeated.connect(googleMock()); await assert.rejects(repeated.listFiles(), /pagination/);
});

test('stream limit cancels oversized content before parsing or committing', async () => {
  let cancelled = false;
  const response = new Response(new ReadableStream({start(controller) {controller.enqueue(new Uint8Array(100));}, cancel() {cancelled = true;}}));
  await assert.rejects(readBoundedText(response, 20), /permitted size/); assert.equal(cancelled, true);
});

test('provider retry timing stops the current sync without automatic retries', async () => {
  let attempts = 0;
  const client = new DriveInboxClient(settings, {fetch: transport(url => {
    if (url.pathname.endsWith('/files')) return json({files: [metadata(), metadata('second1234567890')]});
    attempts++;
    return new Response(JSON.stringify({error: {message: 'Rate limited'}}), {status: 429, headers: {'Retry-After': '120'}});
  })});
  await client.connect(googleMock());
  const run = await client.sync({importBatch: () => assert.fail('must not import')});
  assert.equal(attempts, 1); assert.equal(run.files.length, 1); assert.match(run.stoppedReason, /120 seconds/);
});

test('expired or unauthorized Google session requires reconnect and stops further files', async () => {
  let now = 1000, calls = 0;
  const expired = new DriveInboxClient(settings, {now: () => now, fetch: transport(() => {calls++; return json({files: []});})});
  await expired.connect(googleMock({lifetime: 60})); now += 60_000;
  await assert.rejects(expired.listFiles(), /expired/); assert.equal(calls, 0);
  const client = new DriveInboxClient(settings, {fetch: transport(url => url.pathname.endsWith('/files') ? json({files: [metadata(), metadata('second1234567890')]}) : new Response('', {status: 401}))});
  await client.connect(googleMock()); const result = await client.sync({importBatch: () => assert.fail('must not import')});
  assert.equal(result.files.length, 1); assert.match(result.stoppedReason, /Reconnect/); assert.equal(client.connected, false);
});

test('settings reject credential fields and local status exposes receipts without transport fingerprints', () => {
  const db = emptyDatabase();
  assert.throws(() => handleInbox(db, '/api/drive/settings', 'PUT', {...settings, accessToken: 'secret'}), /only/);
  handleInbox(db, '/api/drive/settings', 'PUT', settings); importInbox(db, batch());
  const status = handleInbox(db, '/api/drive/status', 'GET');
  assert.deepEqual(status.settings, settings); assert.equal(status.receipts.length, 1); assert.equal(Object.hasOwn(status.receipts[0], 'fingerprint'), false);
  assert.equal(validateInboxEnvelope(batch()).requestId, 'capture-1');
});
