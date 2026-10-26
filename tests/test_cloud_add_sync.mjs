// Every record, credential, database, object and HTTP listener in this file is
// disposable. No test request can fall back to the production Site or database.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {readFileSync} from 'node:fs';
import {mkdtemp, realpath, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {isDeepStrictEqual} from 'node:util';
import {DatabaseSync} from 'node:sqlite';
import {IDBFactory} from 'fake-indexeddb';
import {BrowserStore} from '../web-dist/persistence.mjs';
import {BrowserLibrarySync} from '../web-dist/library-sync.mjs';
import {LibraryClient, preparePendingSnapshot} from '../sync/client.mjs';
import {handleLibraryRequest} from '../sync/worker.mjs';
import {handleSiteMcpRequest} from '../hosting/lib/site-mcp.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const GUIDE = readFileSync(new URL('../static/ai-instructions.md', import.meta.url), 'utf8');
const OWNER = 'fixture-owner@example.test';
const CODE = '\n#include <vector>\r\nint fixture_identity(int x) {\r\n\treturn x; // α [[id:literal]]\r\n}\r\n';
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jR7sAAAAASUVORK5CYII=';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(action, description, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {const value = await action(); if (value) return value; await sleep(200);}
  throw new Error('Timed out waiting for isolated fixture: ' + description);
}
const recordMap = archive => Object.fromEntries(['shards', 'links', 'reviews', 'boards', 'assets', 'revisions', 'trash']
  .map(key => [key, Object.fromEntries(archive[key].map(item => [item.id, item]))]));

async function cloud(t) {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('../sync/schema.sql', import.meta.url), 'utf8'));
  const DB = {prepare(sql) {return {bind(...values) {const execute = () => sqlite.prepare(sql).all(...values);
    return {first: async () => execute()[0] || null, all: async () => ({results: execute()}), run: () => ({results: execute()})};}};},
  async batch(statements) {sqlite.exec('BEGIN'); try {const result = statements.map(statement => statement.run()); sqlite.exec('COMMIT'); return result;} catch (error) {sqlite.exec('ROLLBACK'); throw error;}}};
  const objects = new Map(), BUCKET = {async head(key) {const bytes = objects.get(key); return bytes ? {size: bytes.byteLength} : null;},
    async put(key, value) {objects.set(key, new Uint8Array(value));}, async get(key) {const bytes = objects.get(key); return bytes ? {size: bytes.byteLength, body: new Response(bytes).body} : null;}};
  const env = {DB, BUCKET, SHARD_ATLAS_OWNER_PRIVATE: 'true', SHARD_ATLAS_OWNER_EMAIL: OWNER,
    SHARD_ATLAS_GUIDE_RECEIPT_SECRET: 'a'.repeat(64)};
  const controls = {loseAddResponse: false, loseEditResponse: false, nativeOffline: false};
  const cleanups = [];
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, baseUrl), parts = [];
      for await (const part of req) parts.push(part);
      const body = Buffer.concat(parts);
      const headers = {...req.headers, 'oai-authenticated-user-id': 'isolated-fixture-owner', 'oai-authenticated-user-email': OWNER};
      // Interrupt uploads after the native client can inspect its accepted base
      // and persist the exact outbox. This is a loopback failure simulation.
      if (controls.nativeOffline && !['GET', 'HEAD'].includes(req.method) && req.headers['x-shard-atlas-service'] === 'disposable-fixture-service-secret') {
        res.writeHead(503, {'content-type': 'application/json', 'X-Shard-Atlas-Sync': '1'}); res.end(JSON.stringify({error: 'Isolated native transport interrupted.'})); return;
      }
      const request = new Request(url, {method: req.method, headers, ...(!['GET', 'HEAD'].includes(req.method) ? {body} : {})});
      const response = url.pathname === '/mcp'
        ? await handleSiteMcpRequest(request, env, {guideText: GUIDE})
        : await handleLibraryRequest(request, env);
      if (!response) {res.writeHead(404); res.end(); return;}
      const bytes = Buffer.from(await response.arrayBuffer());
      if (controls.loseAddResponse && url.pathname === '/mcp' && JSON.parse(body).params?.name === 'shard_atlas_add_knowledge') {
        controls.loseAddResponse = false; req.socket.destroy(); return;
      }
      if (controls.loseEditResponse && url.pathname === '/mcp' && JSON.parse(body).params?.name === 'shard_atlas_edit_knowledge') {
        controls.loseEditResponse = false; req.socket.destroy(); return;
      }
      res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(bytes);
    } catch {res.writeHead(500); res.end('Isolated fixture request failed.');}
  });
  let baseUrl;
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  baseUrl = 'http://127.0.0.1:' + server.address().port;
  t.after(async () => {for (const cleanup of cleanups.reverse()) await cleanup(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); sqlite.close();});
  const client = new LibraryClient({baseUrl});
  let rpcId = 0;
  async function call(name, args) {
    const response = await fetch(baseUrl + '/mcp', {method: 'POST', headers: {'content-type': 'application/json', Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': 'tools/call', 'Mcp-Name': name},
    body: JSON.stringify({jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: {name, arguments: args,
      _meta: {'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {}}}})});
    assert.equal(response.status, 200);
    const message = await response.json(); assert.equal(message.error, undefined);
    return message.result;
  }
  async function current() {const head = await client.head(); return {head, capsule: head.commit ? await client.download(head.commit) : null};}
  return {env, sqlite, client, baseUrl, controls, call, current, cleanup: action => cleanups.push(action)};
}

async function nativePeer(t, service) {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'atlas-cloud-add-')));
  await writeFile(path.join(directory, '.shard-atlas-cloud-add-fixture'), 'Shard Atlas isolated cloud-add test fixture\n');
  const child = spawn(process.env.SHARD_ATLAS_TEST_PYTHON || 'python3', [path.join(ROOT, 'tests/fixtures/native_sync_peer.py'), '--root', directory, '--cloud-url', service.baseUrl],
    {cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe']});
  let stderr = '', stdout = '';
  child.stderr.on('data', chunk => {stderr = (stderr + chunk).slice(-4000);});
  const ready = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Isolated native peer did not start. ' + stderr)), 15_000);
    child.stdout.on('data', chunk => {stdout += chunk; const line = stdout.split('\n')[0]; try {const value = JSON.parse(line); if (value.isolated) {clearTimeout(timeout); resolve(value);}} catch {}});
    child.once('error', error => {clearTimeout(timeout); reject(error);});
    child.once('exit', code => {clearTimeout(timeout); reject(new Error('Isolated native peer exited (' + code + '). ' + stderr));});
  });
  service.cleanup(async () => {
    if (child.exitCode === null) {
      let timeout;
      child.kill('SIGTERM');
      await Promise.race([new Promise(resolve => child.once('exit', resolve)), new Promise(resolve => {timeout = setTimeout(resolve, 5000);})]);
      clearTimeout(timeout);
    }
    if (child.exitCode === null) {child.kill('SIGKILL'); await new Promise(resolve => child.once('exit', resolve));}
    await rm(directory, {recursive: true, force: true});
  });
  const {url, database} = await ready;
  assert.ok(database.startsWith(directory + path.sep)); assert.match(url, /^http:\/\/127\.0\.0\.1:\d+$/);
  async function request(route, method = 'GET', body) {
    const response = await fetch(url + route, {method, headers: {'content-type': 'application/json'}, signal: AbortSignal.timeout(5000), ...(body === undefined ? {} : {body: JSON.stringify(body)})});
    const value = await response.json(); assert.ok(response.ok, 'Isolated native request failed: ' + JSON.stringify(value)); return value;
  }
  return {request, directory};
}

async function browserPeer(t, service, {canApplyRemote = () => true} = {}) {
  const store = new BrowserStore(new IDBFactory()), sync = new BrowserLibrarySync(store, {client: service.client, canApplyRemote, pollMs: 15_000});
  service.cleanup(async () => {sync.stop(); (await store.ready).close();});
  return {store, sync, read: async () => (await store.atomic(value => value, {readonly: true})).database};
}
async function guide(service) {
  const result = await service.call('shard_atlas_get_instructions', {});
  assert.equal(result.isError, false);
  const data = result.structuredContent;
  assert.equal(data.content, GUIDE); assert.match(data.version, /^[a-f0-9]{64}$/); assert.equal(typeof data.readReceipt, 'string');
  return {instructionsVersion: data.version, instructionsReceipt: data.readReceipt};
}
function addition(requestId, id, helperId) {
  return {requestId, shards: [{id, title: 'Isolated MCP fixture ' + id, content: 'Synthetic transport fixture. The C++ fragment is illustrative and untested.',
    tags: ['QA fixture', 'C++'], kind: 'concept', status: 'learning', languageVersion: 'C++98 baseline',
    codeSolution: {role: 'problem', approaches: [{id: id + '-approach', title: 'Exact code fixture', code: CODE}]}}],
    links: helperId ? [{id: id + '-uses', fromId: id, toId: helperId, type: 'uses', fromApproachId: id + '-approach',
      toApproachId: 'baseline-approach', note: 'This synthetic approach uses the baseline helper.', scope: 'Isolated fixture only', evidence: 'Exercises stable approach endpoints.'}] : []};
}

test('direct MCP cloud additions automatically reach isolated native/browser peers with safe retries, stale checks and protected drafts', {timeout: 120_000}, async t => {
  const service = await cloud(t), native = await nativePeer(t, service);
  await until(async () => (await native.request('/api/library-sync/status')).status === 'synced', 'empty native pairing');
  const asset = await native.request('/api/assets', 'POST', {name: 'Fixture pixel', mimeType: 'image/png', data: PNG});
  const state = await native.request('/api/shards', 'POST', {title: 'Isolated baseline helper', content: `Synthetic helper with retained image ![fixture](/assets/${asset.id})`, tags: ['QA fixture', 'C++'],
    codeSolution: {role: 'snippet', approaches: [{id: 'baseline-approach', title: 'Baseline variant', code: CODE}]}});
  const helper = state.shards.find(item => item.title === 'Isolated baseline helper');
  await native.request('/api/reviews', 'POST', {shardId: helper.id, grade: 'good'});
  await native.request('/api/boards', 'POST', {title: 'Legacy fixture board', items: [{shardId: helper.id, x: 1, y: 2}]});
  const beforeDelete = await native.request('/api/shards', 'POST', {title: 'Deleted fixture', content: 'Retained in Trash.', tags: []});
  await native.request('/api/shards/' + beforeDelete.shards.find(item => item.title === 'Deleted fixture').id, 'DELETE', {});
  const baseline = await native.request('/api/export');
  await until(async () => {const current = await service.current(); return current.capsule && isDeepStrictEqual(recordMap(current.capsule.archive), recordMap(baseline));}, 'native baseline automatic publication');
  let canApply = true;
  const browser = await browserPeer(t, service, {canApplyRemote: () => canApply}); browser.sync.start();
  await until(async () => (await browser.read()).archive.shards.some(item => item.id === helper.id), 'browser initial automatic pull');
  const first = await service.current(), authorization = await guide(service);
  const args = {...authorization, expectedRevision: first.head.revision, batch: addition('m3-integration-first', 'm3-first', helper.id)};
  service.controls.loseAddResponse = true;
  await assert.rejects(() => service.call('shard_atlas_add_knowledge', args));
  const afterLost = await service.current(); assert.notEqual(afterLost.head.revision, first.head.revision);
  const countBeforeRetry = service.sqlite.prepare('SELECT count(*) AS count FROM library_commits').get().count;
  const retry = await service.call('shard_atlas_add_knowledge', args);
  assert.equal(retry.isError, false); assert.equal(retry.structuredContent.replayed, true); assert.equal(retry.structuredContent.verified, true);
  assert.equal(service.sqlite.prepare('SELECT count(*) AS count FROM library_commits').get().count, countBeforeRetry);
  const accepted = await service.current();
  assert.equal(accepted.capsule.archive.shards.filter(item => item.id === 'm3-first').length, 1);
  for (const [kind, records] of Object.entries(recordMap(baseline))) {
    const saved = recordMap(accepted.capsule.archive)[kind];
    for (const [id, record] of Object.entries(records)) assert.deepEqual(saved[id], record, 'An existing synthetic portable record changed during direct addition.');
  }
  try {
    await until(async () => (await native.request('/api/export')).shards.some(item => item.id === 'm3-first') && (await browser.read()).archive.shards.some(item => item.id === 'm3-first'), 'MCP addition automatic device pulls');
  } catch (error) {
    error.message += ' ' + JSON.stringify({native: await native.request('/api/library-sync/status'), browser: await browser.sync.status(),
      nativeIds: (await native.request('/api/export')).shards.map(item => item.id), browserIds: (await browser.read()).archive.shards.map(item => item.id)});
    throw error;
  }
  assert.deepEqual(recordMap(await native.request('/api/export')), recordMap(accepted.capsule.archive));
  assert.deepEqual(recordMap((await browser.read()).archive), recordMap(accepted.capsule.archive));
  assert.equal((await native.request('/api/export')).shards.find(item => item.id === 'm3-first').codeSolution.approaches[0].code, CODE);
  const stale = await service.call('shard_atlas_add_knowledge', {...authorization, expectedRevision: first.head.revision, batch: addition('m3-stale-request', 'm3-stale', helper.id)});
  assert.equal(stale.isError, true); assert.equal(stale.structuredContent.error.code, 'cloud_library_changed');
  assert.equal((await service.current()).head.revision, accepted.head.revision);

  const draft = {values: {title: 'Unfinished isolated draft', content: 'Must survive incoming saved notes.'}, updatedAt: '2026-10-25T00:00:00Z'};
  await native.request('/api/drafts/editor', 'PUT', {draft});
  await browser.store.request('/api/drafts/editor', 'PUT', {draft});
  canApply = false; await browser.sync.markEditing(true);
  await native.request('/api/library-sync/editing', 'POST', {editing: true, clientId: 'isolated-editor'});
  const guarded = await service.call('shard_atlas_add_knowledge', {...authorization, expectedRevision: accepted.head.revision, batch: addition('m3-guarded-request', 'm3-guarded', helper.id)});
  assert.equal(guarded.isError, false); browser.sync.schedule();
  await until(async () => (await native.request('/api/library-sync/status')).incomingAvailable === true && (await browser.sync.status()).incomingAvailable === true, 'incoming data observed behind editor guards', 20_000);
  assert.equal((await native.request('/api/export')).shards.some(item => item.id === 'm3-guarded'), false);
  assert.equal((await browser.read()).archive.shards.some(item => item.id === 'm3-guarded'), false);
  await native.request('/api/library-sync/editing', 'POST', {editing: false, clientId: 'isolated-editor'});
  canApply = true; await browser.sync.markEditing(false); browser.sync.schedule();
  await until(async () => (await native.request('/api/export')).shards.some(item => item.id === 'm3-guarded') && (await browser.read()).archive.shards.some(item => item.id === 'm3-guarded'), 'guarded automatic pulls after finishing edits');
  assert.deepEqual((await native.request('/api/drafts')).drafts.editor, draft);
  assert.deepEqual((await browser.read()).drafts.editor, draft);

  service.controls.nativeOffline = true;
  await native.request('/api/shards/' + helper.id, 'PUT', {content: 'An offline native edit must remain recoverable.'});
  await until(async () => {const status = await native.request('/api/library-sync/status'); return status.pending && status.status === 'offline';}, 'durable native outbox while transport is interrupted', 20_000);
  const beforeConflict = await service.current();
  const remote = await service.call('shard_atlas_add_knowledge', {...authorization, expectedRevision: beforeConflict.head.revision, batch: addition('m3-concurrent-request', 'm3-concurrent', helper.id)});
  assert.equal(remote.isError, false);
  service.controls.nativeOffline = false;
  await until(async () => (await native.request('/api/library-sync/status')).status === 'conflict', 'offline native pending copy retained as a conflict', 20_000);
  const conflicted = await native.request('/api/export');
  assert.equal(conflicted.shards.find(item => item.id === helper.id).content, 'An offline native edit must remain recoverable.');
  const final = await service.current();
  assert.equal(final.capsule.archive.shards.find(item => item.id === helper.id).content, baseline.shards.find(item => item.id === helper.id).content);
  assert.ok(final.capsule.archive.shards.some(item => item.id === 'm3-concurrent'));
  const conflicts = await service.client.conflicts(); assert.ok(conflicts.items.length >= 1);
  const savedConflict = await service.client.download(await service.client.commit(conflicts.items[0].id));
  assert.equal(savedConflict.archive.shards.find(item => item.id === helper.id).content, 'An offline native edit must remain recoverable.');
});

test('direct cloud additions preserve unknown portable extensions through browser receipt and pull', {timeout: 30_000}, async t => {
  const service = await cloud(t), peer = await browserPeer(t, service);
  await peer.store.request('/api/shards', 'POST', {title: 'Existing synthetic extension', content: 'Preserve original fields.', tags: ['QA fixture']});
  const original = await peer.read();
  original.archive.shards[0].futureExtension = {keep: 'exact synthetic extension'};
  const capsule = {format: 'shard-atlas-library', version: 1, archive: original.archive, contributionReceipts: [], futureCapsuleExtension: {keep: true}};
  await service.client.publish(await preparePendingSnapshot(capsule, '', 'm3-extension-seed'));
  const authorization = await guide(service), head = await service.client.head();
  const result = await service.call('shard_atlas_add_knowledge', {...authorization, expectedRevision: head.revision, batch: addition('m3-extension-request', 'm3-extension-added')});
  assert.equal(result.isError, false);
  const current = await service.current();
  assert.deepEqual(current.capsule.archive.shards[0].futureExtension, {keep: 'exact synthetic extension'});
  assert.deepEqual(current.capsule.futureCapsuleExtension, {keep: true});
  const receiving = await browserPeer(t, service); receiving.sync.start();
  await until(async () => (await receiving.read()).archive.shards.some(item => item.id === 'm3-extension-added'), 'browser receives exact preserved extensions');
  assert.deepEqual((await receiving.read()).archive.shards[0].futureExtension, {keep: 'exact synthetic extension'});
});

const EDIT_CODE = '\n#include <vector>\r\nint fixture_identity(int x) {\r\n\treturn x + 1; // β [[id:literal]]\r\n}\r\n';
const APPENDED_CODE = '\nint fixture_alternative(int x) {\r\n\treturn x; // synthetic and untested\r\n}\r\n';
const shardWithId = (archive, id) => archive.shards.find(item => item.id === id);
const linkWithId = (archive, id) => archive.links.find(item => item.id === id);
const editBatch = (requestId, shardId, changes, links = []) => ({requestId, shards: [{id: shardId, changes}], links});

async function editPeers(t) {
  const service = await cloud(t), native = await nativePeer(t, service);
  await until(async () => (await native.request('/api/library-sync/status')).status === 'synced', 'empty edit fixture pairing');
  const asset = await native.request('/api/assets', 'POST', {name: 'Preserved edit fixture pixel', mimeType: 'image/png', data: PNG});
  const first = await native.request('/api/shards', 'POST', {title: 'M4 isolated edit target', content: `Synthetic original with image ![fixture](/assets/${asset.id})`, tags: ['QA fixture', 'Original topic'],
    codeSolution: {role: 'problem', purpose: 'Preserve omitted solution details.', approaches: [
      {id: 'm4-primary', title: 'Original primary', summary: 'Original primary summary.', code: CODE},
      {id: 'm4-secondary', title: 'Original secondary', summary: 'Original secondary summary.', code: APPENDED_CODE}]}});
  const target = first.shards.find(item => item.title === 'M4 isolated edit target');
  const second = await native.request('/api/shards', 'POST', {title: 'M4 isolated related helper', content: 'An unrelated note must remain unchanged.', tags: ['QA fixture'],
    codeSolution: {role: 'snippet', approaches: [{id: 'm4-helper', title: 'Helper', code: CODE}]}});
  const helper = second.shards.find(item => item.title === 'M4 isolated related helper');
  const linked = await native.request('/api/links', 'POST', {fromId: target.id, toId: helper.id, type: 'uses', fromApproachId: 'm4-primary', toApproachId: 'm4-helper',
    note: 'Original typed approach relationship.', scope: 'Synthetic fixture only', evidence: 'Original relationship evidence.'});
  const link = linked.links.find(item => item.fromId === target.id && item.toId === helper.id);
  await native.request('/api/reviews', 'POST', {shardId: target.id, grade: 'good'});
  await native.request('/api/boards', 'POST', {title: 'M4 retained board', items: [{shardId: target.id, x: 3, y: 4}]});
  const deleted = await native.request('/api/shards', 'POST', {title: 'M4 retained Trash fixture', content: 'Keep this recovery record.', tags: []});
  await native.request('/api/shards/' + deleted.shards.find(item => item.title === 'M4 retained Trash fixture').id, 'DELETE', {});
  const baseline = await native.request('/api/export');
  await until(async () => {const value = await service.current(); return value.capsule && isDeepStrictEqual(recordMap(value.capsule.archive), recordMap(baseline));}, 'rich edit fixture automatic publication');
  let canApply = true;
  const browser = await browserPeer(t, service, {canApplyRemote: () => canApply}); browser.sync.start();
  await until(async () => shardWithId((await browser.read()).archive, target.id), 'edit fixture browser initial automatic pull');
  return {service, native, browser, target: shardWithId(baseline, target.id), helper: shardWithId(baseline, helper.id),
    link: linkWithId(baseline, link.id), baseline, setCanApply(value) {canApply = value;}};
}

test('direct MCP shard and typed-link edits preserve history and automatically arrive with exact code and safe lost-response replay', {timeout: 120_000}, async t => {
  const {service, native, browser, target, link, baseline} = await editPeers(t);
  const authorization = await guide(service), first = await service.current();
  const batch = editBatch('m4-first-edit', target.id, {
    content: 'A corrected synthetic explanation. Example code remains explicitly untested.', tags: ['QA fixture', 'Edited topic'],
    codeSolution: {approaches: [{id: 'm4-secondary', summary: 'A partial update keeps the original code and title.'},
      {id: 'm4-primary', code: EDIT_CODE}, {id: 'm4-appended', title: 'Appended alternative', code: APPENDED_CODE}]},
  }, [{id: link.id, changes: {note: 'Corrected typed relationship.', evidence: 'Updated synthetic evidence.'}}]);
  const args = {...authorization, expectedRevision: first.head.revision, batch};
  service.controls.loseEditResponse = true;
  await assert.rejects(() => service.call('shard_atlas_edit_knowledge', args));
  const accepted = await service.current();
  assert.notEqual(accepted.head.revision, first.head.revision);
  const commits = service.sqlite.prepare('SELECT count(*) AS count FROM library_commits').get().count;
  const replay = await service.call('shard_atlas_edit_knowledge', args);
  assert.equal(replay.isError, false); assert.equal(replay.structuredContent.operation, 'edit');
  assert.equal(replay.structuredContent.replayed, true); assert.equal(replay.structuredContent.verified, true);
  assert.equal(replay.structuredContent.currentContentMatches, true);
  assert.deepEqual(replay.structuredContent.edited, {shards: 1, links: 1});
  assert.equal(service.sqlite.prepare('SELECT count(*) AS count FROM library_commits').get().count, commits);
  assert.deepEqual((await service.current()).capsule.archive.revisions, accepted.capsule.archive.revisions);

  const saved = shardWithId(accepted.capsule.archive, target.id), savedLink = linkWithId(accepted.capsule.archive, link.id);
  assert.equal(saved.title, target.title); assert.equal(saved.createdAt, target.createdAt);
  assert.deepEqual(saved.tags, ['QA fixture', 'Edited topic']);
  assert.equal(saved.codeSolution.purpose, target.codeSolution.purpose);
  assert.deepEqual(saved.codeSolution.approaches.map(item => item.id), ['m4-primary', 'm4-secondary', 'm4-appended']);
  assert.equal(saved.codeSolution.approaches[0].code, EDIT_CODE);
  assert.equal(saved.codeSolution.approaches[0].title, 'Original primary');
  assert.equal(saved.codeSolution.approaches[1].code, APPENDED_CODE);
  assert.equal(saved.codeSolution.approaches[1].title, 'Original secondary');
  assert.equal(saved.codeSolution.approaches[2].code, APPENDED_CODE);
  assert.equal(savedLink.fromApproachId, 'm4-primary'); assert.equal(savedLink.toApproachId, 'm4-helper');
  assert.equal(savedLink.fromId, target.id); assert.equal(savedLink.toId, link.toId); assert.equal(savedLink.type, 'uses');
  const newHistory = accepted.capsule.archive.revisions.filter(item => !baseline.revisions.some(old => old.id === item.id));
  assert.equal(newHistory.length, 2);
  assert.ok(newHistory.some(item => isDeepStrictEqual(item.snapshot, target)), 'The exact pre-edit shard must be recoverable.');
  assert.ok(newHistory.some(item => isDeepStrictEqual(item.snapshot, saved)), 'The exact accepted edit must be in shard history.');
  const portableReceipt = accepted.capsule.contributionReceipts.find(item => item.requestId === batch.requestId);
  assert.equal(portableReceipt.operation, 'edit');
  assert.ok(portableReceipt.beforeRecords.every(item => item.kind === 'links'));
  assert.ok(portableReceipt.beforeRecords.some(item => item.kind === 'links' && item.id === link.id && isDeepStrictEqual(item.record, link)));
  const revisionPointers = replay.structuredContent.shardRevisions.find(item => item.id === target.id);
  assert.deepEqual(portableReceipt.receipt.shardRevisions, replay.structuredContent.shardRevisions);
  assert.deepEqual(accepted.capsule.archive.revisions.find(item => item.id === revisionPointers.beforeRevisionId)?.snapshot, target);
  assert.deepEqual(accepted.capsule.archive.revisions.find(item => item.id === revisionPointers.afterRevisionId)?.snapshot, saved);
  const oldCommit = await service.client.download(await service.client.commit(first.head.revision));
  assert.deepEqual(linkWithId(oldCommit.archive, link.id), link);
  for (const [kind, records] of Object.entries(recordMap(baseline))) {
    const next = recordMap(accepted.capsule.archive)[kind];
    for (const [id, record] of Object.entries(records)) if (!(kind === 'shards' && id === target.id || kind === 'links' && id === link.id)) assert.deepEqual(next[id], record, 'An unrelated portable record changed during an edit.');
  }
  await until(async () => shardWithId(await native.request('/api/export'), target.id)?.content === saved.content
    && shardWithId((await browser.read()).archive, target.id)?.content === saved.content, 'MCP edits automatic native/browser arrival');
  assert.deepEqual(recordMap(await native.request('/api/export')), recordMap(accepted.capsule.archive));
  assert.deepEqual(recordMap((await browser.read()).archive), recordMap(accepted.capsule.archive));

  browser.sync.stop();
  const later = await service.call('shard_atlas_edit_knowledge', {...authorization, expectedRevision: accepted.head.revision,
    batch: editBatch('m4-later-edit', target.id, {content: 'A later accepted edit must never be undone by retrying an earlier request.'})});
  assert.equal(later.isError, false);
  const current = await service.current();
  assert.equal(shardWithId((await browser.read()).archive, target.id).content, saved.content);
  browser.sync.start();
  await until(async () => shardWithId((await browser.read()).archive, target.id)?.content === shardWithId(current.capsule.archive, target.id).content, 'reopened browser automatically catches up');
  const oldReplay = await service.call('shard_atlas_edit_knowledge', args);
  assert.equal(oldReplay.isError, false); assert.equal(oldReplay.structuredContent.replayed, true);
  assert.equal(oldReplay.structuredContent.currentContentMatches, false);
  assert.ok(oldReplay.structuredContent.changedShardIds.includes(target.id));
  assert.equal((await service.current()).head.revision, current.head.revision);
  assert.equal(shardWithId((await service.current()).capsule.archive, target.id).content, shardWithId(current.capsule.archive, target.id).content);
  const reused = await service.call('shard_atlas_edit_knowledge', {...args, batch: {...batch, shards: [{id: target.id, changes: {title: 'Changed request payload'}}]}});
  assert.equal(reused.isError, true); assert.equal(reused.structuredContent.error.code, 'request_id_reused');
  const stale = await service.call('shard_atlas_edit_knowledge', {...authorization, expectedRevision: first.head.revision,
    batch: editBatch('m4-stale-edit', target.id, {content: 'Must not replace a newer cloud edit.'})});
  assert.equal(stale.isError, true); assert.equal(stale.structuredContent.error.code, 'cloud_library_changed');
  assert.equal((await service.current()).head.revision, current.head.revision);
  const parallelContent = ['Concurrent correction A.', 'Concurrent correction B.'];
  const parallel = await Promise.all(parallelContent.map((content, index) => service.call('shard_atlas_edit_knowledge', {
    ...authorization, expectedRevision: current.head.revision, batch: editBatch('m4-concurrent-edit-' + index, target.id, {content}),
  })));
  const winner = parallel.findIndex(result => result.isError === false);
  assert.notEqual(winner, -1); assert.equal(parallel.filter(result => result.isError === false).length, 1);
  assert.ok(['cloud_library_changed', 'request_conflicted'].includes(parallel[1 - winner].structuredContent.error.code));
  assert.equal(shardWithId((await service.current()).capsule.archive, target.id).content, parallelContent[winner]);
});

test('direct edits wait behind native/browser drafts and retain overlapping offline native edits for conflict review', {timeout: 120_000}, async t => {
  const {service, native, browser, target, link, setCanApply} = await editPeers(t);
  const authorization = await guide(service), initial = await service.current();
  const draft = {values: {title: 'M4 unfinished draft', content: 'Preserve this local editor text.'}, updatedAt: '2026-10-25T00:00:00Z'};
  const connectionDraft = {values: {fromId: target.id, toId: link.toId, note: 'Preserve this unfinished relationship.'}, updatedAt: '2026-10-25T00:00:00Z'};
  await native.request('/api/drafts/editor', 'PUT', {draft}); await browser.store.request('/api/drafts/editor', 'PUT', {draft});
  await native.request('/api/drafts/connection', 'PUT', {draft: connectionDraft}); await browser.store.request('/api/drafts/connection', 'PUT', {draft: connectionDraft});
  setCanApply(false); await browser.sync.markEditing(true);
  await native.request('/api/library-sync/editing', 'POST', {editing: true, clientId: 'isolated-edit-editor'});
  const guarded = await service.call('shard_atlas_edit_knowledge', {...authorization, expectedRevision: initial.head.revision,
    batch: editBatch('m4-guarded-edit', target.id, {content: 'Cloud edit waiting behind a local draft.'}, [{id: link.id, changes: {note: 'Guarded cloud link correction.'}}])});
  assert.equal(guarded.isError, false); browser.sync.schedule();
  await until(async () => (await native.request('/api/library-sync/status')).incomingAvailable === true
    && (await browser.sync.status()).incomingAvailable === true, 'edited cloud data observed behind both draft guards', 20_000);
  assert.equal(shardWithId(await native.request('/api/export'), target.id).content, target.content);
  assert.equal(shardWithId((await browser.read()).archive, target.id).content, target.content);
  assert.deepEqual((await native.request('/api/drafts')).drafts.editor, draft); assert.deepEqual((await browser.read()).drafts.editor, draft);
  assert.deepEqual((await native.request('/api/drafts')).drafts.connection, connectionDraft); assert.deepEqual((await browser.read()).drafts.connection, connectionDraft);
  await native.request('/api/library-sync/editing', 'POST', {editing: false, clientId: 'isolated-edit-editor'});
  setCanApply(true); await browser.sync.markEditing(false); browser.sync.schedule();
  const guardedCloud = await service.current();
  await until(async () => shardWithId(await native.request('/api/export'), target.id).content === 'Cloud edit waiting behind a local draft.'
    && shardWithId((await browser.read()).archive, target.id).content === 'Cloud edit waiting behind a local draft.', 'guarded edits automatically arrive after editor finishes');
  assert.deepEqual(recordMap(await native.request('/api/export')), recordMap(guardedCloud.capsule.archive));
  assert.deepEqual(recordMap((await browser.read()).archive), recordMap(guardedCloud.capsule.archive));
  assert.deepEqual((await native.request('/api/drafts')).drafts.editor, draft); assert.deepEqual((await browser.read()).drafts.editor, draft);
  assert.deepEqual((await native.request('/api/drafts')).drafts.connection, connectionDraft); assert.deepEqual((await browser.read()).drafts.connection, connectionDraft);

  service.controls.nativeOffline = true;
  await native.request('/api/shards/' + target.id, 'PUT', {content: 'An overlapping offline native edit must stay recoverable.'});
  await until(async () => {const status = await native.request('/api/library-sync/status'); return status.pending && status.status === 'offline';}, 'durable overlapping native outbox', 20_000);
  const beforeRemote = await service.current();
  const remote = await service.call('shard_atlas_edit_knowledge', {...authorization, expectedRevision: beforeRemote.head.revision,
    batch: editBatch('m4-overlapping-cloud-edit', target.id, {content: 'The accepted overlapping cloud edit must remain current.'})});
  assert.equal(remote.isError, false); service.controls.nativeOffline = false;
  await until(async () => (await native.request('/api/library-sync/status')).status === 'conflict', 'overlapping local edit retained for conflict review', 20_000);
  assert.equal(shardWithId(await native.request('/api/export'), target.id).content, 'An overlapping offline native edit must stay recoverable.');
  const final = await service.current();
  assert.equal(shardWithId(final.capsule.archive, target.id).content, 'The accepted overlapping cloud edit must remain current.');
  const conflicts = await service.client.conflicts(); assert.ok(conflicts.items.length >= 1);
  const savedConflict = await service.client.download(await service.client.commit(conflicts.items[0].id));
  assert.equal(shardWithId(savedConflict.archive, target.id).content, 'An overlapping offline native edit must stay recoverable.');
  assert.equal(shardWithId(savedConflict.archive, target.id).codeSolution.approaches[0].code, CODE);
  assert.ok(final.capsule.archive.revisions.some(item => item.snapshot?.content === 'Cloud edit waiting behind a local draft.'));
  assert.deepEqual((await browser.read()).drafts.editor, draft);
  assert.deepEqual((await browser.read()).drafts.connection, connectionDraft);
});

test('direct edits retain unknown cloud/browser extensions and empty approach patches leave saved approaches intact', {timeout: 30_000}, async t => {
  const service = await cloud(t), peer = await browserPeer(t, service);
  await peer.store.request('/api/shards', 'POST', {title: 'M4 extension fixture', content: 'Original synthetic note.', tags: ['Keep until explicitly replaced'],
    codeSolution: {role: 'problem', approaches: [{id: 'm4-extension-approach', title: 'Retained approach', code: CODE}]}});
  const original = await peer.read(), target = original.archive.shards[0];
  shardWithId(original.archive, target.id).futureExtension = {keep: ['exact', 'synthetic', 'values']};
  original.archive.futureArchiveExtension = {keep: true};
  await service.client.publish(await preparePendingSnapshot({format: 'shard-atlas-library', version: 1, archive: original.archive,
    contributionReceipts: [], futureCapsuleExtension: {keep: 'exact'}}, '', 'm4-extension-seed'));
  const authorization = await guide(service), head = await service.client.head();
  const result = await service.call('shard_atlas_edit_knowledge', {...authorization, expectedRevision: head.revision,
    batch: editBatch('m4-extension-edit', target.id, {content: 'A sparse correction preserves unrelated future data.', tags: [], codeSolution: {approaches: []}})});
  assert.equal(result.isError, false);
  const current = await service.current(), saved = shardWithId(current.capsule.archive, target.id);
  assert.deepEqual(saved.tags, []); assert.deepEqual(saved.codeSolution.approaches, target.codeSolution.approaches);
  assert.deepEqual(saved.futureExtension, {keep: ['exact', 'synthetic', 'values']});
  assert.deepEqual(current.capsule.archive.futureArchiveExtension, {keep: true}); assert.deepEqual(current.capsule.futureCapsuleExtension, {keep: 'exact'});
  const receiving = await browserPeer(t, service); receiving.sync.start();
  await until(async () => shardWithId((await receiving.read()).archive, target.id)?.content === saved.content, 'browser receives sparse edit and preserved extensions');
  assert.deepEqual((await receiving.read()).archive, current.capsule.archive);
  const historyLength = current.capsule.archive.revisions.length;
  const noChange = await service.call('shard_atlas_edit_knowledge', {...authorization, expectedRevision: current.head.revision,
    batch: editBatch('m4-approaches-noop', target.id, {codeSolution: {approaches: []}})});
  assert.equal(noChange.isError, false); assert.deepEqual(noChange.structuredContent.unchanged, {shards: 1, links: 0});
  const after = await service.current();
  assert.deepEqual(shardWithId(after.capsule.archive, target.id), saved);
  assert.equal(after.capsule.archive.revisions.length, historyLength);
});
