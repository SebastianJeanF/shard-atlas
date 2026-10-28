import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const window = {document: {activeElement: null}};
vm.runInNewContext(readFileSync(new URL('../static/image-editor.js', import.meta.url), 'utf8'), {window});
const images = window.ShardAtlasImageEditor;
const plain = value => JSON.parse(JSON.stringify(value));
const png = (name, overrides = {}) => ({name, type: 'image/png', size: 100, ...overrides});

test('image controls identify prose references without changing literal examples or offsets', () => {
  const content = 'Intro\r\n![Visible](/assets/a)\r\n'
    + '`![inline](/assets/literal)` and ``![ticks](/assets/literal2)``\r\n'
    + '````cpp\r\nconst char* x = "![fenced](/assets/literal3)";\r\n```\r\n````\r\n'
    + '~~~text\r\n![tilde](/assets/literal4)\r\n~~~\r\n'
    + '    ![indented](/assets/literal5)\r\n'
    + '\\![escaped](/assets/literal6)\r\n![Last](/assets/b)';
  const refs = images.references(content);
  assert.deepEqual(Array.from(refs, ref => ref.source), ['/assets/a', '/assets/b']);
  for (const ref of refs) assert.equal(content.slice(ref.start, ref.end), ref.raw);
});

test('captions round-trip brackets, backslashes, math/currency and HTML as plain text', () => {
  const caption = 'A [x] $4 price \\ source <img onerror="bad()">';
  const markdown = images.imageMarkdown('/assets/a', caption);
  const [ref] = images.references(markdown);
  assert.equal(ref.caption, caption);
  assert.equal(ref.source, '/assets/a');
  assert.equal(images.references(images.imageMarkdown('/assets/a', 'line one\nline two'))[0].caption, 'line one line two');
  for (const source of ['https://example.com/a.png', 'blob:external', '/assets/a?query=1', '/assets/a/extra']) {
    assert.throws(() => images.imageMarkdown(source, ''), /address is invalid/);
  }
});

test('replacement and removal affect one prose reference while retaining exact source bytes', () => {
  const code = '\r\n```cpp\r\n\tconst char* value = "![same](/assets/a)";  \r\n```\r\n';
  const content = 'Before ![same](/assets/a) middle ![same](/assets/a) after' + code;
  const refs = images.references(content);
  const changed = images.replaceReference(content, refs[1], images.imageMarkdown('/assets/b', 'new'));
  assert.equal(changed, 'Before ![same](/assets/a) middle ![new](/assets/b) after' + code);
  const removed = images.replaceReference(content, refs[0], '');
  assert.equal(removed, 'Before  middle ![same](/assets/a) after' + code);
  assert.throws(() => images.replaceReference('New ' + content, refs[0], ''), /explanation changed/);
});

test('image insertion preserves selected text and surrounding CRLF/code literally', () => {
  const before = 'Intro\r\nSELECTED', after = '\r\n```cpp\r\n\treturn value;  \r\n```';
  const result = images.insertImages(before + after, [{source: '/assets/a', caption: 'A'}, {source: '/assets/b', caption: 'B'}], {start: 7, end: before.length});
  assert.ok(result.value.startsWith(before));
  assert.ok(result.value.endsWith(after));
  assert.equal(images.references(result.value).length, 2);
  assert.equal(result.value.slice(result.cursor), after);
});

test('caption edits remap a saved cursor after the reference instead of inserting inside markup', () => {
  const source = 'Intro ![a](/assets/picture) suffix';
  const [ref] = images.references(source);
  const replacement = images.imageMarkdown(ref.source, 'A much longer caption');
  const cursor = source.length;
  const next = images.replaceReference(source, ref, replacement);
  const selection = images.remapSelection({start: cursor, end: cursor}, ref.start, ref.end, replacement.length);
  assert.equal(selection.end, next.length);
  assert.deepEqual(plain(images.remapSelection({start: 2, end: 2}, ref.start, ref.end, replacement.length)), {start: 2, end: 2});
  assert.equal(images.remapSelection({end: ref.start + 2}, ref.start, ref.end, 0).end, ref.start);
  assert.ok(images.insertImages(next, [{source: '/assets/new'}], selection).value.startsWith(next));
});

test('file validation accepts supported desktop files with missing MIME and enforces limits', () => {
  assert.equal(images.validateFile(png('SCREENSHOT.PNG', {type: ''})), 'image/png');
  assert.equal(images.validateFile(png('photo.JPEG', {type: 'application/octet-stream'})), 'image/jpeg');
  assert.equal(images.validateFile(png('photo', {type: 'IMAGE/WEBP'})), 'image/webp');
  assert.equal(images.validateFile(png('large.png', {size: 8 * 1024 * 1024})), 'image/png');
  assert.throws(() => images.validateFile(png('oversize.png', {size: 8 * 1024 * 1024 + 1})), /8 MB/);
  assert.throws(() => images.validateFile(png('empty.png', {size: 0})), /empty/);
  assert.throws(() => images.validateFile(png('file.svg', {type: 'image/svg+xml'})), /PNG, JPEG, GIF, or WebP/);
  assert.throws(() => images.validateFile(png('fake.png', {type: 'text/plain'})), /PNG, JPEG, GIF, or WebP/);
});

function editorFixture(content = '') {
  const listeners = () => ({events: new Map(), addEventListener(name, fn) {this.events.set(name, fn);}});
  const field = {...listeners(), value: content, selectionStart: content.length, selectionEnd: content.length,
    setSelectionRange(start, end) {this.selectionStart = start; this.selectionEnd = end;}, focus() {window.document.activeElement = this;}};
  const picker = {...listeners(), value: '', files: [], click() {this.clicks = (this.clicks || 0) + 1;}};
  const list = {children: [], hidden: false,
    set innerHTML(value) {this.children = [...value.matchAll(/data-image-index="(\d+)"/g)].map(() => {
      const image = {getAttribute(name) {return this[name] || null;}, setAttribute(name, value) {this[name] = value;}};
      const input = {value: ''};
      const button = {setAttribute(name, value) {this[name] = value;}};
      return {querySelector(selector) {return selector === 'img' ? image : selector === '[data-image-editor="view"]' ? button : input;}};
    });}};
  const status = {dataset: {}}, count = {}, choose = {focus() {}}, section = {...listeners(), classList: {add() {}, remove() {}},
    setAttribute() {}, removeAttribute() {}, querySelector(selector) {return {'[data-image-list]': list, '[data-image-status]': status, '[data-image-count]': count, '[data-image-editor="choose"]': choose}[selector];}};
  let busy = false, changed = 0, sequence = 0, beforePicker = false;
  const controller = images.mount({section, field, picker, isBusy: () => busy,
    run: async task => {busy = true; try {return await task();} finally {busy = false;}},
    upload: async file => {if (file.name === 'corrupt.png') throw new Error('Invalid image bytes.'); return {url: '/assets/upload-' + (++sequence)};},
    changed: () => {changed++;}, imageSource: path => 'blob:' + path, openImage() {}, beforePicker: () => {beforePicker = true;}});
  controller.reset();
  return {controller, field, picker, status, list, count, section, changed: () => changed, beforePicker: () => beforePicker};
}

test('mixed multi-file uploads retain successes, report file errors, and insert at the captured cursor', async () => {
  const fixture = editorFixture('Before AFTER');
  fixture.field.selectionStart = fixture.field.selectionEnd = 7;
  fixture.controller.capture();
  const result = await fixture.controller.addFiles([png('first.png', {type: ''}), png('bad.svg', {type: 'image/svg+xml'}), png('corrupt.png'), png('second.png')]);
  assert.equal(result.added, 2);
  assert.equal(result.errors.length, 2);
  assert.equal(images.references(fixture.field.value).length, 2);
  assert.ok(fixture.field.value.startsWith('Before '));
  assert.ok(fixture.field.value.endsWith('AFTER'));
  assert.equal(fixture.list.children.length, 2);
  assert.equal(fixture.changed(), 2);
  assert.match(fixture.status.textContent, /2 images added/);
  assert.match(fixture.status.textContent, /bad\.svg/);
  assert.match(fixture.status.textContent, /corrupt\.png: Invalid image bytes/);
});

test('file picker opens synchronously with replacement/multiple state set first', () => {
  const fixture = editorFixture();
  fixture.controller.choose();
  assert.equal(fixture.picker.clicks, 1);
  assert.equal(fixture.picker.multiple, true);
  assert.equal(fixture.beforePicker(), true);
  fixture.controller.choose({start: 0, end: 0, raw: '', source: '/assets/a'});
  assert.equal(fixture.picker.clicks, 2);
  assert.equal(fixture.picker.multiple, false);
});
