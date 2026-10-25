import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

const source = readFileSync(new URL('../static/release-status.js', import.meta.url), 'utf8');
const manifest = (id = 'a') => ({schemaVersion: 1, application: 'shard-atlas', ...Object.fromEntries(['releaseId', 'frontendId', 'backendId', 'hostedId', 'nativeId'].map(key => [key, id.repeat(64)]))});
class Element {
  constructor() {this.children = new Map(); this.listeners = new Map(); this.dataset = {}; this.hidden = false;}
  setAttribute() {}
  append(...children) {this.appended ||= []; this.appended.push(...children);}
  prepend(child) {this.append(child);}
  after(child) {this.append(child);}
  replaceChildren(...children) {this.appended = children;}
  querySelector(selector) {if (!this.children.has(selector)) this.children.set(selector, new Element()); return this.children.get(selector);}
  querySelectorAll() {return [];}
  addEventListener(name, callback) {this.listeners.set(name, callback);}
  showModal() {this.open = true;}
  close() {this.open = false;}
  async action(value) {await this.listeners.get('click')?.({target: {closest: () => ({dataset: {release: value}})}});}
}
function fixture({native = false, loaded = manifest(), published = manifest(), nativeId = loaded?.nativeId, response, unsaved = false, waiting = false} = {}) {
  const document = new Element(); document.body = new Element(); document.visibilityState = 'visible'; document.getElementById = () => null;
  document.createElement = () => new Element();
  const events = new Map(), intervals = []; let calls = 0, reloads = 0;
  const window = {document, SHARD_ATLAS_RELEASE: loaded, isShardAtlasDesktop: native,
    SHARD_ATLAS_NATIVE: {nativeId}, navigator: {onLine: true, serviceWorker: {getRegistration: async () => ({waiting: waiting ? {} : null})}},
    location: {reload() {reloads++;}}, ShardAtlasHasUnsavedLibraryChanges: () => unsaved,
    ShardAtlasPlatform: {async request(url, options) {calls++; assert.equal(options.cache, 'no-store');
      if (native) {assert.match(url, /^\/api\/release-status\?/); assert.equal(new URL(url, 'https://test').searchParams.get('frontendId'), loaded?.frontendId || '');}
      else assert.equal(url, '/api/release');
      return response ? response(url, options) : {ok: true, json: async () => native ? {state: 'up_to_date', current: loaded, published} : published};}},
    setTimeout() {return 1;}, clearTimeout() {}, setInterval(callback, ms) {intervals.push({callback, ms});},
    addEventListener(name, callback) {events.set(name, callback);}};
  runInNewContext(source, {window, AbortController, URLSearchParams});
  const ui = window.ShardAtlasReleaseUI, instance = ui.install(), dialog = document.body.appended[0];
  return {window, ui, instance, dialog, events, intervals, calls: () => calls, reloads: () => reloads};
}

test('browser freshness compares the loaded frontend against a valid published identity', async () => {
  const f = fixture(); await f.instance.check();
  assert.equal(f.instance.status.state, 'up_to_date');
  const changed = {...manifest(), backendId: 'b'.repeat(64), nativeId: 'c'.repeat(64)};
  assert.equal(f.ui.classify(manifest(), changed), 'up_to_date');
  assert.equal(f.ui.classify(manifest(), {...changed, frontendId: 'd'.repeat(64)}), 'update_available');
  for (const value of [null, {}, {...manifest(), schemaVersion: 2}, {...manifest(), application: 'other'}, {...manifest(), releaseId: 'not-a-hash'}]) assert.equal(f.ui.classify(manifest(), value), 'unknown');
});

test('software checks run every minute and on focus or reconnect without reloading', async () => {
  const f = fixture({published: manifest('b')}); await f.instance.check();
  assert.equal(f.instance.status.state, 'update_available');
  assert.equal(f.intervals[0].ms, 60_000);
  f.events.get('focus')(); await f.instance.check();
  f.events.get('online')(); await f.instance.check();
  assert.equal(f.calls(), 3); assert.equal(f.reloads(), 0);
  f.window.navigator.onLine = false; f.events.get('offline')();
  assert.equal(f.instance.status.state, 'offline');
  await f.instance.check(); assert.equal(f.calls(), 3);
});

test('failed checks and legacy missing identities never claim software is current', async () => {
  const unavailable = fixture({response: async () => {throw new Error('Unavailable');}});
  await unavailable.instance.check(); assert.equal(unavailable.instance.status.state, 'unknown');
  const legacy = fixture({loaded: null}); await legacy.instance.check(); assert.equal(legacy.instance.status.state, 'unknown');
  const native = fixture({native: true, nativeId: ''}); await native.instance.check(); assert.equal(native.instance.status.state, 'unknown');
});

test('a native backend status preserves restart and compiled-window update instructions', async () => {
  for (const state of ['restart_required', 'native_update_required', 'versions_differ', 'offline', 'unknown']) {
    const f = fixture({native: true, response: async () => ({ok: true, json: async () => ({state, message: 'Actionable instruction', published: manifest()})})});
    await f.instance.check(); assert.equal(f.instance.status.state, state); assert.equal(f.instance.status.message, 'Actionable instruction');
  }
});

test('an offline Mac still checks local restart and compiled-window requirements', async () => {
  for (const state of ['restart_required', 'native_update_required', 'up_to_date']) {
    const f = fixture({native: true, response: async () => ({ok: true, json: async () => ({state, published: manifest()})})});
    await f.instance.check();
    f.window.navigator.onLine = false;
    await f.instance.check();
    assert.equal(f.calls(), 2);
    assert.equal(f.instance.status.state, state === 'up_to_date' ? 'offline' : state);
  }
});

test('manual website reload protects open work and waiting service workers', async () => {
  for (const [unsaved, waiting] of [[true, false], [false, true], [false, false]]) {
    const f = fixture({published: manifest('b'), unsaved, waiting}); await f.instance.check();
    await f.dialog.action('reload');
    assert.equal(f.reloads(), !unsaved && !waiting ? 1 : 0);
    if (unsaved || waiting) assert.ok(f.dialog.querySelector('.app-release-work').textContent.length > 0);
  }
});

test('library data labels never confuse incoming data or an unavailable check with a synchronized copy', () => {
  const window = {};
  runInNewContext(readFileSync(new URL('../static/library-sync.js', import.meta.url), 'utf8'), {window});
  const display = window.ShardAtlasLibraryUI.displayState;
  assert.equal(display({state: 'synced', cloudCheck: {state: 'unavailable'}}), 'check_unavailable');
  assert.equal(display({state: 'synced', cloudCheck: {state: 'unknown'}}), 'unknown');
  assert.equal(display({state: 'synced', cloudCheck: {state: 'current'}}), 'synced');
  assert.equal(display({status: 'synced', syncing: true, cloudCheck: {state: 'current'}}), 'syncing');
  assert.equal(display({state: 'pending', incomingAvailable: true}), 'incoming');
  assert.equal(display({state: 'conflict', incomingAvailable: true}), 'conflict');
  assert.equal(display({state: 'update_required', cloudCheck: {state: 'unavailable'}}), 'update_required');
});

test('a failed library status request removes a previously displayed synced claim', async () => {
  const document = new Element(); document.body = new Element(); document.getElementById = () => null; document.createElement = () => new Element();
  let failStatus = false;
  const window = {shardAtlasLibrarySync: {}, crypto: {randomUUID: () => 'fixture'}, addEventListener() {},
    ShardAtlasPlatform: {async request() {
      if (failStatus) throw new Error('Status check unavailable');
      return {ok: true, json: async () => ({state: 'synced', configured: true, cloudCheck: {state: 'current'}})};
    }}};
  runInNewContext(readFileSync(new URL('../static/library-sync.js', import.meta.url), 'utf8'), {window, document, setInterval() {}, setTimeout() {}});
  const instance = window.ShardAtlasLibraryUI.install();
  await instance.refresh();
  const label = document.body.appended[0].querySelector('.library-sync-state');
  assert.equal(label.textContent, 'Library synced');
  failStatus = true; await instance.refresh();
  assert.equal(label.textContent, 'Data check unavailable');
  assert.equal(instance.status.cloudCheck.state, 'unavailable');
});
