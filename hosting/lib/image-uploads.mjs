// Private upload staging never mutates a library head. Accepted snapshots embed
// their own image bytes, independently of this expiring transfer material.
import {sha256} from '../../sync/protocol.mjs';

export const IMAGE_UPLOAD_LIMITS = Object.freeze({fileBytes: 8 * 1024 * 1024, activeUploads: 64, concurrentIngests: 2,
  retainedBytes: 96 * 1024 * 1024, retainedRequests: 4096, ttlMs: 24 * 60 * 60 * 1000,
  leaseMs: 60 * 1000, descriptors: 40, redirects: 3, downloadMs: 30_000});
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$/;
const HASH = /^[a-f0-9]{64}$/;
const UPLOAD_ID = /^image-upload-[a-f0-9]{64}$/;
const TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const encoder = new TextEncoder();
const ingestSlots = new WeakMap();
const causes = new Set(['AbortError', 'TimeoutError', 'TypeError', 'NetworkError', 'Error']);
const phases = new Set(['fetch', 'redirect', 'response', 'read']);
function downloadDetails(details) {
  if (!details || !phases.has(details.phase)) return;
  return Object.freeze({phase: details.phase,
    ...(Number.isInteger(details.downloadStatus) && details.downloadStatus >= 100 && details.downloadStatus <= 599 ? {downloadStatus: details.downloadStatus} : {}),
    ...(causes.has(details.causeName) ? {causeName: details.causeName} : {})});
}
const causeName = error => causes.has(error?.name) ? error.name : 'Error';
const messages = Object.freeze({
  invalid_image_upload: 'Supply one supported image file and a stable request ID. Reuse the same request for retries.',
  image_source_not_allowed: 'Use a file attached to the chat or returned by an image tool. This upload accepts only authorized OpenAI file download links.',
  image_download_failed: 'The image download could not finish. Refresh the file handoff and retry the same request ID.',
  image_too_large: 'Images must be at most 8 MB.',
  invalid_image: 'The file is not a supported PNG, JPEG, GIF, or WebP image with safe dimensions.',
  image_upload_unavailable: 'The private image upload is unavailable. Your saved library is unchanged. Retry the same request ID.',
  image_upload_busy: 'This image upload is already in progress. Check its status or retry the same request ID shortly.',
  image_upload_quota: 'The private image staging capacity is full. Reuse a verified upload or request staging maintenance. Expiration alone does not remove retained image bytes.',
  image_request_reused: 'This upload request ID already belongs to another file or image description. Keep its original request unchanged.',
  image_upload_missing: 'The image upload is unavailable for this account. Upload the image through the current Shard Atlas connection.',
  image_upload_expired: 'The image staging period expired. Refresh the original upload using its same request ID before preparing a new save.',
  image_upload_incomplete: 'The image upload has not been verified. Complete or retry the upload before saving the shard.',
  image_upload_corrupt: 'The uploaded image failed its integrity check. No shard was changed. Retry the original upload.',
});

export class ImageUploadError extends Error {
  constructor(code, status = 503, details) {
    super(messages[code] || messages.image_upload_unavailable);
    this.name = 'ImageUploadError'; this.code = Object.hasOwn(messages, code) ? code : 'image_upload_unavailable'; this.status = status;
    const safe = downloadDetails(details); if (safe) this.details = safe;
  }
}
const fail = (code, status, details) => {throw new ImageUploadError(code, status, details);};
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const bytesHash = value => sha256(value instanceof Uint8Array ? value : encoder.encode(value));

function clock(now) {
  const value = typeof now === 'function' ? now() : now ?? Date.now();
  const number = value instanceof Date ? value.getTime() : value;
  if (!Number.isSafeInteger(number) || number < 0 || number > 8_640_000_000_000_000 - IMAGE_UPLOAD_LIMITS.ttlMs) fail('image_upload_unavailable');
  return number;
}
function owner(value) {
  if (typeof value !== 'string' || !value || value.length > 256 || /[\s\x00-\x1f\x7f]/.test(value)) fail('image_upload_missing', 403);
  return value;
}
function services(env) {
  if (!env?.DB || typeof env.DB.prepare !== 'function' || !env.BUCKET || !['get', 'head', 'put'].every(key => typeof env.BUCKET[key] === 'function')) fail('image_upload_unavailable');
  return env;
}
function reserveIngestSlot(env) {
  let buckets = ingestSlots.get(env.DB);
  if (!buckets) {buckets = new WeakMap(); ingestSlots.set(env.DB, buckets);}
  let state = buckets.get(env.BUCKET);
  if (!state) {state = {active: 0}; buckets.set(env.BUCKET, state);}
  if (state.active >= IMAGE_UPLOAD_LIMITS.concurrentIngests) fail('image_upload_busy', 409);
  state.active++;
  return () => {state.active--;};
}
function exact(value, fields) {
  if (!object(value) || Object.keys(value).some(key => !fields.includes(key))) fail('invalid_image_upload', 400);
}
function downloadUrl(value) {
  if (typeof value !== 'string' || value.length > 8192 || /[\x00-\x20\x7f]/.test(value)) fail('image_source_not_allowed', 400);
  let url;
  try {url = new URL(value);} catch {fail('image_source_not_allowed', 400);}
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash
      || !(url.hostname === 'oaiusercontent.com' || url.hostname.endsWith('.oaiusercontent.com'))) fail('image_source_not_allowed', 400);
  return url.href;
}
function declaredName(value) {
  if (value === undefined) return '';
  if (typeof value !== 'string' || !value.trim() || [...value].length > 240 || /[\x00-\x1f\x7f]/.test(value)) fail('invalid_image_upload', 400);
  return value;
}
function declaredType(value) {
  if (value === undefined) return '';
  if (typeof value !== 'string' || !(TYPES.has(value) || value === 'application/octet-stream')) fail('invalid_image', 400);
  return value;
}

export function validateImageUploadArguments(args) {
  exact(args, ['requestId', 'file']);
  if (!ID.test(args.requestId || '')) fail('invalid_image_upload', 400);
  exact(args.file, ['download_url', 'file_id', 'mime_type', 'file_name']);
  const file = args.file;
  if (typeof file.file_id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,511}$/.test(file.file_id)) fail('invalid_image_upload', 400);
  return {requestId: args.requestId, file: {download_url: downloadUrl(file.download_url), file_id: file.file_id,
    mime_type: declaredType(file.mime_type), file_name: declaredName(file.file_name)}};
}

function beforeDeadline(promise, signal) {
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    if (signal.aborted) {abort(); return;}
    signal.addEventListener('abort', abort, {once: true});
    Promise.resolve(promise).then(value => {signal.removeEventListener('abort', abort); resolve(value);},
      error => {signal.removeEventListener('abort', abort); reject(error);});
  });
}
function discardBody(response) {
  try {Promise.resolve(response?.body?.cancel()).catch(() => {});} catch {}
}
async function readBytes(response, code = 'image_download_failed', signal) {
  signal?.throwIfAborted();
  const declared = response.headers?.get('content-length');
  if (declared !== null && declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > IMAGE_UPLOAD_LIMITS.fileBytes)) {
    discardBody(response); fail('image_too_large', 413);
  }
  if (!response.body || typeof response.body.getReader !== 'function') fail(code);
  const reader = response.body.getReader(), parts = [];
  const abort = () => {reader.cancel().catch(() => {});};
  signal?.addEventListener('abort', abort, {once: true});
  let length = 0;
  try {
    while (true) {
      const part = await beforeDeadline(reader.read(), signal);
      if (part.done) break;
      if (!(part.value instanceof Uint8Array)) fail(code);
      length += part.value.byteLength;
      if (length > IMAGE_UPLOAD_LIMITS.fileBytes) fail('image_too_large', 413);
      parts.push(part.value);
    }
  } finally {signal?.removeEventListener('abort', abort); reader.cancel().catch(() => {}); reader.releaseLock();}
  if (!length) fail('invalid_image', 400);
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {bytes.set(part, offset); offset += part.byteLength;}
  return bytes;
}

async function downloadImage(file, fetchFile) {
  const signal = AbortSignal.timeout(IMAGE_UPLOAD_LIMITS.downloadMs);
  let url = file.download_url;
  for (let hop = 0; hop <= IMAGE_UPLOAD_LIMITS.redirects; hop++) {
    let response;
    try {
      // Workers has no browser cookie jar. A new request with no copied headers
      // cannot forward the caller's credentials, cookies, or referrer.
      response = await beforeDeadline(fetchFile(url, {method: 'GET', redirect: 'manual', signal}), signal);
    } catch (error) {fail('image_download_failed', 503, {phase: 'fetch', causeName: causeName(error)});}
    const downloadStatus = response?.status;
    if (!response || response.redirected) {discardBody(response); fail('image_download_failed', 503, {phase: 'response', downloadStatus});}
    if ([301, 302, 303, 307, 308].includes(downloadStatus)) {
      const location = response.headers?.get('location');
      discardBody(response);
      if (!location || hop === IMAGE_UPLOAD_LIMITS.redirects) fail('image_download_failed', 503, {phase: 'redirect', downloadStatus});
      try {url = downloadUrl(new URL(location, url).href);}
      catch {fail('image_source_not_allowed', 400, {phase: 'redirect', downloadStatus});}
      continue;
    }
    if (!response.ok) {discardBody(response); fail('image_download_failed', 503, {phase: 'response', downloadStatus});}
    let bytes;
    try {bytes = await readBytes(response, 'image_download_failed', signal);}
    catch (error) {
      if (error instanceof ImageUploadError && error.code !== 'image_download_failed') throw error;
      fail('image_download_failed', 503, {phase: 'read', downloadStatus, ...(error instanceof ImageUploadError ? {} : {causeName: causeName(error)})});
    }
    const type = rasterType(bytes);
    if (TYPES.has(file.mime_type) && file.mime_type !== type) fail('invalid_image', 400);
    return {bytes, type};
  }
  fail('image_download_failed', 503, {phase: 'redirect'});
}

function rasterType(bytes) {
  const ascii = (offset, count) => String.fromCharCode(...bytes.subarray(offset, offset + count));
  const be32 = offset => bytes[offset] * 2 ** 24 + bytes[offset + 1] * 2 ** 16 + bytes[offset + 2] * 256 + bytes[offset + 3];
  const le32 = offset => bytes[offset] + bytes[offset + 1] * 256 + bytes[offset + 2] * 2 ** 16 + bytes[offset + 3] * 2 ** 24;
  const dimensions = (width, height) => Number.isSafeInteger(width) && Number.isSafeInteger(height) && width > 0 && height > 0
    && width <= 16384 && height <= 16384 && width * height <= 40_000_000;
  if (bytes.length >= 45 && ascii(0, 8) === '\x89PNG\r\n\x1a\n' && ascii(12, 4) === 'IHDR' && be32(8) === 13) {
    if (!dimensions(be32(16), be32(20))) fail('invalid_image', 400);
    const depths = {0: [1,2,4,8,16], 2: [8,16], 3: [1,2,4,8], 4: [8,16], 6: [8,16]};
    if (!depths[bytes[25]]?.includes(bytes[24]) || bytes[26] !== 0 || bytes[27] !== 0 || bytes[28] > 1) fail('invalid_image', 400);
    let at = 8, data = false, end = false;
    while (at + 12 <= bytes.length) {
      const size = be32(at), type = ascii(at + 4, 4);
      if (size > bytes.length - at - 12) fail('invalid_image', 400);
      if (type === 'IHDR' && at !== 8) fail('invalid_image', 400);
      if (type === 'IDAT' && size > 0) data = true;
      at += size + 12;
      if (type === 'IEND') {end = size === 0 && at === bytes.length; break;}
    }
    if (!data || !end) fail('invalid_image', 400);
    return 'image/png';
  }
  if (bytes.length >= 14 && ['GIF87a', 'GIF89a'].includes(ascii(0, 6)) && bytes.at(-1) === 0x3b) {
    const width = bytes[6] + bytes[7] * 256, height = bytes[8] + bytes[9] * 256;
    if (!dimensions(width, height)) fail('invalid_image', 400);
    let at = 13 + (bytes[10] & 0x80 ? 3 * 2 ** ((bytes[10] & 7) + 1) : 0), frames = 0;
    const subblocks = () => {
      let total = 0;
      while (at < bytes.length) {
        const size = bytes[at++];
        if (!size) return total;
        if (size > bytes.length - at) fail('invalid_image', 400);
        total += size; at += size;
      }
      fail('invalid_image', 400);
    };
    while (at < bytes.length) {
      const type = bytes[at++];
      if (type === 0x3b) {if (!frames || at !== bytes.length) fail('invalid_image', 400); return 'image/gif';}
      if (type === 0x21) {if (at >= bytes.length) fail('invalid_image', 400); at++; subblocks(); continue;}
      if (type !== 0x2c || at + 9 > bytes.length) fail('invalid_image', 400);
      const left = bytes[at] + bytes[at + 1] * 256, top = bytes[at + 2] + bytes[at + 3] * 256;
      const frameWidth = bytes[at + 4] + bytes[at + 5] * 256, frameHeight = bytes[at + 6] + bytes[at + 7] * 256;
      if (!dimensions(frameWidth, frameHeight) || left + frameWidth > width || top + frameHeight > height) fail('invalid_image', 400);
      const flags = bytes[at + 8]; at += 9 + (flags & 0x80 ? 3 * 2 ** ((flags & 7) + 1) : 0);
      if (at >= bytes.length || bytes[at] < 2 || bytes[at] > 8) fail('invalid_image', 400);
      at++; if (!subblocks()) fail('invalid_image', 400); frames++;
    }
    fail('invalid_image', 400);
  }
  if (bytes.length >= 12 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9) {
    let at = 2, components = 0, scan = false;
    while (at + 4 <= bytes.length) {
      if (bytes[at++] !== 0xff) fail('invalid_image', 400);
      while (bytes[at] === 0xff) at++;
      const marker = bytes[at++];
      if (marker === 0xd9) break;
      if (marker === 0x01 || marker >= 0xd0 && marker <= 0xd7) continue;
      const size = bytes[at] * 256 + bytes[at + 1];
      if (size < 2 || at + size > bytes.length) fail('invalid_image', 400);
      if (marker === 0xda) {
        const count = bytes[at + 2];
        if (!components || !count || count > components || size !== 6 + 2 * count || at + size >= bytes.length - 2) fail('invalid_image', 400);
        scan = true; break;
      }
      if ([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker)) {
        components = bytes[at + 7];
        if (!components || size !== 8 + 3 * components || !dimensions(bytes[at + 5] * 256 + bytes[at + 6], bytes[at + 3] * 256 + bytes[at + 4])) fail('invalid_image', 400);
      }
      at += size;
    }
    if (!scan) fail('invalid_image', 400);
    return 'image/jpeg';
  }
  if (bytes.length >= 25 && ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP' && le32(4) + 8 === bytes.length) {
    const le24 = at => bytes[at] + bytes[at + 1] * 256 + bytes[at + 2] * 65536;
    let canvas, image = false;
    const chunks = (from, end, frame) => {
      let at = from, payload = false;
      while (at + 8 <= end) {
        const type = ascii(at, 4), size = le32(at + 4), start = at + 8;
        if (size > end - start) fail('invalid_image', 400);
        let shape;
        if (type === 'VP8X') {
          if (frame || at !== 12 || size !== 10) fail('invalid_image', 400);
          canvas = [1 + le24(start + 4), 1 + le24(start + 7)];
          if (!dimensions(...canvas)) fail('invalid_image', 400);
        }
        if (type === 'VP8 ') {
          if (size < 10 || bytes[start] & 1 || ascii(start + 3, 3) !== '\x9d\x01\x2a') fail('invalid_image', 400);
          shape = [(bytes[start + 6] + bytes[start + 7] * 256) & 0x3fff, (bytes[start + 8] + bytes[start + 9] * 256) & 0x3fff];
        }
        if (type === 'VP8L') {
          if (size < 5 || bytes[start] !== 0x2f || bytes[start + 4] >> 5) fail('invalid_image', 400);
          shape = [1 + bytes[start + 1] + (bytes[start + 2] & 0x3f) * 256, 1 + (bytes[start + 2] >> 6) + bytes[start + 3] * 4 + (bytes[start + 4] & 0x0f) * 1024];
        }
        if (shape) {
          const expected = frame || canvas;
          if (!dimensions(...shape) || expected && (shape[0] !== expected[0] || shape[1] !== expected[1])) fail('invalid_image', 400);
          payload = true;
        }
        if (type === 'ANMF') {
          if (frame || !canvas || size < 16) fail('invalid_image', 400);
          const shape = [1 + le24(start + 6), 1 + le24(start + 9)];
          if (!dimensions(...shape) || le24(start) * 2 + shape[0] > canvas[0] || le24(start + 3) * 2 + shape[1] > canvas[1]
              || !chunks(start + 16, start + size, shape)) fail('invalid_image', 400);
          payload = true;
        }
        at = start + size + (size % 2);
      }
      if (at !== end) fail('invalid_image', 400);
      return payload;
    };
    image = chunks(12, bytes.length);
    if (!image) fail('invalid_image', 400);
    return 'image/webp';
  }
  fail('invalid_image', 400);
}

async function rowFor(env, uploadId, ownerId) {
  return env.DB.prepare('SELECT * FROM image_uploads WHERE id = ? AND owner_id = ?').bind(uploadId, ownerId).first();
}
const activeWhere = "owner_id = ? AND expires_at > ? AND (status = 'verified' OR status LIKE 'uploading:%')";
// Expired and failed immutable blobs still consume this budget. Logical expiry
// cannot be used to accumulate unbounded raw objects by repeatedly uploading.
const retainedWhere = "owner_id = ? AND id != ? AND (sha256 != '' OR (expires_at > ? AND status LIKE 'uploading:%'))";
const quotaSql = `((SELECT count(*) FROM image_uploads WHERE ${activeWhere} AND id != ?) < ? AND
  coalesce((SELECT sum(reserved) FROM (SELECT max(bytes) AS reserved FROM image_uploads WHERE ${retainedWhere}
  GROUP BY CASE WHEN sha256 = '' THEN id ELSE sha256 END)), 0) + ? <= ? AND
  (SELECT count(*) FROM image_uploads WHERE owner_id = ? AND id != ?) < ?)`;

function validRow(row) {
  return object(row) && UPLOAD_ID.test(row.id) && HASH.test(row.sha256) && Number.isSafeInteger(row.bytes)
    && row.bytes > 0 && row.bytes <= IMAGE_UPLOAD_LIMITS.fileBytes && TYPES.has(row.mime_type)
    && typeof row.name === 'string' && row.name.length <= 960 && Number.isFinite(Date.parse(row.created_at)) && Number.isFinite(Date.parse(row.expires_at));
}
async function blobKey(ownerId, hash) {return 'image-uploads/' + await bytesHash(ownerId) + '/blobs/' + hash;}
async function verifiedBytes(env, row, ownerId) {
  if (!validRow(row)) fail('image_upload_corrupt');
  const key = await blobKey(ownerId, row.sha256), metadata = await env.BUCKET.head(key);
  if (!metadata || metadata.size !== row.bytes) fail('image_upload_corrupt');
  const stored = await env.BUCKET.get(key);
  if (!stored || stored.size !== row.bytes) fail('image_upload_corrupt');
  const bytes = await readBytes({body: stored.body}, 'image_upload_corrupt');
  if (bytes.byteLength !== row.bytes || await bytesHash(bytes) !== row.sha256 || rasterType(bytes) !== row.mime_type) fail('image_upload_corrupt');
  return key;
}
function publicReceipt(row, now) {
  return {uploadId: row.id, createdAt: row.created_at, expiresAt: row.expires_at,
    status: Date.parse(row.expires_at) <= now ? 'expired' : row.status === 'verified' ? 'verified' : row.status.startsWith('uploading:') ? 'uploading' : 'failed',
    verified: row.status === 'verified' && Date.parse(row.expires_at) > now,
    ...(row.status === 'verified' ? {assetId: 'image-' + row.sha256, sha256: row.sha256, size: row.bytes, mimeType: row.mime_type, name: row.name} : {}),
    stagingPolicy: {retainedByteLimit: IMAGE_UPLOAD_LIMITS.retainedBytes, expiryRemovesBytes: false}};
}

export async function ingestRemoteImage(env, args, {ownerId, fetch: fetchFile = globalThis.fetch, now} = {}) {
  let reserved = false, statusToken, uploadId, releaseSlot;
  try {
    services(env); ownerId = owner(ownerId);
    const input = validateImageUploadArguments(args), instant = clock(now), stamp = new Date(instant).toISOString();
    // Buffer at most two images per binding pair in this isolate. Durable D1
    // reservations separately enforce owner quotas across workers and restarts.
    releaseSlot = reserveIngestSlot(env);
    const expiry = new Date(instant + IMAGE_UPLOAD_LIMITS.ttlMs).toISOString();
    uploadId = 'image-upload-' + await bytesHash(ownerId + '\n' + input.requestId);
    const descriptionHash = await bytesHash(JSON.stringify([input.file.file_name, input.file.mime_type]));
    const fileHash = 'v2:' + await bytesHash(input.file.file_id) + ':' + descriptionHash;
    let row = await rowFor(env, uploadId, ownerId);
    let sameFile = !row || row.file_id_hash === fileHash;
    if (row && !sameFile) {
      const binding = row.file_id_hash.match(/^v2:([a-f0-9]{64}):([a-f0-9]{64})$/);
      const legacySame = !binding && row.file_id_hash === await bytesHash(JSON.stringify([input.file.file_id, input.file.file_name, input.file.mime_type]));
      sameFile = legacySame;
      const sameDescription = binding ? binding[2] === descriptionHash
        : !row.sha256 && row.name === input.file.file_name && row.mime_type === input.file.mime_type;
      if (!sameFile && !sameDescription) fail('image_request_reused', 409);
    }
    if (row?.status === 'verified') {
      await verifiedBytes(env, row, ownerId);
      if (!sameFile) {
        // Native file handoffs may mint a new file_id for the same path on each
        // invocation. A fresh reference must prove identical bytes before replay.
        const {bytes, type} = await downloadImage(input.file, fetchFile);
        if (await bytesHash(bytes) !== row.sha256 || type !== row.mime_type) fail('image_request_reused', 409);
        await env.DB.prepare("UPDATE image_uploads SET file_id_hash = ? WHERE id = ? AND owner_id = ? AND status = 'verified' AND sha256 = ? AND file_id_hash = ?")
          .bind(fileHash, uploadId, ownerId, row.sha256, row.file_id_hash).run();
      }
      if (Date.parse(row.expires_at) <= instant) {
        await env.DB.prepare(`UPDATE image_uploads SET expires_at = ? WHERE id = ? AND owner_id = ? AND status = 'verified' AND sha256 = ? AND ${quotaSql}`)
          .bind(expiry, uploadId, ownerId, row.sha256,
            ownerId, stamp, uploadId, IMAGE_UPLOAD_LIMITS.activeUploads, ownerId, uploadId, stamp, row.bytes, IMAGE_UPLOAD_LIMITS.retainedBytes,
            ownerId, uploadId, IMAGE_UPLOAD_LIMITS.retainedRequests).run();
        row = await rowFor(env, uploadId, ownerId);
        if (Date.parse(row.expires_at) <= instant) fail('image_upload_quota', 429);
      }
      return {...publicReceipt(row, instant), replayed: true};
    }
    const uploadStarted = Number(row?.status?.match(/^uploading:(\d+):/)?.[1] ?? Date.parse(row?.created_at || ''));
    const abandoned = row?.status?.startsWith('uploading:') && uploadStarted + IMAGE_UPLOAD_LIMITS.leaseMs <= instant;
    if (row?.status?.startsWith('uploading:') && Date.parse(row.expires_at) > instant && !abandoned) fail('image_upload_busy', 409);
    statusToken = 'uploading:' + instant + ':' + crypto.randomUUID();
    const reserve = row?.sha256 ? row.bytes : IMAGE_UPLOAD_LIMITS.fileBytes;
    const quotaValues = [ownerId, stamp, uploadId, IMAGE_UPLOAD_LIMITS.activeUploads, ownerId, uploadId, stamp, reserve, IMAGE_UPLOAD_LIMITS.retainedBytes,
      ownerId, uploadId, IMAGE_UPLOAD_LIMITS.retainedRequests];
    if (!row) {
      await env.DB.prepare(`INSERT OR IGNORE INTO image_uploads (id,owner_id,request_id,file_id_hash,sha256,name,mime_type,bytes,status,created_at,expires_at)
        SELECT ?,?,?,?,?,?,?,?,?,?,? WHERE ${quotaSql}`)
        .bind(uploadId, ownerId, input.requestId, fileHash, '', input.file.file_name, input.file.mime_type, IMAGE_UPLOAD_LIMITS.fileBytes, statusToken, stamp, expiry, ...quotaValues).run();
    } else {
      await env.DB.prepare(`UPDATE image_uploads SET status = ?, bytes = ?, expires_at = ?, file_id_hash = ? WHERE id = ? AND owner_id = ? AND file_id_hash = ?
        AND status = ? AND (status = 'failed' OR expires_at <= ? OR ? = 1) AND ${quotaSql}`)
        .bind(statusToken, reserve, expiry, fileHash, uploadId, ownerId, row.file_id_hash, row.status, stamp, Number(abandoned), ...quotaValues).run();
    }
    row = await rowFor(env, uploadId, ownerId);
    if (!row) fail('image_upload_quota', 429);
    if (row.file_id_hash !== fileHash) {
      if (row.status.startsWith('uploading:') && row.file_id_hash.endsWith(':' + descriptionHash)) fail('image_upload_busy', 409);
      fail('image_request_reused', 409);
    }
    if (row.status !== statusToken) fail(row.status.startsWith('uploading:') ? 'image_upload_busy' : 'image_upload_quota', row.status.startsWith('uploading:') ? 409 : 429);
    reserved = true;
    const {bytes, type} = await downloadImage(input.file, fetchFile);
    const hash = await bytesHash(bytes), key = await blobKey(ownerId, hash);
    if (row.sha256 && row.sha256 !== hash) fail('image_request_reused', 409);
    const name = input.file.file_name || 'Uploaded image.' + ({'image/png':'png','image/jpeg':'jpg','image/gif':'gif','image/webp':'webp'})[type];
    // Account for an immutable blob before writing it. A process failure after
    // put cannot strand bytes outside the retained-storage quota.
    await env.DB.prepare('UPDATE image_uploads SET sha256 = ?, name = ?, mime_type = ?, bytes = ? WHERE id = ? AND owner_id = ? AND status = ?')
      .bind(hash, name, type, bytes.length, uploadId, ownerId, statusToken).run();
    row = await rowFor(env, uploadId, ownerId);
    if (row.status !== statusToken || row.sha256 !== hash) fail('image_upload_busy', 409);
    const exists = await env.BUCKET.head(key);
    if (!exists) await env.BUCKET.put(key, bytes, {httpMetadata: {contentType: type}});
    const next = {...row, sha256: hash, bytes: bytes.length, name, mime_type: type, status: 'verified'};
    await verifiedBytes(env, next, ownerId);
    await env.DB.prepare('UPDATE image_uploads SET sha256 = ?, name = ?, mime_type = ?, bytes = ?, status = ? WHERE id = ? AND owner_id = ? AND status = ?')
      .bind(hash, name, type, bytes.length, 'verified', uploadId, ownerId, statusToken).run();
    row = await rowFor(env, uploadId, ownerId);
    if (row.status !== 'verified' || row.sha256 !== hash) fail('image_upload_corrupt');
    reserved = false;
    return {...publicReceipt(row, instant), replayed: false};
  } catch (error) {
    if (reserved) {
      try {await env.DB.prepare("UPDATE image_uploads SET status = 'failed', bytes = CASE WHEN sha256 = '' THEN 0 ELSE bytes END WHERE id = ? AND owner_id = ? AND status = ?").bind(uploadId, ownerId, statusToken).run();} catch {}
    }
    if (error instanceof ImageUploadError) throw error;
    fail('image_upload_unavailable');
  } finally {releaseSlot?.();}
}

export async function getImageUploadStatus(env, args, {ownerId, now} = {}) {
  try {
    services(env); ownerId = owner(ownerId); exact(args, ['uploadId']);
    if (!UPLOAD_ID.test(args.uploadId || '')) fail('invalid_image_upload', 400);
    const row = await rowFor(env, args.uploadId, ownerId), instant = clock(now);
    if (!row) fail('image_upload_missing', 404);
    if (row.status === 'verified') await verifiedBytes(env, row, ownerId);
    return publicReceipt(row, instant);
  } catch (error) {if (error instanceof ImageUploadError) throw error; fail('image_upload_unavailable');}
}

export async function resolveStagedImages(env, descriptors, {ownerId, now} = {}) {
  try {
    services(env); ownerId = owner(ownerId);
    if (!Array.isArray(descriptors) || descriptors.length > IMAGE_UPLOAD_LIMITS.descriptors) fail('invalid_image_upload', 400);
    const instant = clock(now), cache = new Map(), resolved = [];
    for (const descriptor of descriptors) {
      if (!object(descriptor) || !UPLOAD_ID.test(descriptor.uploadId || '')) fail('invalid_image_upload', 400);
      let value = cache.get(descriptor.uploadId);
      if (!value) {
        const row = await rowFor(env, descriptor.uploadId, ownerId);
        if (!row) fail('image_upload_missing', 404);
        if (row.status !== 'verified') fail('image_upload_incomplete', 409);
        if (Date.parse(row.expires_at) <= instant) fail('image_upload_expired', 409);
        const key = await verifiedBytes(env, row, ownerId);
        value = {uploadId: row.id, asset: {id: 'image-' + row.sha256, name: row.name, mimeType: row.mime_type,
          size: row.bytes, createdAt: row.created_at, data: ''}, source: {kind: 'r2-raw', key, sha256: row.sha256, bytes: row.bytes}};
        cache.set(descriptor.uploadId, value);
      }
      resolved.push(value);
    }
    return resolved;
  } catch (error) {if (error instanceof ImageUploadError) throw error; fail('image_upload_unavailable');}
}
