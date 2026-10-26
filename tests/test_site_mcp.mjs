import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {handleSiteMcpRequest} from '../hosting/lib/site-mcp.mjs';

const OWNER = 'owner@example.test';
const identity = {'oai-authenticated-user-id': 'site-scoped-owner', 'oai-authenticated-user-email': OWNER};
const env = (values = {}) => {
  const value = {SHARD_ATLAS_OWNER_PRIVATE: 'true', SHARD_ATLAS_OWNER_EMAIL: OWNER, ...values};
  for (const key of ['DB', 'BUCKET']) Object.defineProperty(value, key, {get() {throw new Error(`Connection tests must not access ${key}`);}});
  return value;
};
function request(message, {headers = {}, authenticated = true, method = 'POST', path = '/mcp'} = {}) {
  return new Request('https://atlas.example.test' + path, {method, headers: {'content-type': 'application/json', ...(authenticated ? identity : {}), ...headers},
    ...(['GET', 'HEAD'].includes(method) ? {} : {body: typeof message === 'string' ? message : JSON.stringify(message)})});
}
const rpc = (method, params = {}, id = 1) => ({jsonrpc: '2.0', id, method, params});
async function invoke(message, options, configuration = env(), dependencies) {
  const response = await handleSiteMcpRequest(request(message, options), configuration, dependencies);
  assert.equal(response.headers.get('cache-control'), 'no-store, private');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  return {response, data: response.status === 202 ? null : await response.json()};
}

test('unrelated paths are left to the existing application without inspecting identity or storage', async () => {
  assert.equal(await handleSiteMcpRequest(request(rpc('tools/list'), {path: '/api/library/head', authenticated: false}), new Proxy({}, {get() {throw new Error('Unrelated route must pass through');}})), null);
  assert.equal(await handleSiteMcpRequest(request(rpc('tools/list'), {path: '/mcp/other'}), env()), null);
});

test('private MCP fails closed without owner configuration, identity, or the matching owner email', async () => {
  for (const configuration of [env({SHARD_ATLAS_OWNER_PRIVATE: undefined}), env({SHARD_ATLAS_OWNER_PRIVATE: 'false'}), env({SHARD_ATLAS_OWNER_EMAIL: ''}), env({SHARD_ATLAS_OWNER_EMAIL: undefined})]) {
    assert.equal((await invoke(rpc('tools/list'), {}, configuration)).response.status, 503);
  }
  for (const headers of [{}, {'oai-authenticated-user-id': 'owner'}, {'oai-authenticated-user-email': OWNER}, {'oai-authenticated-user-id': ' ', 'oai-authenticated-user-email': OWNER}, {'OAI-Sites-Authorization': 'Bearer service-only', 'X-Shard-Atlas-Service': 'service-only'}]) {
    assert.equal((await invoke(rpc('tools/list'), {authenticated: false, headers})).response.status, 401);
  }
  assert.equal((await invoke(rpc('tools/list'), {headers: {'oai-authenticated-user-email': 'different@example.test'}})).response.status, 403);
  assert.equal((await invoke({...rpc('tools/list'), owner: OWNER}, {authenticated: false})).response.status, 401);
});

test('discovery and the tool list need no library protocol header or storage bindings', async () => {
  const discovery = await invoke(rpc('server/discover'));
  assert.deepEqual(discovery.data, {jsonrpc: '2.0', id: 1, result: {supportedVersions: ['2026-07-28'], capabilities: {tools: {}}, ttlMs: 0, cacheScope: 'private', resultType: 'complete'}});
  const listing = await invoke(rpc('tools/list'), {headers: {'oai-authenticated-user-email': OWNER.toUpperCase(), Origin: 'https://chatgpt.com'}});
  assert.equal(listing.data.result.tools.length, 6);
  assert.deepEqual(listing.data.result.tools.map(tool => tool.name), ['shard_atlas_connection_test', 'shard_atlas_search', 'shard_atlas_read', 'shard_atlas_get_instructions', 'shard_atlas_add_knowledge', 'shard_atlas_edit_knowledge']);
  for (const listed of listing.data.result.tools) assert.deepEqual(listed.annotations, {readOnlyHint: !['shard_atlas_add_knowledge', 'shard_atlas_edit_knowledge'].includes(listed.name), destructiveHint: listed.name === 'shard_atlas_edit_knowledge', idempotentHint: true, openWorldHint: false});
  assert.equal(listing.data.result.ttlMs, 0); assert.equal(listing.data.result.cacheScope, 'private');
  const tool = listing.data.result.tools[0];
  assert.equal(tool.name, 'shard_atlas_connection_test');
  assert.deepEqual(tool.inputSchema, {type: 'object', properties: {}, additionalProperties: false});
  assert.deepEqual(tool.annotations, {readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false});
});

test('MCP validates every supplied origin while supporting Sites and ChatGPT transport', async () => {
  for (const origin of ['https://atlas.example.test', 'https://chatgpt.com', 'https://chat.openai.com']) {
    const result = await invoke(rpc('tools/list'), {headers: {Origin: origin}});
    assert.equal(result.response.status, 200);
    assert.equal(result.data.result.tools.length, 6);
  }
  for (const origin of ['null', 'not an origin', 'https://other.example.test', 'https://chatgpt.com.evil.example', 'https://chatgpt.com/', 'https://chatgpt.com https://other.example.test', 'https://user:password@chatgpt.com']) {
    assert.equal((await invoke(rpc('tools/list'), {headers: {Origin: origin}})).response.status, 403);
    assert.equal((await invoke(rpc('tools/list'), {authenticated: false, headers: {Origin: origin}})).response.status, 403);
  }
});

test('connection calls return fixed success without personal data, library reads, or writes', async () => {
  const a = await invoke(rpc('tools/call', {name: 'shard_atlas_connection_test', arguments: {}}));
  const b = await invoke(rpc('tools/call', {name: 'shard_atlas_connection_test'}));
  assert.deepEqual(a.data, b.data);
  assert.equal(a.data.result.isError, false);
  assert.equal(a.data.result.resultType, 'complete');
  assert.deepEqual(a.data.result.structuredContent, {connected: true, application: 'shard-atlas', protocolVersion: '2026-07-28', access: 'connection-test-only', readsNotes: false, modifiesData: false});
  assert.doesNotMatch(JSON.stringify(a.data), /owner@example|site-scoped-owner|sqlite|shards\.sqlite/);
  assert.match(a.data.result.content[0].text, /reads no notes and makes no changes/);
});

test('tool errors reject unknown tools and all nonempty or nonobject arguments', async () => {
  const unknown = await invoke(rpc('tools/call', {name: 'shard_atlas_delete_knowledge', arguments: {query: 'private'}}));
  assert.equal(unknown.data.error.code, -32602);
  assert.equal(unknown.data.result, undefined);
  for (const args of [{query: 'private'}, {readNotes: true}, [], 'text', 1, false, null]) {
    const result = await invoke(rpc('tools/call', {name: 'shard_atlas_connection_test', arguments: args}));
    assert.equal(result.data.result.isError, true);
    assert.equal(result.data.result.structuredContent, undefined);
  }
  for (const params of [{}, {name: 1}, {name: 'shard_atlas_connection_test', extra: true}]) assert.equal((await invoke(rpc('tools/call', params))).data.error.code, -32602);
});

test('initialization, ping, and notifications support stateless clients', async () => {
  const initialized = await invoke(rpc('initialize', {protocolVersion: '2026-07-28', capabilities: {}, clientInfo: {name: 'test-client', version: '1'}}));
  assert.equal(initialized.data.result.protocolVersion, '2026-07-28');
  assert.deepEqual(initialized.data.result.capabilities, {tools: {}});
  assert.equal(initialized.data.result.serverInfo.version, '1.3.0');
  assert.match(initialized.data.result.instructions, /a request to add knowledge does not authorize editing/);
  assert.match(initialized.data.result.instructions, /No deletion or image upload/);
  assert.match(initialized.data.result.instructions, /Unsynced device changes are excluded/);
  assert.deepEqual((await invoke(rpc('ping'))).data.result, {resultType: 'complete'});
  assert.deepEqual((await invoke(rpc('ping', {}, null))).data, {jsonrpc: '2.0', id: null, result: {resultType: 'complete'}});
  assert.equal((await invoke(rpc('ping', {_meta: {'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {}}}))).data.result.resultType, 'complete');
  const notified = await invoke({jsonrpc: '2.0', method: 'notifications/initialized'});
  assert.equal(notified.response.status, 202); assert.equal(notified.data, null);
  assert.equal(await notified.response.text(), '');
  assert.equal((await invoke(rpc('initialize', {}))).data.error.code, -32602);
  assert.equal((await invoke(rpc('ping', {unexpected: true}))).data.error.code, -32602);
  assert.equal((await invoke(rpc('tools/list', {cursor: 'unknown'}))).data.error.code, -32602);
});

test('modern metadata and supplied mirrored headers agree without breaking headerless Sites bootstrap', async () => {
  const _meta = {'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {}};
  const body = rpc('tools/call', {name: 'shard_atlas_connection_test', arguments: {}, _meta});
  const headers = {'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': 'tools/call', 'Mcp-Name': 'shard_atlas_connection_test'};
  assert.equal((await invoke(body, {headers})).data.result.resultType, 'complete');
  assert.equal((await invoke(body)).data.result.isError, false);
  assert.equal((await invoke(rpc('server/discover'))).response.status, 200);
  for (const changes of [{'MCP-Protocol-Version': '2025-11-25'}, {'Mcp-Method': 'tools/list'}, {'Mcp-Name': 'shard_atlas_search'}, {'Mcp-Name': '=?base64?%%%?='}]) {
    const failed = await invoke(body, {headers: {...headers, ...changes}});
    assert.equal(failed.response.status, 400); assert.equal(failed.data.error.code, -32020);
  }
  const absentBodyVersion = await invoke(rpc('tools/list'), {headers: {'MCP-Protocol-Version': '2026-07-28'}});
  assert.equal(absentBodyVersion.response.status, 400); assert.equal(absentBodyVersion.data.error.code, -32020);
  const encodedName = '=?base64?' + Buffer.from('shard_atlas_connection_test').toString('base64') + '?=';
  assert.equal((await invoke(body, {headers: {...headers, 'Mcp-Name': encodedName}})).data.result.isError, false);
  const unsupported = await invoke(rpc('tools/list', {_meta: {..._meta, 'io.modelcontextprotocol/protocolVersion': '1900-01-01'}}), {headers: {'MCP-Protocol-Version': '1900-01-01', 'Mcp-Method': 'tools/list'}});
  assert.equal(unsupported.response.status, 400); assert.equal(unsupported.data.error.code, -32022);
  assert.deepEqual(unsupported.data.error.data, {supported: ['2026-07-28'], requested: '1900-01-01'});
  assert.equal((await invoke(rpc('ping', {_meta: []}))).data.error.code, -32602);
});

test('invalid protocol metadata neither throws nor reflects arbitrary private values', async () => {
  const secret = 'private-value-do-not-echo'.repeat(100);
  for (const version of [{toString: null}, {}, [], ['2026-07-28'], 1, null, false, secret, '', '2026-7-28']) {
    const failed = await invoke(rpc('tools/list', {_meta: {'io.modelcontextprotocol/protocolVersion': version, 'io.modelcontextprotocol/clientCapabilities': {}}}));
    assert.equal(failed.response.status, 400);
    assert.equal(failed.data.error.code, -32602);
    assert.equal(failed.data.error.message, 'Invalid MCP protocol metadata.');
    assert.equal(failed.data.error.data, undefined);
    assert.doesNotMatch(JSON.stringify(failed.data), /private-value-do-not-echo|toString/);
  }
  for (const metadata of [
    {'io.modelcontextprotocol/protocolVersion': '2026-07-28'},
    {'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': []},
    {'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {}, 'io.modelcontextprotocol/clientInfo': {name: 1, version: '1'}},
  ]) assert.equal((await invoke(rpc('tools/list', {_meta: metadata}))).data.error.code, -32602);
});

test('invalid JSON-RPC and unsupported HTTP requests produce bounded private errors', async () => {
  assert.equal((await invoke('not JSON')).data.error.code, -32700);
  for (const message of [null, [], [{jsonrpc: '2.0', id: 1, method: 'tools/list'}], {id: 1, method: 'tools/list'}, rpc('', {}), rpc('tools/list', []), rpc('tools/list', {}, {}), {...rpc('tools/list'), extra: true}]) {
    assert.equal((await invoke(message)).data.error.code, -32600);
  }
  const unknown = await invoke(rpc('unknown'));
  assert.equal(unknown.response.status, 404); assert.equal(unknown.data.error.code, -32601);
  for (const method of ['GET', 'HEAD', 'PUT', 'DELETE']) {
    const result = await invoke(rpc('tools/list'), {method});
    assert.equal(result.response.status, 405); assert.equal(result.response.headers.get('allow'), 'POST');
  }
  assert.equal((await invoke(rpc('tools/list'), {headers: {'content-type': 'text/plain'}})).response.status, 415);
});

test('oversized declared and streamed bodies are rejected before any tool runs', async () => {
  assert.equal((await invoke(rpc('tools/list'), {headers: {'content-length': 'invalid'}})).response.status, 400);
  assert.equal((await invoke(rpc('tools/list'), {headers: {'content-length': '16385'}})).response.status, 413);
  const huge = JSON.stringify(rpc('tools/call', {name: 'shard_atlas_connection_test', arguments: {payload: 'x'.repeat(17 * 1024)}}));
  assert.equal((await invoke(huge)).response.status, 413);
  const body = new ReadableStream({start(controller) {controller.enqueue(new Uint8Array(16385)); controller.close();}});
  const response = await handleSiteMcpRequest(new Request('https://atlas.example.test/mcp', {method: 'POST', headers: {...identity, 'content-type': 'application/json'}, body, duplex: 'half'}), env());
  assert.equal(response.status, 413);
  const invalidUTF8 = new ReadableStream({start(controller) {controller.enqueue(new Uint8Array([0xff])); controller.close();}});
  const malformed = await handleSiteMcpRequest(new Request('https://atlas.example.test/mcp', {method: 'POST', headers: {...identity, 'content-type': 'application/json'}, body: invalidUTF8, duplex: 'half'}), env());
  assert.equal(malformed.status, 400); assert.equal((await malformed.json()).error.code, -32700);
});

const cloudFixture = () => ({revision: 'accepted-1', snapshotHash: 'a'.repeat(64), acceptedAt: '2026-10-25T12:00:00Z', checkedAt: '2026-10-25T12:00:01Z', archive: {
  shards: [
    {id: 'ownership', title: 'Ownership with RAII', content: 'Resource ownership and scope-based cleanup.', tags: ['C++', 'RAII'], kind: 'concept', status: 'learning',
      sourceUrl: 'https://example.test/ownership', createdAt: '2026-10-25T10:00:00Z', updatedAt: '2026-10-25T11:00:00Z',
      codeSolution: {role: 'snippet', aliases: ['Resource handle'], code: '\r\nint value = 1;\r\n'}},
    {id: 'unwinding', title: 'Stack unwinding', content: 'Exceptions destroy automatic objects.', tags: ['C++', 'exceptions'], kind: 'concept', status: 'learning',
      createdAt: '2026-10-25T10:00:00Z', updatedAt: '2026-10-25T10:00:00Z'},
  ],
  links: [{id: 'link-1', fromId: 'ownership', toId: 'unwinding', type: 'explains', note: 'Cleanup also applies during unwinding.', fromApproachId: '', toApproachId: ''}],
}});

test('search and read expose the accepted cloud revision and exact notes through the real MCP handler', async () => {
  let reads = 0;
  const fixture = cloudFixture(), before = JSON.stringify(fixture);
  const dependencies = {loadLibrary: async configuration => {assert.equal(configuration.SHARD_ATLAS_OWNER_EMAIL, OWNER); reads++; return fixture;}};
  const search = await invoke(rpc('tools/call', {name: 'shard_atlas_search', arguments: {query: 'RAII', limit: 3}}), {}, env(), dependencies);
  assert.equal(search.data.result.isError, false);
  const found = search.data.result.structuredContent;
  assert.ok(found.matches.some(shard => shard.id === 'ownership'));
  assert.equal(found.authority, 'accepted-cloud'); assert.equal(found.revision, 'accepted-1');
  assert.equal(found.snapshotHash, 'a'.repeat(64)); assert.equal(found.checkedAt, fixture.checkedAt);
  assert.equal(found.excludesUnpublishedDeviceChanges, true); assert.equal(found.readOnly, true);
  assert.match(found.untrustedDataNotice, /untrusted reference/);
  assert.deepEqual(JSON.parse(search.data.result.content[0].text), found);
  const read = await invoke(rpc('tools/call', {name: 'shard_atlas_read', arguments: {ids: ['ownership', 'absent'], expectedRevision: found.revision}}), {}, env(), dependencies);
  const data = read.data.result.structuredContent;
  assert.equal(read.data.result.isError, false);
  assert.equal(data.shards[0].codeSolution.code, '\r\nint value = 1;\r\n');
  assert.equal(data.links[0].fromId, 'ownership'); assert.equal(data.links[0].toId, 'unwinding'); assert.equal(data.links[0].type, 'explains');
  assert.deepEqual(data.missingIds, ['absent']); assert.equal(data.revision, found.revision);
  assert.deepEqual(JSON.parse(read.data.result.content[0].text), data);
  assert.equal(reads, 2); assert.equal(JSON.stringify(fixture), before);
});

test('a changed cloud revision refuses the read without mixing search candidates with new notes', async () => {
  const dependencies = {loadLibrary: async () => cloudFixture()};
  const stale = await invoke(rpc('tools/call', {name: 'shard_atlas_read', arguments: {ids: ['ownership'], expectedRevision: 'older-revision'}}), {}, env(), dependencies);
  assert.equal(stale.data.result.isError, true);
  assert.equal(stale.data.result.structuredContent.error.code, 'stale_revision');
  assert.equal(stale.data.result.structuredContent.revision, 'accepted-1');
  assert.equal(stale.data.result.structuredContent.shards, undefined);
  assert.doesNotMatch(JSON.stringify(stale.data), /int value|scope-based cleanup/);
  const current = await invoke(rpc('tools/call', {name: 'shard_atlas_read', arguments: {ids: ['ownership']}}), {}, env(), dependencies);
  assert.equal(current.data.result.isError, false);
});

test('library tool arguments and authorization fail before any library storage is loaded', async () => {
  let reads = 0;
  const dependencies = {loadLibrary: async () => {reads++; throw new Error('Must not load storage.');}};
  const invalid = [
    ['shard_atlas_search', {}], ['shard_atlas_search', {query: null}], ['shard_atlas_search', {query: 'x', limit: 51}],
    ['shard_atlas_search', {query: 'x', role: 'unknown'}], ['shard_atlas_search', {query: 'x', tags: ['a', 'A']}],
    ['shard_atlas_search', {query: Array.from({length: 33}, (_, i) => 'term' + i).join(' ')}],
    ['shard_atlas_search', {query: 'x', database: 'private'}], ['shard_atlas_read', {ids: []}],
    ['shard_atlas_read', {ids: ['ownership', 'ownership']}], ['shard_atlas_read', {ids: ['../private']}],
    ['shard_atlas_read', {ids: ['ownership'], expectedRevision: []}], ['shard_atlas_read', {ids: ['ownership'], includeTrash: true}],
  ];
  for (const [name, args] of invalid) {
    const bad = await invoke(rpc('tools/call', {name, arguments: args}), {}, env(), dependencies);
    assert.equal(bad.data.error.code, -32602);
  }
  for (const name of ['shard_atlas_search', 'shard_atlas_read']) {
    const args = name === 'shard_atlas_search' ? {query: 'RAII'} : {ids: ['ownership']};
    assert.equal((await invoke(rpc('tools/call', {name, arguments: args}), {authenticated: false}, env(), dependencies)).response.status, 401);
    assert.equal((await invoke(rpc('tools/call', {name, arguments: args}), {headers: {'oai-authenticated-user-email': 'another@example.test'}}, env(), dependencies)).response.status, 403);
  }
  for (const method of ['server/discover', 'tools/list', 'ping']) await invoke(rpc(method), {}, env(), dependencies);
  await invoke(rpc('tools/call', {name: 'shard_atlas_connection_test', arguments: {}}), {}, env(), dependencies);
  await invoke({jsonrpc: '2.0', method: 'tools/call', params: {name: 'shard_atlas_search', arguments: {query: 'RAII'}}}, {}, env(), dependencies);
  assert.equal(reads, 0);
});

test('library failures are honest bounded tool errors without private exception details or stale notes', async () => {
  const failed = await invoke(rpc('tools/call', {name: 'shard_atlas_search', arguments: {query: 'RAII'}}), {}, env(), {
    loadLibrary: async () => {throw new Error('SELECT serviceToken FROM private_config; secret-value');},
  });
  assert.equal(failed.data.result.isError, true);
  assert.equal(failed.data.result.structuredContent.error.code, 'library_unavailable');
  assert.doesNotMatch(JSON.stringify(failed.data), /SELECT|serviceToken|secret-value|private_config/);
  assert.equal(failed.data.result.structuredContent.matches, undefined);
});

const guideText = readFileSync(new URL('../static/ai-instructions.md', import.meta.url), 'utf8');
const contributionEnv = () => env({SHARD_ATLAS_GUIDE_RECEIPT_SECRET: 'a'.repeat(64)});
const batch = () => ({requestId: 'cloud-request-1', shards: [{id: 'new-concept', title: 'A new concept', content: 'A self-contained technical explanation.', tags: ['CS']}], links: []});
async function guideArguments(configuration = contributionEnv()) {
  const delivered = await invoke(rpc('tools/call', {name: 'shard_atlas_get_instructions', arguments: {}}), {}, configuration, {guideText});
  assert.equal(delivered.data.result.isError, false);
  const guide = delivered.data.result.structuredContent;
  return {batch: batch(), expectedRevision: 'accepted-1', instructionsVersion: guide.version, instructionsReceipt: guide.readReceipt};
}

test('the MCP guide delivers the full current canonical text without library access', async () => {
  const result = await invoke(rpc('tools/call', {name: 'shard_atlas_get_instructions', arguments: {}}), {}, contributionEnv(), {guideText});
  assert.equal(result.data.result.isError, false);
  assert.equal(result.data.result.structuredContent.content, guideText);
  assert.match(result.data.result.structuredContent.version, /^[a-f0-9]{64}$/);
  assert.match(guideText, /Emergency Google Drive fallback/);
  assert.deepEqual(JSON.parse(result.data.result.content[0].text), result.data.result.structuredContent);
  for (const args of [null, [], false, 'text', {database: 'private'}]) {
    const invalid = await invoke(rpc('tools/call', {name: 'shard_atlas_get_instructions', arguments: args}), {}, contributionEnv(), {guideText});
    assert.equal(invalid.data.error.code, -32602);
  }
});

test('a delivered owner-bound guide permits a revision-checked additive save and verified receipt', async () => {
  const configuration = contributionEnv(), args = await guideArguments(configuration);
  let saves = 0;
  const receipt = {requestId: args.batch.requestId, verified: true, replayed: false, currentContentMatches: true,
    acceptedRevision: 'accepted-2', currentRevision: 'accepted-2', added: {shards: 1, links: 0}, skipped: {shards: 0, links: 0}};
  const saved = await invoke(rpc('tools/call', {name: 'shard_atlas_add_knowledge', arguments: args}), {}, configuration, {
    guideText, saveKnowledge: async (env, input) => {saves++; assert.equal(env, configuration); assert.deepEqual(input, {batch: args.batch, expectedRevision: args.expectedRevision}); return receipt;},
  });
  assert.equal(saves, 1); assert.equal(saved.data.result.isError, false);
  assert.deepEqual(saved.data.result.structuredContent.added, {shards: 1, links: 0});
  assert.equal(saved.data.result.structuredContent.acceptedRevision, 'accepted-2');
  assert.equal(saved.data.result.structuredContent.authority, 'accepted-cloud');
  assert.equal(saved.data.result.structuredContent.readOnly, false);
  assert.match(saved.data.result.structuredContent.untrustedDataNotice, /Device synchronization is separate/);
});

test('missing, stale, tampered, or transferred guide acknowledgments stop before any save', async () => {
  const configuration = contributionEnv(), original = await guideArguments(configuration);
  let saves = 0;
  const dependencies = {guideText, saveKnowledge: async () => {saves++; throw new Error('Must not save.');}};
  for (const changes of [{instructionsVersion: 'b'.repeat(64)}, {instructionsReceipt: 'v1.invalid.invalid'}, {instructionsReceipt: ''}, {instructionsVersion: 1}]) {
    const result = await invoke(rpc('tools/call', {name: 'shard_atlas_add_knowledge', arguments: {...original, ...changes}}), {}, configuration, dependencies);
    assert.equal(result.data.result.isError, true);
    assert.ok(['guide_changed', 'guide_read_required'].includes(result.data.result.structuredContent.error.code));
  }
  const transferred = await invoke(rpc('tools/call', {name: 'shard_atlas_add_knowledge', arguments: original}), {headers: {'oai-authenticated-user-id': 'different-owner-session'}}, configuration, dependencies);
  assert.equal(transferred.data.result.structuredContent.error.code, 'guide_read_required');
  for (const missing of ['batch', 'expectedRevision', 'instructionsVersion', 'instructionsReceipt']) {
    const args = {...original}; delete args[missing];
    assert.equal((await invoke(rpc('tools/call', {name: 'shard_atlas_add_knowledge', arguments: args}), {}, configuration, dependencies)).data.error.code, -32602);
  }
  assert.equal((await invoke(rpc('tools/call', {name: 'shard_atlas_add_knowledge', arguments: {...original, overwrite: true}}), {}, configuration, dependencies)).data.error.code, -32602);
  assert.equal(saves, 0);
});

test('additions allow useful notes beyond read-request limits but enforce their own bounded batch', async () => {
  const configuration = contributionEnv(), args = await guideArguments(configuration);
  let saves = 0;
  const dependencies = {guideText, saveKnowledge: async () => {saves++; return {verified: true, acceptedRevision: 'accepted-2'};}};
  args.batch.shards[0].content = 'x'.repeat(20_000);
  const accepted = await invoke(rpc('tools/call', {name: 'shard_atlas_add_knowledge', arguments: args}), {}, configuration, dependencies);
  assert.equal(accepted.data.result.isError, false); assert.equal(saves, 1);
  args.batch.shards = Array.from({length: 3}, (_, i) => ({...batch().shards[0], id: 'large-' + i, content: 'x'.repeat(88_000)}));
  const tooLarge = await invoke(rpc('tools/call', {name: 'shard_atlas_add_knowledge', arguments: args}), {}, configuration, dependencies);
  assert.equal(tooLarge.data.result.structuredContent.error.code, 'contribution_too_large');
  assert.equal(saves, 1);
  args.batch.shards = Array.from({length: 21}, (_, i) => ({...batch().shards[0], id: 'too-many-' + i}));
  assert.equal((await invoke(rpc('tools/call', {name: 'shard_atlas_add_knowledge', arguments: args}), {}, configuration, dependencies)).data.result.structuredContent.error.code, 'invalid_contribution');
  assert.equal(saves, 1);
});

test('duplicate JSON keys, unauthorized writes, notifications, and unknown errors cannot silently save', async () => {
  const configuration = contributionEnv(), args = await guideArguments(configuration);
  let saves = 0;
  const dependencies = {guideText, saveKnowledge: async () => {saves++; throw new Error('private SQL serviceToken=secret-value');}};
  const duplicate = JSON.stringify(rpc('tools/call', {name: 'shard_atlas_add_knowledge', arguments: args})).replace('"requestId":"cloud-request-1"', '"requestId":"other","requestId":"cloud-request-1"');
  assert.equal((await invoke(duplicate, {}, configuration, dependencies)).response.status, 400);
  assert.equal((await invoke(rpc('tools/call', {name: 'shard_atlas_add_knowledge', arguments: args}), {authenticated: false}, configuration, dependencies)).response.status, 401);
  const notification = await invoke({jsonrpc: '2.0', method: 'tools/call', params: {name: 'shard_atlas_add_knowledge', arguments: args}}, {}, configuration, dependencies);
  assert.equal(notification.response.status, 202); assert.equal(saves, 0);
  const failed = await invoke(rpc('tools/call', {name: 'shard_atlas_add_knowledge', arguments: args}), {}, configuration, dependencies);
  assert.equal(failed.data.result.structuredContent.error.code, 'save_outcome_unknown');
  assert.match(failed.data.result.content[0].text, /Retry the identical batch and requestId/);
  assert.doesNotMatch(JSON.stringify(failed.data), /SQL|serviceToken|secret-value|Nothing was saved/);
});

async function editArguments(configuration = contributionEnv()) {
  const args = await guideArguments(configuration);
  args.batch = {requestId: 'cloud-edit-1', shards: [{id: 'saved-note', changes: {title: 'A revised title'}}], links: []};
  return args;
}

test('edit tool publishes a typed sparse schema with explicit array and approach semantics', async () => {
  const listed = await invoke(rpc('tools/list'));
  const tool = listed.data.result.tools.find(item => item.name === 'shard_atlas_edit_knowledge');
  assert.ok(tool); assert.equal(tool.annotations.destructiveHint, true); assert.equal(tool.annotations.readOnlyHint, false);
  const schema = tool.inputSchema, batchSchema = schema.properties.batch;
  assert.deepEqual(schema.required, ['batch', 'expectedRevision', 'instructionsVersion', 'instructionsReceipt']);
  assert.equal(batchSchema.additionalProperties, false);
  assert.deepEqual(batchSchema.required, ['requestId', 'shards', 'links']);
  const shard = batchSchema.properties.shards.items, link = batchSchema.properties.links.items;
  assert.deepEqual(shard.required, ['id', 'changes']); assert.deepEqual(link.required, ['id', 'changes']);
  for (const changes of [shard.properties.changes, link.properties.changes]) {
    assert.equal(changes.additionalProperties, false); assert.equal(changes.minProperties, 1); assert.equal(changes.required, undefined);
    for (const immutable of ['id', 'createdAt', 'updatedAt', 'reviewCount', 'lastReviewedAt', 'nextReviewAt', 'assets', 'delete']) assert.equal(changes.properties[immutable], undefined);
  }
  const code = shard.properties.changes.properties.codeSolution;
  assert.deepEqual(shard.properties.changes.properties.prompt.type, 'string');
  assert.equal(shard.properties.changes.properties.prompt.maxLength, 10_000);
  assert.equal(JSON.stringify(batchSchema).includes('"type":"null"'), false);
  assert.equal(code.required, undefined); assert.equal(code.minProperties, 1);
  assert.match(shard.properties.changes.properties.tags.description, /replaces the entire saved field/);
  assert.match(code.properties.approaches.description, /Keyed upserts/);
  assert.deepEqual(code.properties.approaches.items.required, ['id']);
  assert.match(tool.description, /Omitted fields remain unchanged/);
  assert.match(tool.description, /No shard\/connection deletion or creation/);
});

test('current guide authorizes sparse existing-record edits without replacing omitted fields in transit', async () => {
  const configuration = contributionEnv(), args = await editArguments(configuration);
  const exactCode = '\nint identity(int x) {\r\n\treturn x;\r\n}\r\n';
  args.batch.shards[0].changes = {content: 'An explicitly revised explanation.', codeSolution: {approaches: [{id: 'existing-approach', code: exactCode}]}};
  args.batch.links = [{id: 'saved-link', changes: {note: 'An improved explanation of this saved relationship.'}}];
  const original = JSON.stringify(args.batch); let edits = 0;
  const receipt = {requestId: args.batch.requestId, operation: 'edit', verified: true, replayed: false,
    currentContentMatches: true, acceptedRevision: 'accepted-edit', currentRevision: 'accepted-edit', edited: {shards: 1, links: 1}, unchanged: {shards: 0, links: 0}};
  const edited = await invoke(rpc('tools/call', {name: 'shard_atlas_edit_knowledge', arguments: args}), {}, configuration, {
    guideText, editKnowledge: async (actualEnv, input) => {
      edits++; assert.equal(actualEnv, configuration); assert.deepEqual(input, {batch: args.batch, expectedRevision: args.expectedRevision});
      assert.equal(input.batch.shards[0].changes.codeSolution.approaches[0].code, exactCode);
      assert.equal(Object.hasOwn(input.batch.shards[0].changes, 'title'), false); return receipt;
    },
  });
  assert.equal(edits, 1); assert.equal(edited.data.result.isError, false);
  assert.equal(edited.data.result.structuredContent.operation, 'edit');
  assert.equal(edited.data.result.structuredContent.verified, true);
  assert.equal(edited.data.result.structuredContent.acceptedRevision, 'accepted-edit');
  assert.equal(JSON.stringify(args.batch), original);
});

test('edit authorization, guide proofs, malformed patches and notifications fail before editing storage', async () => {
  const configuration = contributionEnv(), original = await editArguments(configuration); let edits = 0;
  const dependencies = {guideText, editKnowledge: async () => {edits++; throw new Error('Storage must not be called.');}};
  for (const options of [{authenticated: false}, {headers: {'oai-authenticated-user-email': 'other@example.test'}}, {headers: {Origin: 'https://evil.example.test'}}]) {
    assert.ok([401, 403].includes((await invoke(rpc('tools/call', {name: 'shard_atlas_edit_knowledge', arguments: original}), options, configuration, dependencies)).response.status));
  }
  for (const missing of ['batch', 'expectedRevision', 'instructionsVersion', 'instructionsReceipt']) {
    const args = {...original}; delete args[missing];
    assert.equal((await invoke(rpc('tools/call', {name: 'shard_atlas_edit_knowledge', arguments: args}), {}, configuration, dependencies)).data.error.code, -32602);
  }
  for (const changes of [{instructionsReceipt: 'v1.invalid.invalid'}, {instructionsVersion: 'b'.repeat(64)}]) {
    assert.equal((await invoke(rpc('tools/call', {name: 'shard_atlas_edit_knowledge', arguments: {...original, ...changes}}), {}, configuration, dependencies)).data.result.isError, true);
  }
  for (const patch of [{}, {id: 'replace-id'}, {createdAt: '2026-01-01T00:00:00Z'}, {reviewCount: 1}, {assets: []}, {delete: true},
    JSON.parse('{"__proto__":{"polluted":true}}'), {codeSolution: {constructor: {polluted: true}}},
    {codeSolution: {}}, {codeSolution: {approaches: [{title: 'Missing stable ID'}]}}]) {
    const args = {...original, batch: {...original.batch, shards: [{id: 'saved-note', changes: patch}]}};
    assert.equal((await invoke(rpc('tools/call', {name: 'shard_atlas_edit_knowledge', arguments: args}), {}, configuration, dependencies)).data.result.isError, true);
  }
  const duplicate = JSON.stringify(rpc('tools/call', {name: 'shard_atlas_edit_knowledge', arguments: original})).replace('"requestId":"cloud-edit-1"', '"requestId":"other","requestId":"cloud-edit-1"');
  assert.equal((await invoke(duplicate, {}, configuration, dependencies)).response.status, 400);
  assert.equal((await invoke({jsonrpc: '2.0', method: 'tools/call', params: {name: 'shard_atlas_edit_knowledge', arguments: original}}, {}, configuration, dependencies)).response.status, 202);
  assert.equal(edits, 0);
});

test('edit bodies receive the bounded write allowance and unknown outcomes never claim no edit occurred', async () => {
  const configuration = contributionEnv(), args = await editArguments(configuration); let edits = 0;
  args.batch.shards[0].changes = {content: 'x'.repeat(20_000)};
  const dependencies = {guideText, editKnowledge: async () => {edits++; return {operation: 'edit', verified: true};}};
  const accepted = await invoke(rpc('tools/call', {name: 'shard_atlas_edit_knowledge', arguments: args}), {}, configuration, dependencies);
  assert.equal(accepted.data.result.isError, false); assert.equal(edits, 1);
  args.batch.shards = Array.from({length: 3}, (_, index) => ({id: 'large-' + index, changes: {content: 'x'.repeat(88_000)}}));
  assert.equal((await invoke(rpc('tools/call', {name: 'shard_atlas_edit_knowledge', arguments: args}), {}, configuration, dependencies)).data.result.isError, true);
  assert.equal(edits, 1);
  args.batch.shards = [{id: 'saved-note', changes: {content: 'A reviewed update.'}}];
  const unknown = await invoke(rpc('tools/call', {name: 'shard_atlas_edit_knowledge', arguments: args}), {}, configuration, {
    guideText, editKnowledge: async () => {throw new Error('SELECT private_token SECRET_PAYLOAD');},
  });
  assert.equal(unknown.data.result.structuredContent.error.code, 'save_outcome_unknown');
  assert.match(unknown.data.result.content[0].text, /Retry the identical batch and requestId/);
  assert.doesNotMatch(JSON.stringify(unknown.data), /private_token|SECRET_PAYLOAD|No new save was attempted|Nothing was saved/);
});
