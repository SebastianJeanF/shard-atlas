/* Browser-local Shard Atlas data model. Keep archive records portable with server.py. */

const KINDS = new Set(['concept', 'fact', 'example', 'mistake', 'event', 'idea']);
const STATUSES = new Set(['learning', 'solid', 'verify']);
const LINK_TYPES = new Set(['depends_on', 'explains', 'contrasts_with', 'example_of', 'related_to', 'part_of', 'supports', 'contradicts', 'supersedes', 'released_by']);
const EVIDENCE_STATUSES = new Set(['unverified', 'reported', 'corroborated', 'disputed', 'superseded']);
const EVENT_TYPES = new Set(['', 'event', 'announcement', 'release', 'research', 'rumor', 'forecast']);
const ENTITY_TYPES = new Set(['', 'company', 'model', 'concept', 'person']);
const MAX_ASSET_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_ASSET_BYTES = 96 * 1024 * 1024;
const KNOWLEDGE_DEFAULTS = {evidenceStatus: 'unverified', sources: [], publicationDate: '', verifiedDate: '', eventType: '', entities: [], entityType: '', inbox: false, facts: []};
const MUTABLE_SHARD_FIELDS = new Set(['title', 'content', 'prompt', 'tags', 'kind', 'status', 'sourceUrl', 'languageVersion', 'eventDate', ...Object.keys(KNOWLEDGE_DEFAULTS)]);
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const fieldValue = (object, key, fallback) => own(object, key) ? object[key] : fallback;
const now = () => new Date().toISOString();

function fail(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  throw error;
}

function object(value, message) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(message);
  return value;
}

/** Clone JSON archive data, with no references back into storage. */
export function copy(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function newId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  // Older secure-context WebViews expose getRandomValues but not randomUUID.
  if (!globalThis.crypto?.getRandomValues) fail('Secure local storage requires a browser with cryptographic randomness.', 500);
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = [...bytes].map(value => value.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function recordId(value, name = 'id') {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$/.test(value)) fail(`${name} must be a stable identifier of 1–100 letters, numbers, or . _ : -.`);
  return value;
}

function textField(value, name, limit, required = false) {
  if (typeof value !== 'string') fail(`${name} must be text.`);
  if ([...value].length > limit) fail(`${name} must be at most ${limit.toLocaleString('en-US')} characters.`);
  if (value.includes('\0')) fail(`${name} cannot contain a null character.`);
  if (required && !value.trim()) fail(`${name} is required.`);
  return name === 'title' ? value.trim() : value;
}

function timestamp(value, name, optional = false) {
  if (optional && (value === null || value === undefined || value === '')) return null;
  if (typeof value !== 'string' || value.length > 64 || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/i.test(value) || !Number.isFinite(Date.parse(value))) fail(`${name} must be an ISO timestamp with a time zone.`);
  // Date.parse normalizes impossible calendar dates, which archives must reject.
  partialDate(value.slice(0, 10), name);
  const clock = value.slice(11).match(/^(\d{2}):(\d{2})(?::(\d{2}))?/);
  if (+clock[1] > 23 || +clock[2] > 59 || +(clock[3] || 0) > 59) fail(`${name} must be an ISO timestamp with a time zone.`);
  return new Date(value).toISOString();
}

function partialDate(value, name) {
  value = textField(value, name, 10);
  if (!value) return '';
  if (!/^\d{4}(?:-\d{2}(?:-\d{2})?)?$/.test(value)) fail(`${name} must use YYYY, YYYY-MM, or YYYY-MM-DD.`);
  const [year, month = 1, day = 1] = value.split('-').map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > days[month - 1]) fail(`${name} must be a valid date.`);
  return value;
}

function sourceUrl(value, name = 'sourceUrl') {
  value = textField(value, name, 2048);
  if (!value) return value;
  try {
    const url = new URL(value);
    if (!/^https?:\/\//i.test(value) || !['https:', 'http:'].includes(url.protocol) || !url.hostname || url.username || url.password || /[\s\\]/.test(value)) fail('Invalid URL.');
  } catch {
    fail(`${name} must be an http or https URL without embedded credentials.`);
  }
  return value;
}

function tags(value) {
  if (!Array.isArray(value) || value.length > 50) fail('tags must be a list of at most 50 tags.');
  const normalized = value.map(tag => textField(tag, 'tag', 80, true).trim());
  if (new Set(normalized).size !== normalized.length) fail('tags cannot contain duplicates.');
  return normalized;
}

function knowledge(data) {
  const result = {...copy(KNOWLEDGE_DEFAULTS)};
  for (const key of Object.keys(KNOWLEDGE_DEFAULTS)) if (own(data, key)) result[key] = copy(data[key]);
  for (const [field, allowed] of [['evidenceStatus', EVIDENCE_STATUSES], ['eventType', EVENT_TYPES], ['entityType', ENTITY_TYPES]]) {
    if (!allowed.has(result[field])) fail(`Unknown ${field}.`);
  }
  for (const field of ['publicationDate', 'verifiedDate']) result[field] = partialDate(result[field], field);
  if (typeof result.inbox !== 'boolean') fail('inbox must be true or false.');
  if (!Array.isArray(result.entities) || result.entities.length > 100) fail('entities must be a list of at most 100 names.');
  result.entities = [...new Set(result.entities.map(value => textField(value, 'entity', 240, true).trim()))];
  for (const [field, maximum] of [['sources', 100], ['facts', 200]]) {
    if (!Array.isArray(result[field]) || result[field].length > maximum) fail(`${field} must be a list of at most ${maximum} objects.`);
    result[field] = result[field].map(item => {
      object(item, `Each ${field} entry must be an object.`);
      // Source extensions (for example Lucid IDs) must survive edits and exports.
      if (field === 'sources') return {...copy(item), url: sourceUrl(fieldValue(item, 'url', ''), 'source URL'), title: textField(fieldValue(item, 'title', ''), 'source title', 500), publishedDate: partialDate(fieldValue(item, 'publishedDate', ''), 'publishedDate'), accessedDate: partialDate(fieldValue(item, 'accessedDate', ''), 'accessedDate'), note: textField(fieldValue(item, 'note', ''), 'source note', 5000)};
      return {...copy(item), label: textField(fieldValue(item, 'label', ''), 'fact label', 240, true), value: textField(fieldValue(item, 'value', ''), 'fact value', 5000), unit: textField(fieldValue(item, 'unit', ''), 'fact unit', 100), sourceUrl: sourceUrl(fieldValue(item, 'sourceUrl', '')), asOf: partialDate(fieldValue(item, 'asOf', ''), 'asOf')};
    });
  }
  return result;
}

export function validateShard(data, {imported = false, current = null} = {}) {
  object(data, 'Each shard must be an object.');
  const merged = {...copy(current || {})};
  for (const [key, value] of Object.entries(data)) if (imported || MUTABLE_SHARD_FIELDS.has(key)) Object.defineProperty(merged, key, {value: copy(value), enumerable: true, writable: true, configurable: true});
  const stamp = now();
  const result = {...copy(merged), id: imported ? recordId(data.id) : current ? recordId(current.id) : newId(), title: textField(fieldValue(merged, 'title', ''), 'title', 240, true), content: textField(fieldValue(merged, 'content', ''), 'content', 100_000), prompt: textField(fieldValue(merged, 'prompt', ''), 'prompt', 10_000), tags: tags(fieldValue(merged, 'tags', [])), kind: fieldValue(merged, 'kind', 'concept'), status: fieldValue(merged, 'status', 'learning'), sourceUrl: sourceUrl(fieldValue(merged, 'sourceUrl', '')), languageVersion: textField(fieldValue(merged, 'languageVersion', ''), 'languageVersion', 100), eventDate: partialDate(fieldValue(merged, 'eventDate', ''), 'eventDate'), createdAt: timestamp(fieldValue(merged, 'createdAt', stamp), 'createdAt'), updatedAt: timestamp(imported ? fieldValue(merged, 'updatedAt', stamp) : stamp, 'updatedAt'), reviewCount: fieldValue(merged, 'reviewCount', 0), lastReviewedAt: timestamp(merged.lastReviewedAt, 'lastReviewedAt', true), nextReviewAt: timestamp(merged.nextReviewAt, 'nextReviewAt', true)};
  if (!KINDS.has(result.kind)) fail('Unknown shard kind.');
  if (!STATUSES.has(result.status)) fail('Unknown shard status.');
  if (!Number.isInteger(result.reviewCount) || result.reviewCount < 0 || result.reviewCount > 1_000_000) fail('reviewCount must be a nonnegative integer.');
  return {...result, ...knowledge(merged)};
}

export function validateLink(data, {imported = false, current = null} = {}) {
  object(data, 'Each relationship must be an object.');
  const merged = current ? {...copy(current), ...Object.fromEntries(Object.entries(data).filter(([key]) => ['fromId', 'toId', 'type', 'note'].includes(key)))} : data;
  const result = {...(imported || current ? copy(merged) : {}), id: current ? recordId(current.id) : imported ? recordId(data.id) : newId(), fromId: recordId(merged.fromId, 'fromId'), toId: recordId(merged.toId, 'toId'), type: fieldValue(merged, 'type', 'related_to'), note: textField(fieldValue(merged, 'note', ''), 'note', 2000), createdAt: timestamp(imported || current ? fieldValue(merged, 'createdAt', now()) : now(), 'createdAt')};
  if (!LINK_TYPES.has(result.type)) fail('Unknown relationship type.');
  if (result.fromId === result.toId) fail('A relationship must connect two different shards.');
  return result;
}

export function validateAsset(data, {imported = false} = {}) {
  object(data, 'Each image must be an object.');
  if (!['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(data.mimeType)) fail('Images must be PNG, JPEG, GIF, or WebP.');
  if (typeof data.data !== 'string' || data.data.length > Math.ceil(MAX_ASSET_BYTES / 3) * 4) fail('Images must be at most 8 MB.');
  if (data.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data.data)) fail('Image data must be valid base64.');
  let raw;
  try { raw = atob(data.data); } catch { fail('Image data must be valid base64.'); }
  if (btoa(raw) !== data.data) fail('Image data must be valid base64.');
  const byte = offset => raw.charCodeAt(offset);
  const big32 = offset => byte(offset) * 2 ** 24 + byte(offset + 1) * 2 ** 16 + byte(offset + 2) * 256 + byte(offset + 3);
  const little32 = offset => byte(offset) + byte(offset + 1) * 256 + byte(offset + 2) * 2 ** 16 + byte(offset + 3) * 2 ** 24;
  const dimensions = (width, height) => width > 0 && height > 0 && width <= 16384 && height <= 16384 && width * height <= 40_000_000;
  let valid = false;
  if (data.mimeType === 'image/png') valid = raw.length >= 33 && raw.startsWith('\x89PNG\r\n\x1a\n') && raw.slice(12, 16) === 'IHDR' && dimensions(big32(16), big32(20));
  if (data.mimeType === 'image/jpeg') valid = raw.length >= 4 && raw.startsWith('\xff\xd8\xff') && raw.endsWith('\xff\xd9');
  if (data.mimeType === 'image/gif') valid = raw.length >= 14 && ['GIF87a', 'GIF89a'].includes(raw.slice(0, 6)) && raw.endsWith(';') && dimensions(byte(6) + byte(7) * 256, byte(8) + byte(9) * 256);
  if (data.mimeType === 'image/webp') valid = raw.length >= 20 && raw.startsWith('RIFF') && raw.slice(8, 12) === 'WEBP' && little32(4) + 8 === raw.length;
  if (!valid || raw.length > MAX_ASSET_BYTES) fail('The image contents do not match a supported raster image format.');
  return {...(imported ? copy(data) : {}), id: imported ? recordId(data.id) : newId(), name: textField(fieldValue(data, 'name', 'Image'), 'name', 240, true), mimeType: data.mimeType, data: data.data, size: raw.length, createdAt: timestamp(imported ? fieldValue(data, 'createdAt', now()) : now(), 'createdAt')};
}

export function emptyDatabase() {
  return {archive: {schemaVersion: 1, shards: [], links: [], boards: [], reviews: [], assets: [], revisions: [], trash: []}, drafts: {}, backups: [], imports: []};
}

export function publicState(db) {
  const {assets = [], revisions, trash, ...visible} = db.archive;
  const state = copy(visible);
  state.assets = assets.map(asset => {const {data, ...metadata} = asset; return copy(metadata);});
  return state;
}

/** Safety snapshots include portable images, legacy records, drafts, and receipts. */
export function saveBackup(db) {
  const createdAt = now();
  const snapshot = {archive: copy(db.archive), drafts: copy(db.drafts), imports: copy(db.imports)};
  const entry = {filename: `shards-mobile-${createdAt.replace(/[:.]/g, '-')}-${newId()}.json`, createdAt, size: new TextEncoder().encode(JSON.stringify(snapshot)).length, shardCount: db.archive.shards.length, valid: true, error: null, ...snapshot};
  db.backups.push(entry);
  return entry;
}

function revision(db, shard, reason) {
  db.archive.revisions.push({id: newId(), shardId: shard.id, createdAt: now(), reason, snapshot: copy(shard)});
}

function find(list, id, noun) {
  recordId(id);
  const value = list.find(item => item.id === id);
  if (!value) fail(`${noun} not found.`, 404);
  return value;
}

function linkKey(link) { return JSON.stringify([link.fromId, link.toId, link.type]); }
function checkLink(db, link, excludeId = null) {
  const ids = new Set(db.archive.shards.map(item => item.id));
  if (!ids.has(link.fromId) || !ids.has(link.toId)) fail('Both relationship endpoints must exist.');
  if (db.archive.links.some(item => item.id !== excludeId && (item.id === link.id || linkKey(item) === linkKey(link)))) fail('This relationship already exists.', 409);
}

function draftKind(value) {
  if (!['editor', 'connection'].includes(value)) fail('Unknown draft kind.');
  return value;
}

function jsonBytes(value) {
  const seen = new WeakSet();
  let encoded;
  try {
    encoded = JSON.stringify(value, (key, item) => {
      if (typeof item === 'number' && !Number.isFinite(item) || ['undefined', 'function', 'symbol', 'bigint'].includes(typeof item)) throw new Error();
      if (item && typeof item === 'object') {
        if (seen.has(item)) throw new Error();
        seen.add(item);
      }
      return item;
    });
  } catch { fail('Draft must contain finite JSON data.'); }
  return new TextEncoder().encode(encoded).length;
}

function pathId(value) {
  try { return recordId(decodeURIComponent(value)); } catch (error) {
    if (error.status) throw error;
    fail('Invalid record identifier.');
  }
}

/** Apply one synchronous API operation. Unowned endpoints return undefined. */
export function handleCore(db, path, method = 'GET', body = {}) {
  method = method.toUpperCase();
  const archive = db.archive;
  const read = method === 'GET' || method === 'HEAD';
  if (read && ['/api/state', '/api/data'].includes(path)) return publicState(db);
  if (read && path === '/api/export') return copy(archive);
  if (read && path === '/api/health') return {ok: true, backendVersion: 'mobile-1', dbPath: 'This device', backupDirectory: 'This device', storageMode: 'browser-local', schemaVersion: 1};
  if (read && path === '/api/shards') return {shards: copy(archive.shards)};
  if (read && path === '/api/links') return {links: copy(archive.links)};
  if (read && path === '/api/boards') return {boards: copy(archive.boards)};
  if (read && path === '/api/drafts') return {drafts: {editor: null, connection: null, ...copy(db.drafts)}};
  if (read && path === '/api/trash') return {trash: copy(archive.trash).reverse()};
  let route;
  if ((route = /^\/api\/shards\/([^/]+)\/revisions$/.exec(path)) && read) {
    const shardId = pathId(route[1]);
    return {revisions: copy(archive.revisions.filter(item => item.shardId === shardId)).reverse()};
  }
  if (method === 'POST' && path === '/api/shards') {
    const shard = validateShard(body);
    archive.shards.push(shard);
    revision(db, shard, 'created');
    delete db.drafts.editor;
    return publicState(db);
  }
  if ((route = /^\/api\/shards\/([^/]+)$/.exec(path))) {
    if (read) return copy(find(archive.shards, pathId(route[1]), 'Shard'));
    if (method === 'PUT') {
      const current = find(archive.shards, pathId(route[1]), 'Shard');
      const updated = validateShard(body, {current});
      archive.shards[archive.shards.indexOf(current)] = updated;
      revision(db, updated, 'edited');
      delete db.drafts.editor;
      return publicState(db);
    }
    if (method === 'DELETE') {
      const shard = find(archive.shards, pathId(route[1]), 'Shard');
      const trash = {id: newId(), deletedAt: now(), shard: copy(shard), links: copy(archive.links.filter(item => [item.fromId, item.toId].includes(shard.id))), reviews: copy(archive.reviews.filter(item => item.shardId === shard.id))};
      saveBackup(db);
      archive.trash.push(trash);
      archive.shards = archive.shards.filter(item => item.id !== shard.id);
      archive.links = archive.links.filter(item => ![item.fromId, item.toId].includes(shard.id));
      archive.reviews = archive.reviews.filter(item => item.shardId !== shard.id);
      return publicState(db);
    }
  }
  if (method === 'POST' && path === '/api/links') {
    const link = validateLink(body);
    checkLink(db, link);
    archive.links.push(link);
    delete db.drafts.connection;
    return publicState(db);
  }
  if ((route = /^\/api\/links\/([^/]+)$/.exec(path))) {
    if (read) return copy(find(archive.links, pathId(route[1]), 'Relationship'));
    if (method === 'PUT') {
      const current = find(archive.links, pathId(route[1]), 'Relationship');
      const updated = validateLink(body, {current});
      checkLink(db, updated, current.id);
      archive.links[archive.links.indexOf(current)] = updated;
      delete db.drafts.connection;
      return publicState(db);
    }
    if (method === 'DELETE') {
      const current = find(archive.links, pathId(route[1]), 'Relationship');
      saveBackup(db);
      archive.links = archive.links.filter(item => item.id !== current.id);
      return publicState(db);
    }
  }
  if (method === 'PUT' && path === '/api/tags/rename') {
    object(body, 'Topic changes must be an object.');
    const from = textField(fieldValue(body, 'from', ''), 'from', 80, true).trim();
    const to = textField(fieldValue(body, 'to', ''), 'to', 80, true).trim();
    if (from !== to) for (const shard of archive.shards) if (shard.tags.includes(from)) {
      shard.tags = [...new Set(shard.tags.map(tag => tag === from ? to : tag))];
      shard.updatedAt = now();
      revision(db, shard, 'topic renamed');
    }
    return publicState(db);
  }
  if ((route = /^\/api\/drafts\/([^/]+)$/.exec(path))) {
    if (method === 'PUT') {
      const kind = draftKind(route[1]);
      object(body, 'Draft request must be an object.');
      object(body.draft, 'Draft must be an object.');
      if (jsonBytes(body.draft) > 250_000) fail('Draft is too large.', 413);
      Object.defineProperty(db.drafts, kind, {value: copy(body.draft), enumerable: true, writable: true, configurable: true});
      return {...publicState(db), ok: true, drafts: {editor: null, connection: null, ...copy(db.drafts)}};
    }
    if (method === 'DELETE') {
      const kind = draftKind(route[1]);
      if (own(db.drafts, kind)) saveBackup(db);
      delete db.drafts[kind];
      return {...publicState(db), ok: true, drafts: {editor: null, connection: null, ...copy(db.drafts)}};
    }
  }
  if ((route = /^\/api\/shards\/([^/]+)\/restore$/.exec(path)) && method === 'POST') {
    const shardId = pathId(route[1]);
    object(body, 'Revision restore must be an object.');
    const item = find(archive.revisions, recordId(body.revisionId, 'revisionId'), 'Revision');
    if (item.shardId !== shardId) fail('Revision not found.', 404);
    const current = archive.shards.find(shard => shard.id === shardId);
    if (!current) fail('Restore the shard from trash before restoring a revision.', 409);
    const restored = validateShard(item.snapshot, {current});
    // Extension metadata belongs to the saved version; recall progress stays current.
    for (const [key, value] of Object.entries(item.snapshot)) if (!own(restored, key)) Object.defineProperty(restored, key, {value: copy(value), enumerable: true, writable: true, configurable: true});
    saveBackup(db);
    archive.shards[archive.shards.indexOf(current)] = restored;
    revision(db, restored, 'revision restored');
    return publicState(db);
  }
  if ((route = /^\/api\/trash\/([^/]+)\/restore$/.exec(path)) && method === 'POST') {
    const item = find(archive.trash, pathId(route[1]), 'Trash item');
    const shard = validateShard(item.shard, {imported: true});
    if (archive.shards.some(value => value.id === shard.id)) fail('A shard with this ID already exists. Existing content was preserved.', 409);
    const candidates = (item.links || []).map(link => validateLink(link, {imported: true}));
    archive.shards.push(shard);
    const ids = new Set(archive.shards.map(value => value.id));
    let restoredLinks = 0, skippedLinks = 0;
    for (const link of candidates) {
      if (ids.has(link.fromId) && ids.has(link.toId) && !archive.links.some(value => value.id === link.id || linkKey(value) === linkKey(link))) {
        archive.links.push(copy(link));
        restoredLinks++;
      } else {
        skippedLinks++;
        // Keep pending edges with the other deleted endpoint, so restoring both
        // notes in either order recovers their relationship.
        if (!ids.has(link.fromId) || !ids.has(link.toId)) for (const other of archive.trash) {
          if (other.id !== item.id && [link.fromId, link.toId].includes(other.shard.id) && !(other.links || []).some(value => value.id === link.id)) {
            other.links ||= [];
            other.links.push(copy(link));
          }
        }
      }
    }
    for (const review of item.reviews || []) if (!archive.reviews.some(value => value.id === review.id)) archive.reviews.push(copy(review));
    archive.trash = archive.trash.filter(value => value.id !== item.id);
    revision(db, shard, 'restored from trash');
    return {...publicState(db), restoreSummary: {restoredLinks, skippedLinks}};
  }
  if (method === 'POST' && path === '/api/assets') {
    const asset = validateAsset(body);
    if (archive.assets.reduce((total, item) => total + (item.size || 0), 0) + asset.size > MAX_TOTAL_ASSET_BYTES) fail('Images in a collection must total at most 96 MB.', 413);
    archive.assets.push(asset);
    const metadata = {...asset};
    delete metadata.data;
    return {...publicState(db), ...metadata, url: `/assets/${asset.id}`};
  }
  if ((route = /^\/api\/assets\/([^/]+)\/text$/.exec(path)) && method === 'POST') {
    find(archive.assets, pathId(route[1]), 'Image');
    return {text: '', available: false, method: 'unavailable', warnings: ['Text recognition is unavailable on this device. The original image is retained; add its text manually.']};
  }
  return undefined;
}
