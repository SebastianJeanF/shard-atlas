import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';

const bootstrap = await readFile(new URL('../../web-dist/bootstrap.mjs', import.meta.url), 'utf8');
const source = bootstrap.slice(bootstrap.indexOf('async function prepareOffline()'), bootstrap.indexOf("window.addEventListener('beforeinstallprompt'"));
function registration() {return Object.assign(new EventTarget(), {active: {state: 'activated'}, waiting: null, installing: null});}
function harness(current, update) {
  let calls = 0;
  const status = {textContent: 'Preparing offline access…'};
  current.update = async () => {calls++; return update?.(current);};
  const serviceWorker = {register: async (url, options) => {assert.equal(url, '/sw.js'); assert.equal(options.updateViaCache, 'none'); return current;}, ready: Promise.resolve(current)};
  const prepareOffline = runInNewContext(source + '\nprepareOffline;', {navigator: {serviceWorker}, $: () => status, message() {}, localStorage: {getItem: () => 'yes'}, setTimeout, clearTimeout});
  return {status, prepareOffline, calls: () => calls};
}

test('existing ready worker still gets an explicit fresh update check and waiting message', async () => {
  const current = registration();
  const fixture = harness(current, value => {value.waiting = {state: 'installed'};});
  await fixture.prepareOffline();
  assert.equal(fixture.calls(), 1);
  assert.match(fixture.status.textContent, /Update ready.*Close all/);
});

test('updatefound fired before ready and an already-installing worker are both observed', async () => {
  for (const alreadyInstalling of [false, true]) {
    const current = registration(), installing = Object.assign(new EventTarget(), {state: 'installing'});
    if (alreadyInstalling) current.installing = installing;
    const fixture = harness(current, value => {
      if (!alreadyInstalling) {value.installing = installing; value.dispatchEvent(new Event('updatefound'));}
    });
    await fixture.prepareOffline();
    assert.match(fixture.status.textContent, /Downloading an offline update/);
    installing.state = 'installed'; current.installing = null; current.waiting = installing;
    installing.dispatchEvent(new Event('statechange'));
    assert.match(fixture.status.textContent, /Update ready.*Close all/);
  }
});

test('failed update retains existing offline version and reports the incomplete check', async () => {
  const current = registration();
  const fixture = harness(current, () => {throw new Error('Offline');});
  await fixture.prepareOffline();
  assert.match(fixture.status.textContent, /Saved offline version retained.*Update check did not finish/);
  assert.equal(current.active.state, 'activated');
});

test('failed update without any active version does not claim offline readiness', async () => {
  const current = registration(); current.active = null;
  const fixture = harness(current, () => {throw new Error('No connection');});
  await fixture.prepareOffline();
  assert.equal(fixture.status.textContent, 'Offline setup did not finish. Reopen while connected.');
});
