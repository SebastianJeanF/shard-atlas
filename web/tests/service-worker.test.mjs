import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile, mkdtemp, mkdir, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {runPython} from '../tools/python.mjs';
import {runInNewContext} from 'node:vm';

const workerSource = await readFile(new URL('../../web-dist/sw.js', import.meta.url), 'utf8');
function worker(cached, origin, network = async () => new Response('Network response')) {
  return runInNewContext(workerSource + '\n({navigation})', {
    self: {location: {origin}, addEventListener() {}},
    caches: {open: async () => ({match: async () => cached?.clone ? cached.clone() : cached})},
    fetch: network, URL, Request, Response,
  });
}

test('a real redirected cached HTML response is safe for manual-redirect navigation', async () => {
  const server = createServer((request, response) => {
    if (request.url === '/redirect') {response.writeHead(302, {Location: '/index.html'}); response.end();}
    else {response.writeHead(200, 'Atlas shell', {'Content-Type': 'text/html; charset=utf-8', 'X-Atlas-Release': 'test-release'}); response.end('<!doctype html><title>Shard Atlas</title>');}
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const origin = 'http://127.0.0.1:' + server.address().port;
    const cached = await fetch(origin + '/redirect');
    assert.equal(cached.redirected, true);
    const request = new Request(origin + '/', {redirect: 'manual'});
    const response = await worker(cached, origin).navigation(request, new URL(request.url));
    // The original worker returned cached directly, retaining redirected:true
    // and causing Fetch to reject this manual-redirect navigation.
    assert.equal(request.redirect, 'manual'); assert.equal(response.redirected, false);
    assert.equal(response.status, 200); assert.equal(response.statusText, 'Atlas shell');
    assert.equal(response.headers.get('X-Atlas-Release'), 'test-release');
    assert.equal(response.headers.get('Content-Type'), 'text/html; charset=utf-8');
    assert.equal(await response.text(), '<!doctype html><title>Shard Atlas</title>');
  } finally {server.closeAllConnections(); await new Promise(resolve => server.close(resolve));}
});

test('opaque, external, auth-path and non-HTML responses never replace the app shell', async () => {
  const origin = 'https://atlas.example', request = new Request(origin + '/', {redirect: 'manual'});
  for (const candidate of [
    {type: 'opaque', status: 0},
    {type: 'basic', status: 200, url: 'https://auth.example/index.html', headers: new Headers({'Content-Type': 'text/html'})},
    {type: 'basic', status: 200, url: origin + '/sign-in', headers: new Headers({'Content-Type': 'text/html'})},
    new Response('{}', {headers: {'Content-Type': 'application/json'}}),
    new Response('Not found', {status: 404, headers: {'Content-Type': 'text/html'}}),
  ]) {
    let calls = 0;
    const response = await worker(candidate, origin, async () => {calls++; return new Response('Network response');}).navigation(request, new URL(request.url));
    assert.equal(calls, 1); assert.equal(await response.text(), 'Network response');
  }
});

test('offline fallback normalizes a readable shell without modifying online auth responses', async () => {
  const origin = 'https://atlas.example', request = new Request(origin + '/other-page', {redirect: 'manual'});
  const shell = new Response('<title>Offline atlas</title>', {headers: {'Content-Type': 'text/html'}});
  const offline = await worker(shell, origin, async () => {throw new Error('Offline');}).navigation(request, new URL(request.url));
  assert.equal(offline.redirected, false); assert.equal(await offline.text(), '<title>Offline atlas</title>');
  const auth = {type: 'opaqueredirect', status: 0};
  const online = await worker(shell, origin, async () => auth).navigation(request, new URL(request.url));
  assert.equal(online, auth);
});

test('cache generation is stable and a worker-only change creates a new cache identity', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'atlas-worker-test-'));
  try {
    await mkdir(path.join(root, 'dist'));
    await writeFile(path.join(root, 'dist/index.html'), '<title>Shard Atlas</title>');
    await writeFile(path.join(root, 'dist/sw.js'), workerSource);
    const generate = () => runPython([fileURLToPath(new URL('../../tools/build_web.py', import.meta.url)), '--refresh-cache', path.join(root, 'dist')], {stdio: 'pipe'});
    const identity = async () => (await readFile(path.join(root, 'dist/sw.js'), 'utf8')).match(/const CACHE_NAME = '([^']+)'/)[1];
    generate(); const first = await identity();
    generate(); assert.equal(await identity(), first);
    await writeFile(path.join(root, 'dist/sw.js'), (await readFile(path.join(root, 'dist/sw.js'), 'utf8')) + '\n// Worker-only behavior change.\n');
    generate(); const second = await identity(); assert.notEqual(second, first);
    generate(); assert.equal(await identity(), second);
  } finally {await rm(root, {recursive: true, force: true});}
});
