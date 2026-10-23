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
    this.style = {}; this.clientWidth = 900; this.clientHeight = 600; this.naturalWidth = 0; this.naturalHeight = 0; this.scrollLeft = 0; this.scrollTop = 0; this.selectionStart = 0; this.selectionEnd = 0; this.listeners = new Map(); this._html = ''; this._text = '';
    for (const [key, value] of Object.entries(attrs)) if (key.startsWith('data-')) this.dataset[key.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = value;
    const classes = new Set((attrs.class || '').split(/\s+/).filter(Boolean));
    this.classList = { contains: name => classes.has(name), toggle: (name, force) => { const add = force ?? !classes.has(name); if (add) classes.add(name); else classes.delete(name); return add; }, remove: name => classes.delete(name) };
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
  dispatchEvent(event) { event.target ||= this; event.currentTarget = this; for (const listener of this.listeners.get(event.type) || []) listener(event); if (event.bubbles && !event.propagationStopped) this.document?.dispatchEvent(event); return !event.defaultPrevented; }
  showModal() { this.open = true; }
  close() { this.open = false; }
  focus() { if (this.document) this.document.activeElement = this; }
  select() { this.selectionStart = 0; this.selectionEnd = this.value.length; }
  click() { this.dispatchEvent(new FixtureEvent('click')); }
  closest() { return null; }
  setRangeText(text, start, end) { this.value = this.value.slice(0, start) + text + this.value.slice(end); this.selectionStart = this.selectionEnd = start + text.length; }
  setAttribute(name, value) { this.attrs[name] = value; }
  removeAttribute(name) { delete this.attrs[name]; if (name === 'src') this.src = ''; }
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
  constructor(type, options = {}) { this.type = type; this.defaultPrevented = false; Object.assign(this, options); }
  preventDefault() { this.defaultPrevented = true; }
  stopPropagation() { this.propagationStopped = true; }
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
    if (selector === 'dialog[open]') return [...this.ids.values()].filter(element => element.tagName === 'DIALOG' && element.open);
    if (selector === 'dialog form' || selector === 'dialog[open] form') return [...this.ids.values()].filter(element => element instanceof Form && (selector === 'dialog form' || this.ids.get(element.dialogId)?.open));
    return [];
  }
  addEventListener(name, callback) { const listeners = this.listeners.get(name) || []; listeners.push(callback); this.listeners.set(name, listeners); }
  dispatchEvent(event) { event.target ||= this; event.currentTarget = this; for (const listener of this.listeners.get(event.type) || []) listener(event); return !event.defaultPrevented; }
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
  let apiWrites = 0;
  let ocrResponse = null, failBoardPut=false, boardPutGate=null, boardPutStarted=false;
  let failDelete = false, failDraftPut = false, failReleaseLoad = false, releaseResponse = null, failSpiralLoad = false, spiralResponse = null, reducedMotion = false, activeWrites = 0, maxActiveWrites = 0;
  let failAiInstructions = false, failClipboard = false, aiInstructionsRequests = 0;
  let stateReadCount = 0, stateResponseGate = null, releaseReadCount = 0, releaseResponseGate = null;
  let importPreviewGate = null, importPreviewStarted = false;
  const previewObjectUrls = new Set(), revokedPreviewUrls = [];
  class FixtureURL extends URL {
    static createObjectURL(blob) { const url = URL.createObjectURL(blob); previewObjectUrls.add(url); return url; }
    static revokeObjectURL(url) { revokedPreviewUrls.push(url); previewObjectUrls.delete(url); URL.revokeObjectURL(url); }
  }
  let instructionText = '# Add knowledge to Shard Atlas\n\nCheck for duplicates and verify every saved note.\n';
  const clipboardWrites = [];
  const browserFetch = async (url, options = {}) => {
    const full = new URL(url, base), method = options.method || 'GET';
    if (method !== 'GET') { apiWrites++; activeWrites++; maxActiveWrites = Math.max(maxActiveWrites, activeWrites); }
    try {
      if (full.pathname === '/api/import/preview' && importPreviewGate) { const gate = importPreviewGate; importPreviewGate = null; const response = await fetch(full, options); importPreviewStarted = true; await gate; return response; }
      if(method==='PUT'&&full.pathname.startsWith('/api/boards/')&&failBoardPut)return {ok:false,json:async()=>({error:'Simulated board save failure'})};
      if(method==='PUT'&&full.pathname.startsWith('/api/boards/')&&boardPutGate){const gate=boardPutGate;boardPutGate=null;const response=await fetch(full,options);boardPutStarted=true;await gate;return response;}
      if (full.pathname.startsWith('/api/assets/') && full.pathname.endsWith('/text') && ocrResponse) return {ok:true,json:async()=>ocrResponse};
      if (full.pathname === '/api/state' && method === 'GET') { stateReadCount++; if (stateResponseGate) { const response = await fetch(full, options); await stateResponseGate; return response; } }
      if (full.pathname === '/cpp-releases.json') { releaseReadCount++; if (releaseResponseGate) await releaseResponseGate; }
      if (full.pathname === '/cpp-releases.json' && failReleaseLoad) return { ok: false, json: async () => ({ error: 'Simulated missing reference' }) };
      if (full.pathname === '/cpp-releases.json' && releaseResponse) return { ok: true, json: async () => releaseResponse };
      if (full.pathname === '/spiral-timeline.json' && failSpiralLoad) return { ok: false, json: async () => ({ error: 'Simulated missing world guide' }) };
      if (full.pathname === '/spiral-timeline.json' && spiralResponse) return { ok: true, json: async () => spiralResponse };
      if (full.pathname === '/ai-instructions.md') { assert.equal(options.cache, 'no-store'); aiInstructionsRequests++; return { ok: !failAiInstructions, text: async () => instructionText }; }
      if (failDelete && method === 'DELETE' && full.pathname.startsWith('/api/drafts/')) return { ok: false, json: async () => ({ error: 'Simulated draft delete failure' }) };
      if (failDraftPut && method === 'PUT' && full.pathname.startsWith('/api/drafts/')) return { ok: false, json: async () => ({ error: 'Simulated draft save failure' }) };
      await delay(4); return await fetch(full, options);
    } finally { if (method !== 'GET') activeWrites--; }
  };
  // Exercise refresh explicitly below; background polling must not replace synthetic fixture collections.
  const trackedSetTimeout = (callback, milliseconds) => { if (milliseconds === 15000) return null; const timer = setTimeout(() => { timers.delete(timer); callback(); }, milliseconds); timers.add(timer); return timer; };
  const require = createRequire(import.meta.url);
  const windowListeners = new Map();
  const w = { document, matchMedia: () => ({ matches: reducedMotion }), addEventListener(name, callback) { const listeners = windowListeners.get(name) || []; listeners.push(callback); windowListeners.set(name, listeners); }, katex: require(path.join(project, 'static/vendor/katex/katex.min.js')), confirm: () => true };
  context = vm.createContext({ window: w, document, fetch: browserFetch, FormData: FixtureFormData, FileReader: FixtureFileReader, navigator: { clipboard: { writeText: async text => { if (failClipboard) throw new Error('Clipboard permission denied'); clipboardWrites.push(text); } } }, localStorage: { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value), removeItem: key=>storage.delete(key) }, setTimeout: trackedSetTimeout, clearTimeout: timer => { timers.delete(timer); clearTimeout(timer); }, console, Blob, URL: FixtureURL, atob: value => Buffer.from(value, 'base64').toString('binary') });
  for (const filename of ['academic.js','learning.js','experiments.js','import-review.js']) vm.runInContext(fs.readFileSync(path.join(project,'static',filename),'utf8'),context,{filename});
  const code = fs.readFileSync(path.join(project, 'static/app.js'), 'utf8');
  vm.runInContext(code + '\nwindow.testAtlas={renderExperiments,saveExperimentConfiguration,attachExperimentDraft,copyExperimentSetup,canRefreshAtlas,state,drafts,openImageViewer,imageViewerLoaded,imageViewerFailed,fitImageViewer,setImageViewerScale,zoomImageViewer,handleImageViewerKey,get imageViewer(){return imageViewer},filteredShards,subjectMemberships,renderCourses,reviewedImport,revalidateImport,get importIncluded(){return importIncluded},markdown,stabilizeWikiLinks,renderNav,renderLibrary,renderTimeline,renderBoards,atlasModel,atlasRelationshipModel,renderAtlas,renderDetail,dateLabel,previewImport,clearImportPreview,selectImportShard,get importImageUrls(){return importImageUrls},saveBoard,openBoardEditor,fitBoard,boardBounds,recognizeImage,imageIdsInEditor,changeView,boardSaves,boardRecovery,loadBoardRecovery,markBoardChanged,renderDraftShelf,renderUndoSummary,jumpToBoardSection,jumpToBoardItem,sectionBoardBounds,shardReleaseIds,filteredReleaseFeatures,filteredReleaseShards,renderReleaseFeature,loadReleaseCatalog,loadSpiralCatalog,setTimelineTheme,savedTimelineTheme,filteredSpiralExamples,handlePortalKey,openEditor,openLink,linkDirty,scheduleDraft,persistDraft,deleteDraft,writeRequest,runAction,closeDialog,showHistory,showRecovery,uploadImage,showWikiSuggestions,clearFilters,refreshAtlas,get pending(){return pendingWrites},get busy(){return busy},get editing(){return editingId}};', context, { filename: 'static/app.js' });
  const t = w.testAtlas, $ = selector => document.querySelector(selector), results = [];
  async function until(predicate) { for (let i = 0; i < 300; i++) { if (predicate()) return; await delay(10); } throw new Error('Timed out waiting for frontend state'); }
  async function get(url) { const response = await fetch(base + url), data = await response.json(); assert.ok(response.ok, JSON.stringify(data)); return data; }
  async function post(url, data, method = 'POST') { const response = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }), result = await response.json(); assert.ok(response.ok, JSON.stringify(result)); return result; }
  async function check(name, test) { await test(); results.push(name); }
  const submit = form => form.dispatchEvent(new FixtureEvent('submit'));
  const searchTopics = query => { const input = $('#topic-search'); input.value = query; input.dispatchEvent(new FixtureEvent('input', { bubbles: true })); };
  const pressTopicKey = (key, options = {}) => { const event = new FixtureEvent('keydown', { key, bubbles: true, ...options }); $('#topic-search').dispatchEvent(event); return event; };
  const topicButtons = () => [...$('#topic-list').innerHTML.matchAll(/<button([^>]*)>([\s\S]*?)<\/button>/g)].map(match => ({ ...attributes(match[1]), count: Number(match[2].match(/<small>(\d+)<\/small>/)?.[1]) })).filter(button => button['data-tag']);
  async function withTopicCollection(shards, test) {
    const previous = { ...t.state };
    try { t.state.data = { ...previous.data, shards, links: [] }; t.clearFilters(); t.changeView('library'); await test(); }
    finally { Object.assign(t.state, previous); $('#search').value = t.state.query; t.renderNav(); }
  }
  async function withTimelineCollection(test) {
    const previous = { ...t.state }, baseShard = previous.data.shards[0];
    try {
      t.state.data = { ...previous.data, links: [], shards: [
        { ...baseShard, id: 'explicit', title: 'My move note', content: 'Resources move in this example.', languageVersion: 'C++11 / C++26', tags: ['ownership'] },
        { ...baseShard, id: 'unknown', title: 'Unassigned source note', content: 'An unversioned explanation.', languageVersion: 'C++ notes', tags: ['types'] },
        { ...baseShard, id: 'excluded-version', title: 'Older implementation note', content: 'A bounded earlier implementation.', languageVersion: 'pre-C++11, before C++17', tags: ['ownership'] }
      ] };
      t.state.releaseCatalog = { schemaVersion: 1, coverage: 'Fixture reference coverage.', sources: [{ id: 'standard', title: 'WG21 fixture', url: 'https://www.open-std.org/jtc1/sc22/wg21/' }], releases: [
        { id: 'cpp11', label: 'C++11', year: 2011, status: 'published', summary: 'Modern foundations.', sourceIds: ['standard'], features: [{ id: 'move', title: 'Move semantics', summary: 'Transfer resources.', category: 'language', tags: ['ownership', 'types'], sourceIds: ['standard'] }, { id: 'threads', title: 'Threads', summary: 'Concurrent execution.', category: 'library', tags: ['concurrency'], sourceIds: ['standard'] }] },
        { id: 'cpp26', label: 'C++26', year: 2026, status: 'draft', summary: 'Work in progress.', sourceIds: ['standard'], features: [] }
      ] };
      t.state.releaseCatalogError = null; t.state.timelineContent = 'both'; t.clearFilters(); t.changeView('timeline');
      await test();
    } finally { Object.assign(t.state, previous); $('#search').value = t.state.query; t.renderNav(); }
  }
  async function withAtlasCollection(test, records = null) {
    const previous = { ...t.state }, baseShard = previous.data.shards[0];
    const shards = records || [
      { ...baseShard, id: 'atlas-a', title: 'Alpha classes', content: 'alpha-only marker', tags: ['Templates', 'Classes', 'templates', ' C++ '] },
      { ...baseShard, id: 'atlas-b', title: 'Beta memory', content: 'beta-only marker', tags: ['Classes', 'Memory'] },
      { ...baseShard, id: 'atlas-c', title: 'Gamma templates', content: 'gamma-only marker', tags: ['Templates', 'Memory', 'LucidChart'] },
      { ...baseShard, id: 'atlas-d', title: 'Organizational note', content: 'organization-only marker', tags: ['C++', 'Images'] },
      { ...baseShard, id: 'atlas-e', title: 'Untagged note', content: 'untagged-only marker', tags: [] }
    ];
    try {
      t.state.data = { ...previous.data, shards, links: records ? [] : [
        { id: 'atlas-ab', fromId: 'atlas-a', toId: 'atlas-b', type: 'depends_on', note: 'A needs B first.' },
        { id: 'atlas-bc', fromId: 'atlas-b', toId: 'atlas-c', type: 'explains', note: 'B explains C.' },
        { id: 'atlas-cd', fromId: 'atlas-c', toId: 'atlas-d', type: 'related_to', note: 'Recorded association.' },
        { id: 'atlas-missing', fromId: 'atlas-a', toId: 'missing-shard', type: 'related_to', note: 'An unavailable archive endpoint.' }
      ] };
      t.clearFilters(); Object.assign(t.state, { atlasMode: 'topics', atlasTopic: null, atlasSelectedId: null, atlasInspectId: null, atlasExpandedIds: [], atlasShowOrganizational: false, atlasRelation: 'all', atlasBridge: null, atlasLimit: 12, atlasZoom: 1, atlasFit: false });
      await test();
    } finally { Object.assign(t.state, previous); $('#search').value = t.state.query; t.renderNav(); }
  }
  const atlasSnapshot = model => JSON.stringify({
    shards: Array.from(model.shards, shard => shard.id),
    topics: model.topics,
    overlaps: model.overlaps,
    memberships: Array.from(model.memberships)
  });
  const timelineShardIds = output => [...output.matchAll(/class="release-note"[^>]*data-shard-id="([^"]+)"/g)].map(match => match[1]);
  async function withWorldTimeline(test) {
    await withTimelineCollection(async () => {
      t.state.releaseCatalog = JSON.parse(fs.readFileSync(path.join(project, 'static/cpp-releases.json'), 'utf8'));
      t.state.spiralCatalog = JSON.parse(fs.readFileSync(path.join(project, 'static/spiral-timeline.json'), 'utf8'));
      t.state.timelineTheme = 'spiral'; t.state.timelineReleaseId = 'cpp98';
      $('#workspace').innerHTML = t.renderTimeline();
      await test();
    });
  }
  const openingAttributes = (markup, tag, className) => [...markup.matchAll(new RegExp('<' + tag + '([^>]*)>', 'g'))]
    .map(match => attributes(match[1])).filter(attrs => (attrs.class || '').split(/\s+/).includes(className));
  const shardReleaseGroups = markup => [...markup.matchAll(/<div class="shard-release-chips"([^>]*)>([\s\S]*?)<\/div>/g)]
    .map(match => ({ ...attributes(match[1]), markup: match[2], chips: openingAttributes(match[2], 'span', 'shard-release-chip') }));
  async function withReleaseNavigation(test) {
    const query = document.querySelector, workspace = $('#workspace'), trace = { scrolls: [], reveals: [], focus: [] };
    const track = new Element('div', { id: 'release-track' }, document), columns = new Map();
    track.scrollTo = options => trace.scrolls.push(options);
    track.scrollIntoView = options => trace.reveals.push(options);
    for (const [index, release] of t.state.releaseCatalog.releases.entries()) {
      const column = new Element('section', { id: 'release-' + release.id }, document);
      column.offsetLeft = index * 360;
      column.focus = options => { document.activeElement = column; trace.focus.push({ id: column.id, ...options }); };
      columns.set('#' + column.id, column);
    }
    document.querySelector = function(selector, inside) {
      if (selector === '#release-track' || columns.has(selector)) {
        // The lightweight fixture otherwise retains IDs from replaced markup.
        if (!workspace.innerHTML.includes('id="' + selector.slice(1) + '"')) return null;
        return selector === '#release-track' ? track : columns.get(selector);
      }
      return query.call(this, selector, inside);
    };
    try { await test(trace); }
    finally { document.querySelector = query; reducedMotion = false; }
  }

  await until(() => t.state.data.shards.length && $('.shard-card'));
  await until(() => t.pending === 0);
  await check('No Recall interface or editor prompt', async () => {
    assert.ok(!/recall|least reviewed|practice|questions to revisit/i.test(html + t.renderLibrary()));
    assert.equal($('[name=prompt]'), null); assert.ok(!/review/.test(t.renderLibrary()));
  });
  await check('Technical navigation offers Library, Courses, Experiments, Topic map, and C++ timeline without retired views', async () => {
    const nav=html.match(/<nav>([\s\S]*?)<\/nav>/)[1];assert.deepEqual([...nav.matchAll(/data-view="([^"]+)"/g)].map(match=>match[1]),['library','courses','experiments','atlas','timeline']);assert.match(nav,/> Topic map</);assert.ok(!/data-view="(?:boards|graph)"|> (?:Canvas|Connections)</.test(nav));assert.match(nav,/C\+\+ timeline/);
    for(const retired of ['entities','inbox','compare','ask']){t.changeView(retired);assert.equal(t.state.view,'library');}
    t.changeView('boards');assert.equal(t.state.view,'atlas');assert.equal($('#view-label').textContent,'Topic map');assert.ok(!/data-action="(?:new-board|edit-board|add-board-item|add-section)"/.test($('#workspace').innerHTML));t.changeView('library');
    for(const view of ['library','atlas','timeline']){t.changeView(view);assert.ok(!/Ideas belong together\.|class="graph-controls"|id="graph-(?:color|group)"|data-view="graph"/.test($('#workspace').innerHTML),view);}t.changeView('library');
    assert.equal(t.state.timelineMode,'releases');assert.ok(!/AI &amp; your events|Dated notes|timeline-modes/.test(t.renderTimeline()));assert.ok(!/\/api\/(?:ask|entities|capture\/preview)/.test(code));
  });
  await check('Topic neighborhoods retain every membership and count case variants once', async () => {
    await withAtlasCollection(async () => {
      const model=t.atlasModel(),topics=Object.fromEntries(Array.from(model.topics,topic=>[topic.key,topic]));
      assert.deepEqual(Object.keys(topics).sort(),['classes','memory','templates']);
      assert.deepEqual(Array.from(topics.classes.shardIds),['atlas-a','atlas-b']);
      assert.deepEqual(Array.from(topics.templates.shardIds),['atlas-a','atlas-c']);
      assert.deepEqual(Array.from(model.memberships.get('atlas-a')),['classes','templates']);
      for(const topic of model.topics){assert.equal(topic.count,2);assert.match(topic.color,/^#[a-f0-9]{6}$/i);}
      const overlaps=Array.from(model.overlaps,pair=>({a:pair.a,b:pair.b,count:pair.count,ids:Array.from(pair.shardIds)})).sort((a,b)=>(a.a+a.b).localeCompare(b.a+b.b));
      assert.deepEqual(overlaps,[{a:'classes',b:'memory',count:1,ids:['atlas-b']},{a:'classes',b:'templates',count:1,ids:['atlas-a']},{a:'memory',b:'templates',count:1,ids:['atlas-c']}]);
      assert.deepEqual(Array.from(model.unmappedShards,shard=>shard.id).sort(),['atlas-d','atlas-e']);
    });
  });
  await check('Organizational topics can be included without losing untagged notes', async () => {
    await withAtlasCollection(async () => {
      const hidden=t.atlasModel(),shown=t.atlasModel(t.filteredShards(),true),topics=new Map(Array.from(shown.topics,topic=>[topic.key,topic]));
      assert.equal(hidden.topics.some(topic=>topic.key==='c++'),false);assert.deepEqual(Array.from(topics.get('c++').shardIds),['atlas-a','atlas-d']);
      assert.equal(topics.get('lucidchart').count,1);assert.equal(topics.get('images').count,1);
      assert.deepEqual(Array.from(shown.unmappedShards,shard=>shard.id),['atlas-e']);
      t.state.atlasShowOrganizational=true;assert.equal(t.atlasModel().topics.length,shown.topics.length);
      const tags=['C++','LucidChart','Images','Links','Source material','Tables','Code examples'];
      const organizationalOnly={...t.state.data.shards[0],id:'org-only',tags};assert.equal(t.atlasModel([organizationalOnly],false).topics.length,0);assert.equal(t.atlasModel([organizationalOnly],true).topics.length,tags.length);
    });
  });
  await check('Automatic topic models and rendering are stable without changing saved knowledge', async () => {
    await withAtlasCollection(async () => {
      const original=JSON.stringify(t.state.data),first=atlasSnapshot(t.atlasModel()),markup=t.renderAtlas();
      t.state.data={...t.state.data,shards:[...t.state.data.shards].reverse(),links:[...t.state.data.links].reverse()};
      assert.equal(atlasSnapshot(t.atlasModel()),first);assert.equal(t.renderAtlas(),markup);
      t.state.data={...t.state.data,shards:[...t.state.data.shards].reverse(),links:[...t.state.data.links].reverse()};
      assert.equal(JSON.stringify(t.state.data),original);assert.ok(!/data-action="(?:new-board|edit-board|add-board-item|add-section)"/.test(markup));
      assert.match(markup,/shared shards/i);assert.match(markup,/Untagged note/);assert.match(markup,/Organizational note/);
    });
  });
  await check('Topic maps honor filters and provide useful empty states', async () => {
    await withAtlasCollection(async () => {
      t.state.query='gamma-only';const filtered=t.atlasModel();assert.deepEqual(Array.from(filtered.shards,shard=>shard.id),['atlas-c']);
      assert.deepEqual(Array.from(filtered.topics,topic=>topic.key).sort(),['memory','templates']);assert.ok(filtered.topics.every(topic=>topic.count===1));
      t.state.query='no-such-topic-map-note';assert.equal(t.atlasModel().shards.length,0);assert.match(t.renderAtlas(),/No (?:matching|shards match)/i);
    });
    await withAtlasCollection(async () => {assert.equal(t.atlasModel().topics.length,0);const output=t.renderAtlas();assert.match(output,/shard/i);assert.ok(!/data-action="new-board"/.test(output));},[]);
  });
  await check('A filtered-out neighborhood cannot leave an invisible overlap filter active', async () => {
    const baseShard=t.state.data.shards[0];
    await withAtlasCollection(async () => {
      await t.runAction('atlas-overlap',{dataset:{id:'classes',other:'templates'}});
      const cardIds=()=>openingAttributes(t.renderAtlas(),'button','atlas-shard-open').map(attrs=>attrs['data-id']);
      assert.deepEqual(cardIds(),['bridge-origin']);
      t.state.query='filtered-map';const model=t.atlasModel();assert.equal(model.topics.some(topic=>topic.key==='classes'),false);assert.equal(model.topics.some(topic=>topic.key==='templates'),true);
      assert.deepEqual(cardIds().sort(),['eligible-memory','eligible-template']);
      assert.match(t.renderAtlas(),/Explore your shards/);assert.ok(!t.renderAtlas().includes('Classes ∩ Templates'));
    },[
      {...baseShard,id:'bridge-origin',title:'Original bridge',content:'Original intersection.',tags:['Classes','Templates']},
      {...baseShard,id:'eligible-template',title:'Template result',content:'filtered-map result',tags:['Templates']},
      {...baseShard,id:'eligible-memory',title:'Memory result',content:'filtered-map result',tags:['Memory']}
    ]);
  });
  await check('Topic shard lists honor selected sorting while map neighborhoods remain stable', async () => {
    const baseShard=t.state.data.shards[0];
    await withAtlasCollection(async () => {
      const cardIds=()=>openingAttributes(t.renderAtlas(),'button','atlas-shard-open').map(attrs=>attrs['data-id']);
      const model=atlasSnapshot(t.atlasModel());
      t.state.sort='updated';assert.deepEqual(cardIds(),['sort-zeta','sort-beta','sort-alpha']);assert.equal(atlasSnapshot(t.atlasModel()),model);
      t.state.sort='title';assert.deepEqual(cardIds(),['sort-alpha','sort-beta','sort-zeta']);assert.equal(atlasSnapshot(t.atlasModel()),model);
      t.state.sort='created';assert.deepEqual(cardIds(),['sort-alpha','sort-zeta','sort-beta']);assert.equal(atlasSnapshot(t.atlasModel()),model);
    },[
      {...baseShard,id:'sort-zeta',title:'Zeta',content:'Sorting example.',tags:['Templates'],updatedAt:'2026-10-16T12:00:00Z',createdAt:'2026-02-01T12:00:00Z'},
      {...baseShard,id:'sort-alpha',title:'Alpha',content:'Sorting example.',tags:['Classes'],updatedAt:'2026-10-14T12:00:00Z',createdAt:'2026-03-01T12:00:00Z'},
      {...baseShard,id:'sort-beta',title:'Beta',content:'Sorting example.',tags:['Memory'],updatedAt:'2026-10-15T12:00:00Z',createdAt:'2026-01-01T12:00:00Z'}
    ]);
  });
  await check('Focused exploration uses directed recorded links rather than topic overlap', async () => {
    await withAtlasCollection(async () => {
      t.state.atlasMode='connections';t.state.atlasSelectedId='atlas-a';
      let model=t.atlasRelationshipModel();assert.deepEqual(Array.from(model.nodes,shard=>shard.id).sort(),['atlas-a','atlas-b']);
      assert.deepEqual(Array.from(model.edges,link=>({id:link.id,fromId:link.fromId,toId:link.toId,type:link.type})),[{id:'atlas-ab',fromId:'atlas-a',toId:'atlas-b',type:'depends_on'}]);
      assert.equal(model.frontierCount,1);assert.equal(model.hiddenByNode.get('atlas-b'),1);
      // A and C share Templates, but only the recorded A→B link belongs in this first step.
      assert.equal(model.nodes.some(shard=>shard.id==='atlas-c'),false);
      t.state.atlasExpandedIds=['atlas-b'];model=t.atlasRelationshipModel();assert.deepEqual(Array.from(model.nodes,shard=>shard.id).sort(),['atlas-a','atlas-b','atlas-c']);
      assert.deepEqual(Array.from(model.edges,link=>link.id).sort(),['atlas-ab','atlas-bc']);assert.equal(model.frontierCount,1);
      t.state.atlasExpandedIds=['atlas-b','atlas-c'];model=t.atlasRelationshipModel();assert.deepEqual(Array.from(model.nodes,shard=>shard.id).sort(),['atlas-a','atlas-b','atlas-c','atlas-d']);assert.equal(model.frontierCount,0);
      t.state.atlasSelectedId='atlas-b';t.state.atlasExpandedIds=[];model=t.atlasRelationshipModel();const incoming=model.edges.find(link=>link.id==='atlas-ab');assert.equal(incoming.fromId,'atlas-a');assert.equal(incoming.toId,'atlas-b');
    });
  });
  await check('Relationship exploration respects filters and refuses hidden or unreachable expansions', async () => {
    await withAtlasCollection(async () => {
      t.state.atlasMode='connections';t.state.atlasSelectedId='atlas-a';t.state.atlasExpandedIds=['atlas-c'];
      assert.deepEqual(Array.from(t.atlasRelationshipModel().nodes,shard=>shard.id).sort(),['atlas-a','atlas-b']);
      t.state.atlasRelation='depends_on';t.state.atlasExpandedIds=['atlas-b'];const typed=t.atlasRelationshipModel();assert.deepEqual(Array.from(typed.nodes,shard=>shard.id).sort(),['atlas-a','atlas-b']);assert.equal(typed.edges[0].type,'depends_on');
      t.state.atlasRelation='all';t.state.tags=['Classes'];const filtered=t.atlasRelationshipModel();assert.deepEqual(Array.from(filtered.nodes,shard=>shard.id).sort(),['atlas-a','atlas-b']);assert.ok(filtered.edges.every(link=>link.fromId!=='atlas-c'&&link.toId!=='atlas-c'));
      t.state.tags=[];t.state.atlasSelectedId='atlas-e';t.state.atlasExpandedIds=[];const isolated=t.atlasRelationshipModel();assert.deepEqual(Array.from(isolated.nodes,shard=>shard.id),['atlas-e']);assert.equal(isolated.edges.length,0);assert.equal(isolated.frontierCount,0);
    });
  });
  await check('Topic and connection exploration changes only local view state', async () => {
    await withAtlasCollection(async () => {
      await until(()=>t.pending===0);const before=JSON.stringify(t.state.data),writes=apiWrites;
      t.changeView('atlas');await t.runAction('atlas-topic',{dataset:{id:'templates'}});assert.equal(t.state.atlasTopic,'templates');
      await t.runAction('atlas-select',{dataset:{id:'atlas-a'}});assert.equal(t.state.atlasMode,'connections');assert.equal(t.state.atlasSelectedId,'atlas-a');
      await t.runAction('atlas-expand',{dataset:{id:'atlas-b'}});assert.ok(t.state.atlasExpandedIds.includes('atlas-b'));
      await t.runAction('atlas-inspect',{dataset:{id:'atlas-c'}});assert.equal(t.state.atlasInspectId,'atlas-c');assert.equal(t.state.atlasSelectedId,'atlas-a');
      t.state.tags=['Classes'];await t.runAction('atlas-reset',{dataset:{}});assert.deepEqual(Array.from(t.state.tags),['Classes']);assert.equal(t.state.atlasExpandedIds.length,0);
      await t.runAction('atlas-mode',{dataset:{id:'topics'}});assert.equal(t.state.atlasMode,'topics');
      assert.equal(apiWrites,writes);assert.equal(JSON.stringify(t.state.data),before);t.changeView('library');
    });
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
    assert.match($('#ai-instructions-status').textContent, /selected below/); assert.equal(aiInstructionsRequests, 4); failClipboard = false;
    $('#ai-instructions-text').selectionEnd = 0; await t.runAction('select-ai-instructions', { dataset: {} }); assert.equal($('#ai-instructions-text').selectionEnd, instructionText.length);
    assert.equal(aiInstructionsRequests, 4);
  });
  await check('Opening and copying AI instructions refreshes changed guidance and never copies a stale fallback', async () => {
    const requests = aiInstructionsRequests, writes = apiWrites;
    instructionText = '# Updated Shard Atlas guide\n\nExplain every release assignment.\n';
    $('#ai-dialog').close(); await t.runAction('use-ai', { dataset: {} });
    assert.equal(aiInstructionsRequests, requests + 1); assert.equal($('#ai-instructions-text').value, instructionText);
    instructionText += '\nLabel runnable and illustrative examples accurately.\n';
    await t.runAction('copy-ai-instructions', { dataset: {} });
    assert.equal(aiInstructionsRequests, requests + 2); assert.equal(clipboardWrites.at(-1), instructionText);
    instructionText += '\nKeep useful caveats with their claim.\n'; failClipboard = true;
    await t.runAction('copy-ai-instructions', { dataset: {} }); failClipboard = false;
    assert.equal(aiInstructionsRequests, requests + 3); assert.equal($('#ai-instructions-text').value, instructionText);
    assert.equal($('#ai-instructions-text').selectionEnd, instructionText.length);
    const copies = clipboardWrites.length; failAiInstructions = true;
    await assert.rejects(t.runAction('copy-ai-instructions', { dataset: {} }), /could not be opened/);
    assert.equal(clipboardWrites.length, copies); assert.equal($('#ai-instructions-text').value, '');
    assert.ok(!$('#copy-ai-instructions').disabled); failAiInstructions = false;
    assert.equal(apiWrites, writes);
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
  await check('Topic search finds late custom keywords across the entire collection', async () => {
    const baseShard = t.state.data.shards[0], rare = 'Zyzzyva custom constexpr keyword';
    const shards = Array.from({ length: 480 }, (_, index) => ({ ...baseShard, id: 'topic-inventory-' + index, title: 'Topic fixture ' + index, content: 'An independent note.', tags: ['Custom topic ' + String(index).padStart(3, '0')] }));
    shards.push({ ...baseShard, id: 'rare-keyword', title: 'Rare keyword source', tags: [rare] });
    await withTopicCollection(shards, async () => {
      assert.equal(topicButtons().length, 481);
      const workspace = $('#workspace').innerHTML, input = $('#topic-search'); input.focus(); input.selectionStart = input.selectionEnd = 8;
      searchTopics('ZYZZYVA custom');
      assert.deepEqual(topicButtons().map(button => button['data-tag']), [rare]);
      assert.equal(topicButtons()[0].count, 1); assert.match($('#topic-search-status').textContent, /1 of 481/);
      assert.equal($('#workspace').innerHTML, workspace); assert.equal($('#topic-search'), input); assert.equal(document.activeElement, input);
      assert.equal(t.state.query, ''); assert.equal(t.filteredShards().length, 481);
      searchTopics(''); assert.equal(topicButtons().length, 481);
    });
  });
  await check('Topic lookup preserves selected filters and the independent note search', async () => {
    const baseShard = t.state.data.shards[0];
    await withTopicCollection([
      { ...baseShard, id: 'topic-selected', title: 'Needle example', content: 'Needle explanation.', kind: 'concept', status: 'verify', tags: ['Ownership', 'Lifetimes'] },
      { ...baseShard, id: 'topic-other', title: 'Other example', tags: ['Consteval'] }
    ], async () => {
      t.state.tags = ['Ownership', 'Lifetimes']; t.state.tagMode = 'any'; t.state.kind = 'concept'; t.state.status = 'verify'; t.state.query = 'needle'; $('#search').value = 'needle'; t.renderNav();
      const filtered = Array.from(t.filteredShards(), shard => shard.id), before = $('#workspace').innerHTML;
      searchTopics('const');
      assert.deepEqual(topicButtons().map(button => button['data-tag']), ['Consteval']);
      assert.ok(!$('#selected-topic-filters').hidden);
      for (const tag of t.state.tags) assert.ok($('#selected-topic-filters').innerHTML.includes('data-tag="' + tag + '"'));
      assert.deepEqual(Array.from(t.filteredShards(), shard => shard.id), filtered); assert.equal($('#workspace').innerHTML, before);
      assert.deepEqual(Array.from(t.state.tags), ['Ownership', 'Lifetimes']); assert.equal(t.state.tagMode, 'any'); assert.equal(t.state.kind, 'concept'); assert.equal(t.state.status, 'verify'); assert.equal(t.state.query, 'needle'); assert.equal($('#search').value, 'needle');
      await t.runAction('clear-topic-search', { dataset: {} });
      assert.equal($('#topic-search').value, ''); assert.equal(t.state.topicQuery, ''); assert.ok($('#clear-topic-search').hidden);
      assert.deepEqual(Array.from(t.state.tags), ['Ownership', 'Lifetimes']); assert.equal(t.state.query, 'needle'); assert.equal($('#search').value, 'needle'); assert.equal(t.state.status, 'verify');
      searchTopics('const'); await t.runAction('clear-filters', { dataset: {} });
      assert.equal(t.state.topicQuery, ''); assert.equal($('#topic-search').value, ''); assert.equal(t.state.query, ''); assert.equal($('#search').value, ''); assert.equal(t.state.tags.length, 0); assert.equal(t.state.kind, 'all'); assert.equal(t.state.status, 'all');
    });
  });
  await check('Missing topic queries are escaped and leave removable selections visible', async () => {
    const baseShard = t.state.data.shards[0];
    await withTopicCollection([{ ...baseShard, id: 'topic-safe', tags: ['Keep selected'] }], async () => {
      t.state.tags = ['Keep selected']; searchTopics('<img src=x onerror="bad()"> & missing');
      assert.equal(topicButtons().length, 0); assert.match($('#topic-list').textContent, /No topics match/);
      assert.ok(!$('#topic-list').innerHTML.includes('<img')); assert.ok($('#topic-list').innerHTML.includes('&lt;img')); assert.ok($('#topic-list').innerHTML.includes('&amp; missing'));
      assert.ok(!$('#selected-topic-filters').hidden); assert.match($('#selected-topic-filters').innerHTML, /data-tag="Keep selected"/);
      const before = Array.from(t.state.tags); pressTopicKey('Enter'); assert.deepEqual(Array.from(t.state.tags), before);
      searchTopics('  '); assert.deepEqual(topicButtons().map(button => button['data-tag']), ['Keep selected']);
    });
  });
  await check('Topic Enter selects exact or unique matches without guessing an ambiguous result', async () => {
    const baseShard = t.state.data.shards[0];
    await withTopicCollection([
      { ...baseShard, id: 'topic-keyboard-a', title: 'Needle note', tags: ['const', 'consteval'] },
      { ...baseShard, id: 'topic-keyboard-b', tags: ['constexpr', 'Ownership'] }
    ], async () => {
      t.state.query = 'needle'; $('#search').value = 'needle';
      searchTopics('cons'); pressTopicKey('Enter'); assert.equal(t.state.tags.length, 0);
      searchTopics('CONST'); pressTopicKey('Enter'); assert.deepEqual(Array.from(t.state.tags), ['const']);
      searchTopics('ship'); pressTopicKey('Enter'); assert.deepEqual(Array.from(t.state.tags), ['const', 'Ownership']);
      assert.equal(t.state.query, 'needle'); assert.equal($('#search').value, 'needle');
      searchTopics('eval'); pressTopicKey('Enter', { isComposing: true }); assert.deepEqual(Array.from(t.state.tags), ['const', 'Ownership']);
      pressTopicKey('Enter'); assert.deepEqual(Array.from(t.state.tags), ['const', 'Ownership', 'consteval']);
      pressTopicKey('Enter'); assert.deepEqual(Array.from(t.state.tags), ['const', 'Ownership']);
      searchTopics(''); pressTopicKey('Enter'); assert.deepEqual(Array.from(t.state.tags), ['const', 'Ownership']);
    });
  });
  await check('Escape clears only topic lookup and consumes the keyboard event', async () => {
    const baseShard = t.state.data.shards[0];
    await withTopicCollection([{ ...baseShard, id: 'topic-escape', tags: ['Ownership'] }], async () => {
      t.state.tags = ['Ownership']; t.state.query = 'note query'; $('#search').value = 'note query';
      document.body.classList.toggle('sidebar-open', true); $('#help-dialog').showModal();
      searchTopics('own'); const workspace = $('#workspace').innerHTML, event = pressTopicKey('Escape');
      assert.ok(event.defaultPrevented); assert.ok(event.propagationStopped); assert.equal(t.state.topicQuery, ''); assert.equal($('#topic-search').value, '');
      assert.deepEqual(Array.from(t.state.tags), ['Ownership']); assert.equal(t.state.query, 'note query'); assert.equal($('#search').value, 'note query');
      assert.ok($('#help-dialog').open); assert.equal(t.state.view, 'library'); assert.equal($('#workspace').innerHTML, workspace);
      assert.ok(document.body.classList.contains('sidebar-open')); document.body.classList.remove('sidebar-open'); $('#help-dialog').close();
    });
  });
  await check('Timeline topic lookup unites personal and release topics with case-insensitive counts', async () => {
    const baseShard = t.state.data.shards[0];
    await withTopicCollection([
      { ...baseShard, id: 'topic-release-a', tags: ['Ownership', 'Personal keyword'] },
      { ...baseShard, id: 'topic-release-b', tags: ['ownership'] }
    ], async () => {
      t.state.releaseCatalog = { schemaVersion: 1, sources: [], releases: [{ id: 'cpp23', label: 'C++23', year: 2023, status: 'published', summary: '', features: [
        { id: 'ref-a', title: 'A feature', summary: '', category: 'language', sourceIds: [], tags: ['OWNERSHIP', 'Release keyword'] },
        { id: 'ref-b', title: 'A library feature', summary: '', category: 'library', sourceIds: [], tags: ['ownership'] }
      ] }] };
      t.state.view = 'timeline'; t.state.timelineMode = 'releases'; t.state.tags = ['OWNERSHIP']; t.renderNav();
      searchTopics('OwNeR'); const buttons = topicButtons(); assert.equal(buttons.length, 1); assert.equal(buttons[0]['data-tag'], 'Ownership'); assert.equal(buttons[0].count, 4); assert.equal(buttons[0]['aria-pressed'], 'true');
      searchTopics('keyword'); assert.deepEqual(topicButtons().map(button => button['data-tag']).sort(), ['Personal keyword', 'Release keyword']);
      assert.match($('#selected-topic-filters').innerHTML, /data-tag="OWNERSHIP"/); assert.deepEqual(Array.from(t.state.tags), ['OWNERSHIP']);
      t.state.view = 'library'; t.state.tags = []; t.renderNav(); searchTopics('ownership');
      assert.deepEqual(topicButtons().map(button => button['data-tag']).sort(), ['Ownership', 'ownership']); assert.ok(topicButtons().every(button => button.count === 1));
      searchTopics('Release keyword'); assert.equal(topicButtons().length, 0);
    });
  });
  await check('Release timeline shows assigned shards without expanding a hidden section', async () => {
    await until(() => t.state.releaseCatalog || t.state.releaseCatalogError);
    await withTimelineCollection(async () => {
      assert.deepEqual(Array.from(t.shardReleaseIds(t.state.data.shards[0])), ['cpp11', 'cpp26']);
      assert.deepEqual(Array.from(t.shardReleaseIds({ languageVersion: 'Lecture 11, C++2011, C++230, pre-C++11, before C++17' })), []);
      assert.deepEqual(Array.from(t.shardReleaseIds({ languageVersion: 'C++11 or later' })), ['cpp11']);
      const original = JSON.stringify(t.state.data.shards), output = t.renderTimeline();
      const cpp11 = output.slice(output.indexOf('id="release-cpp11"'), output.indexOf('id="release-cpp26"'));
      assert.match(cpp11, /<section class="release-own-notes"[^>]*>[\s\S]*<h3>Your shards/);
      assert.match(cpp11, /data-shard-id="explicit"/); assert.ok(!/data-shard-id="(?:unknown|excluded-version)"/.test(cpp11));
      assert.ok(!/<details class="release-own-notes"/.test(output));
      assert.equal(timelineShardIds(output).filter(id => id === 'explicit').length, 2);
      assert.match(output, /Working draft/); assert.match(output, /Release reference/); assert.match(output, /href="https:\/\/www.open-std.org/);
      assert.equal(JSON.stringify(t.state.data.shards), original); assert.ok(!/Practice recall|Try recalling/i.test(output));
    });
  });
  await check('Unassigned shards have a counted timeline column and working jump target', async () => {
    await withTimelineCollection(async () => {
      const output = t.renderTimeline(), unassigned = output.slice(output.indexOf('id="release-unassigned"'));
      assert.match(output, /data-action="jump-release" data-id="unassigned">No release assigned <span>2<\/span>/);
      assert.match(unassigned, /No release assigned/); assert.match(unassigned, /<h3>Your shards <span>2<\/span><\/h3>/);
      assert.match(unassigned, /data-shard-id="unknown"/); assert.match(unassigned, /data-shard-id="excluded-version"/);
      assert.ok(!/data-shard-id="explicit"/.test(unassigned));
      assert.ok(output.indexOf('id="release-unassigned"') > output.indexOf('id="release-track"'));
      assert.ok(!/class="release-unversioned"/.test(output));
      $('#workspace').innerHTML = output; let jumpedTo = null;
      $('#release-track').offsetLeft = 260; $('#release-unassigned').offsetLeft = 1400;
      $('#release-track').scrollTo = options => { jumpedTo = options.left; };
      await t.runAction('jump-release', { dataset: { id: 'unassigned' } }); assert.equal(jumpedTo, 1400);
    });
  });
  await check('Timeline content modes change through the control and preserve filters', async () => {
    await withTimelineCollection(async () => {
      assert.equal(t.state.timelineContent, 'both');
      const output = t.renderTimeline(); assert.match(output, /id="timeline-content" aria-label="Timeline content"/);
      assert.match(output, />My shards &amp; reference<\/option>/); assert.match(output, />My shards<\/option>/); assert.match(output, />Release reference<\/option>/);
      t.state.tags = ['Ownership']; t.state.query = 'move'; t.state.releaseCategory = 'language';
      $('#workspace').innerHTML = t.renderTimeline();
      const select = $('#timeline-content'); select.value = 'shards'; select.dispatchEvent(new FixtureEvent('change', { bubbles: true }));
      assert.equal(t.state.timelineContent, 'shards'); assert.deepEqual(Array.from(t.state.tags), ['Ownership']); assert.equal(t.state.query, 'move'); assert.equal(t.state.releaseCategory, 'language');
      assert.deepEqual(timelineShardIds($('#workspace').innerHTML), ['explicit', 'explicit']); assert.ok(!/class="release-feature"/.test($('#workspace').innerHTML));
      select.value = 'reference'; select.dispatchEvent(new FixtureEvent('change', { bubbles: true }));
      assert.equal(t.state.timelineContent, 'reference'); assert.equal(timelineShardIds($('#workspace').innerHTML).length, 0); assert.match($('#workspace').innerHTML, /class="release-feature"/);
      assert.ok(!/id="release-unassigned"/.test($('#workspace').innerHTML));
      select.value = 'both'; select.dispatchEvent(new FixtureEvent('change', { bubbles: true }));
      assert.equal(t.state.timelineContent, 'both'); assert.equal(timelineShardIds($('#workspace').innerHTML).length, 2); assert.match($('#workspace').innerHTML, /class="release-feature"/);
    });
  });
  await check('Timeline shard filtering stays independent of reference feature categories', async () => {
    await withTimelineCollection(async () => {
      t.state.releaseCategory = 'library'; let output = t.renderTimeline();
      assert.equal(t.filteredReleaseFeatures(t.state.releaseCatalog.releases[0])[0].id, 'threads');
      assert.equal(timelineShardIds(output).length, 4); assert.ok(!/class="release-feature-title">Move semantics/.test(output));
      t.state.tags = ['Ownership', 'TYPES']; t.state.tagMode = 'all';
      assert.equal(t.filteredReleaseShards().length, 0); assert.equal(timelineShardIds(t.renderTimeline()).length, 0);
      t.state.tagMode = 'any'; assert.equal(t.filteredReleaseShards().length, 3); assert.equal(timelineShardIds(t.renderTimeline()).length, 4);
      t.clearFilters(); t.state.query = 'unassigned source'; output = t.renderTimeline();
      assert.deepEqual(timelineShardIds(output), ['unknown']); assert.match(output, /id="release-unassigned"/);
      t.state.query = 'nothing matches this fixture'; output = t.renderTimeline(); assert.equal(timelineShardIds(output).length, 0);
      assert.ok(!/id="release-unassigned"/.test(output)); assert.match(output, /No matching shards for this release/);
      t.clearFilters(); t.state.query = 'transfer resources'; assert.equal(t.filteredReleaseFeatures(t.state.releaseCatalog.releases[0])[0].id, 'move');
    });
  });
  await check('Clicking a visible timeline shard opens the corresponding library detail', async () => {
    await withTimelineCollection(async () => {
      const match = t.renderTimeline().match(/<button class="release-note"([^>]*)>/); assert.ok(match);
      const button = new Element('button', { class: 'release-note', ...attributes(match[1]) }, document);
      button.closest = selector => selector === 'button,a' ? button : null;
      document.dispatchEvent(new FixtureEvent('click', { target: button }));
      assert.equal(t.state.view, 'library'); assert.equal(t.state.selectedId, button.dataset.shardId);
      assert.match($('#workspace').innerHTML, /<h2 class="note-title">My move note<\/h2>/); assert.match($('#workspace').innerHTML, /aria-label="Selected shard"/);
    });
  });
  await check('Timeline personal shards remain searchable when the release reference is unavailable', async () => {
    await withTimelineCollection(async () => {
      t.state.releaseCatalog = null; t.state.releaseCatalogError = 'Simulated missing reference';
      let output = t.renderTimeline(); assert.match(output, /reference could not open/); assert.match(output, /reload-releases/);
      assert.deepEqual(timelineShardIds(output), ['explicit', 'unknown', 'excluded-version']);
      t.state.query = 'unassigned source'; assert.deepEqual(timelineShardIds(t.renderTimeline()), ['unknown']);
      t.state.query = 'nothing matches this fixture'; output = t.renderTimeline(); assert.equal(timelineShardIds(output).length, 0); assert.match(output, /No shards match/);
      t.state.timelineContent = 'reference'; t.state.query = ''; assert.equal(timelineShardIds(t.renderTimeline()).length, 0);
    });
  });
  await check('C++ release loading failure never blocks the atlas', async () => {
    const previousCatalog = t.state.releaseCatalog;
    t.state.timelineMode = 'releases'; t.state.releaseCatalog = null; failReleaseLoad = true;
    await t.loadReleaseCatalog(); assert.match(t.renderTimeline(), /reference could not open/); assert.match(t.renderTimeline(), /reload-releases/); assert.ok(t.renderLibrary().includes('Build your technical understanding'));
    failReleaseLoad = false; releaseResponse = { schemaVersion: 1, coverage: 'Test reference.', sources: [], releases: [] }; await t.loadReleaseCatalog(); assert.equal(t.state.releaseCatalogError, null); assert.ok(t.state.releaseCatalog);
    releaseResponse = null; t.state.releaseCatalog = previousCatalog;
  });
  await check('Every built-in release feature has a cppreference reading page', async () => {
    await withWorldTimeline(async () => {
      const features=t.state.releaseCatalog.releases.flatMap(release=>release.features);
      assert.ok(features.length>900);
      for(const feature of features){
        assert.ok(Array.isArray(feature.cppreferenceLinks)&&feature.cppreferenceLinks.length,feature.id);
        const urls=new Set();
        for(const link of feature.cppreferenceLinks){
          const url=new URL(link.url);
          assert.equal(url.protocol,'https:',feature.id);assert.equal(url.hostname,'en.cppreference.com',feature.id);
          assert.match(url.pathname,/^\/(?:w\/)?(?:cpp|c)\//,feature.id);assert.ok(link.title.startsWith('cppreference: '),feature.id);
          assert.ok(!urls.has(link.url),feature.id);urls.add(link.url);
        }
      }
    });
  });
  await check('Timeline search finds API names in cppreference reading titles', async () => {
    await withWorldTimeline(async () => {
      const release=t.state.releaseCatalog.releases.find(release=>release.id==='cpp26');
      for(const query of ['generate_random','exception_ptr_cast']){
        t.state.query=query;
        const features=t.filteredReleaseFeatures(release);
        assert.ok(features.length,query);
        assert.ok(features.some(feature=>feature.cppreferenceLinks.some(link=>link.title.includes(query))),query);
      }
      t.state.releaseCategory='language';assert.equal(t.filteredReleaseFeatures(release).length,0);
    });
  });
  await check('Feature cards present cppreference beside their original standards sources', async () => {
    await withWorldTimeline(async () => {
      const feature=t.state.releaseCatalog.releases[0].features[0],before=JSON.stringify(feature);
      const source=t.state.releaseCatalog.sources.find(source=>source.id===feature.sourceIds[0]);
      const output=t.renderReleaseFeature(feature);
      assert.ok(output.includes('href="'+feature.cppreferenceLinks[0].url+'"'));
      assert.ok(output.includes('href="'+source.url+'"'));assert.ok(output.includes(source.title));
      assert.ok(output.includes('target="_blank"'));assert.equal(JSON.stringify(feature),before);
      const {cppreferenceLinks,...legacy}=feature,legacyOutput=t.renderReleaseFeature(legacy);
      assert.ok(legacyOutput.includes('href="'+source.url+'"'));
      assert.ok(!legacyOutput.includes('en.cppreference.com'));
    });
  });
  await check('All eight world portals keep C++ years, draft status, and personal notes primary', async () => {
    await withWorldTimeline(async () => {
      const original = JSON.stringify(t.state.data), output = t.renderTimeline();
      const portals = [...output.matchAll(/data-portal-release="([^"]+)"/g)].map(match => match[1]);
      assert.deepEqual(portals, ['cpp98','cpp03','cpp11','cpp14','cpp17','cpp20','cpp23','cpp26']);
      for (const id of portals) {
        assert.match(output, new RegExp(`aria-controls="release-${id}"`));
        const column = output.slice(output.indexOf(`id="release-${id}"`));
        assert.ok(column.indexOf('class="release-heading"') < column.indexOf('class="spiral-banner"'));
      }
      assert.equal((output.match(/<details class="spiral-world-info">/g) || []).length, 8);
      assert.match(output, /Wizard101 history/); assert.match(output, /Working draft/);
      assert.match(output, /aria-label="Jump to C\+\+26, working draft:/);
      assert.equal(timelineShardIds(output).filter(id => id === 'explicit').length, 2);
      assert.match(output, /data-id="unassigned">No release assigned/);
      assert.equal(JSON.stringify(t.state.data), original);
    });
  });
  await check('Timeline appearance persists while filters, selected notes, and the collection stay intact', async () => {
    const oldPreference = storage.get('shard-atlas-timeline-theme');
    try {
      await withWorldTimeline(async () => {
        const saved = await get('/api/state'); t.state.tags = ['ownership']; t.state.query = 'move'; t.state.releaseCategory = 'library'; t.state.selectedId = 'explicit';
        const themedIds = timelineShardIds(t.renderTimeline());
        await t.runAction('timeline-theme', { dataset: { theme: 'plain' } });
        assert.equal(t.savedTimelineTheme(), 'plain'); assert.equal(storage.get('shard-atlas-timeline-theme'), 'plain');
        let output = t.renderTimeline(); assert.ok(!/class="spiral-banner"|class="spiral-portal"|class="spiral-examples"/.test(output));
        assert.deepEqual(timelineShardIds(output), themedIds); assert.equal(t.state.selectedId, 'explicit');
        assert.deepEqual(Array.from(t.state.tags), ['ownership']); assert.equal(t.state.query, 'move'); assert.equal(t.state.releaseCategory, 'library');
        await t.runAction('timeline-theme', { dataset: { theme: 'spiral' } });
        assert.equal(t.savedTimelineTheme(), 'spiral'); assert.equal((t.renderTimeline().match(/data-portal-release=/g) || []).length, 8);
        assert.deepEqual(timelineShardIds(t.renderTimeline()), themedIds); assert.deepEqual(await get('/api/state'), saved);
      });
    } finally { if (oldPreference === undefined) storage.delete('shard-atlas-timeline-theme'); else storage.set('shard-atlas-timeline-theme', oldPreference); }
  });
  await check('Every world has a distinct bundled fallback emblem and grouped releases show all worlds', async () => {
    await withWorldTimeline(async () => {
      const worlds = Object.values(t.state.spiralCatalog.releases), emblems = worlds.flatMap(world => world.emblems);
      assert.equal(emblems.length, 15); assert.equal(new Set(emblems.map(emblem => emblem.id)).size, 15);
      for (const world of worlds) {
        assert.deepEqual(Array.from(world.emblems, emblem => emblem.name), Array.from(world.worldNames));
        for (const emblem of world.emblems) {
          assert.match(emblem.src, /^\/spiral\/emblems\/[a-z0-9-]+\.svg$/);
          assert.ok(fs.existsSync(path.join(project, 'static', emblem.src)));
          assert.equal(emblem.license, 'MIT'); assert.equal(emblem.officialArtwork, false);
        }
      }
      const output = t.renderTimeline();
      assert.equal((output.match(/class="spiral-world-emblem"/g) || []).length, 15);
      assert.equal((output.match(/class="spiral-portal-emblems"/g) || []).length, 8);
      assert.equal((output.match(/class="spiral-trail-emblems"/g) || []).length, 6);
      assert.ok(!output.includes('class="spiral-portal-art"'));
      assert.match(output, /data-world="four-dungeons"/);
      t.state.timelineTheme = 'plain';
      assert.ok(!/data-spiral-release=|spiral-world-emblem|spiral-portal-emblem/.test(t.renderTimeline()));
    });
  });
  await check('Shard details automatically show only assigned release worlds, including groups and Plain mode', async () => {
    await withWorldTimeline(async () => {
      const shard=t.state.data.shards[0],before=JSON.stringify(t.state.data);
      let output=t.renderDetail({...shard,languageVersion:'C++98+'});
      assert.match(output,/aria-label="Open C\+\+98 timeline: Dragonspyre"/);
      assert.equal((output.match(/class="note-world-badge"/g)||[]).length,1);
      output=t.renderDetail({...shard,languageVersion:'C++20 / C++11 / C++20'});
      assert.equal((output.match(/class="note-world-badge"/g)||[]).length,2);
      assert.ok(output.indexOf('aria-label="Open C++11 timeline: Celestia"')<output.indexOf('aria-label="Open C++20 timeline: Castle Darkmoor"'));
      const buttons=openingAttributes(output,'button','note-world-badge');
      assert.deepEqual(buttons.map(button=>button['data-id']),['cpp11','cpp20']);
      for(const button of buttons){assert.equal(button.type,'button');assert.equal(button['data-action'],'open-release');assert.match(button['aria-label'],/^Open C\+\+\d+ timeline: /);assert.ok(!button.role);}
      t.state.timelineTheme='plain';
      output=t.renderDetail({...shard,languageVersion:'C++14 / C++26'});
      assert.match(output,/C\+\+14: Zafaria, Avalon, Azteca/);
      assert.match(output,/C\+\+26 \(draft\): Karamelle, Lemuria, Novus, Wallaru/);
      const badges=output.slice(output.indexOf('class="note-world-badges"'),output.indexOf('class="note-actions"'));
      assert.equal((badges.match(/<img /g)||[]).length,7);
      for(const languageVersion of ['','C++ notes','pre-C++11, before C++17'])assert.ok(!t.renderDetail({...shard,languageVersion}).includes('note-world-badges'));
      assert.equal(JSON.stringify(t.state.data),before);
    });
  });
  await check('A late world catalog updates only the selected shard heading and fails gracefully', async () => {
    await withWorldTimeline(async () => {
      const heading=new Element('div',{'class':'note-heading','data-shard-id':'explicit'},document),query=document.querySelector;
      const workspaceBefore=$('#workspace').innerHTML;
      document.querySelector=function(selector,inside){return selector==='.note-heading'?heading:query.call(this,selector,inside);};
      try{
        t.state.view='library';t.state.selectedId='explicit';t.state.spiralCatalog=null;
        await t.loadSpiralCatalog();
        assert.match(heading.innerHTML,/Open C\+\+11 timeline: Celestia/);assert.match(heading.innerHTML,/Open C\+\+26 \(draft\) timeline: Karamelle/);
        assert.equal($('#workspace').innerHTML,workspaceBefore);
        failSpiralLoad=true;await t.loadSpiralCatalog();
        assert.ok(!heading.innerHTML.includes('note-world-badges'));assert.match(heading.innerHTML,/My move note/);
        assert.equal($('#workspace').innerHTML,workspaceBefore);
      }finally{failSpiralLoad=false;document.querySelector=query;}
    });
  });
  await check('Library cards and detail panels derive single, blended, and neutral themes without changing shards', async () => {
    await withWorldTimeline(async () => {
      const baseShard=t.state.data.shards[0];
      t.state.data.shards=[
        {...baseShard,id:'single-era',languageVersion:'C++98+'},
        {...baseShard,id:'many-eras',languageVersion:'C++26 / C++11 / C++26'},
        {...baseShard,id:'future-era',languageVersion:'C++30'},
        {...baseShard,id:'excluded-eras',languageVersion:'pre-C++11, before C++17'}
      ];
      t.state.selectedId='many-eras';t.state.timelineTheme='plain';t.changeView('library');
      const before=JSON.stringify(t.state.data),output=t.renderLibrary(),cards=openingAttributes(output,'button','shard-card');
      const single=cards.find(card=>card['data-shard-id']==='single-era'),multi=cards.find(card=>card['data-shard-id']==='many-eras');
      assert.equal(single['data-shard-worlds'],'cpp98');assert.equal(single['data-spiral-release'],'cpp98');
      assert.match(single.style,/--shard-tint:linear-gradient\(/);assert.match(single.style,/--cpp98-soft/);assert.ok(!single.style.includes('cpp03'));
      assert.equal(multi['data-shard-worlds'],'cpp11 cpp26');assert.ok(!multi['data-spiral-release']);
      assert.match(multi.style,/linear-gradient/);assert.match(multi.style,/--cpp11-soft/);assert.match(multi.style,/--cpp26-soft/);
      for(const id of ['future-era','excluded-eras']){const card=cards.find(card=>card['data-shard-id']===id);assert.ok(!card['data-shard-worlds']);assert.ok(!card.style);}
      const panel=openingAttributes(output,'article','detail-panel')[0];
      assert.equal(panel['data-shard-worlds'],'cpp11 cpp26');assert.match(panel.style,/--cpp11-soft/);assert.match(panel.style,/--cpp26-soft/);
      for(const card of output.matchAll(/<button[^>]*class="shard-card[^>]*>([\s\S]*?)<\/button>/g))assert.ok(!/<button\b|data-action="open-release"/.test(card[1]));
      t.state.spiralCatalog=null;
      assert.equal(openingAttributes(t.renderLibrary(),'article','detail-panel')[0]['data-shard-worlds'],'cpp11 cpp26');
      assert.equal(JSON.stringify(t.state.data),before);
    });
  });
  await check('A multirelease shard takes each Timeline column theme while Plain notes stay neutral', async () => {
    await withWorldTimeline(async () => {
      const before=JSON.stringify(t.state.data),output=t.renderTimeline();
      for(const id of ['cpp11','cpp26']){
        const start=output.indexOf('id="release-'+id+'"'),next=output.indexOf('<section class="release-column',start);
        const column=output.slice(start,next<0?undefined:next),note=openingAttributes(column,'button','release-note').find(note=>note['data-shard-id']==='explicit');
        assert.ok(note);assert.equal(note['data-shard-worlds'],id);assert.equal(note['data-spiral-release'],id);
        assert.match(note.style,new RegExp('--'+id+'-soft'));
        assert.ok(!note.style.includes(id==='cpp11'?'cpp26':'cpp11'));
      }
      for(const note of openingAttributes(output,'button','release-note').filter(note=>note['data-shard-id']!=='explicit'))assert.ok(!note['data-shard-worlds']);
      t.state.timelineTheme='plain';
      for(const note of openingAttributes(t.renderTimeline(),'button','release-note')){assert.ok(!note['data-shard-worlds']);assert.ok(!note.style);}
      assert.equal(JSON.stringify(t.state.data),before);
    });
  });
  await check('Library cards identify every assigned release with a readable year and its miniature worlds', async () => {
    await withWorldTimeline(async () => {
      const baseShard=t.state.data.shards[0];
      t.state.data.shards=[
        {...baseShard,id:'release-foundation',languageVersion:'C++98+'},
        {...baseShard,id:'release-many',languageVersion:'C++26 / C++14 / C++03 / C++11 / C++14'},
        {...baseShard,id:'release-unassigned',languageVersion:'C++ notes'},
        {...baseShard,id:'release-excluded',languageVersion:'pre-C++11, before C++17'}
      ];
      t.state.selectedId='release-many';t.state.timelineTheme='plain';t.changeView('library');
      const before=JSON.stringify(t.state.data),writes=apiWrites,output=t.renderLibrary();
      const cards=[...output.matchAll(/<button([^>]*class="shard-card[^>]*)>([\s\S]*?)<\/button>/g)]
        .map(match=>({...attributes(match[1]),markup:match[2]}));
      const single=shardReleaseGroups(cards.find(card=>card['data-shard-id']==='release-foundation').markup)[0];
      assert.equal(single.role,'list');assert.equal(single['aria-label'],'C++ releases');
      assert.deepEqual(single.chips.map(chip=>chip['data-spiral-release']),['cpp98']);
      assert.equal(single.chips[0]['aria-label'],'C++98: Dragonspyre');
      assert.match(single.markup,/>C\+\+98<\/span>/);assert.equal((single.markup.match(/<img /g)||[]).length,1);
      const many=shardReleaseGroups(cards.find(card=>card['data-shard-id']==='release-many').markup)[0];
      assert.deepEqual(many.chips.map(chip=>chip['data-spiral-release']),['cpp03','cpp11','cpp14','cpp26']);
      assert.equal(many.chips.find(chip=>chip['data-spiral-release']==='cpp14')['aria-label'],'C++14: Zafaria, Avalon, Azteca');
      assert.equal(many.chips.find(chip=>chip['data-spiral-release']==='cpp26')['aria-label'],'C++26 (draft): Karamelle, Lemuria, Novus, Wallaru');
      assert.equal((many.markup.match(/<img /g)||[]).length,9);
      assert.match(many.markup,/>C\+\+26 \(draft\)<\/span>/);
      for(const card of cards){assert.ok(!/<button\b|data-action="open-release"/.test(card.markup));if(['release-unassigned','release-excluded'].includes(card['data-shard-id']))assert.equal(shardReleaseGroups(card.markup).length,0);}
      assert.ok(!t.renderTimeline().includes('shard-release-chips'));
      t.state.spiralCatalog=null;t.state.releaseCatalog=null;
      const withoutCatalog=shardReleaseGroups(t.renderLibrary()).find(group=>group['data-shard-release-id']==='release-many');
      assert.deepEqual(withoutCatalog.chips.map(chip=>chip['aria-label']),['C++03','C++11','C++14','C++26 (draft)']);
      assert.ok(!withoutCatalog.markup.includes('<img '));assert.match(withoutCatalog.markup,/>C\+\+14<\/span>/);
      assert.equal(JSON.stringify(t.state.data),before);assert.equal(apiWrites,writes);
    });
  });
  await check('A late or failed world catalog updates compact release indicators without replacing the workspace', async () => {
    await withWorldTimeline(async () => {
      const queryAll=document.querySelectorAll,workspaceBefore=$('#workspace').innerHTML;
      const containers=['explicit','unknown'].map(id=>new Element('div',{'data-shard-release-id':id},document));
      document.querySelectorAll=function(selector){return selector==='[data-shard-release-id]'?containers:queryAll.call(this,selector);};
      try{
        t.state.view='atlas';t.state.spiralCatalog=null;
        const before=JSON.stringify(t.state.data),writes=apiWrites;
        await t.loadSpiralCatalog();
        assert.match(containers[0].innerHTML,/C\+\+11: Celestia/);assert.match(containers[0].innerHTML,/C\+\+26 \(draft\): Karamelle/);assert.match(containers[0].innerHTML,/<img /);
        assert.equal(containers[1].innerHTML,'');assert.equal($('#workspace').innerHTML,workspaceBefore);
        failSpiralLoad=true;await t.loadSpiralCatalog();
        assert.deepEqual(openingAttributes(containers[0].innerHTML,'span','shard-release-chip').map(chip=>chip['aria-label']),['C++11','C++26 (draft)']);
        assert.ok(!containers[0].innerHTML.includes('<img '));assert.equal($('#workspace').innerHTML,workspaceBefore);
        assert.equal(JSON.stringify(t.state.data),before);assert.equal(apiWrites,writes);
      }finally{failSpiralLoad=false;document.querySelectorAll=queryAll;}
    });
  });
  await check('Topic map cards, focused shards, neighbors, and relationship nodes identify their release years', async () => {
    await withWorldTimeline(async () => {
      await withAtlasCollection(async () => {
        Object.assign(t.state.data.shards[0],{languageVersion:'C++98+'});
        Object.assign(t.state.data.shards[1],{languageVersion:'C++26 / C++11 / C++26'});
        for(const shard of t.state.data.shards.slice(2))shard.languageVersion='C++ notes';
        const before=JSON.stringify(t.state.data),writes=apiWrites;
        t.changeView('atlas');
        const overview=t.renderAtlas(),cards=[...overview.matchAll(/<article([^>]*class="atlas-shard-card[^>]*)>([\s\S]*?)<\/article>/g)];
        assert.equal(cards.length,5);
        const groups=cards.flatMap(card=>shardReleaseGroups(card[2]));
        assert.deepEqual(groups.map(group=>group['data-shard-release-id']).sort(),['atlas-a','atlas-b']);
        assert.deepEqual(groups.find(group=>group['data-shard-release-id']==='atlas-b').chips.map(chip=>chip['data-spiral-release']),['cpp11','cpp26']);
        await t.runAction('atlas-select',{dataset:{id:'atlas-a'}});
        const focused=t.renderAtlas(),inspector=focused.match(/<section class="atlas-focus-card"[^>]*>([\s\S]*?)<\/section>/)?.[1];
        assert.ok(inspector);assert.equal(shardReleaseGroups(inspector)[0]['data-shard-release-id'],'atlas-a');assert.match(inspector,/C\+\+98: Dragonspyre/);
        const neighbors=focused.match(/<ul class="atlas-neighbor-list">([\s\S]*?)<\/ul>/)?.[1];
        assert.ok(neighbors);assert.equal(shardReleaseGroups(neighbors)[0]['data-shard-release-id'],'atlas-b');assert.match(neighbors,/C\+\+26 \(draft\): Karamelle/);
        const nodes=[...focused.matchAll(/<g([^>]*class="atlas-relationship-node[^>]*)>([\s\S]*?)<\/g>/g)]
          .map(match=>({...attributes(match[1]),markup:match[2]}));
        const multi=nodes.find(node=>node['data-id']==='atlas-b');assert.ok(multi);
        assert.match(multi['aria-label'],/C\+\+11/);assert.match(multi['aria-label'],/C\+\+26 \(draft\)/);
        assert.match(multi.markup,/class="atlas-node-releases"/);assert.match(multi.markup,/C\+\+11/);assert.match(multi.markup,/C\+\+26 \(draft\)/);
        assert.equal(JSON.stringify(t.state.data),before);assert.equal(apiWrites,writes);
      });
    });
  });
  await check('Clicking a detail badge opens its release, preserves Library state, and respects reduced motion', async () => {
    await withWorldTimeline(async () => {
      await withReleaseNavigation(async trace=>{
        const shard=t.state.data.shards[0],keys=['selectedId','query','tags','tagMode','kind','status','sort','topicQuery','releaseCategory','timelineContent','timelineTheme'];
        Object.assign(t.state,{selectedId:shard.id,query:'move',tags:['ownership'],tagMode:'any',kind:shard.kind,status:shard.status,sort:'title',topicQuery:'own',releaseCategory:'library',timelineContent:'shards',timelineTheme:'plain'});
        t.changeView('library');const before=JSON.stringify(keys.map(key=>t.state[key])),collection=JSON.stringify(t.state.data);
        const badge=openingAttributes(t.renderDetail(shard),'button','note-world-badge').find(button=>button['data-id']==='cpp26');
        assert.equal(badge['aria-label'],'Open C++26 (draft) timeline: Karamelle, Lemuria, Novus, Wallaru');
        const control=new Element('button',badge,document);control.closest=selector=>selector==='button,a'?control:null;
        reducedMotion=true;document.dispatchEvent(new FixtureEvent('click',{target:control}));
        await until(()=>trace.focus.length===1);
        assert.equal(t.state.view,'timeline');assert.equal(t.state.timelineMode,'releases');assert.equal(t.state.timelineReleaseId,'cpp26');
        assert.equal(JSON.stringify(keys.map(key=>t.state[key])),before);assert.equal(JSON.stringify(t.state.data),collection);
        assert.equal(trace.scrolls[0].left,7*360);assert.equal(trace.scrolls[0].behavior,'auto');
        assert.equal(trace.reveals[0].block,'start');assert.equal(trace.reveals[0].behavior,'auto');
        assert.deepEqual(trace.focus,[{id:'release-cpp26',preventScroll:true}]);
        const requests=releaseReadCount;await t.runAction('open-release',{dataset:{id:'cpp99'}});
        assert.equal(releaseReadCount,requests);assert.equal(trace.focus.length,1);assert.equal(t.state.timelineReleaseId,'cpp26');
      });
    });
  });
  await check('A badge awaits the shared catalog request before scrolling to its release', async () => {
    await withWorldTimeline(async () => {
      await withReleaseNavigation(async trace=>{
        t.state.selectedId='explicit';t.changeView('library');t.state.releaseCatalog=null;
        const requests=releaseReadCount;let release;
        releaseResponseGate=new Promise(resolve=>{release=resolve;});
        const initial=t.loadReleaseCatalog();await until(()=>releaseReadCount===requests+1);
        const navigation=t.runAction('open-release',{dataset:{id:'cpp17'}});
        try{
          await until(()=>t.state.view==='timeline');
          assert.equal(releaseReadCount,requests+1);assert.equal(trace.focus.length,0);
          assert.match($('#workspace').innerHTML,/Opening the C\+\+ release reference/);
        }finally{releaseResponseGate=null;release();await Promise.all([initial,navigation]);}
        assert.equal(releaseReadCount,requests+1);assert.equal(t.state.selectedId,'explicit');
        assert.equal(trace.focus.length,1);assert.equal(trace.focus[0].id,'release-cpp17');assert.equal(trace.scrolls[0].behavior,'smooth');
        assert.match($('#workspace').innerHTML,/data-portal-release="cpp17"[^>]*aria-current="step"/);
      });
    });
  });
  await check('Pending badge navigation keeps the newest destination and cancels after leaving the view', async () => {
    await withWorldTimeline(async () => {
      await withReleaseNavigation(async trace=>{
        t.state.selectedId='explicit';t.changeView('library');t.state.releaseCatalog=null;
        const requests=releaseReadCount;let release;releaseResponseGate=new Promise(resolve=>{release=resolve;});
        const first=t.runAction('open-release',{dataset:{id:'cpp11'}});
        await until(()=>releaseReadCount===requests+1);
        const newest=t.runAction('open-release',{dataset:{id:'cpp26'}});
        try{await until(()=>t.state.timelineReleaseId==='cpp26');assert.equal(releaseReadCount,requests+1);}
        finally{releaseResponseGate=null;release();await Promise.all([first,newest]);}
        assert.deepEqual(trace.focus.map(item=>item.id),['release-cpp26']);
        trace.focus.length=0;trace.scrolls.length=0;trace.reveals.length=0;
        t.changeView('library');t.state.releaseCatalog=null;
        releaseResponseGate=new Promise(resolve=>{release=resolve;});
        const cancelled=t.runAction('open-release',{dataset:{id:'cpp14'}});
        try{await until(()=>releaseReadCount===requests+2);t.changeView('library');t.changeView('timeline');}
        finally{releaseResponseGate=null;release();await cancelled;}
        assert.equal(t.state.view,'timeline');assert.equal(trace.focus.length,0);assert.equal(trace.scrolls.length,0);assert.equal(trace.reveals.length,0);
        assert.equal(t.state.selectedId,'explicit');
      });
    });
  });
  await check('Failed badge catalog loading keeps a retry route to the requested release', async () => {
    await withWorldTimeline(async () => {
      await withReleaseNavigation(async trace=>{
        t.state.selectedId='explicit';t.changeView('library');t.state.releaseCatalog=null;
        const before=JSON.stringify(t.state.data),requests=releaseReadCount;
        try{
          failReleaseLoad=true;await t.runAction('open-release',{dataset:{id:'cpp20'}});
          assert.equal(t.state.view,'timeline');assert.equal(t.state.timelineReleaseId,'cpp20');assert.equal(t.state.selectedId,'explicit');
          assert.match($('#workspace').innerHTML,/reference could not open/);assert.match($('#workspace').innerHTML,/data-action="reload-releases"/);
          assert.equal(trace.focus.length,0);assert.equal(trace.scrolls.length,0);
          failReleaseLoad=false;await t.runAction('reload-releases',{dataset:{}});
          assert.equal(releaseReadCount,requests+2);assert.equal(t.state.releaseCatalogError,null);
          assert.deepEqual(trace.focus.map(item=>item.id),['release-cpp20']);assert.equal(t.state.timelineReleaseId,'cpp20');
          assert.equal(JSON.stringify(t.state.data),before);
        }finally{failReleaseLoad=false;}
      });
    });
  });
  await check('Portal keyboard navigation and activation reach every release with reduced-motion support', async () => {
    await withWorldTimeline(async () => {
      const ids = t.state.releaseCatalog.releases.map(release => release.id);
      const portalFor = id => { const button = new Element('button', { 'data-portal-release': id, 'data-action': 'jump-release', 'data-id': id }, document); button.closest = selector => selector === '[data-portal-release]' || selector === 'button,a' ? button : null; return button; };
      for (let index = 0; index < ids.length; index++) {
        const event = new FixtureEvent('keydown', { key: 'ArrowRight', target: portalFor(ids[index]) }); document.dispatchEvent(event);
        assert.equal(event.defaultPrevented, true); assert.equal(document.activeElement.id, 'portal-' + ids[(index + 1) % ids.length]);
      }
      for (const [key, id] of [['Home','cpp98'],['End','cpp26']]) { document.dispatchEvent(new FixtureEvent('keydown', { key, target: portalFor('cpp14') })); assert.equal(document.activeElement.id, 'portal-' + id); }
      let scroll; $('#release-track').scrollTo = options => { scroll = options; }; $('#release-cpp26').offsetLeft = 2200;
      reducedMotion = true; document.dispatchEvent(new FixtureEvent('click', { target: portalFor('cpp26') }));
      await until(() => t.state.timelineReleaseId === 'cpp26');
      assert.equal(scroll.left, 2200); assert.equal(scroll.behavior, 'auto'); assert.equal(document.activeElement.id, 'release-cpp26');
      assert.match(t.renderTimeline(), /data-portal-release="cpp26"[^>]*aria-current="step"/);
      reducedMotion = false;
    });
  });
  await check('World examples and constexpr trail preserve exact C++ text and follow content filters', async () => {
    await withWorldTimeline(async () => {
      const output = t.renderTimeline(), examples = Object.values(t.state.spiralCatalog.releases).flatMap(world => world.examples || []), steps = t.state.spiralCatalog.trail.steps;
      const codeText = [...output.matchAll(/<pre><code>([\s\S]*?)<\/code><\/pre>/g)].map(match => decode(match[1].replace(/<[^>]+>/g, '')));
      for (const example of [...examples, ...steps]) if (example.code) assert.ok(codeText.includes(example.code), 'Example text changed: ' + example.title);
      assert.match(output, /class="spiral-trail"/); assert.match(output, /class="syn-keyword"/); assert.match(output, /data-action="copy-code"/);
      t.state.query = 'nothing matches this fixture'; assert.ok(!/class="spiral-examples"/.test(t.renderTimeline()));
      t.clearFilters(); t.state.tags = ['OPTIONAL']; t.state.releaseCategory = 'library';
      const result = t.filteredSpiralExamples(t.state.releaseCatalog.releases.find(release => release.id === 'cpp17'));
      assert.ok(result.length); assert.ok(result.every(example => example.tags.some(tag => tag.toLowerCase() === 'optional')));
      t.state.timelineContent = 'shards'; const personal = t.renderTimeline();
      assert.ok(!/class="spiral-examples"|class="spiral-trail"|class="release-feature"/.test(personal));
      assert.equal((personal.match(/data-portal-release=/g) || []).length, 8);
    });
  });
  await check('Missing or malformed world assets fall back to the plain timeline and can retry', async () => {
    await withWorldTimeline(async () => {
      const before = JSON.stringify(t.state.data); failSpiralLoad = true; await t.loadSpiralCatalog();
      let output = t.renderTimeline(); assert.match(output, /World guide unavailable/); assert.match(output, /data-action="reload-spiral"/);
      assert.ok(!/class="spiral-banner"|class="spiral-portal"/.test(output)); assert.ok(timelineShardIds(output).length);
      failSpiralLoad = false; spiralResponse = { schemaVersion: 1, releases: {} }; await t.loadSpiralCatalog(); assert.ok(t.state.spiralCatalogError);
      spiralResponse = null; await t.runAction('reload-spiral', { dataset: {} });
      assert.equal(t.state.spiralCatalogError, null); assert.equal((t.renderTimeline().match(/data-portal-release=/g) || []).length, 8);
      assert.equal(JSON.stringify(t.state.data), before);
    });
  });
  await check('Relationship editing and rationale/endpoint search', async () => {
    const link = t.state.data.links[0]; assert.ok(link); t.openLink(null, link.id);
    $('#link-form').elements.note.value = 'unique rationalefind reasoning'; $('#link-form').elements.type.value = 'contrasts_with';
    submit($('#link-form')); await until(() => !$('#link-dialog').open && !t.busy);
    const updated = t.state.data.links.find(item => item.id === link.id); assert.equal(updated.note, 'unique rationalefind reasoning'); assert.equal(updated.type, 'contrasts_with');
    t.state.query = 'rationalefind'; const found = Array.from(t.filteredShards(), shard => shard.id); assert.ok(found.includes(link.fromId) && found.includes(link.toId)); t.state.query = '';
  });
  await check('New connections expose technical evidence relationships while legacy types survive editing', async () => {
    const from=t.state.data.shards[0],to=t.state.data.shards[1],types=['uses','implements','alternative_to','depends_on','explains','contrasts_with','example_of','related_to','part_of','supports','contradicts'];t.openLink(from.id);let form=$('#link-form');assert.deepEqual([...form.elements.type.innerHTML.matchAll(/value="([^"]+)"/g)].map(match=>match[1]),types);$('#link-dialog').close();
    await post('/api/links',{fromId:from.id,toId:to.id,type:'released_by',note:'Legacy relationship context'});t.state.data=await get('/api/state');const legacy=t.state.data.links.find(link=>link.fromId===from.id&&link.toId===to.id&&link.type==='released_by');t.openLink(null,legacy.id);assert.equal(form.elements.type.value,'released_by');assert.match(form.elements.type.innerHTML,/value="released_by"/);form.elements.note.value='Preserved legacy relationship context';submit(form);await until(()=>!$('#link-dialog').open&&!t.busy);assert.equal(t.state.data.links.find(link=>link.id===legacy.id).type,'released_by');
    t.openLink(from.id);assert.ok(!form.elements.type.innerHTML.includes('released_by'));$('#link-dialog').close();
  });
  await check('Relationship explanations preserve direction from both connected notes', async () => {
    const links=t.state.data.links,from=t.state.data.shards[0],to=t.state.data.shards[1];for(const [type,forward,inverse] of [['part_of','is part of','contains'],['depends_on','depends on','is a dependency of'],['supports','supports','is supported by'],['supersedes','supersedes','is superseded by']]){t.state.data.links=[{id:'direction-check',fromId:from.id,toId:to.id,type,note:''}];assert.ok(t.renderDetail(from).includes('This idea '+forward+'</span>'),type);assert.ok(t.renderDetail(to).includes('This idea '+inverse+'</span>'),type);}t.state.data.links=links;
  });
  await check('Library connection previews remain interactive and lead to focused Topic map exploration', async () => {
    await withAtlasCollection(async () => {
      await until(()=>t.pending===0);const before=JSON.stringify(t.state.data),writes=apiWrites;
      t.state.selectedId='atlas-a';t.changeView('library');
      let output=t.renderLibrary();assert.match(output,/aria-label="Connections around Alpha classes"/);assert.match(output,/data-graph-id="atlas-b"/);
      const node=new Element('g',{'data-graph-id':'atlas-b'},document);node.closest=selector=>selector==='[data-graph-id]'?node:null;
      document.dispatchEvent(new FixtureEvent('click',{target:node}));assert.equal(t.state.view,'library');assert.equal(t.state.selectedId,'atlas-b');assert.match($('#workspace').innerHTML,/aria-label="Connections around Beta memory"/);
      const alpha=new Element('g',{'data-graph-id':'atlas-a'},document);alpha.closest=selector=>selector==='[data-graph-id]'?alpha:null;
      const keyboard=new FixtureEvent('keydown',{target:alpha,key:'Enter'});document.dispatchEvent(keyboard);assert.ok(keyboard.defaultPrevented);assert.equal(t.state.selectedId,'atlas-a');
      output=t.renderLibrary();const button=[...output.matchAll(/<button([^>]*)>([\s\S]*?)<\/button>/g)].map(match=>({...attributes(match[1]),label:decode(match[2].replace(/<[^>]*>/g,''))})).find(attrs=>attrs['data-action']==='open-topic-map');
      assert.ok(button);assert.equal(button['data-id'],'atlas-a');assert.match(button.label,/Explore in Topic map/);
      await t.runAction('open-topic-map',{dataset:{id:button['data-id']}});assert.equal(t.state.view,'atlas');assert.equal(t.state.atlasMode,'connections');assert.equal(t.state.atlasSelectedId,'atlas-a');assert.equal($('#view-label').textContent,'Topic map');
      assert.deepEqual(Array.from(t.atlasRelationshipModel().nodes,shard=>shard.id).sort(),['atlas-a','atlas-b']);assert.match($('#workspace').innerHTML,/A needs B first\./);
      assert.equal(apiWrites,writes);assert.equal(JSON.stringify(t.state.data),before);t.changeView('library');
    });
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
  await check('Note images expose accessible zoom buttons without interpreting captions as HTML', async () => {
    const caption = '<img src=x onerror="bad()"> & "quoted"', source = '/assets/image.v1:copy';
    const output = t.markdown('![' + caption + '](' + source + ')');
    const previews = openingAttributes(output, 'button', 'image-preview');
    assert.equal(previews.length, 1); assert.equal(previews[0].type, 'button');
    assert.equal(previews[0]['data-action'], 'open-image'); assert.equal(previews[0]['data-image-src'], source);
    assert.equal(previews[0]['data-image-alt'], caption); assert.match(previews[0]['aria-label'], /(?:zoom|enlarge|open|view)/i);
    assert.match(output, /<figure class="note-image">/); assert.match(output, /<figcaption>&lt;img src=x onerror=&quot;bad\(\)&quot;&gt; &amp; &quot;quoted&quot;<\/figcaption>/);
    assert.equal((output.match(/<img\b/g) || []).length, 1);
    for (const source of ['https://example.com/image.png', '//example.com/image.png', 'javascript:alert(1)', '/assets/../secret', '/assets/image?download=1']) {
      assert.equal(openingAttributes(t.markdown('![Unsafe](' + source + ')'), 'button', 'image-preview').length, 0, source);
    }
  });
  await check('Image viewer fits dense diagrams and switches to actual size and bounded zoom without saving', async () => {
    await until(() => t.pending === 0);
    const writes = apiWrites, before = JSON.stringify(t.state.data), trigger = new Element('button', { 'data-image-src': '/assets/dense-container-diagram', 'data-image-alt': 'Container hierarchy' }, document);
    const viewport = $('#image-viewer-viewport'), image = $('#image-viewer-image');
    viewport.clientWidth = 900; viewport.clientHeight = 600; image.naturalWidth = 0; image.naturalHeight = 0;
    trigger.focus(); await t.runAction('open-image', trigger);
    assert.ok($('#image-viewer-dialog').open); assert.equal(image.src, '/assets/dense-container-diagram');
    assert.equal(image.alt, 'Container hierarchy'); assert.match($('#image-viewer-title').textContent, /Container hierarchy/);
    assert.ok(!$('#image-viewer-message').hidden); assert.match($('#image-viewer-message').textContent, /loading|opening/i);
    assert.ok($('#image-zoom-in').disabled && $('#image-actual').disabled);
    image.naturalWidth = 2400; image.naturalHeight = 1600; image.dispatchEvent(new FixtureEvent('load'));
    assert.ok($('#image-viewer-message').hidden); assert.equal(t.imageViewer.mode, 'fit');
    assert.ok(!$('#image-zoom-in').disabled && !$('#image-actual').disabled);
    assert.ok(Math.abs(t.imageViewer.scale - 568 / 1600) < 1e-8);
    await t.runAction('image-actual', { dataset: {} }); assert.equal(t.imageViewer.scale, 1); assert.notEqual(t.imageViewer.mode, 'fit');
    assert.equal(viewport.scrollLeft, 766, 'Actual size should keep the fitted image center in view when scrollbars first appear');
    assert.equal(viewport.scrollTop, 516);
    await t.runAction('image-zoom-in', { dataset: {} }); assert.ok(t.imageViewer.scale > 1);
    t.setImageViewerScale(100); assert.equal(t.imageViewer.scale, 4);
    t.setImageViewerScale(0.00001); assert.equal(t.imageViewer.scale, 0.1);
    await t.runAction('image-fit', { dataset: {} }); assert.equal(t.imageViewer.mode, 'fit');
    assert.ok(Math.abs(t.imageViewer.scale - 568 / 1600) < 1e-8);
    t.closeDialog('image-viewer-dialog'); assert.ok(!$('#image-viewer-dialog').open); assert.equal(document.activeElement, trigger);
    image.naturalWidth = 320; image.naturalHeight = 200; t.openImageViewer('/assets/small-image', 'Small image', trigger); t.imageViewerLoaded();
    assert.equal(t.imageViewer.scale, 1, 'Fit should not blur a small image by enlarging it automatically');
    t.closeDialog('image-viewer-dialog');
    image.naturalWidth = 20000; image.naturalHeight = 12000; t.openImageViewer('/assets/large-diagram', 'Large diagram', trigger); t.imageViewerLoaded();
    const largeFit = t.imageViewer.scale; assert.ok(largeFit < 0.1); t.setImageViewerScale(0.00001); assert.equal(t.imageViewer.scale, largeFit, 'Very large diagrams can still zoom out far enough to fit');
    t.closeDialog('image-viewer-dialog'); assert.equal(apiWrites, writes); assert.equal(JSON.stringify(t.state.data), before);
  });
  await check('Image viewer refuses nonlocal paths and gives a recoverable missing-image message', async () => {
    const writes = apiWrites, image = $('#image-viewer-image');
    for (const source of ['https://example.com/image.png', '//example.com/image.png', 'data:image/png;base64,AAAA', 'javascript:alert(1)', '/assets/../secret', '/assets/image?download=1']) {
      t.openImageViewer(source, 'Unsafe image'); assert.ok(!$('#image-viewer-dialog').open, source);
    }
    image.naturalWidth = 0; image.naturalHeight = 0; t.openImageViewer('/assets/missing-image', 'Missing image');
    image.dispatchEvent(new FixtureEvent('error')); assert.ok($('#image-viewer-dialog').open);
    assert.ok(!$('#image-viewer-message').hidden); assert.match($('#image-viewer-message').textContent, /unavailable|could not|couldn.t|unable|failed/i);
    assert.ok($('#image-zoom-in').disabled && $('#image-fit').disabled && $('#image-actual').disabled);
    assert.ok(Number.isFinite(t.imageViewer.scale)); t.closeDialog('image-viewer-dialog'); assert.equal(apiWrites, writes);
  });
  await check('Image shortcuts zoom, fit, and close while leaving text input keys alone', async () => {
    const image = $('#image-viewer-image'), trigger = new Element('button', {}, document);
    image.naturalWidth = 2400; image.naturalHeight = 1600; t.openImageViewer('/assets/keyboard-diagram', 'Keyboard diagram', trigger); t.imageViewerLoaded();
    const press = (key, target = $('#image-viewer-viewport'), options = {}) => {
      const event = new FixtureEvent('keydown', { key, target, ...options }); t.handleImageViewerKey(event); return event;
    };
    const fit = t.imageViewer.scale; assert.ok(press('+').defaultPrevented); assert.ok(t.imageViewer.scale > fit);
    const zoomed = t.imageViewer.scale; assert.ok(press('-').defaultPrevented); assert.ok(t.imageViewer.scale < zoomed);
    assert.ok(press('1').defaultPrevented); assert.equal(t.imageViewer.scale, 1);
    assert.ok(press('0').defaultPrevented); assert.equal(t.imageViewer.mode, 'fit'); assert.equal(t.imageViewer.scale, fit);
    const input = new Element('input', {}, document), typed = press('+', input); assert.ok(!typed.defaultPrevented); assert.equal(t.imageViewer.scale, fit);
    const modified = press('+', $('#image-viewer-viewport'), { metaKey: true }); assert.ok(!modified.defaultPrevented); assert.equal(t.imageViewer.scale, fit);
    assert.ok(press('Escape').defaultPrevented); assert.ok(!$('#image-viewer-dialog').open); assert.equal(document.activeElement, trigger);
  });
  await check('Enlarged images pan by dragging and pointer zoom keeps the inspected point in place', async () => {
    const image = $('#image-viewer-image'), viewport = $('#image-viewer-viewport'), writes = apiWrites;
    image.naturalWidth = 2400; image.naturalHeight = 1600; t.openImageViewer('/assets/pannable-diagram', 'Pannable diagram'); t.imageViewerLoaded();
    await t.runAction('image-actual', { dataset: {} }); viewport.scrollLeft = 400; viewport.scrollTop = 300;
    const down = new FixtureEvent('pointerdown', { button: 0, pointerType: 'mouse', pointerId: 7, clientX: 300, clientY: 200 }); viewport.dispatchEvent(down);
    assert.ok(down.defaultPrevented); assert.equal(viewport.dataset.dragging, 'true');
    viewport.dispatchEvent(new FixtureEvent('pointermove', { pointerId: 8, clientX: 240, clientY: 150 })); assert.equal(viewport.scrollLeft, 400);
    viewport.dispatchEvent(new FixtureEvent('pointermove', { pointerId: 7, clientX: 240, clientY: 150 })); assert.equal(viewport.scrollLeft, 460); assert.equal(viewport.scrollTop, 350);
    viewport.dispatchEvent(new FixtureEvent('pointerup', { pointerId: 7 })); assert.ok(!viewport.dataset.dragging);
    viewport.dispatchEvent(new FixtureEvent('pointermove', { pointerId: 7, clientX: 200, clientY: 100 })); assert.equal(viewport.scrollLeft, 460);
    const point = () => ({ x: (viewport.scrollLeft + 300 - parseFloat(image.style.left)) / t.imageViewer.scale, y: (viewport.scrollTop + 200 - parseFloat(image.style.top)) / t.imageViewer.scale });
    const before = point(), wheel = new FixtureEvent('wheel', { ctrlKey: true, deltaY: -50, clientX: 300, clientY: 200 }); viewport.dispatchEvent(wheel);
    assert.ok(wheel.defaultPrevented); assert.ok(t.imageViewer.scale > 1); assert.ok(Math.abs(point().x - before.x) < 1); assert.ok(Math.abs(point().y - before.y) < 1);
    t.closeDialog('image-viewer-dialog'); assert.equal(apiWrites, writes);
  });
  await check('Closing a zoomed editor preview preserves the underlying unsaved note and its durable draft', async () => {
    t.openEditor(); $('#shard-title').value = 'Unfinished note with an image'; $('#shard-content').value = 'Keep my explanation.\n\n![Diagram](/assets/editor-image)';
    t.scheduleDraft('editor'); await t.persistDraft('editor'); await until(() => t.pending === 0);
    const draftBefore = JSON.stringify(t.drafts.editor), durableBefore = JSON.stringify((await get('/api/drafts')).drafts.editor), writes = apiWrites;
    const trigger = new Element('button', {}, document), image = $('#image-viewer-image');
    trigger.focus(); image.naturalWidth = 2000; image.naturalHeight = 1000; t.openImageViewer('/assets/editor-image', 'Diagram', trigger); t.imageViewerLoaded();
    assert.ok($('#editor-dialog').open && $('#image-viewer-dialog').open);
    document.dispatchEvent(new FixtureEvent('keydown', { key: 'Enter', metaKey: true, target: $('#image-viewer-viewport') }));
    await delay(20); assert.ok($('#editor-dialog').open && $('#image-viewer-dialog').open); assert.equal(apiWrites, writes, 'Viewer shortcuts must not submit the editor underneath');
    t.closeDialog('image-viewer-dialog');
    assert.ok($('#editor-dialog').open); assert.ok(!$('#draft-close-dialog').open); assert.equal(document.activeElement, trigger);
    assert.equal($('#shard-content').value, 'Keep my explanation.\n\n![Diagram](/assets/editor-image)');
    assert.equal(JSON.stringify(t.drafts.editor), draftBefore); assert.equal(JSON.stringify((await get('/api/drafts')).drafts.editor), durableBefore); assert.equal(apiWrites, writes);
    await t.deleteDraft('editor'); $('#editor-dialog').close();
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
  await check('Overlapping subject views and course navigation reuse shared shards without changing content', async () => {
    const previous={...t.state},sample=previous.data.shards[0];
    try {
      const common={...sample,id:'academic-shared',title:'A shared mathematical method',languageVersion:'',tags:['Optimization'],subjects:['Mathematics','ML'],content:'A connected explanation.',courses:[{courseCode:'CS 3780',term:'Fall 2026',lecture:'Lecture 11',position:11,context:'Validation context.'},{courseCode:'CS 4789',term:'Fall 2026',lecture:'Notes 3',position:3}],notation:[{symbol:'gamma',meaning:'Local tolerance',shape:'Scalar',role:'Fixed input',scope:'This formulation'}],assumptions:['Bounded observations.']};
      const cpp={...sample,id:'academic-cpp',title:'C++ fixture',tags:['C++'],subjects:[],courses:[]};
      t.state.data={...previous.data,shards:[common,cpp],links:[]};t.clearFilters();const before=JSON.stringify(t.state.data);
      t.state.subject='Mathematics';assert.deepEqual(Array.from(t.filteredShards(),shard=>shard.id),['academic-shared']);
      t.state.subject='ML';assert.deepEqual(Array.from(t.filteredShards(),shard=>shard.id),['academic-shared']);
      t.state.subject='CS';assert.deepEqual(Array.from(t.filteredShards(),shard=>shard.id),['academic-cpp']);
      t.clearFilters();t.changeView('courses');assert.match($('#workspace').innerHTML,/CS 3780/);assert.match($('#workspace').innerHTML,/CS 4789/);
      await t.runAction('academic-open-course',{dataset:{course:JSON.stringify(['CS 3780','Fall 2026'])}});assert.match($('#workspace').innerHTML,/Validation context/);
      await t.runAction('academic-open-shard',{dataset:{id:common.id}});assert.equal(t.state.view,'library');assert.equal(t.state.selectedId,common.id);
      assert.match(t.renderDetail(common),/Local tolerance/);assert.match(t.renderDetail(common),/Bounded observations/);
      assert.equal(t.filteredReleaseShards().some(shard=>shard.id===common.id),false);assert.equal(JSON.stringify(t.state.data),before);
    } finally {Object.assign(t.state,previous);t.renderNav();}
  });
  await check('Search includes course locations, notation meanings and assumptions', async () => {
    const previous={...t.state},sample=previous.data.shards[0];
    try {
      t.state.data={...previous.data,shards:[{...sample,id:'academic-search',title:'A method',content:'Explanation.',courses:[{courseCode:'CS 4789',sourceLocation:'Appendix fourteen'}],notation:[{symbol:'z',meaning:'Continuation estimate'}],assumptions:['Finite action set']}],links:[]};t.clearFilters();
      for(const query of ['appendix fourteen','continuation estimate','finite action']){t.state.query=query;assert.equal(t.filteredShards().length,1,query);}
    } finally {Object.assign(t.state,previous);t.renderNav();}
  });
  await check('Experiments view runs both built-ins immediately without adding collection content',async()=>{
    const previous={...t.state},before=JSON.stringify(await get('/api/state'));
    try{t.state.data={...previous.data,shards:[],links:[]};t.changeView('experiments');const output=$('#workspace').innerHTML;assert.equal($('#view-label').textContent,'Experiments');assert.match(output,/Quadratic gradient descent/);assert.match(output,/Finite MDP value iteration/);assert.match(output,/Run simulation/);assert.match(output,/Saved with your shards/);assert.ok($('#subject-view').disabled);assert.equal(JSON.stringify(await get('/api/state')),before);}finally{Object.assign(t.state,previous);t.changeView('library');}
  });
  await check('Adding an experiment opens a recoverable shard draft and protects an existing draft',async()=>{
    const experiment=w.ExperimentAtlas.defaultExperiment('gradient-descent'),before=JSON.stringify(await get('/api/state'));t.attachExperimentDraft({experiment});const form=$('#editor-form');assert.ok($('#editor-dialog').open);assert.equal(form.elements.title.value,experiment.title);assert.equal(JSON.parse(form.elements.experiments.value)[0].config.learningRate,experiment.config.learningRate);await t.persistDraft('editor');const recovered=t.drafts.editor;assert.equal(JSON.parse(recovered.values.experiments)[0].algorithmVersion,1);$('#editor-dialog').close();assert.throws(()=>t.attachExperimentDraft({experiment}),/Restore or discard/);assert.equal(t.drafts.editor.values.experiments,recovered.values.experiments);assert.equal(JSON.stringify(await get('/api/state')),before);await t.deleteDraft('editor');$('#editor-dialog').close();
  });
  await check('Atomic configuration save preserves explanation, understanding and a second experiment',async()=>{
    const gd=w.ExperimentAtlas.defaultExperiment('gradient-descent'),vi=w.ExperimentAtlas.defaultExperiment('value-iteration');gd.id='frontend-gd';vi.id='frontend-vi';
    await post('/api/shards',{title:'Saved experiment QA',content:'Preserve my explanation.',status:'solid',tags:['Optimization'],experiments:[gd,vi],perspectives:[{title:'Existing viewpoint',content:'Preserve this viewpoint.'}]});t.state.data=await get('/api/state');const before=t.state.data.shards.find(shard=>shard.title==='Saved experiment QA'),updated=JSON.parse(JSON.stringify(before.experiments[0]));updated.config.learningRate=.1;updated.comparisonConfig={...updated.config,learningRate:.3};await t.saveExperimentConfiguration({shardId:before.id,experiment:updated});const saved=(await get('/api/state')).shards.find(shard=>shard.id===before.id);
    assert.equal(saved.experiments[0].config.learningRate,.1);assert.equal(saved.experiments[0].comparisonConfig.learningRate,.3);assert.equal(saved.content,before.content);assert.equal(saved.status,'solid');assert.equal(JSON.stringify(saved.perspectives),JSON.stringify(before.perspectives));assert.equal(JSON.stringify(saved.verification),JSON.stringify(before.verification));assert.equal(JSON.stringify(saved.experiments[1]),JSON.stringify(before.experiments[1]));
    const html=t.renderExperiments();assert.match(html,/Saved experiment QA/);assert.ok(html.includes(`data-shard-id="${before.id}"`));
  });
  await check('Experiment setup copy uses both browser and native clipboard boundaries without changing notes',async()=>{
    const before=JSON.stringify(t.state.data),setup=JSON.stringify({experiments:[w.ExperimentAtlas.defaultExperiment('value-iteration')]});await t.copyExperimentSetup(setup);assert.equal(clipboardWrites.at(-1),setup);const native=[];w.webkit={messageHandlers:{nativeClipboard:{postMessage:value=>native.push(value)}}};try{await t.copyExperimentSetup(setup);assert.equal(native[0].text,setup);}finally{delete w.webkit;}assert.equal(JSON.stringify(t.state.data),before);
  });
  await check('Experiment imports retain A/B parameters and remain read-only until confirmed',async()=>{
    const experiment=w.ExperimentAtlas.defaultExperiment('gradient-descent');experiment.id='import-experiment';experiment.config.learningRate=.125;experiment.comparisonConfig={...experiment.config,learningRate:.25};const before=JSON.stringify(await get('/api/state'));
    await t.previewImport({schemaVersion:1,shards:[{id:'experiment-import-note',title:'Imported reproducible setup',experiments:[experiment]}]});const preview=$('#import-preview-content').innerHTML;assert.match(preview,/Interactive experiment/);assert.match(preview,/Configuration B/);assert.ok(!preview.includes('data-experiment-command="save"'));assert.ok(!preview.includes('data-experiment-command="attach"'));assert.equal(JSON.stringify(await get('/api/state')),before);await t.runAction('confirm-import',{dataset:{}});const saved=(await get('/api/state')).shards.find(shard=>shard.id==='experiment-import-note');assert.equal(saved.experiments[0].config.learningRate,.125);assert.equal(saved.experiments[0].comparisonConfig.learningRate,.25);assert.equal(saved.experiments[0].algorithmVersion,1);
  });
  await check('Malformed experiment input shows validation errors without crashing import review',async()=>{
    await t.previewImport({schemaVersion:1,shards:[{id:'experiment-invalid',title:'Invalid setup',experiments:[null,{id:'bad',title:'Bad',type:'gradient-descent',algorithmVersion:9,config:{}}]}]});assert.ok($('#import-preview-dialog').open);assert.ok($('#confirm-import').disabled);assert.match($('#import-preview-content').innerHTML,/experiment|algorithm|object/i);t.closeDialog('import-preview-dialog');
  });
  await check('Experiment editor drafts restore settings independently of the body',async()=>{
    const card=t.state.data.shards.find(shard=>shard.id==='experiment-import-note');t.openEditor(card.id);const form=$('#editor-form'),config=JSON.parse(form.elements.experiments.value);assert.equal(config[0].config.learningRate,.125);config[0].config.learningRate='';form.elements.experiments.value=JSON.stringify(config);form.elements.content.value='Unfinished experiment edit.';t.scheduleDraft('editor');await t.persistDraft('editor');const draft=t.drafts.editor;$('#editor-dialog').close();t.openEditor(null,draft);assert.equal(JSON.parse(form.elements.experiments.value)[0].config.learningRate,'');assert.equal(form.elements.content.value,'Unfinished experiment edit.');await t.deleteDraft('editor');$('#editor-dialog').close();
  });
  await check('Background collection refresh waits while an experiment preview has changed',async()=>{
    const original=w.ExperimentAtlas.hasPreviewChanges;try{w.ExperimentAtlas.hasPreviewChanges=()=>true;assert.equal(t.canRefreshAtlas(),false);const result=await t.refreshAtlas();assert.equal(result.skipped,true);}finally{w.ExperimentAtlas.hasPreviewChanges=original;}assert.equal(t.canRefreshAtlas(),true);
  });
  const learningFixture={
    perspectives:[{title:'Geometric view',viewpoint:'Geometry',content:'A **geometric explanation** with $x+1$.',assumptions:['Projection fixture'],sourceUrl:'https://example.com/geometry',sourceLocation:'Figure 2'}],
    walkthroughs:[{title:'Worked path',kind:'derivation',goal:'Show the transition.',steps:[{title:'Substitute',expression:'x+1=3',explanation:'Substitution fixture.',justification:'Definition fixture.'}],conclusion:'Path conclusion.'}],
    comparisons:[{title:'Choose a method',question:'Which assumptions hold?',alternatives:[{name:'Method A',summary:'First option',assumptions:['Finite fixture'],strengths:['Exact fixture'],limitations:['Costly fixture'],cost:'Quadratic fixture'},{name:'Method B',summary:'Second option',assumptions:[],strengths:['Fast fixture'],limitations:['Approximate fixture'],cost:'Linear fixture'}],conclusion:'Choose according to assumptions.'}],
    learningLog:[{kind:'question',prompt:'Why is the projection unique?',status:'resolved',resolution:'Resolution fixture.',history:[{date:'2026-10-21',note:'Recorded question history.'}]}],
    verification:{status:'source-checked',note:'Manual source comparison fixture.',sourceUrl:'https://example.com/reference',sourceLocation:'Section 2',checkedAt:'2026-10-21'}
  };
  await check('Structured explanations render math, method choices and learning history beside independent verification', async () => {
    const sample={...t.state.data.shards[0],...learningFixture,status:'learning'};
    const output=t.renderDetail(sample);
    for(const text of ['Geometric view','Worked path','Choose a method','Method A','Method B','Why is the projection unique?','Recorded question history','Source checked','Learning'])assert.ok(output.includes(text),text);
    assert.match(output,/class="katex"/);assert.ok(!output.includes('data-view="compare"'));
  });
  await check('Search covers structured explanations and rich relationship scope', async () => {
    const previous={...t.state},sample=previous.data.shards[0],peer=previous.data.shards[1];
    try {
      t.state.data={...previous.data,shards:[{...sample,...learningFixture},peer],links:[{id:'rich-search',fromId:sample.id,toId:peer.id,type:'supports',note:'',scope:'Conditional evidence fixture'}]};t.clearFilters();
      for(const query of ['geometric explanation','substitution fixture','quadratic fixture','recorded question history','manual source comparison','conditional evidence']){t.state.query=query;assert.ok(t.filteredShards().some(shard=>shard.id===sample.id),query);}
    }finally{Object.assign(t.state,previous);t.renderNav();}
  });
  await check('Source verification filter is independent of personal understanding and treats old cards as unverified', async () => {
    const previous={...t.state},sample=previous.data.shards[0];
    try {
      t.state.data={...previous.data,shards:[{...sample,id:'verified-learning',status:'learning',...learningFixture},{...sample,id:'unverified-confident',status:'solid',verification:undefined}],links:[]};t.clearFilters();const before=JSON.stringify(t.state.data);
      t.state.verificationFilter='source-checked';assert.deepEqual(Array.from(t.filteredShards(),shard=>shard.id),['verified-learning']);
      t.state.status='solid';assert.equal(t.filteredShards().length,0);
      t.state.verificationFilter='unverified';assert.deepEqual(Array.from(t.filteredShards(),shard=>shard.id),['unverified-confident']);
      t.clearFilters();assert.equal(t.state.verificationFilter,'all');assert.equal(JSON.stringify(t.state.data),before);
    }finally{Object.assign(t.state,previous);t.renderNav();}
  });
  await check('Malformed nested learning data renders validation errors without failing the import review', async () => {
    await t.previewImport({schemaVersion:1,shards:[{id:'learning-invalid',title:'Malformed learning metadata',perspectives:[null],walkthroughs:[{steps:[null]}],comparisons:[null],learningLog:[null],verification:[]} ]});
    assert.ok($('#import-preview-dialog').open);assert.equal($('#confirm-import').disabled,true);assert.match($('#import-preview-content').innerHTML,/object|perspective|walkthrough|verification/i);t.closeDialog('import-preview-dialog');
  });
  await check('Rich import review edits connection scope without writing until confirmation and preserves structured content', async () => {
    const before=await get('/api/state');
    await t.previewImport({schemaVersion:1,shards:[{id:'learning-rich-a',title:'Structured QA concept',...learningFixture},{id:'learning-rich-b',title:'Related QA concept'}],links:[{id:'learning-rich-edge',fromId:'learning-rich-a',toId:'learning-rich-b',type:'supports',note:'Why these connect.',scope:'Initial scope.',evidence:'Reasoned connection.',sourceUrl:'https://example.com/edge',sourceLocation:'Lemma 2'}]});
    assert.match($('#import-preview-content').innerHTML,/Geometric view/);assert.equal((await get('/api/state')).shards.length,before.shards.length);
    document.dispatchEvent(new FixtureEvent('change',{target:{dataset:{importLinkField:'scope',linkIndex:'0'},value:'Reviewed finite setting.'}}));await until(()=>!$('#confirm-import').disabled);
    await t.runAction('confirm-import',{dataset:{}});const saved=await get('/api/state'),card=saved.shards.find(shard=>shard.id==='learning-rich-a'),edge=saved.links.find(link=>link.id==='learning-rich-edge');
    assert.equal(card.perspectives[0].title,'Geometric view');assert.equal(card.walkthroughs[0].steps[0].expression,'x+1=3');assert.equal(card.verification.status,'source-checked');assert.equal(card.status,'learning');assert.equal(edge.scope,'Reviewed finite setting.');assert.equal(edge.evidence,'Reasoned connection.');assert.equal(edge.sourceLocation,'Lemma 2');assert.match(t.renderDetail(card),/Where this connection applies/);
  });
  await check('Reusing a saved card redirects method comparisons as well as inline references', async () => {
    const existing=t.state.data.shards.find(shard=>shard.id==='learning-rich-b'),before=JSON.stringify(existing);
    await t.previewImport({schemaVersion:1,shards:[{id:'learning-method-referrer',title:'Method comparison QA',comparisons:[{title:'Related methods',alternatives:[{name:'Existing method',shardId:'learning-method-duplicate',summary:'See [[id:learning-method-duplicate|method]].'},{name:'Other method',summary:'Alternative.'}]}]},{id:'learning-method-duplicate',title:existing.title,content:'Should not replace saved concept.'}]});
    t.selectImportShard(1);await t.runAction('import-reuse-card',{dataset:{id:existing.id}});await t.runAction('confirm-import',{dataset:{}});
    const saved=await get('/api/state'),comparison=saved.shards.find(shard=>shard.id==='learning-method-referrer').comparisons[0];assert.equal(comparison.alternatives[0].shardId,existing.id);assert.match(comparison.alternatives[0].summary,/\[\[id:learning-rich-b\|/);assert.equal(JSON.stringify(saved.shards.find(shard=>shard.id===existing.id)),before);
  });
  await check('Editor drafts retain structured metadata and restore independently of the body', async () => {
    const card=t.state.data.shards.find(shard=>shard.id==='learning-rich-a'),form=$('#editor-form');t.openEditor(card.id);
    for(const key of ['perspectives','walkthroughs','comparisons','learningLog','verification'])assert.equal(JSON.stringify(JSON.parse(form.elements[key].value)),JSON.stringify(card[key]),key);
    form.elements.content.value='Draft body only.';t.scheduleDraft('editor');await t.persistDraft('editor');const recovered=t.drafts.editor;
    assert.equal(JSON.parse(recovered.values.perspectives)[0].title,'Geometric view');assert.equal(JSON.parse(recovered.values.verification).status,'source-checked');$('#editor-dialog').close();t.openEditor(null,recovered);assert.equal(JSON.parse(form.elements.learningLog.value)[0].history[0].note,'Recorded question history.');assert.equal(form.elements.content.value,'Draft body only.');await t.deleteDraft('editor');$('#editor-dialog').close();
  });
  await check('Connection editor and recoverable draft retain scope, evidence and exact source locator', async () => {
    const link=t.state.data.links.find(link=>link.id==='learning-rich-edge');t.openLink(link.fromId,link.id);const form=$('#link-form');
    for(const key of ['scope','evidence','sourceUrl','sourceLocation'])assert.equal(form.elements[key].value,link[key],key);
    form.elements.scope.value='Changed scope in draft.';t.scheduleDraft('connection');await t.persistDraft('connection');const recovered=t.drafts.connection;
    assert.equal(recovered.values.scope,'Changed scope in draft.');assert.equal(recovered.values.sourceLocation,'Lemma 2');await t.deleteDraft('connection');$('#link-dialog').close();
  });
  await check('Malformed academic input stays previewable with validation errors', async () => {
    await t.previewImport({schemaVersion:1,shards:[{id:'academic-invalid',title:'Malformed metadata',courses:[null],notation:[null]}]});
    assert.ok($('#import-preview-dialog').open);assert.equal($('#confirm-import').disabled,true);assert.match($('#import-preview-content').innerHTML,/course occurrence|notation|object/i);t.closeDialog('import-preview-dialog');
  });
  await check('Partial import saves only selected cards and omits connections to skipped new cards', async () => {
    await t.previewImport({schemaVersion:1,shards:[{id:'academic-selected',title:'Selected course concept'},{id:'academic-skipped',title:'Skipped course concept'}],links:[{id:'academic-skipped-edge',fromId:'academic-selected',toId:'academic-skipped',type:'depends_on'}]});
    await t.runAction('import-select-none',{dataset:{}});assert.equal($('#confirm-import').disabled,true);
    t.importIncluded.add(0);await t.revalidateImport();assert.match($('#import-preview-content').innerHTML,/1 connection is omitted/);
    const before=await get('/api/state');assert.ok(!before.shards.some(shard=>shard.id==='academic-selected'));
    await t.runAction('confirm-import',{dataset:{}});const saved=await get('/api/state');assert.ok(saved.shards.some(shard=>shard.id==='academic-selected'));assert.ok(!saved.shards.some(shard=>shard.id==='academic-skipped'));assert.ok(!saved.links.some(link=>link.id==='academic-skipped-edge'));
  });
  await check('Connection review can revise type and rationale and skip an edge before saving', async () => {
    await t.previewImport({schemaVersion:1,shards:[{id:'academic-edge-a',title:'Edge source'},{id:'academic-edge-b',title:'Edge target'}],links:[{id:'academic-edge-kept',fromId:'academic-edge-a',toId:'academic-edge-b',type:'depends_on',note:'Original reason.'},{id:'academic-edge-skipped',fromId:'academic-edge-b',toId:'academic-edge-a',type:'explains'}]});
    assert.match($('#import-preview-content').innerHTML,/Include this connection/);
    document.dispatchEvent(new FixtureEvent('change',{target:{dataset:{importLinkField:'note',linkIndex:'0'},value:'Reviewed relationship reason.'}}));await until(()=>!$('#confirm-import').disabled);
    document.dispatchEvent(new FixtureEvent('change',{target:{dataset:{importLinkField:'type',linkIndex:'0'},value:'related_to'}}));await until(()=>!$('#confirm-import').disabled);
    document.dispatchEvent(new FixtureEvent('change',{target:{dataset:{importLinkInclude:'1'},checked:false}}));await until(()=>!$('#confirm-import').disabled);
    assert.match($('#import-preview-content').innerHTML,/1 connection is skipped/);await t.runAction('confirm-import',{dataset:{}});const saved=await get('/api/state');assert.ok(!saved.links.some(link=>link.id==='academic-edge-skipped'));const edge=saved.links.find(link=>link.id==='academic-edge-kept');assert.equal(edge.type,'related_to');assert.equal(edge.note,'Reviewed relationship reason.');
  });
  await check('Incoming card edits affect the reviewed batch before any collection write', async () => {
    await t.previewImport({schemaVersion:1,shards:[{id:'academic-edited',title:'Incoming draft',content:'Original candidate.',tags:[]}]});
    await t.runAction('edit-import-shard',{dataset:{}});assert.ok($('#import-edit-dialog').open);const form=$('#import-edit-form');form.elements.title.value='Reviewed candidate';form.elements.content.value='Corrected before saving.';submit(form);
    await until(()=>!$('#import-edit-dialog').open&&!$('#confirm-import').disabled);assert.ok(!(await get('/api/state')).shards.some(shard=>shard.id==='academic-edited'));assert.match($('#import-preview-content').innerHTML,/Corrected before saving/);
    await t.runAction('confirm-import',{dataset:{}});assert.equal((await get('/api/state')).shards.find(shard=>shard.id==='academic-edited').title,'Reviewed candidate');
  });
  await check('Explicit duplicate reuse redirects relationships and inline links while preserving saved metadata', async () => {
    const existing=t.state.data.shards.find(shard=>shard.id==='academic-selected'),original=JSON.stringify(existing);
    await t.previewImport({schemaVersion:1,shards:[{id:'academic-referrer',title:'A connected new idea',content:'See [[id:academic-duplicate|the saved idea]].'},{id:'academic-duplicate',title:existing.title,content:'Incoming duplicate.',subjects:['ML']}],links:[{id:'academic-reused-edge',fromId:'academic-referrer',toId:'academic-duplicate',type:'depends_on'}]});
    t.selectImportShard(1);await t.runAction('import-reuse-card',{dataset:{id:existing.id}});assert.match($('#import-preview-content').innerHTML,/Its saved explanation, course memberships, and notation stay intact/);
    await t.runAction('confirm-import',{dataset:{}});const saved=await get('/api/state');assert.equal(JSON.stringify(saved.shards.find(shard=>shard.id===existing.id)),original);assert.ok(!saved.shards.some(shard=>shard.id==='academic-duplicate'));assert.equal(saved.links.find(link=>link.id==='academic-reused-edge').toId,existing.id);assert.match(saved.shards.find(shard=>shard.id==='academic-referrer').content,/\[\[id:academic-selected\|/);
  });
  await check('Saving rechecks a changed collection and requires review of the new conflict', async () => {
    await t.previewImport({schemaVersion:1,shards:[{id:'academic-concurrent',title:'Incoming version',content:'Incoming text.'}]});
    await post('/api/contributions',{requestId:'academic-concurrent-write',shards:[{id:'academic-concurrent',title:'Saved by another chat',content:'Preserve this text.'}],links:[]});
    await t.runAction('confirm-import',{dataset:{}});assert.ok($('#import-preview-dialog').open);assert.match($('#import-preview-content').innerHTML,/existing content will be preserved/);assert.equal((await get('/api/state')).shards.find(shard=>shard.id==='academic-concurrent').content,'Preserve this text.');t.closeDialog('import-preview-dialog');
  });
  await check('AI JSON review renders full cards, syntax, math, releases, sources and pending relationships without saving', async () => {
    const before = JSON.stringify(await get('/api/state')), clientBefore = JSON.stringify(t.state.data);
    const archive = { schemaVersion: 1, shards: [
      { id: 'review-rich-note', title: 'Generated <script>alert(1)</script> card', kind: 'concept', status: 'learning', tags: ['Templates'], languageVersion: 'C++11 / C++20', sourceUrl: 'https://en.cppreference.com/w/cpp/language/templates.html', sources: [{ url: 'https://en.cppreference.com/w/cpp/language/constraints.html', title: 'Constraints reference', note: 'Checked supporting source.' }], content: '## A complete explanation\n\n```cpp\ntemplate<class T>\nT twice(T value) { return value + value; }\n```\n\n$x+1$\n\nRead [[id:review-peer-note|Pending peer]].\n\nThe last paragraph must remain visible in full.' },
      { id: 'review-peer-note', title: 'Pending peer', content: 'A second incoming card.', tags: ['Types'] }
    ], links: [{ id: 'review-generated-link', fromId: 'review-rich-note', toId: 'review-peer-note', type: 'depends_on', note: 'Understand this dependency first.' }], boards: [] };
    const originalArchive = JSON.stringify(archive);
    t.openEditor(); $('#shard-title').value = 'An unfinished personal draft'; $('#shard-content').value = 'Keep this draft exactly.';
    await t.previewImport(archive, 'Generated cards.json');
    let output = $('#import-preview-content').innerHTML;
    assert.ok($('#import-preview-dialog').open); assert.match(output, /class="import-card-review"/); assert.match(output, /class="import-review-card/);
    assert.match(output, /Generated &lt;script&gt;alert\(1\)&lt;\/script&gt; card/); assert.ok(!output.includes('<script>'));
    assert.match(output, /syn-keyword/); assert.match(output, /class="katex"/); assert.match(output, /Templates/); assert.match(output, /C\+\+11/); assert.match(output, /C\+\+20/);
    assert.match(output, /Constraints reference/); assert.match(output, /Checked supporting source/); assert.match(output, /The last paragraph must remain visible in full\./);
    assert.match(output, /Pending peer/); assert.match(output, /Understand this dependency first\./); assert.match(output, /depends on|depends_on/i); assert.ok(!output.includes('wiki-link missing'));
    assert.match(output, /data-action="preview-import-shard"[^>]*data-index="1"/);
    await t.runAction('preview-import-shard', { dataset: { index: '1' } }); output = $('#import-preview-content').innerHTML;
    assert.match(output, /A second incoming card\./); assert.match(output, /Types/);
    t.selectImportShard(-1); t.selectImportShard(99); assert.match($('#import-preview-content').innerHTML, /A second incoming card\./);
    const editor = $('#editor-form'), requestSubmit = editor.requestSubmit, writes = apiWrites; let submitted = 0;
    editor.requestSubmit = function () { submitted++; return requestSubmit.call(this); };
    try {
      document.dispatchEvent(new FixtureEvent('keydown', { key: 'Enter', metaKey: true, target: $('#import-preview-content') }));
      document.dispatchEvent(new FixtureEvent('keydown', { key: 'Enter', ctrlKey: true, target: $('#import-preview-content') }));
      await delay(20); assert.equal(submitted, 0, 'Review shortcuts must not submit the editor underneath'); assert.equal(apiWrites, writes);
      assert.ok($('#import-preview-dialog').open && $('#editor-dialog').open);
    } finally { editor.requestSubmit = requestSubmit; }
    assert.equal($('#shard-title').value, 'An unfinished personal draft'); assert.equal($('#shard-content').value, 'Keep this draft exactly.'); assert.ok($('#editor-dialog').open);
    assert.equal(JSON.stringify(t.state.data), clientBefore); assert.equal(JSON.stringify(await get('/api/state')), before); assert.equal(JSON.stringify(archive), originalArchive);
    t.closeDialog('import-preview-dialog'); $('#editor-dialog').close();
  });
  await check('Embedded JSON photos are reviewable and enlargeable before commit, then revoked on cancel', async () => {
    const before = JSON.stringify(await get('/api/state'));
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7m8AAAAASUVORK5CYII=';
    const archive = { schemaVersion: 1, shards: [{ id: 'review-photo-note', title: 'Pending photo', content: '![Diagram <caption>](/assets/review-photo-asset)', tags: [] }], assets: [{ id: 'review-photo-asset', name: 'diagram.png', mimeType: 'image/png', data: png }], links: [] };
    const original = JSON.stringify(archive); await t.previewImport(archive, 'With a photo.json');
    assert.equal($('#confirm-import').disabled, false); const url = t.importImageUrls.get('review-photo-asset'); assert.ok(url?.startsWith('blob:')); assert.ok(previewObjectUrls.has(url));
    const output = $('#import-preview-content').innerHTML; assert.ok(output.includes('src="' + url + '"')); assert.ok(output.includes('data-image-src="' + url + '"')); assert.match(output, /Diagram &lt;caption&gt;/);
    assert.equal((await fetch(base + '/assets/review-photo-asset')).status, 404); assert.equal(JSON.stringify(await get('/api/state')), before); assert.equal(JSON.stringify(archive), original);
    t.openImageViewer(url, 'Pending diagram'); assert.ok($('#image-viewer-dialog').open); assert.equal($('#image-viewer-image').src, url);
    t.closeDialog('image-viewer-dialog'); t.closeDialog('import-preview-dialog');
    assert.equal(t.importImageUrls.size, 0); assert.ok(!previewObjectUrls.has(url)); assert.ok(revokedPreviewUrls.includes(url));
    t.openImageViewer(url, 'Expired preview'); assert.ok(!$('#image-viewer-dialog').open); assert.equal(JSON.stringify(await get('/api/state')), before);
  });
  await check('Import review labels existing-ID conflicts while preserving the current card', async () => {
    const existing = t.state.data.shards[0], before = JSON.stringify(await get('/api/state'));
    await t.previewImport({ schemaVersion: 1, shards: [{ id: existing.id, title: 'Different incoming title', content: 'Incoming content cannot replace the existing card.', tags: [] }], links: [] }, 'Conflicting card.json');
    const output = $('#import-preview-content').innerHTML;
    assert.match(output, /Existing card kept|Already in your atlas/); assert.match(output, /Incoming content cannot replace the existing card/); assert.match(output, /existing content will be preserved|will not replace|won.t replace/i);
    assert.equal(JSON.stringify(await get('/api/state')), before); t.closeDialog('import-preview-dialog');
  });
  await check('Invalid JSON archives remain previewable but cannot be confirmed', async () => {
    const before = JSON.stringify(await get('/api/state'));
    await t.previewImport({ schemaVersion: 1, shards: [{ id: 'review-invalid-note', title: 'Invalid photo fixture', content: '![Missing](/assets/review-bad-photo)', tags: [] }], assets: [{ id: 'review-bad-photo', name: 'bad.png', mimeType: 'image/png', data: 'not-base64' }] }, 'Invalid archive.json');
    assert.equal($('#confirm-import').disabled, true); assert.equal(t.importImageUrls.size, 0); assert.match($('#import-preview-content').innerHTML, /base64|supported raster|invalid/i);
    const writes = apiWrites; await t.runAction('confirm-import', { dataset: {} }); assert.equal(apiWrites, writes); assert.equal(JSON.stringify(await get('/api/state')), before); assert.ok($('#import-preview-dialog').open);
    t.closeDialog('import-preview-dialog');
  });
  await check('Replacing or cancelling an import review releases photo previews and clears confirmation state', async () => {
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7m8AAAAASUVORK5CYII=';
    await t.previewImport({ schemaVersion: 1, shards: [{ id: 'review-replaced-photo-note', title: 'Replaced photo', content: '![Diagram](/assets/review-replaced-photo)', tags: [] }], assets: [{ id: 'review-replaced-photo', name: 'diagram.png', mimeType: 'image/png', data: png }] });
    const oldUrl = t.importImageUrls.get('review-replaced-photo'); assert.ok(oldUrl);
    await t.previewImport({ schemaVersion: 1, shards: [{ id: 'review-replacement-note', title: 'Replacement card', content: 'Use this replacement.', tags: [] }] });
    assert.ok(revokedPreviewUrls.includes(oldUrl)); assert.equal(t.importImageUrls.size, 0); assert.match($('#import-preview-content').innerHTML, /Use this replacement/);
    t.closeDialog('import-preview-dialog'); const writes = apiWrites; await t.runAction('confirm-import', { dataset: {} }); assert.equal(apiWrites, writes); assert.ok(!$('#import-preview-dialog').open);
  });
  await check('A later import selection wins over a delayed earlier preview response', async () => {
    let release; importPreviewGate = new Promise(resolve => { release = resolve; }); importPreviewStarted = false;
    const old = t.previewImport({ schemaVersion: 1, shards: [{ id: 'review-stale-old', title: 'Old delayed card', content: 'Do not reopen this.', tags: [] }] }, 'Earlier file');
    await until(() => importPreviewStarted);
    await t.previewImport({ schemaVersion: 1, shards: [{ id: 'review-stale-new', title: 'Newest selected card', content: 'Keep the newest selection.', tags: [] }] }, 'Newest file');
    release(); await old;
    assert.equal($('#import-preview-title').textContent, 'Newest file'); assert.match($('#import-preview-content').innerHTML, /Keep the newest selection/); assert.ok(!$('#import-preview-content').innerHTML.includes('Do not reopen this.'));
    t.closeDialog('import-preview-dialog');
  });
  await check('Cancelling a pending import response cannot reopen or confirm it', async () => {
    let release; importPreviewGate = new Promise(resolve => { release = resolve; }); importPreviewStarted = false;
    const pending = t.previewImport({ schemaVersion: 1, shards: [{ id: 'review-cancelled-response', title: 'Cancelled delayed card', content: 'Never save this.', tags: [] }] });
    await until(() => importPreviewStarted); t.clearImportPreview(); release(); await pending;
    assert.ok(!$('#import-preview-dialog').open); const writes = apiWrites; await t.runAction('confirm-import', { dataset: {} }); assert.equal(apiWrites, writes);
  });
  await check('Confirming a reviewed embedded photo imports the original bytes and card text', async () => {
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7m8AAAAASUVORK5CYII=';
    const content = '![Kept caption](/assets/review-committed-photo)';
    await t.previewImport({ schemaVersion: 1, shards: [{ id: 'review-committed-photo-note', title: 'Committed photo fixture', content, tags: [] }], assets: [{ id: 'review-committed-photo', name: 'diagram.png', mimeType: 'image/png', data: png }], links: [] });
    const url = t.importImageUrls.get('review-committed-photo'); await t.runAction('confirm-import', { dataset: {} });
    assert.ok(!$('#import-preview-dialog').open); assert.equal(t.importImageUrls.size, 0); assert.ok(revokedPreviewUrls.includes(url));
    assert.equal(t.state.data.shards.find(shard => shard.id === 'review-committed-photo-note').content, content);
    const response = await fetch(base + '/assets/review-committed-photo'); assert.equal(response.status, 200); assert.deepEqual(Buffer.from(await response.arrayBuffer()), Buffer.from(png, 'base64'));
  });
  await check('Import preview is read-only, confirmation produces a receipt and undo preserves edited notes', async () => {
    const count=(await get('/api/state')).shards.length;await t.previewImport({schemaVersion:1,shards:[{id:'frontend-preview-note',title:'Preview fixture',content:'Original import text',tags:[]}],links:[],boards:[]},'QA import');assert.ok($('#import-preview-dialog').open);assert.equal((await get('/api/state')).shards.length,count);await t.runAction('confirm-import',{dataset:{}});assert.ok(!$('#import-preview-dialog').open);assert.ok(t.state.data.shards.some(s=>s.id==='frontend-preview-note'));const receipt=(await get('/api/imports')).imports[0];assert.ok(receipt.id);
    await post('/api/shards/frontend-preview-note',{title:'Edited after import'},'PUT');await t.runAction('undo-import',{dataset:{id:receipt.id}});$('#confirm-action').click();await until(()=>!$('#confirm-dialog').open&&!t.busy);assert.equal((await get('/api/state')).shards.find(s=>s.id==='frontend-preview-note').title,'Edited after import');$('#recovery-dialog').close();
  });
  await check('Legacy connection-map routes open the focused Topic map without restoring the removed section', async () => {
    await withAtlasCollection(async () => {
      await until(()=>t.pending===0);const before=JSON.stringify(t.state.data),writes=apiWrites;
      t.state.selectedId='atlas-a';t.state.atlasExpandedIds=['atlas-c'];t.changeView('graph');
      assert.equal(t.state.view,'atlas');assert.equal(t.state.atlasMode,'connections');assert.equal(t.state.atlasSelectedId,'atlas-a');assert.equal(t.state.atlasExpandedIds.length,0);
      assert.ok(!/Ideas belong together\.|class="graph-controls"|id="graph-(?:color|group)"/.test($('#workspace').innerHTML));
      t.changeView('library');t.state.selectedId='atlas-b';t.state.atlasMode='topics';w.shardAtlasDesktop.command('graph');
      assert.equal(t.state.view,'atlas');assert.equal(t.state.atlasMode,'connections');assert.equal(t.state.atlasSelectedId,'atlas-b');assert.equal($('#view-label').textContent,'Topic map');
      assert.deepEqual(Array.from(t.atlasRelationshipModel().nodes,shard=>shard.id).sort(),['atlas-a','atlas-b','atlas-c']);
      assert.equal(apiWrites,writes);assert.equal(JSON.stringify(t.state.data),before);t.changeView('library');
    });
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
