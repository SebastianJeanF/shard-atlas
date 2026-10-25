import test from 'node:test';
import assert from 'node:assert/strict';
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
async function invoke(message, options, configuration = env()) {
  const response = await handleSiteMcpRequest(request(message, options), configuration);
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

test('discovery and the read-only tool list need no library protocol header or storage bindings', async () => {
  const discovery = await invoke(rpc('server/discover'));
  assert.deepEqual(discovery.data, {jsonrpc: '2.0', id: 1, result: {supportedVersions: ['2026-07-28'], capabilities: {tools: {}}, ttlMs: 0, cacheScope: 'private', resultType: 'complete'}});
  const listing = await invoke(rpc('tools/list'), {headers: {'oai-authenticated-user-email': OWNER.toUpperCase(), Origin: 'https://chatgpt.com'}});
  assert.equal(listing.data.result.tools.length, 1);
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
    assert.equal(result.data.result.tools.length, 1);
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
  const unknown = await invoke(rpc('tools/call', {name: 'shard_atlas_search', arguments: {query: 'private'}}));
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
  assert.match(initialized.data.result.instructions, /cannot read, add, edit, delete, import, or synchronize notes/);
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
