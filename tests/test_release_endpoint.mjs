import test from 'node:test';
import assert from 'node:assert/strict';
import {handleReleaseRequest} from '../sync/release.mjs';
import {sha256} from '../sync/protocol.mjs';

const manifest = {schemaVersion: 1, application: 'shard-atlas', ...Object.fromEntries(['releaseId', 'frontendId', 'backendId', 'hostedId', 'nativeId'].map(key => [key, 'a'.repeat(64)]))};
const env = {SHARD_ATLAS_OWNER_PRIVATE: 'true', SHARD_ATLAS_OWNER_EMAIL: 'owner@example.test'};
const identity = {'oai-authenticated-user-id': 'owner', 'oai-authenticated-user-email': 'owner@example.test'};

test('published release aliases authenticate without requiring a matching data protocol', async () => {
  for (const path of ['/api/release', '/api/sync/release']) {
    const response = await handleReleaseRequest(new Request('https://atlas.test' + path, {headers: {...identity, 'X-Shard-Atlas-Sync': 'future'}}), env, manifest);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('Cache-Control'), 'no-store, private');
    assert.equal(response.headers.get('X-Shard-Atlas-Sync'), '1');
    assert.deepEqual(await response.json(), manifest);
  }
});

test('release discovery denies anonymous, wrong owner and revoked service credentials', async () => {
  const hash = await sha256(new TextEncoder().encode('device-secret'));
  const service = {...env, SHARD_ATLAS_ALLOW_SERVICE_ACCESS: 'true', SHARD_ATLAS_SERVICE_SECRET_SHA256_ALLOWLIST: JSON.stringify([hash])};
  const request = headers => new Request('https://atlas.test/api/release', {headers});
  assert.equal((await handleReleaseRequest(request({}), env, manifest)).status, 401);
  assert.equal((await handleReleaseRequest(request({...identity, 'oai-authenticated-user-email': 'other@example.test'}), env, manifest)).status, 403);
  assert.equal((await handleReleaseRequest(request({'X-Shard-Atlas-Service': 'device-secret'}), service, manifest)).status, 200);
  service.SHARD_ATLAS_SERVICE_SECRET_SHA256_ALLOWLIST = '[]';
  assert.equal((await handleReleaseRequest(request({'X-Shard-Atlas-Service': 'device-secret'}), service, manifest)).status, 403);
});

test('release discovery handles HEAD, unavailable metadata, invalid method and unrelated routes', async () => {
  assert.equal(await handleReleaseRequest(new Request('https://atlas.test/'), env, manifest), null);
  const head = await handleReleaseRequest(new Request('https://atlas.test/api/release', {method: 'HEAD', headers: identity}), env, manifest);
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
  assert.equal((await handleReleaseRequest(new Request('https://atlas.test/api/release', {headers: identity}), env, {})).status, 503);
  assert.equal((await handleReleaseRequest(new Request('https://atlas.test/api/release', {method: 'POST', headers: identity}), env, manifest)).status, 405);
});
