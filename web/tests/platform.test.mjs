import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';

const source = await readFile(new URL('../../static/platform.js', import.meta.url), 'utf8');

test('Mac defaults preserve the local API, image URLs and Drive integration', async () => {
  let request, installed;
  const window = {fetch: (...args) => {request = args; return 'response';}, DriveInbox: {install: value => {installed = value;}}};
  runInNewContext(source, {window, URL, Headers});
  const host = window.ShardAtlasPlatform;
  assert.equal(await host.request('/api/state', {method: 'GET'}), 'response');
  assert.equal(request[0], '/api/state');
  assert.equal(host.imageSource('/assets/image'), '/assets/image');
  assert.equal(host.canRefreshDialog({id: 'ai-dialog'}), true);
  assert.equal(host.canRefreshDialog({id: 'editor-dialog'}), false);
  const context = {refreshAtlas() {}};
  host.installIntegrations(context);
  assert.equal(installed, context);
  assert.equal(host.message('draftSaved'), 'Draft saved on this Mac.');
});

test('browser services configure the same shared interface without changing Mac defaults in source', async () => {
  const window = {fetch() {throw new Error('Unexpected native fetch');}};
  runInNewContext(source, {window, URL, Headers});
  const host = window.ShardAtlasPlatform;
  let saved;
  host.configure({request: async () => 'browser response', imageSource: () => 'blob:image', canRefreshDialog: dialog => dialog.id === 'drive-dialog', didSave: value => {saved = value;}, messages: {draftSaved: 'Saved in browser'}});
  assert.equal(await host.request('/api/state'), 'browser response');
  assert.equal(host.imageSource('/assets/image'), 'blob:image');
  assert.equal(host.canRefreshDialog({id: 'drive-dialog'}), true);
  const detail = {id: 'shard'};
  host.didSave(detail);
  assert.equal(saved, detail);
  assert.equal(host.message('draftSaved'), 'Saved in browser');
  assert.equal(host.message('aiReady'), 'Ready to copy. Share these instructions with your chat.');
  assert.throws(() => host.configure({request: false}), /must be a function/);
});

test('native writes retain the revision of an observed state, including an empty initial base', async () => {
  const calls = [];
  let revision = '';
  const window = {
    async fetch(path, options) {
      calls.push({path, options});
      return new Response('{}', {headers: {'X-Shard-Atlas-Library-Revision': revision}});
    },
  };
  runInNewContext(source, {window, URL, Headers});
  const host = window.ShardAtlasPlatform;
  const first = await (await host.request('/api/state')).json();
  host.acceptState(first);
  await host.request('/api/shards', {method: 'POST', headers: {'Content-Type': 'application/json'}});
  assert.equal(calls.at(-1).options.headers.get('X-Shard-Atlas-View-Revision'), '');
  assert.equal(calls.at(-1).options.headers.get('Content-Type'), 'application/json');
  revision = 'new-cloud-revision';
  const discarded = await (await host.request('/api/state')).json();
  await host.request('/api/shards/id', {method: 'PUT'});
  assert.equal(calls.at(-1).options.headers.get('X-Shard-Atlas-View-Revision'), '', 'A read discarded by an open editor must not advance its viewed base');
  host.acceptState({});
  await host.request('/api/shards/id', {method: 'PUT'});
  assert.equal(calls.at(-1).options.headers.get('X-Shard-Atlas-View-Revision'), '', 'Unrelated parsed JSON cannot advance the viewed base');
  host.acceptState(discarded);
  await host.request('/api/shards/id', {method: 'PUT'});
  assert.equal(calls.at(-1).options.headers.get('X-Shard-Atlas-View-Revision'), revision);
  for (const path of ['/api/drafts/editor', '/api/library-sync/editing', '/api/import/preview', '/api/import-preview', '/api/backup', '/api/assets/id/text']) {
    await host.request(path, {method: 'POST'});
    assert.equal(new Headers(calls.at(-1).options.headers).has('X-Shard-Atlas-View-Revision'), false, path);
  }
});
