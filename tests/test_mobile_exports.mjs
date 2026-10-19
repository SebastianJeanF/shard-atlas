#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { markdownZip } from '../mobile/exports.mjs';

// Python's independent ZIP reader verifies headers, CRCs, byte contents, and paths.
function unzip(bytes) {
  return JSON.parse(execFileSync('python3', ['-c', `
import base64, io, json, sys, zipfile
with zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())) as archive:
    assert archive.testzip() is None
    assert all(info.compress_type == zipfile.ZIP_STORED for info in archive.infolist())
    assert len(archive.namelist()) == len(set(archive.namelist()))
    print(json.dumps({name: base64.b64encode(archive.read(name)).decode('ascii') for name in archive.namelist()}))
`], { input: bytes, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' }));
}

const binary = Uint8Array.from({ length: 256 }, (_, value) => value);
const cpp = '```cpp\r\nstd::string value = "<T> & /assets/image.v1:copy";\r\n// ![Literal](/assets/image.v1:copy)\r\n```';
const content = cpp + '\n\nActual image: ![Diagram](/assets/image.v1:copy)\nInline: `![Code](/assets/image.v1:copy)`\n    ![Indented code](/assets/image.v1:copy)\n';
const archive = {
  schemaVersion: 1, unknownFutureField: { keep: true },
  shards: [
    { id: 'cpp:one', title: 'C++ <T> & café', content, tags: ['C++', 'Types'], kind: 'concept', status: 'learning', sourceUrl: 'https://example.com/primary', sources: [{ title: 'Reference', url: 'https://example.com/reference', note: 'Preserve caveat.', publishedDate: '2026', accessedDate: '2026-10-19' }] },
    { id: 'cpp-two', title: 'Second shard', content: 'Keep my exact explanation: $x < y$.' },
  ],
  links: [{ id: 'one-to-two', fromId: 'cpp:one', toId: 'cpp-two', type: 'contrasts_with', note: 'Typed direction remains recorded.' }],
  assets: [{ id: 'image.v1:copy', name: 'diagram.png', mimeType: 'image/png', data: Buffer.from(binary).toString('base64') }],
  revisions: [{ id: 'history-1', snapshot: { content: 'Original content.' } }],
  trash: [{ id: 'deleted-1', content: 'Recovery data.' }], reviews: [{ id: 'legacy-review' }],
};
const before = JSON.stringify(archive);
const zip = markdownZip(archive);
assert.ok(zip instanceof Uint8Array);
assert.equal(JSON.stringify(archive), before);
assert.deepEqual(markdownZip(archive), zip, 'The same archive produces deterministic bytes.');
const files = unzip(zip);
const text = name => Buffer.from(files[name], 'base64').toString('utf8');
assert.deepEqual(JSON.parse(text('shard-atlas.json')), archive);
assert.deepEqual(JSON.parse(text('relationships.json')), archive.links);
const asset = Object.keys(files).find(name => name.startsWith('assets/'));
assert.deepEqual(Buffer.from(files[asset], 'base64'), Buffer.from(binary));
const note = text(Object.keys(files).find(name => name.startsWith('notes/C-')));
assert.ok(note.includes(cpp), 'C++ code preserves original characters and CRLF line endings.');
assert.ok(note.includes('Actual image: ![Diagram](../' + asset + ')'));
assert.ok(note.includes('Inline: `![Code](/assets/image.v1:copy)`'));
assert.ok(note.includes('    ![Indented code](/assets/image.v1:copy)'));
assert.ok(note.includes('https://example.com/primary'));
assert.ok(note.includes('Preserve caveat.'));
assert.ok(note.includes('Published: 2026'));
assert.ok(note.includes('Accessed: 2026-10-19'));
assert.ok(note.includes('→ contrasts with →'));
assert.ok(note.includes('Typed direction remains recorded.'));
assert.ok(note.includes('[Second shard](Second-shard--cpp-two.md)'));

const unsafe = { shards: [
  { id: '../../evil', title: '../ / unsafe', content: '![Image](/assets/../../photo)' },
  { id: '../../evil', title: '../ / unsafe', content: 'Duplicate malformed IDs must not overwrite files.' },
  { id: '~2E', title: '雪 ❄️', content: 'UTF-8 content survives: λ, 日本語, 🧠' },
], assets: [
  { id: '../../photo', data: 'AQID' }, { id: '../../photo', data: 'BAU=' }, { id: '.', data: 'Bg==' },
] };
const safeFiles = unzip(markdownZip(unsafe));
assert.equal(Object.keys(safeFiles).length, 8);
for (const path of Object.keys(safeFiles)) {
  assert.ok(!path.startsWith('/') && !path.includes('\\'));
  assert.ok(!path.split('/').includes('..') && !path.split('/').includes('.'));
}
const firstNote = Object.keys(safeFiles).find(name => name.startsWith('notes/unsafe--'));
assert.ok(Buffer.from(safeFiles[firstNote], 'base64').toString().includes('../assets/~2E.~2F..~2Fphoto'));
assert.ok(Object.values(safeFiles).some(data => Buffer.from(data, 'base64').toString().includes('UTF-8 content survives: λ, 日本語, 🧠')));
assert.equal(Object.keys(unzip(markdownZip({ shards: [], assets: [], links: [] }))).length, 2);
assert.throws(() => markdownZip({ assets: [{ id: 'missing' }] }), /complete archive/);
assert.throws(() => markdownZip({ assets: [{ id: 'bad', data: 'not base64!' }] }), /invalid base64/);
assert.throws(() => markdownZip(null), /archive object/);
console.log('Mobile export tests passed.');
