#!/usr/bin/env node
// Lightweight DOM fixtures exercise rendering and form behavior without browser packages.
// Run with Node 18+ and Python 3.10+: node tests/test_frontend.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import vm from 'node:vm';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporary = await mkdtemp(path.join(tmpdir(), 'shard-atlas-frontend-'));
const html = fs.readFileSync(path.join(project, 'static/index.html'), 'utf8').replace(/<script[^>]*>[\s\S]*?<\/script>/g, '');
const timers = new Set();
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const decode = value => String(value).replace(/&(amp|quot|#39|lt|gt);/g, (_, name) => ({ amp: '&', quot: '"', '#39': "'", lt: '<', gt: '>' }[name]));
const attributes = source => Object.fromEntries([...source.matchAll(/([\w-]+)(?:="([^"]*)")?/g)].map(match => [match[1], decode(match[2] ?? '')]));

class Element {
  constructor(tag = 'div', attrs = {}, document = null) {
    this.tagName = tag.toUpperCase(); this.attrs = attrs; this.document = document;
    this.id = attrs.id || ''; this.name = attrs.name || ''; this.type = attrs.type || (tag === 'button' ? 'submit' : 'text');
    this.value = attrs.value || ''; this.defaultValue = this.value; this.dataset = {};
    this.hidden = 'hidden' in attrs; this.open = false; this.disabled = false; this.inert = false;
    this.style = {}; this.clientWidth = 900; this.clientHeight = 600; this.selectionStart = 0; this.selectionEnd = 0; this.listeners = new Map(); this._html = ''; this._text = '';
    for (const [key, value] of Object.entries(attrs)) if (key.startsWith('data-')) this.dataset[key.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = value;
    const classes = new Set((attrs.class || '').split(/\s+/).filter(Boolean));
    this.classList = { toggle: (name, force) => { const add = force ?? !classes.has(name); if (add) classes.add(name); else classes.delete(name); return add; }, remove: name => classes.delete(name) };
  }
  set innerHTML(value) {
    this._html = String(value);
    if (this.tagName === 'SELECT') {
      const options = [...this._html.matchAll(/<option([^>]*)>([\s\S]*?)<\/option>/g)];
      const option = options.find(match => /\bselected\b/.test(match[1])) || options[0];
      this.value = option ? (attributes(option[1]).value ?? decode(option[2])) : '';
    }
    this.document?.registerIds(this._html);
  }
  get innerHTML() { return this._html; }
  set textContent(value) { this._text = String(value); }
  get textContent() { return this._text || this._html.replace(/<[^>]*>/g, ' '); }
  addEventListener(name, callback) { const listeners = this.listeners.get(name) || []; listeners.push(callback); this.listeners.set(name, listeners); }
  dispatchEvent(event) { event.target = this; for (const listener of this.listeners.get(event.type) || []) listener(event); return !event.defaultPrevented; }
  showModal() { this.open = true; }
  close() { this.open = false; }
  focus() {}
  select() { this.selectionStart = 0; this.selectionEnd = this.value.length; }
  click() { this.dispatchEvent(new FixtureEvent('click')); }
  closest() { return null; }
  setRangeText(text, start, end) { this.value = this.value.slice(0, start) + text + this.value.slice(end); this.selectionStart = this.selectionEnd = start + text.length; }
  setAttribute(name, value) { this.attrs[name] = value; }
  getBoundingClientRect() { return { left: 0, top: 0, width: this.clientWidth, height: this.clientHeight }; }
  setPointerCapture() {}
  querySelector(selector) { return this.document?.querySelector(selector, this._html) || null; }
}
class Form extends Element {
  constructor(attrs, document) { super('form', attrs, document); this.elements = {}; }
  reset() { for (const element of Object.values(this.elements)) element.value = element.defaultValue; }
  requestSubmit() { this.dispatchEvent(new FixtureEvent('submit')); }
}
class FixtureEvent {
  constructor(type) { this.type = type; this.defaultPrevented = false; }
  preventDefault() { this.defaultPrevented = true; }
}
class FixtureFormData {
  constructor(form) { this.entries = Object.entries(form.elements).map(([name, element]) => [name, element.value]); }
  [Symbol.iterator]() { return this.entries[Symbol.iterator](); }
}
class FixtureFile extends Blob {
  constructor(parts, name, options) { super(parts, options); this.name = name; }
}
class FixtureFileReader {
  async readAsDataURL(file) { try { this.result = 'data:' + file.type + ';base64,' + Buffer.from(await file.arrayBuffer()).toString('base64'); this.onload?.(); } catch { this.onerror?.(); } }
}
class DocumentFixture {
  constructor(source) {
    this.source = source; this.ids = new Map(); this.named = new Map(); this.staticElements = []; this.listeners = new Map();
    this.body = new Element('body', {}, this); this.body._html = source;
    this.registerIds(source);
    for (const match of source.matchAll(/<form([^>]*)>([\s\S]*?)<\/form>/g)) {
      const attrs = attributes(match[1]), form = new Form(attrs, this); this.ids.set(form.id, form);
      form.dialogId = [...source.slice(0, match.index).matchAll(/<dialog[^>]*id="([^"]+)"/g)].at(-1)?.[1];
      for (const field of match[2].matchAll(/<(input|textarea|select)([^>]*)(?:>([\s\S]*?)<\/\1>|\s*\/?>)/g)) {
        const fieldAttrs = attributes(field[2]); if (!fieldAttrs.name) continue;
        const element = fieldAttrs.id ? this.ids.get(fieldAttrs.id) : new Element(field[1], fieldAttrs, this);
        if (field[1] === 'select') element.innerHTML = field[3] || '';
        if (field[1] === 'textarea') element.value = field[3] || '';
        element.defaultValue = element.value; form.elements[fieldAttrs.name] = element; this.named.set(fieldAttrs.name, element);
      }
    }
  }
  registerIds(source) {
    for (const match of source.matchAll(/<([a-z][\w-]*)([^>]*)>/gi)) {
      const attrs = attributes(match[2]);
      if (attrs.id && !this.ids.has(attrs.id)) this.ids.set(attrs.id, new Element(match[1], attrs, this));
      if ('data-view' in attrs) this.staticElements.push(new Element(match[1], attrs, this));
    }
  }
  querySelector(selector, inside = null) {
    if (selector.startsWith('#')) return this.ids.get(selector.slice(1)) || null;
    if (selector === 'dialog[open]') return [...this.ids.values()].find(element => element.tagName === 'DIALOG' && element.open) || null;
    const named = selector.match(/^\[name=([^\]]+)\]$/); if (named) return this.named.get(named[1]) || null;
    if (selector.startsWith('.')) {
      const className = selector.slice(1), sources = inside ? [inside] : [...this.ids.values()].map(element => element._html);
      for (const source of sources) for (const match of source.matchAll(/<([a-z][\w-]*)([^>]*)>/gi)) { const attrs = attributes(match[2]); if ((attrs.class || '').split(/\s+/).includes(className)) return new Element(match[1], attrs, this); }
    }
    return null;
  }
  querySelectorAll(selector) {
    if (selector === '[data-view]') return this.staticElements;
    if (selector === 'dialog form' || selector === 'dialog[open] form') return [...this.ids.values()].filter(element => element instanceof Form && (selector === 'dialog form' || this.ids.get(element.dialogId)?.open));
    return [];
  }
  addEventListener(name, callback) { const listeners = this.listeners.get(name) || []; listeners.push(callback); this.listeners.set(name, listeners); }
}

const server = spawn(process.env.SHARD_ATLAS_TEST_PYTHON || 'python3', ['-u', path.join(project, 'server.py'), '--db', path.join(temporary, 'atlas.sqlite3'), '--backup-dir', path.join(temporary, 'backups'), '--port', '0'], { cwd: project, stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = '', base, context;
server.stderr.on('data', chunk => { serverLog = (serverLog + chunk).slice(-4000); });
try {
  base = await new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error('Temporary server did not start. ' + serverLog)), 15000);
    let output = '';
    server.stdout.on('data', chunk => { output += chunk; const address = output.match(/http:\/\/127\.0\.0\.1:\d+/); if (address) { clearTimeout(deadline); resolve(address[0]); } });
    server.once('error', error => { clearTimeout(deadline); reject(error); });
    server.once('exit', code => { clearTimeout(deadline); reject(new Error('Temporary server exited (' + code + '). ' + serverLog)); });
  });
  const document = new DocumentFixture(html), storage = new Map();
  let ocrResponse = null, failBoardPut=false, boardPutGate=null, boardPutStarted=false;
  let failDelete = false, failDraftPut = false, failReleaseLoad = false, releaseResponse = null, activeWrites = 0, maxActiveWrites = 0;
  let failAiInstructions = false, failClipboard = false, aiInstructionsRequests = 0;
  let stateReadCount = 0, stateResponseGate = null;
  const instructionText = '# Add knowledge to Shard Atlas\n\nCheck for duplicates and verify every saved note.\n', clipboardWrites = [];
  const browserFetch = async (url, options = {}) => {
    const full = new URL(url, base), method = options.method || 'GET';
    if (method !== 'GET') { activeWrites++; maxActiveWrites = Math.max(maxActiveWrites, activeWrites); }
    try {
      if(method==='PUT'&&full.pathname.startsWith('/api/boards/')&&failBoardPut)return {ok:false,json:async()=>({error:'Simulated board save failure'})};
      if(method==='PUT'&&full.pathname.startsWith('/api/boards/')&&boardPutGate){const gate=boardPutGate;boardPutGate=null;const response=await fetch(full,options);boardPutStarted=true;await gate;return response;}
      if (full.pathname.startsWith('/api/assets/') && full.pathname.endsWith('/text') && ocrResponse) return {ok:true,json:async()=>ocrResponse};
      if (full.pathname === '/api/state' && method === 'GET') { stateReadCount++; if (stateResponseGate) { const response = await fetch(full, options); await stateResponseGate; return response; } }
      if (full.pathname === '/cpp-releases.json' && failReleaseLoad) return { ok: false, json: async () => ({ error: 'Simulated missing reference' }) };
      if (full.pathname === '/cpp-releases.json' && releaseResponse) return { ok: true, json: async () => releaseResponse };
      if (full.pathname === '/ai-instructions.md') { aiInstructionsRequests++; return { ok: !failAiInstructions, text: async () => instructionText }; }
      if (failDelete && method === 'DELETE' && full.pathname.startsWith('/api/drafts/')) return { ok: false, json: async () => ({ error: 'Simulated draft delete failure' }) };
      if (failDraftPut && method === 'PUT' && full.pathname.startsWith('/api/drafts/')) return { ok: false, json: async () => ({ error: 'Simulated draft save failure' }) };
      await delay(4); return await fetch(full, options);
    } finally { if (method !== 'GET') activeWrites--; }
  };
  const trackedSetTimeout = (callback, milliseconds) => { const timer = setTimeout(() => { timers.delete(timer); callback(); }, milliseconds); timers.add(timer); return timer; };
  const require = createRequire(import.meta.url);
  const windowListeners = new Map();
  const w = { document, addEventListener(name, callback) { const listeners = windowListeners.get(name) || []; listeners.push(callback); windowListeners.set(name, listeners); }, katex: require(path.join(project, 'static/vendor/katex/katex.min.js')), confirm: () => true };
  context = vm.createContext({ window: w, document, fetch: browserFetch, FormData: FixtureFormData, FileReader: FixtureFileReader, navigator: { clipboard: { writeText: async text => { if (failClipboard) throw new Error('Clipboard permission denied'); clipboardWrites.push(text); } } }, localStorage: { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value), removeItem: key=>storage.delete(key) }, setTimeout: trackedSetTimeout, clearTimeout: timer => { timers.delete(timer); clearTimeout(timer); }, console, Blob, URL });
  const code = fs.readFileSync(path.join(project, 'static/app.js'), 'utf8');
  vm.runInContext(code + '\nwindow.testAtlas={state,drafts,filteredShards,markdown,stabilizeWikiLinks,renderLibrary,renderGraphPage,renderTimeline,renderBoards,renderDetail,dateLabel,previewImport,saveBoard,openBoardEditor,fitBoard,boardBounds,recognizeImage,imageIdsInEditor,changeView,boardSaves,boardRecovery,loadBoardRecovery,markBoardChanged,renderDraftShelf,renderUndoSummary,jumpToBoardSection,jumpToBoardItem,sectionBoardBounds,shardReleaseIds,filteredReleaseFeatures,filteredReleaseShards,loadReleaseCatalog,openEditor,openLink,linkDirty,scheduleDraft,persistDraft,deleteDraft,writeRequest,runAction,closeDialog,showHistory,showRecovery,uploadImage,showWikiSuggestions,clearFilters,refreshAtlas,get pending(){return pendingWrites},get busy(){return busy},get editing(){return editingId}};', context, { filename: 'static/app.js' });
  const t = w.testAtlas, $ = selector => document.querySelector(selector), results = [];
  async function until(predicate) { for (let i = 0; i < 300; i++) { if (predicate()) return; await delay(10); } throw new Error('Timed out waiting for frontend state'); }
  async function get(url) { const response = await fetch(base + url), data = await response.json(); assert.ok(response.ok, JSON.stringify(data)); return data; }
  async function post(url, data, method = 'POST') { const response = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }), result = await response.json(); assert.ok(response.ok, JSON.stringify(result)); return result; }
  async function check(name, test) { await test(); results.push(name); }
  const submit = form => form.dispatchEvent(new FixtureEvent('submit'));

  await until(() => t.state.data.shards.length && $('.shard-card'));
  await until(() => t.pending === 0);
  await check('No Recall interface or editor prompt', async () => {
    assert.ok(!/recall|least reviewed|practice|questions to revisit/i.test(html + t.renderLibrary()));
    assert.equal($('[name=prompt]'), null); assert.ok(!/review/.test(t.renderLibrary()));
  });
  await check('Technical navigation exposes a focused library, graph, canvas and C++ reference', async () => {
    const nav=html.match(/<nav>([\s\S]*?)<\/nav>/)[1];assert.deepEqual([...nav.matchAll(/data-view="([^"]+)"/g)].map(match=>match[1]),['library','graph','boards','timeline']);assert.match(nav,/> Canvas</);assert.match(nav,/C\+\+ timeline/);
    for(const retired of ['entities','inbox','compare','ask']){t.changeView(retired);assert.equal(t.state.view,'library');}
    assert.equal(t.state.timelineMode,'releases');assert.ok(!/AI &amp; your events|Dated notes|timeline-modes/.test(t.renderTimeline()));assert.ok(!/\/api\/(?:ask|entities|capture\/preview)/.test(code));
  });
  await check('An empty atlas provides a concrete technical canvas creation path', async () => {
    const prior=t.state.data.boards;t.state.data.boards=[];const output=t.renderBoards();assert.match(output,/Create a technical canvas/);assert.match(output,/ownership and lifetimes/);assert.match(output,/data-action="new-board"/);assert.ok(!/career|salary|news|comparisons/i.test(output));t.state.data.boards=prior;
  });
  await check('Use with AI is discoverable and failed instruction loading can be retried', async () => {
    assert.ok((html.match(/data-action="use-ai"/g) || []).length >= 2);
    assert.match(html, /Start a new chat on this Mac/); assert.match(html, /without access to this Mac/);
    const originalCount = t.state.data.shards.length; $('#help-dialog').showModal(); failAiInstructions = true;
    await t.runAction('use-ai', { dataset: {} }); assert.ok($('#ai-dialog').open); assert.ok(!$('#help-dialog').open);
    assert.match($('#ai-instructions-status').textContent, /could not be opened/); assert.equal($('#ai-instructions-text').value, '');
    failAiInstructions = false; await t.runAction('copy-ai-instructions', { dataset: {} });
    assert.equal(clipboardWrites.at(-1), instructionText); assert.equal($('#ai-instructions-text').value, instructionText);
    assert.equal(aiInstructionsRequests, 2); assert.equal(t.state.data.shards.length, originalCount); assert.ok(!$('#copy-ai-instructions').disabled);
  });
  await check('AI instructions use native copying and visibly select text if browser copying fails', async () => {
    const nativeCopies = []; w.webkit = { messageHandlers: { nativeClipboard: { postMessage: payload => nativeCopies.push(payload.text) } } };
    await t.runAction('copy-ai-instructions', { dataset: {} }); assert.equal(nativeCopies[0], instructionText);
    delete w.webkit; failClipboard = true; await t.runAction('copy-ai-instructions', { dataset: {} });
    assert.ok($('#ai-instructions-panel').open); assert.equal($('#ai-instructions-text').selectionEnd, instructionText.length);
    assert.match($('#ai-instructions-status').textContent, /selected below/); assert.equal(aiInstructionsRequests, 2); failClipboard = false;
    $('#ai-instructions-text').selectionEnd = 0; await t.runAction('select-ai-instructions', { dataset: {} }); assert.equal($('#ai-instructions-text').selectionEnd, instructionText.length);
  });
  await check('AI archive handoff closes its dialog and opens the existing JSON picker', async () => {
    let pickerOpened = false; const file = $('#import-file'), originalClick = file.click; file.click = () => { pickerOpened = true; };
    await t.runAction('import-ai', { dataset: {} }); assert.ok(pickerOpened); assert.ok(!$('#ai-dialog').open); assert.equal(w.shardAtlasDesktop.filePickerType(), 'json'); file.click = originalClick;
    assert.match(html, /href="\/ai-instructions\.md" download="Shard Atlas AI instructions\.md"/);
  });
  await check('External additions refresh on focus while unchanged notes keep the rendered view intact', async () => {
    const workspace = $('#workspace'), existingView = workspace.innerHTML; workspace.innerHTML = existingView + '<!-- scroll position sentinel -->';
    await t.refreshAtlas(); assert.match(workspace.innerHTML, /scroll position sentinel/);
    const selected = t.state.selectedId;
    await post('/api/shards', { title: 'External chat contribution', content: 'Saved outside the current window.', tags: ['external-refresh-qa'] });
    for (const callback of windowListeners.get('focus') || []) callback(); await until(() => t.state.data.shards.some(shard => shard.title === 'External chat contribution'));
    assert.equal(t.state.selectedId, selected); assert.ok(!workspace.innerHTML.includes('scroll position sentinel'));
    document.visibilityState = 'hidden'; const reads = stateReadCount; assert.ok((await t.refreshAtlas()).skipped); assert.equal(stateReadCount, reads);
    document.visibilityState = 'visible'; for (const callback of document.listeners.get('visibilitychange') || []) callback(); await until(() => stateReadCount > reads);
    await t.refreshAtlas();
  });
  await check('Refresh skips open editors and pending writes, including edits started during a read', async () => {
    t.openEditor(); const reads = stateReadCount; assert.ok((await t.refreshAtlas()).skipped); assert.equal(stateReadCount, reads); $('#editor-dialog').close();
    const pending = t.writeRequest('/api/drafts/editor', 'PUT', { draft: { editingId: null, values: { title: 'Pending write guard', content: '' }, baseline: '{}', updatedAt: new Date().toISOString() } });
    assert.ok((await t.refreshAtlas()).skipped); await pending; await t.deleteDraft('editor');
    let releaseRead; stateResponseGate = new Promise(resolve => { releaseRead = resolve; }); const inFlight = t.refreshAtlas(); await until(() => stateReadCount > reads);
    t.openEditor(); $('#shard-title').value = 'Keep my unfinished idea'; releaseRead(); const result = await inFlight; stateResponseGate = null;
    assert.ok(result.skipped); assert.equal($('#shard-title').value, 'Keep my unfinished idea'); assert.ok($('#editor-dialog').open); $('#editor-dialog').close();
  });
  await check('Refresh notes in the AI dialog displays newly saved content without closing the handoff', async () => {
    await t.runAction('use-ai', { dataset: {} }); await post('/api/shards', { title: 'Second external contribution', content: 'Ready to find.', tags: [] });
    await t.runAction('refresh-ai-notes', { dataset: {} }); assert.ok($('#ai-dialog').open); assert.match($('#ai-refresh-status').textContent, /latest notes/);
    assert.ok(t.state.data.shards.some(shard => shard.title === 'Second external contribution'));
    await t.runAction('refresh-ai-notes', { dataset: {} }); assert.match($('#ai-refresh-status').textContent, /up to date/); assert.ok(!$('#refresh-ai-notes').disabled); $('#ai-dialog').close();
  });
  await check('Multi-topic AND/OR and understanding filters', async () => {
    const first = t.state.data.shards.find(shard => shard.tags.length >= 2); assert.ok(first);
    t.state.tags = Array.from(first.tags.slice(0, 2)); t.state.tagMode = 'all';
    const all = Array.from(t.filteredShards(), shard => shard.id); assert.ok(all.includes(first.id));
    t.state.tagMode = 'any'; const any = Array.from(t.filteredShards(), shard => shard.id); assert.ok(all.every(id => any.includes(id)));
    t.state.status = 'verify'; assert.ok(t.filteredShards().every(shard => shard.status === 'verify')); t.clearFilters();
  });
  await check('Release timeline uses explicit versions and keeps reference separate from notes', async () => {
    await until(() => t.state.releaseCatalog || t.state.releaseCatalogError);
    const previousCatalog = t.state.releaseCatalog, previousShards = t.state.data.shards;
    t.state.releaseCatalog = { schemaVersion: 1, coverage: 'Fixture reference coverage.', sources: [{ id: 'standard', title: 'WG21 fixture', url: 'https://www.open-std.org/jtc1/sc22/wg21/' }], releases: [
      { id: 'cpp11', label: 'C++11', year: 2011, status: 'published', summary: 'Modern foundations.', sourceIds: ['standard'], features: [{ id: 'move', title: 'Move semantics', summary: 'Transfer resources.', category: 'language', tags: ['ownership', 'types'], sourceIds: ['standard'] }, { id: 'threads', title: 'Threads', summary: 'Concurrent execution.', category: 'library', tags: ['concurrency'], sourceIds: ['standard'] }] },
      { id: 'cpp26', label: 'C++26', year: 2026, status: 'draft', summary: 'Work in progress.', sourceIds: ['standard'], features: [] }
    ] };
    t.state.data.shards = [ { ...previousShards[0], id: 'explicit', title: 'My move note', languageVersion: 'C++11 / C++26', tags: ['ownership'] }, { ...previousShards[0], id: 'unknown', title: 'Unassigned source note', languageVersion: 'C++ notes', tags: ['types'] } ];
    assert.deepEqual(Array.from(t.shardReleaseIds(t.state.data.shards[0])), ['cpp11', 'cpp26']);
    assert.deepEqual(Array.from(t.shardReleaseIds({ languageVersion: 'Lecture 11, C++2011, C++230, pre-C++11, before C++17' })), []);
    assert.deepEqual(Array.from(t.shardReleaseIds({ languageVersion: 'C++11 or later' })), ['cpp11']);
    t.state.timelineMode='releases'; const output = t.renderTimeline();
    assert.match(output, /id="release-track"/); assert.match(output, /data-action="jump-release"/); assert.match(output, /Working draft/); assert.match(output, /Notes without a release/); assert.match(output, /Your notes <span>1/); assert.match(output, /Release reference/); assert.match(output, /href="https:\/\/www.open-std.org/);
    assert.equal(t.state.data.shards.length, 2); assert.ok(!/Practice recall|Try recalling/i.test(output)); assert.match(output, /<details class="release-own-notes"><summary>Your notes/);
    $('#workspace').innerHTML = output; let jumpedTo = null; $('#release-track').offsetLeft = 260; $('#release-cpp11').offsetLeft = 723; $('#release-track').scrollTo = options => { jumpedTo = options.left; }; await t.runAction('jump-release', { dataset: { id: 'cpp11' } }); assert.equal(jumpedTo, 723);
    t.state.tags = ['Ownership', 'TYPES']; t.state.tagMode = 'all'; assert.equal(t.filteredReleaseFeatures(t.state.releaseCatalog.releases[0]).length, 1); assert.equal(t.filteredReleaseShards().length, 0);
    t.state.tagMode = 'any'; assert.equal(t.filteredReleaseShards().length, 2);
    t.clearFilters(); t.state.releaseCategory = 'library'; assert.equal(t.filteredReleaseFeatures(t.state.releaseCatalog.releases[0])[0].id, 'threads');
    t.clearFilters(); t.state.query = 'transfer resources'; assert.equal(t.filteredReleaseFeatures(t.state.releaseCatalog.releases[0])[0].id, 'move');
    t.clearFilters(); t.state.releaseCatalog = previousCatalog; t.state.data.shards = previousShards;
  });
  await check('C++ release loading failure never blocks the atlas', async () => {
    const previousCatalog = t.state.releaseCatalog;
    t.state.timelineMode = 'releases'; t.state.releaseCatalog = null; failReleaseLoad = true;
    await t.loadReleaseCatalog(); assert.match(t.renderTimeline(), /reference could not open/); assert.match(t.renderTimeline(), /reload-releases/); assert.ok(t.renderLibrary().includes('Build your technical understanding'));
    failReleaseLoad = false; releaseResponse = { schemaVersion: 1, coverage: 'Test reference.', sources: [], releases: [] }; await t.loadReleaseCatalog(); assert.equal(t.state.releaseCatalogError, null); assert.ok(t.state.releaseCatalog);
    releaseResponse = null; t.state.releaseCatalog = previousCatalog;
  });
  await check('Relationship editing and rationale/endpoint search', async () => {
    const link = t.state.data.links[0]; assert.ok(link); t.openLink(null, link.id);
    $('#link-form').elements.note.value = 'unique rationalefind reasoning'; $('#link-form').elements.type.value = 'contrasts_with';
    submit($('#link-form')); await until(() => !$('#link-dialog').open && !t.busy);
    const updated = t.state.data.links.find(item => item.id === link.id); assert.equal(updated.note, 'unique rationalefind reasoning'); assert.equal(updated.type, 'contrasts_with');
    t.state.query = 'rationalefind'; const found = Array.from(t.filteredShards(), shard => shard.id); assert.ok(found.includes(link.fromId) && found.includes(link.toId)); t.state.query = '';
  });
  await check('New connections use six technical relationships while legacy types survive editing', async () => {
    const from=t.state.data.shards[0],to=t.state.data.shards[1],types=['depends_on','explains','contrasts_with','example_of','related_to','part_of'];t.openLink(from.id);let form=$('#link-form');assert.deepEqual([...form.elements.type.innerHTML.matchAll(/value="([^"]+)"/g)].map(match=>match[1]),types);$('#link-dialog').close();
    await post('/api/links',{fromId:from.id,toId:to.id,type:'released_by',note:'Legacy relationship context'});t.state.data=await get('/api/state');const legacy=t.state.data.links.find(link=>link.fromId===from.id&&link.toId===to.id&&link.type==='released_by');t.openLink(null,legacy.id);assert.equal(form.elements.type.value,'released_by');assert.match(form.elements.type.innerHTML,/value="released_by"/);form.elements.note.value='Preserved legacy relationship context';submit(form);await until(()=>!$('#link-dialog').open&&!t.busy);assert.equal(t.state.data.links.find(link=>link.id===legacy.id).type,'released_by');
    t.openLink(from.id);assert.ok(!form.elements.type.innerHTML.includes('released_by'));$('#link-dialog').close();
  });
  await check('Relationship explanations preserve direction from both connected notes', async () => {
    const links=t.state.data.links,from=t.state.data.shards[0],to=t.state.data.shards[1];for(const [type,forward,inverse] of [['part_of','is part of','contains'],['depends_on','depends on','is a dependency of'],['supports','supports','is supported by'],['supersedes','supersedes','is superseded by']]){t.state.data.links=[{id:'direction-check',fromId:from.id,toId:to.id,type,note:''}];assert.ok(t.renderDetail(from).includes('This idea '+forward+'</span>'),type);assert.ok(t.renderDetail(to).includes('This idea '+inverse+'</span>'),type);}t.state.data.links=links;
  });
  await check('Graph topic/kind coloring, grouping and legend', async () => {
    t.state.graphColor = 'kind'; t.state.graphGroup = 'kind'; const output = t.renderGraphPage();
    assert.match(output, /graph-category-legend/); assert.match(output, /graph-group-label/); assert.match(output, /Concept/); assert.match(output, /style="fill:#[a-f0-9]+/); t.state.graphGroup = 'none';
  });
  await check('Offline math, safe HTML, local images, and stable wikilinks', async () => {
    const target = t.state.data.shards[0]; assert.match(t.markdown('$x^2$\n\n$$\\frac{a}{b}$$'), /class="katex"/);
    assert.ok(!t.markdown('$\\href{https://example.com}{link}$').includes('<a href'));
    assert.match(t.markdown('<script>alert(1)</script>'), /&lt;script&gt;/); assert.ok(!t.markdown('`$x$`').includes('class="katex"'));
    assert.match(t.markdown('![Picture](/assets/image.v1:copy)'), /src="\/assets\/image.v1:copy"/); assert.ok(!t.markdown('![Bad](https://example.com/image.png)').includes('<img'));
    const stable = t.stabilizeWikiLinks('[[' + target.title + ']]'); assert.ok(stable.includes('id:' + target.id));
    const oldTitle = target.title; target.title = 'Renamed but same identity'; assert.ok(t.markdown(stable).includes('data-shard-id="' + target.id + '"')); target.title = oldTitle;
    assert.ok(t.markdown('`[[' + oldTitle + ']]`').includes('<code>'));
  });
  await check('Reverted editor draft clears local and durable recovery', async () => {
    t.openEditor(); $('#shard-title').value = 'Temporary draft'; t.scheduleDraft('editor'); await t.persistDraft('editor');
    assert.equal((await get('/api/drafts')).drafts.editor.values.title, 'Temporary draft');
    $('#shard-title').value = ''; t.scheduleDraft('editor'); await until(() => t.pending === 0);
    assert.equal(t.drafts.editor, null); assert.equal((await get('/api/drafts')).drafts.editor, null); t.closeDialog('editor-dialog'); assert.ok(!$('#editor-dialog').open);
  });
  await check('Failed draft deletion retains recoverable draft', async () => {
    t.openEditor(); $('#shard-title').value = 'Retain me'; t.scheduleDraft('editor'); await t.persistDraft('editor');
    failDelete = true; await assert.rejects(t.deleteDraft('editor')); assert.equal(t.drafts.editor.values.title, 'Retain me');
    assert.equal((await get('/api/drafts')).drafts.editor.values.title, 'Retain me'); failDelete = false; await t.deleteDraft('editor'); $('#editor-dialog').close();
  });
  await check('Dirty connection close requires explicit choice and failed keep stays open', async () => {
    t.openLink(t.state.data.shards[0].id); $('#link-form').elements.note.value = 'Unfinished connection rationale'; t.scheduleDraft('connection');
    assert.ok(t.linkDirty()); t.closeDialog('link-dialog'); assert.ok($('#draft-close-dialog').open && $('#link-dialog').open);
    failDraftPut = true; await assert.rejects(t.runAction('close-keep', { dataset: {} })); assert.ok($('#link-dialog').open);
    failDraftPut = false; await t.runAction('close-keep', { dataset: {} }); assert.ok(!$('#link-dialog').open);
    assert.equal((await get('/api/drafts')).drafts.connection.values.note, 'Unfinished connection rationale'); await t.deleteDraft('connection');
  });
  await check('All writes serialize and native saving covers pending queue', async () => {
    const first = t.writeRequest('/api/drafts/editor', 'PUT', { draft: { values: { title: 'Queued 1' }, updatedAt: new Date().toISOString() } });
    const second = t.writeRequest('/api/drafts/editor', 'PUT', { draft: { values: { title: 'Queued 2' }, updatedAt: new Date().toISOString() } });
    assert.ok(w.shardAtlasDesktop.status().saving); await Promise.all([first, second]);
    assert.equal((await get('/api/drafts')).drafts.editor.values.title, 'Queued 2'); assert.equal(maxActiveWrites, 1);
    await t.deleteDraft('editor'); assert.ok(!w.shardAtlasDesktop.status().saving);
  });
  await check('Successful new save survives draft cleanup failure without duplicate mode', async () => {
    const before = t.state.data.shards.length; t.openEditor(); $('#shard-title').value = 'Saved despite draft cleanup'; $('#shard-content').value = 'Proof of robust save';
    t.scheduleDraft('editor'); await t.persistDraft('editor'); failDelete = true; submit($('#editor-form')); await until(() => !$('#editor-dialog').open && !t.busy);
    assert.equal(t.state.data.shards.length, before + 1); assert.ok(t.editing); assert.equal(t.drafts.editor.editingId, t.editing);
    failDelete = false; await t.deleteDraft('editor');
  });
  await check('Revision, trash and snapshot recovery UI consumes real API lists', async () => {
    const saved = t.state.data.shards.find(shard => shard.title === 'Saved despite draft cleanup'); t.state.data = await post('/api/shards/' + saved.id, { title: 'Later title' }, 'PUT');
    await t.showHistory(saved.id); assert.match($('#history-content').innerHTML, /Restore this version/); $('#history-dialog').close();
    t.state.data = await post('/api/shards/' + saved.id, {}, 'DELETE'); await t.showRecovery('trash'); assert.match($('#recovery-content').innerHTML, /Restore shard/); $('#recovery-dialog').close();
    await t.showRecovery('backups'); assert.match($('#recovery-content').innerHTML, /Restore snapshot/); $('#recovery-dialog').close();
  });
  await check('Native image/JSON file picker type and offline KaTeX resources', async () => {
    t.openEditor(); await t.runAction('upload-image', { dataset: {} }); assert.equal(w.shardAtlasDesktop.filePickerType(), 'image');
    await t.runAction('import', { dataset: {} }); assert.equal(w.shardAtlasDesktop.filePickerType(), 'json'); $('#editor-dialog').close();
    for (const url of ['/vendor/katex/katex.min.js', '/vendor/katex/katex.min.css', '/vendor/katex/fonts/KaTeX_Main-Regular.woff2']) assert.equal((await fetch(base + url)).status, 200);
  });
  await check('Actual PNG upload inserts a durable local image into the draft', async () => {
    t.openEditor(); const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7m8AAAAASUVORK5CYII=', 'base64');
    await t.uploadImage(new FixtureFile([image], 'attachment-qa.png', { type: 'image/png' }));
    assert.match($('#shard-content').value, /!\[attachment-qa.png\]\(\/assets\/[A-Za-z0-9_.:-]+\)/); await t.persistDraft('editor');
    assert.match((await get('/api/drafts')).drafts.editor.values.content, /\/assets\//); await t.deleteDraft('editor'); $('#editor-dialog').close();
  });
  await check('Saving an existing note preserves legacy prompt metadata', async () => {
    const existing = t.state.data.shards.find(shard => shard.prompt); assert.ok(existing); const prior = existing.prompt;
    t.openEditor(existing.id); $('#shard-content').value += '\n\nMetadata preservation check.'; submit($('#editor-form')); await until(() => !$('#editor-dialog').open && !t.busy);
    assert.equal(t.state.data.shards.find(shard => shard.id === existing.id).prompt, prior);
  });
  await check('Wiki suggestions create stable ID links without submitting the editor', async () => {
    t.openEditor(); const target = t.state.data.shards[0], field = $('#shard-content'); field.value = 'Read [[' + target.title.slice(0, 4); field.selectionStart = field.selectionEnd = field.value.length;
    t.showWikiSuggestions(); assert.ok(!$('#wiki-suggestions').hidden); assert.equal($('.wiki-suggestion').type, 'button');
    await t.runAction('insert-wiki', { dataset: { id: target.id } }); assert.ok(field.value.includes('[[id:' + target.id + '|')); assert.ok($('#editor-dialog').open);
    await t.deleteDraft('editor'); $('#editor-dialog').close();
  });

  await check('Image OCR is reviewable and appends only accepted text without replacing the original', async () => {
    t.openEditor();const field=$('#shard-content');field.value='My original explanation.\n\n![Screenshot](/assets/ocr-fixture)';ocrResponse={text:'std::unique_ptr<int> owns the pointer',available:true,method:'macos-vision'};await t.recognizeImage('ocr-fixture');assert.equal(field.value,'My original explanation.\n\n![Screenshot](/assets/ocr-fixture)');assert.match($('#image-recognition').innerHTML,/std::unique_ptr/);assert.equal(Array.from(t.imageIdsInEditor())[0],'ocr-fixture');$('#recognized-text').value='std::unique_ptr<int>, checked transcription.';
    await t.runAction('append-recognized-text',{dataset:{}});assert.match(field.value,/My original explanation/);assert.match(field.value,/!\[Screenshot\]\(\/assets\/ocr-fixture\)/);assert.match(field.value,/checked transcription/);assert.ok($('#image-recognition').hidden);
    ocrResponse={text:'',available:false,method:'unavailable'};await t.recognizeImage('ocr-fixture');assert.match($('#image-recognition').innerHTML,/unavailable on this device/);assert.match(field.value,/checked transcription/);ocrResponse=null;await t.deleteDraft('editor');$('#editor-dialog').close();
  });
  await check('Technical source editing preserves legacy metadata without restoring news controls', async () => {
    const legacy={title:'Move semantics source fixture',content:'Original C++ explanation.',kind:'event',tags:['C++','ownership'],languageVersion:'C++11',evidenceStatus:'reported',eventDate:'2026-10',eventType:'research',publicationDate:'2026',entities:['Company, Inc.'],inbox:true,facts:[{label:'Saved measurement',value:'64',unit:'bytes',sourceUrl:'https://example.com/move',asOf:'2026-10'}],sources:[{url:'https://example.com/move',title:'Move semantics reference',publishedDate:'2026-10',accessedDate:'2026-10-14',note:'Original source context.'}]};
    await post('/api/shards',legacy);t.state.data=await get('/api/state');const original=t.state.data.shards.find(shard=>shard.title===legacy.title);t.openEditor(original.id);const form=$('#editor-form');form.elements.content.value='Revised C++ explanation.';submit(form);await until(()=>!$('#editor-dialog').open&&!t.busy);
    const saved=t.state.data.shards.find(shard=>shard.id===original.id);assert.equal(saved.content,'Revised C++ explanation.');for(const key of ['kind','evidenceStatus','eventDate','eventType','publicationDate','entities','inbox','facts','sources'])assert.equal(JSON.stringify(saved[key]),JSON.stringify(original[key]),key);
    assert.equal(t.state.view,'library');assert.match(t.renderLibrary(),/Move semantics source fixture/);const detail=t.renderDetail(saved);assert.match(detail,/Supporting sources/);assert.match(detail,/Move semantics reference/);assert.ok(!/Evidence &amp; context|data-action="entity"|data-view="compare"/.test(detail));
    t.openEditor();assert.ok(!form.elements.kind.innerHTML.includes('value="event"'));$('#editor-dialog').close();
    for(const name of ['evidenceStatus','eventDate','eventType','publicationDate','verifiedDate','entityType','entities','inbox','facts'])assert.equal(form.elements[name].type,'hidden',name);
  });
  await check('Saved boards preserve geometry, collapsed sections and viewport through HTTP', async () => {
    await t.runAction('new-board',{dataset:{}});const form=$('#board-form');form.elements.title.value='C++ connections QA';form.elements.description.value='Shared notes, spatial arrangement';submit(form);await until(()=>!$('#board-dialog').open&&!t.busy);
    const board=t.state.data.boards.find(b=>b.title==='C++ connections QA');assert.ok(board);const shard=t.state.data.shards[0];board.items=[{shardId:shard.id,x:-20,y:60,width:270,height:210,sectionId:'research'}];board.sections=[{id:'research',title:'Research',x:-50,y:0,width:700,height:500,collapsed:true}];board.viewport={x:40,y:80,zoom:.2};await t.saveBoard(board);
    const persisted=(await get('/api/state')).boards.find(b=>b.id===board.id);assert.equal(persisted.items[0].x,-20);assert.equal(persisted.sections[0].collapsed,true);assert.equal(persisted.viewport.zoom,.2);t.state.boardId=board.id;assert.match(t.renderBoards(),/board-minimap/);assert.match(t.renderBoards(),/Research/);assert.match(t.renderBoards(),/0 visible \/ 1 saved cards/);
    await t.runAction('toggle-section',{dataset:{id:'research'}});await until(()=>t.pending===0);await delay(350);await until(()=>t.pending===0);assert.match(t.renderBoards(),/data-board-card=/);t.state.view='library';
  });
  await check('Import preview is read-only, confirmation produces a receipt and undo preserves edited notes', async () => {
    const count=(await get('/api/state')).shards.length;await t.previewImport({schemaVersion:1,shards:[{id:'frontend-preview-note',title:'Preview fixture',content:'Original import text',tags:[]}],links:[],boards:[]},'QA import');assert.ok($('#import-preview-dialog').open);assert.equal((await get('/api/state')).shards.length,count);await t.runAction('confirm-import',{dataset:{}});assert.ok(!$('#import-preview-dialog').open);assert.ok(t.state.data.shards.some(s=>s.id==='frontend-preview-note'));const receipt=(await get('/api/imports')).imports[0];assert.ok(receipt.id);
    await post('/api/shards/frontend-preview-note',{title:'Edited after import'},'PUT');await t.runAction('undo-import',{dataset:{id:receipt.id}});$('#confirm-action').click();await until(()=>!$('#confirm-dialog').open&&!t.busy);assert.equal((await get('/api/state')).shards.find(s=>s.id==='frontend-preview-note').title,'Edited after import');$('#recovery-dialog').close();
  });
  await check('Large connection maps disclose the bounded graph instead of forcing every imported node', async () => {
    const previous=t.state.data.shards,base=previous[0];t.state.data.shards=Array.from({length:250},(_,i)=>({...base,id:'large-'+i,title:'Large note '+i,tags:[]}));t.state.graphScope='all';const output=t.renderGraphPage();assert.equal((output.match(/data-graph-id=/g)||[]).length,100);assert.match(output,/Showing the first 100 matches/);t.state.data.shards=previous;
  });

  await check('Exact imported JSON remains available in a collapsed disclosure', async () => {
    const content='Readable imported explanation.\n\nOriginal Lucid shape data:\n```json\n{"text":"Original <source>","x":123}\n```';const output=t.markdown(content);assert.match(output,/<details class="diagram-provenance"><summary>Original diagram data/);assert.match(output,/Readable imported explanation/);assert.match(output,/Original &lt;source&gt;/);assert.ok(!/<details[^>]* open/.test(output));assert.ok(!t.markdown('```json\n{"a":1}\n```').includes('diagram-provenance'));
  });
  await check('Unchanged comma-containing entity names survive an explanation-only edit', async () => {
    await post('/api/shards',{title:'Punctuation fixture',content:'Original explanation.',entities:['Company, Inc.'],tags:[]});t.state.data=await get('/api/state');const shard=t.state.data.shards.find(s=>s.title==='Punctuation fixture');t.openEditor(shard.id);assert.equal($('#editor-form').elements.entities.value,'Company, Inc.');$('#shard-content').value='Revised explanation only.';submit($('#editor-form'));await until(()=>!$('#editor-dialog').open&&!t.busy);assert.deepEqual(Array.from(t.state.data.shards.find(s=>s.id===shard.id).entities),['Company, Inc.']);
  });
  await check('Board saves reconcile the original board after switching while a response is pending', async () => {
    const initial=t.state.data.boards[0],shard=t.state.data.shards[0];await post('/api/boards',{title:'Second board race fixture',items:[{shardId:shard.id,x:50,y:60,width:200,height:120,sectionId:''}],sections:[],viewport:{x:0,y:0,zoom:1}});t.state.data=await get('/api/state');let a=t.state.data.boards.find(b=>b.id===initial.id),b=t.state.data.boards.find(b=>b.title==='Second board race fixture');t.state.boardId=a.id;let release;boardPutGate=new Promise(resolve=>{release=resolve;});boardPutStarted=false;a.items[0].x=123;t.markBoardChanged(a);const pending=t.saveBoard(a);await until(()=>boardPutStarted);t.state.boardId=b.id;b.items[0].x=987;t.markBoardChanged(b);release();await pending;assert.equal(t.state.data.boards.find(board=>board.id===a.id).items[0].x,123);assert.equal(t.state.data.boards.find(board=>board.id===b.id).items[0].x,987);await delay(350);await until(()=>t.pending===0);assert.equal((await get('/api/state')).boards.find(board=>board.id===b.id).items[0].x,987);
  });
  await check('A failed board autosave survives a simulated restart and offers reviewable recovery', async () => {
    const board=t.state.data.boards[0];t.state.boardId=board.id;board.items[0].x=777;failBoardPut=true;t.markBoardChanged(board);assert.equal(await t.saveBoard(board),false);assert.ok(w.shardAtlasDesktop.status().dirty);t.boardSaves.clear();t.boardRecovery.clear();t.state.data=await get('/api/state');t.loadBoardRecovery();t.renderDraftShelf();assert.ok(t.boardRecovery.has(board.id));assert.match($('#draft-shelf').innerHTML,/Restore arrangement/);failBoardPut=false;await t.runAction('restore-board-draft',{dataset:{id:board.id}});$('#confirm-action').click();await until(()=>!$('#confirm-dialog').open&&!t.busy&&t.pending===0);assert.equal((await get('/api/state')).boards.find(b=>b.id===board.id).items[0].x,777);assert.ok(!t.boardRecovery.has(board.id));
  });
  await check('Missing board cards and undo-preserved records expose recovery context', async () => {
    const board=t.state.data.boards[0],items=board.items;t.state.boardId=board.id;board.items=[...items,{shardId:'unavailable-shard',x:0,y:0,width:200,height:100,sectionId:''}];assert.match(t.renderBoards(),/reference unavailable notes/);assert.match(t.renderBoards(),/Recently deleted/);board.items=items;const output=t.renderUndoSummary({removed:{shards:2},skipped:[{kind:'shards',id:'preserved-note',reason:'used by a later connection'}]});assert.match(output,/1 records preserved/);assert.match(output,/used by a later connection/);
  });
  await check('Dollar amounts remain literal while numeric and symbolic inline math still render', async () => {
    for(const text of ['$487,000 to $701,000','$450K','$558,000/year to $636,000/year','$100–$200','$450K-$700K']){const output=t.markdown(text);assert.ok(!output.includes('class="katex"'),text);assert.ok(output.includes(text),text);}
    const mixed=t.markdown('Cost $100 followed later by $x+1$.');assert.match(mixed,/Cost \$100 followed later/);assert.match(mixed,/class="katex"/);assert.match(t.markdown('$5+3$'),/class="katex"/);assert.match(t.markdown('$5 + 3$'),/class="katex"/);assert.match(t.markdown('`$100` and $x$'),/<code>\$100<\/code>/);assert.match(t.markdown('[$100](https://example.com/a)'),/>\$100 ↗<\/a>/);
  });

  await check('Full-chart section and search jumps keep headings readable and persist viewport', async () => {
    const board=t.state.data.boards[0],originalSections=board.sections,originalItems=board.items,originalViewport=board.viewport,shard=t.state.data.shards[0];t.state.boardId=board.id;t.state.view='boards';board.sections=[{id:'huge-timeline',title:'C++ language map',x:100,y:20000,width:4000,height:100000,collapsed:true},{id:'date-divider',title:'Value categories',x:100,y:22000,width:800,height:500,collapsed:false}];board.items=[{shardId:shard.id,x:130,y:20100,width:270,height:200,sectionId:'huge-timeline'}];board.viewport={x:0,y:0,zoom:.01};$('#workspace').innerHTML=t.renderBoards();assert.match($('#workspace').innerHTML,/id="board-section-jump"/);assert.match($('#workspace').innerHTML,/Value categories/);assert.match($('#workspace').innerHTML,/Find on this canvas/);t.jumpToBoardSection('huge-timeline');assert.ok(board.viewport.zoom>=.25&&board.viewport.zoom<=1.2);assert.equal(Math.round(board.viewport.y+board.sections[0].y*board.viewport.zoom),32);assert.equal(board.sections[0].collapsed,false);await t.saveBoard(board);assert.equal((await get('/api/state')).boards.find(b=>b.id===board.id).viewport.zoom,board.viewport.zoom);t.jumpToBoardItem(board.items[0]);assert.equal(board.viewport.zoom,1.2);await t.saveBoard(board);board.sections=originalSections;board.items=originalItems;board.viewport=originalViewport;await t.saveBoard(board);t.state.view='library';
  });

  await check('Original arrows connect shared heading notes without duplicate cards', async () => {
    const board=t.state.data.boards[0],originalSections=board.sections,originalItems=board.items,originalLinks=t.state.data.links,heading=t.state.data.shards[0],child=t.state.data.shards[1];t.state.boardId=board.id;board.sections=[{id:'heading-section',title:'Ownership',shardId:heading.id,x:0,y:0,width:900,height:600,collapsed:false}];board.items=[{shardId:heading.id,x:0,y:0,width:900,height:70,sectionId:''},{shardId:child.id,x:120,y:140,width:250,height:180,sectionId:'heading-section'}];t.state.data.links=[{id:'heading-arrow',fromId:heading.id,toId:child.id,type:'supports',note:'Original heading connection'}];let output=t.renderBoards();assert.match(output,new RegExp('class="section-note-open" data-shard-id="'+heading.id+'"'));assert.match(output,/aria-label="Move section Ownership"/);assert.equal((output.match(/data-board-card=/g)||[]).length,1);const edges=output.split('class="board-connections"')[1].split('</svg>')[0];assert.match(edges,/<line /);assert.match(edges,/supports/);board.sections[0].shardId='missing-heading-note';output=t.renderBoards();assert.match(output,/saved canvas reference.*reference unavailable notes/);assert.match(output,/Recently deleted/);board.sections=originalSections;board.items=originalItems;t.state.data.links=originalLinks;
  });

  console.log(results.length + ' frontend checks passed.');
  for (const result of results) console.log('  ✓ ' + result);
} catch (error) {
  console.error(error); process.exitCode = 1;
} finally {
  for (const timer of timers) clearTimeout(timer);
  if (server.exitCode === null && server.signalCode === null) {
    const exited = new Promise(resolve => server.once('exit', resolve)); server.kill('SIGTERM');
    let timeout; await Promise.race([exited, new Promise(resolve => { timeout = setTimeout(() => { server.kill('SIGKILL'); resolve(); }, 3000); })]); clearTimeout(timeout);
  }
  await rm(temporary, { recursive: true, force: true });
}
