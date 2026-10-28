import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {handleSiteMcpRequest} from '../hosting/lib/site-mcp.mjs';
import {ingestRemoteImage, ImageUploadError} from '../hosting/lib/image-uploads.mjs';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jR7sAAAAASUVORK5CYII=', 'base64');
function fixture(t) {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('../sync/schema.sql', import.meta.url), 'utf8'));
  t.after(() => sqlite.close());
  const DB = {prepare(sql) {return {bind(...args) {const rows = () => sqlite.prepare(sql).all(...args); return {first: async () => rows()[0] ?? null, all: async () => ({results: rows()}), run: async () => {const result = sqlite.prepare(sql).run(...args); return {success: true, meta: {changes: result.changes}};}};}};}};
  const blobs = new Map();
  const BUCKET = {async put(key, value) {blobs.set(key, new Uint8Array(value));}, async head(key) {return blobs.has(key) ? {size: blobs.get(key).byteLength} : null;},
    async get(key) {const bytes = blobs.get(key); return bytes ? {size: bytes.byteLength, body: new Response(bytes).body} : null;}};
  return {sqlite, blobs, env: {DB, BUCKET, SHARD_ATLAS_OWNER_PRIVATE: 'true', SHARD_ATLAS_OWNER_EMAIL: 'owner@example.test'}};
}
async function call(f, name, args = {}, options = {}) {
  const request = new Request('https://atlas.example.test/mcp', {method: 'POST', headers: {'content-type': 'application/json',
    ...(options.authenticated === false ? {} : {'oai-authenticated-user-id': 'owner-scope', 'oai-authenticated-user-email': 'owner@example.test'})},
    body: JSON.stringify({jsonrpc: '2.0', id: 1, method: name === 'tools/list' ? name : 'tools/call', params: name === 'tools/list' ? {} : {name, arguments: args}})});
  const response = await handleSiteMcpRequest(request, f.env, options.dependencies);
  return {status: response.status, body: await response.json()};
}

test('published image tool declares the complete native file handoff contract', async t => {
  const f = fixture(t), {body} = await call(f, 'tools/list');
  const upload = body.result.tools.find(tool => tool.name === 'shard_atlas_upload_image');
  assert.deepEqual(upload._meta['openai/fileParams'], ['file']);
  assert.deepEqual(upload.inputSchema.properties.file.required, ['download_url', 'file_id']);
  assert.deepEqual(Object.keys(upload.inputSchema.properties.file.properties).sort(), ['download_url', 'file_id', 'file_name', 'mime_type']);
  assert.equal(upload.annotations.readOnlyHint, false);
  const status = body.result.tools.find(tool => tool.name === 'shard_atlas_image_upload_status');
  assert.equal(status.annotations.readOnlyHint, true);
  assert.match(upload.description, /staging only/);
});

test('authenticated MCP file handoff stages exact bytes without changing library heads', async t => {
  const f = fixture(t), args = {requestId: 'native-file-handoff', file: {file_id: 'file-synthetic-fixture', download_url: 'https://files.oaiusercontent.com/synthetic.png?private-token=never-return', mime_type: 'image/png', file_name: 'diagram.png'}};
  const dependencies = {uploadImage: (env, values, options) => ingestRemoteImage(env, values, {...options, fetch: async (url, init) => {
    assert.equal(url.toString(), args.file.download_url);
    assert.equal(init.redirect, 'manual');
    assert.ok(!new Headers(init.headers).has('authorization'));
    return new Response(png, {headers: {'content-type': 'image/png', 'content-length': String(png.length)}});
  }})};
  const first = await call(f, 'shard_atlas_upload_image', args, {dependencies});
  assert.equal(first.status, 200); assert.equal(first.body.result.isError, false, JSON.stringify(first.body));
  const receipt = first.body.result.structuredContent;
  assert.equal(receipt.verified, true); assert.equal(receipt.authority, 'private-image-staging');
  assert.equal(f.sqlite.prepare('SELECT count(*) AS n FROM library_heads').get().n, 0);
  assert.equal(f.sqlite.prepare('SELECT count(*) AS n FROM library_commits').get().n, 0);
  assert.deepEqual([...f.blobs.values()][0], new Uint8Array(png));
  assert.doesNotMatch(JSON.stringify(first.body), /private-token|download_url|file-synthetic-fixture|data:image|base64/);
  const checked = await call(f, 'shard_atlas_image_upload_status', {uploadId: receipt.uploadId});
  assert.equal(checked.body.result.structuredContent.uploadId, receipt.uploadId);
  assert.equal(checked.body.result.structuredContent.readOnly, true);
  assert.equal(checked.body.result.structuredContent.verified, true);
  const retry = await call(f, 'shard_atlas_upload_image', {...args, file: {...args.file, download_url: 'https://files.oaiusercontent.com/renewed.png?changed-signature'}}, {dependencies});
  assert.equal(retry.body.result.structuredContent.uploadId, receipt.uploadId);
  assert.equal(f.sqlite.prepare('SELECT count(*) AS n FROM image_uploads').get().n, 1);
});

test('unauthenticated image tools never reach staging or reveal upload status', async t => {
  const f = fixture(t); let calls = 0;
  const dependencies = {uploadImage() {calls++;}, imageUploadStatus() {calls++;}};
  for (const name of ['shard_atlas_upload_image', 'shard_atlas_image_upload_status', 'shard_atlas_verify_image_workflow']) {
    assert.equal((await call(f, name, {}, {authenticated: false, dependencies})).status, 401);
  }
  assert.equal(calls, 0);
});

test('upload failures expose bounded phases and status without private provider details', async t => {
  const f = fixture(t), failure = new ImageUploadError('image_download_failed');
  failure.details = {phase: 'response', downloadStatus: 403, causeName: 'PRIVATE_PROVIDER_MESSAGE', download_url: 'PRIVATE_SIGNED_URL', headers: {secret: 'PRIVATE_HEADER'}};
  const result = await call(f, 'shard_atlas_upload_image', {}, {dependencies: {uploadImage: () => {throw failure;}}});
  assert.deepEqual(result.body.result.structuredContent.diagnostics, {phase: 'response', downloadStatus: 403});
  assert.doesNotMatch(JSON.stringify(result.body), /PRIVATE_|download_url|headers/);
  failure.details = {phase: 'PRIVATE_PROVIDER_MESSAGE', downloadStatus: 1000};
  const invalid = await call(f, 'shard_atlas_upload_image', {}, {dependencies: {uploadImage: () => {throw failure;}}});
  assert.equal(invalid.body.result.structuredContent.diagnostics, undefined);
});
