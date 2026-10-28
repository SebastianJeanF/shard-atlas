// Uploads stay outside the live library until the existing add/edit CAS commits.
import {resolveStagedImages} from './image-uploads.mjs';
import {assetDataHash, assetByteSize, registerAssetSource} from './cloud-capsule.mjs';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$/;
const HASH = /^[a-f0-9]{64}$/;
const UPLOAD_ID = /^image-upload-[a-f0-9]{64}$/;
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const fail = (message = 'The image attachment could not be verified.', status = 400) => {
  throw Object.assign(new Error(message), {code: 'invalid_image_attachment', status});
};

export function validateImageAttachments(images, targetIds) {
  if (!Array.isArray(images) || images.length > 20) fail();
  const targets = new Set(targetIds), placeholders = new Set();
  for (const item of images) {
    if (!object(item) || Object.keys(item).some(key => !['shardId', 'uploadId', 'caption', 'placement', 'placeholder'].includes(key))
        || !ID.test(item.shardId || '') || !UPLOAD_ID.test(item.uploadId || '') || !targets.has(item.shardId)
        || own(item, 'caption') && (typeof item.caption !== 'string' || [...item.caption].length > 1000 || /[\r\n]/.test(item.caption))) fail();
    const placement = item.placement ?? 'append';
    if (!['append', 'prepend', 'placeholder'].includes(placement)) fail();
    if (placement === 'placeholder') {
      if (typeof item.placeholder !== 'string' || !/^\{\{image:[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}\}\}$/.test(item.placeholder)) fail();
      const identity = item.shardId + '\n' + item.placeholder;
      if (placeholders.has(identity)) fail();
      placeholders.add(identity);
    } else if (own(item, 'placeholder')) fail();
  }
  return images;
}

const markdown = (id, caption) => '![' + caption.replace(/[\\\[\]]/g, '\\$&') + '](/assets/' + id + ')';
function placeholderRanges(source, token) {
  const result = [];
  let offset = 0, fence = null, inline = 0;
  for (const raw of source.match(/[^\r\n]*(?:\r\n|\r|\n|$)/g) || []) {
    if (!raw) continue;
    const line = raw.replace(/[\r\n]+$/, ''), marker = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (fence) {
      if (marker && marker[1][0] === fence.char && marker[1].length >= fence.length && !marker[2].trim()) fence = null;
    } else if (marker && !inline) fence = {char: marker[1][0], length: marker[1].length};
    else if (!/^(?: {4}|\t)/.test(line)) {
      for (let i = 0; i < line.length;) {
        if (line[i] === '\\') {i += 2; continue;}
        if (line[i] === '`') {
          let end = i + 1; while (line[end] === '`') end++;
          if (!inline) inline = end - i; else if (inline === end - i) inline = 0;
          i = end; continue;
        }
        if (!inline && line.startsWith(token, i)) {result.push({start: offset + i, end: offset + i + token.length}); i += token.length;}
        else i++;
      }
    }
    offset += raw.length;
  }
  return result;
}

export function attachImagesToContent(content, images) {
  if (!images.length) return content;
  if (typeof content !== 'string') fail();
  const append = [], prepend = [], replacements = [];
  for (const image of images) {
    const text = markdown(image.assetId, image.caption);
    if (image.placement === 'placeholder') {
      const ranges = placeholderRanges(content, image.placeholder);
      if (ranges.length !== 1) fail('Each image placeholder must occur exactly once outside literal code.');
      replacements.push({...ranges[0], text});
    } else (image.placement === 'prepend' ? prepend : append).push(text);
  }
  let result = content;
  for (const replacement of replacements.sort((a, b) => b.start - a.start)) result = result.slice(0, replacement.start) + replacement.text + result.slice(replacement.end);
  if (prepend.length) result = prepend.join('\n\n') + (result ? '\n\n' : '') + result;
  if (append.length) result += (result ? '\n\n' : '') + append.join('\n\n');
  return result;
}

export async function prepareImageAttachments(env, capsule, descriptors, ownerId) {
  if (!descriptors?.length) return {capsule, images: [], savedAssets: []};
  if (typeof ownerId !== 'string' || !ownerId) fail('The image upload owner could not be verified.', 403);
  const resolved = await resolveStagedImages(env, descriptors, {ownerId});
  if (!Array.isArray(resolved) || resolved.length !== descriptors.length) fail();
  const assets = new Map(capsule.archive.assets.map(asset => [asset.id, asset])), added = [], images = [], savedAssets = new Map(), hashes = new Map();
  for (let index = 0; index < descriptors.length; index++) {
    const descriptor = descriptors[index], upload = resolved[index], asset = upload?.asset;
    if (upload?.uploadId !== descriptor.uploadId || !object(asset) || !ID.test(asset.id || '') || !object(upload.source)
        || !HASH.test(upload.source.sha256 || '') || asset.id !== 'image-' + upload.source.sha256
        || asset.size !== upload.source.bytes || upload.source.kind !== 'r2-raw' || typeof upload.source.key !== 'string') fail();
    registerAssetSource(asset, {...upload.source, read: async () => {
      const stored = await env.BUCKET.get(upload.source.key);
      if (!stored || stored.size !== upload.source.bytes) fail();
      return stored.body;
    }});
    const dataHash = hashes.get(asset.id) ?? await assetDataHash(asset), current = assets.get(asset.id);
    if (!HASH.test(dataHash || '')) fail();
    if (current && !hashes.has(asset.id)) {
      if (assetByteSize(current) !== asset.size || current.mimeType !== asset.mimeType || await assetDataHash(current) !== dataHash) fail('An existing image identity has different saved bytes.', 409);
    } else if (!current) {assets.set(asset.id, asset); added.push(asset);}
    hashes.set(asset.id, dataHash);
    const kept = current ?? asset;
    savedAssets.set(asset.id, {id: asset.id, mimeType: kept.mimeType, size: assetByteSize(kept), dataHash});
    images.push({uploadId: descriptor.uploadId, shardId: descriptor.shardId, assetId: asset.id,
      caption: descriptor.caption ?? asset.name, placement: descriptor.placement ?? 'append',
      ...(descriptor.placement === 'placeholder' ? {placeholder: descriptor.placeholder} : {})});
  }
  const all = [...capsule.archive.assets, ...added];
  if (all.length > 2048 || all.reduce((sum, asset) => sum + assetByteSize(asset), 0) > 96 * 1024 * 1024) fail('The library image capacity has been reached.', 413);
  return {capsule: {...capsule, archive: {...capsule.archive, assets: all}}, images, savedAssets: [...savedAssets.values()]};
}

export function validateImageReceipt(entry, batch) {
  const expected = batch.images ?? [], images = entry.receipt?.images ?? [], assets = entry.savedAssets ?? [];
  if (!Array.isArray(images) || !Array.isArray(assets) || images.length !== expected.length || assets.length > images.length) fail();
  const bindings = new Map();
  for (const asset of assets) {
    if (!object(asset) || !ID.test(asset.id || '') || bindings.has(asset.id) || !HASH.test(asset.dataHash || '')
        || !Number.isSafeInteger(asset.size) || asset.size < 1 || asset.size > 8 * 1024 * 1024
        || !['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(asset.mimeType)) fail();
    bindings.set(asset.id, asset);
  }
  const used = new Set();
  for (let index = 0; index < expected.length; index++) {
    const descriptor = expected[index], image = images[index];
    if (!object(image) || Object.keys(image).some(key => !['uploadId', 'shardId', 'assetId', 'caption', 'placement', 'placeholder'].includes(key))
        || image.uploadId !== descriptor.uploadId || image.shardId !== descriptor.shardId || !bindings.has(image.assetId)
        || typeof image.caption !== 'string' || [...image.caption].length > 1000 || /[\r\n]/.test(image.caption)
        || own(descriptor, 'caption') && image.caption !== descriptor.caption
        || image.placement !== (descriptor.placement ?? 'append') || image.placeholder !== descriptor.placeholder) fail();
    used.add(image.assetId);
  }
  if (used.size !== bindings.size) fail();
}

export async function compareImageReceiptAssets(capsule, entry) {
  const current = new Map((capsule.archive.assets ?? []).map(asset => [asset.id, asset]));
  const missingAssetIds = [], changedAssetIds = [];
  for (const saved of entry.savedAssets ?? []) {
    const asset = current.get(saved.id);
    if (!asset) missingAssetIds.push(saved.id);
    else if (asset.mimeType !== saved.mimeType || assetByteSize(asset) !== saved.size || await assetDataHash(asset) !== saved.dataHash) changedAssetIds.push(saved.id);
  }
  return {missingAssetIds, changedAssetIds};
}
