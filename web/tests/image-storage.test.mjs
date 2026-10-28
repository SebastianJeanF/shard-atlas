import test from 'node:test';
import assert from 'node:assert/strict';
import {IDBFactory} from 'fake-indexeddb';
import {BrowserStore} from '../../web-dist/persistence.mjs';
import {markdownZip} from '../../web-dist/exports.mjs';

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jR7sAAAAASUVORK5CYII=';
const gif = 'R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';
const image = (asset, caption) => `![${caption}](/assets/${asset.id})`;
const source = '\tconst char* example = "![literal](/assets/not-an-image)";  \r\n';

function device(t, indexedDB = new IDBFactory()) {
  const store = new BrowserStore(indexedDB);
  t.after(async () => (await store.ready).close());
  return {store, indexedDB};
}
async function asset(store, name = 'diagram.png', mimeType = 'image/png', data = png) {
  return (await store.request('/api/assets', 'POST', {name, mimeType, data})).result;
}
async function create(store, title, content) {
  const {result} = await store.request('/api/shards', 'POST', {title, content, codeSolution: {role: 'snippet', code: source}});
  return result.shards.find(shard => shard.title === title);
}
async function exported(store) {return (await store.request('/api/export')).result;}
function zipFiles(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), files = new Map();
  let offset = 0;
  while (view.getUint32(offset, true) === 0x04034b50) {
    assert.equal(view.getUint16(offset + 8, true), 0, 'export uses standard stored ZIP members');
    const size = view.getUint32(offset + 18, true), nameLength = view.getUint16(offset + 26, true), extraLength = view.getUint16(offset + 28, true);
    const name = new TextDecoder().decode(bytes.subarray(offset + 30, offset + 30 + nameLength));
    const start = offset + 30 + nameLength + extraLength;
    files.set(name, bytes.slice(start, start + size));
    offset = start + size;
  }
  assert.equal(view.getUint32(offset, true), 0x02014b50);
  return files;
}

test('new and existing shards retain multiple inline images, captions, surrounding text and exact code', async t => {
  const {store} = device(t), first = await asset(store), second = await asset(store, 'process.gif', 'image/gif', gif);
  const content = `Before the diagram.\n\n${image(first, 'Queue before processing: α → β')}\n\nBetween the images.\n\n${image(second, 'Queue after processing')}\n\nAfter both images.`;
  const shard = await create(store, 'Image lifecycle fixture', content);
  assert.equal(shard.content, content);
  const changed = content.replace('Queue before processing: α → β', 'Updated caption: input → output');
  await store.request(`/api/shards/${shard.id}`, 'PUT', {content: changed});
  const saved = await exported(store);
  assert.equal(saved.shards[0].content, changed);
  assert.equal(saved.shards[0].codeSolution.code, source);
  assert.deepEqual(saved.assets.map(item => item.data), [png, gif]);
  assert.equal(saved.revisions.find(item => item.shardId === shard.id && item.reason === 'created').snapshot.content, content);
});

test('image drafts for new and existing shards survive restart and failed shard saves without losing bytes', async t => {
  const first = device(t), picture = await asset(first.store);
  const content = `Unfinished explanation.\n\n${image(picture, 'Draft diagram')}`;
  await first.store.request('/api/drafts/editor', 'PUT', {draft: {editingId: null, title: '', content}});
  await assert.rejects(first.store.request('/api/shards', 'POST', {title: '', content}), /title/);
  (await first.store.ready).close();
  const restarted = device(t, first.indexedDB);
  const draft = (await restarted.store.request('/api/drafts')).result.drafts.editor;
  assert.equal(draft.content, content);
  assert.equal((await exported(restarted.store)).shards.length, 0);
  assert.equal((await exported(restarted.store)).assets[0].data, png);
  const shard = await create(restarted.store, 'Saved from image draft', draft.content);
  assert.equal((await restarted.store.request('/api/drafts')).result.drafts.editor, null);

  const replacement = await asset(restarted.store, 'replacement.gif', 'image/gif', gif);
  const nextContent = image(replacement, 'Unfinished replacement');
  await restarted.store.request('/api/drafts/editor', 'PUT', {draft: {editingId: shard.id, title: '', content: nextContent}});
  await assert.rejects(restarted.store.request(`/api/shards/${shard.id}`, 'PUT', {title: '', content: nextContent}), /title/);
  (await restarted.store.ready).close();
  const again = device(t, first.indexedDB), saved = await exported(again.store);
  assert.equal(saved.shards[0].content, content, 'a failed edit leaves the saved shard intact');
  assert.equal((await again.store.request('/api/drafts')).result.drafts.editor.content, nextContent);
  assert.deepEqual(saved.assets.map(item => item.data), [png, gif]);
});

test('replacement and removal retain images used by another shard, saved versions, and Trash recovery', async t => {
  const {store} = device(t), original = await asset(store), replacement = await asset(store, 'replacement.gif', 'image/gif', gif);
  const oldContent = `Original explanation.\n\n${image(original, 'Original diagram')}`;
  const edited = await create(store, 'Editable image fixture', oldContent);
  const shared = await create(store, 'Shared image fixture', image(original, 'Same image, different caption'));
  const version = (await store.request(`/api/shards/${edited.id}/revisions`)).result.revisions[0];
  await store.request(`/api/shards/${edited.id}`, 'PUT', {content: image(replacement, 'Replacement diagram')});
  await store.request(`/api/shards/${edited.id}`, 'PUT', {content: 'Explanation after removing its image.'});
  assert.equal((await store.request(`/api/shards/${shared.id}`)).result.content, image(original, 'Same image, different caption'));
  assert.deepEqual((await exported(store)).assets.map(item => item.data), [png, gif]);
  await store.request(`/api/shards/${edited.id}/restore`, 'POST', {revisionId: version.id});
  assert.equal((await store.request(`/api/shards/${edited.id}`)).result.content, oldContent);
  await store.request(`/api/shards/${edited.id}`, 'DELETE');
  const trash = (await store.request('/api/trash')).result.trash.find(item => item.shard.id === edited.id);
  assert.equal(trash.shard.content, oldContent);
  await store.request(`/api/trash/${trash.id}/restore`, 'POST');
  assert.equal((await store.request(`/api/shards/${edited.id}`)).result.content, oldContent);
  assert.deepEqual((await exported(store)).assets.map(item => item.data), [png, gif]);
});

test('JSON and readable ZIP exports preserve image bytes, captions, stable references and saved versions', async t => {
  const {store} = device(t), first = await asset(store), second = await asset(store, 'process.gif', 'image/gif', gif);
  const content = `${image(first, 'Input diagram: α → β')}\n\nMiddle explanation.\n\n${image(second, 'Output diagram')}`;
  const shard = await create(store, 'Portable image fixture', content);
  await store.request(`/api/shards/${shard.id}`, 'PUT', {content: `${content}\n\nA later observation.`});
  const archive = await exported(store), files = zipFiles(markdownZip(archive));
  assert.deepEqual(files.get(`assets/${first.id}`), Uint8Array.from(Buffer.from(png, 'base64')));
  assert.deepEqual(files.get(`assets/${second.id}`), Uint8Array.from(Buffer.from(gif, 'base64')));
  const markdown = new TextDecoder().decode([...files].find(([name]) => name.endsWith(`--${shard.id}.md`))[1]);
  assert.ok(markdown.includes(`![Input diagram: α → β](../assets/${first.id})`));
  assert.ok(markdown.includes(`![Output diagram](../assets/${second.id})`));
  assert.ok(markdown.includes(source), 'literal image-like code remains byte-for-byte unchanged');
  const embedded = JSON.parse(new TextDecoder().decode(files.get('shard-atlas.json')));
  assert.deepEqual(embedded, archive);
  const restored = device(t).store;
  assert.equal((await restored.request('/api/import/preview', 'POST', {data: embedded})).result.valid, true);
  await restored.request('/api/import', 'POST', {data: embedded});
  assert.deepEqual(await exported(restored), archive);
});

test('a rejected image or archive import leaves saved images and the unfinished image draft intact', async t => {
  const {store} = device(t), picture = await asset(store);
  const content = image(picture, 'Keep this draft');
  await store.request('/api/drafts/editor', 'PUT', {draft: {title: 'Pending', content}});
  const before = await exported(store);
  await assert.rejects(asset(store, 'wrong.png', 'image/png', gif), /contents/);
  const badArchive = {...before, assets: [...before.assets, {...before.assets[0], id: 'corrupt-image', data: 'not base64'}]};
  await assert.rejects(store.request('/api/import', 'POST', {data: badArchive}), /base64/);
  assert.deepEqual(await exported(store), before);
  assert.equal((await store.request('/api/drafts')).result.drafts.editor.content, content);
});
