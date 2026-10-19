import {copy, emptyDatabase, publicState, recordId, saveBackup, validateAsset, validateLink, validateShard} from './model.mjs';

const KINDS = ['shards', 'links', 'reviews', 'assets', 'revisions', 'trash', 'boards'];
const RECORD_LIMIT = 100_000, ARCHIVE_LIMIT = 256 * 1024 * 1024;
const REVIEW_DAYS = {again: 1, hard: 3, good: 7, easy: 14};
const REVIEW_FIELDS = ['reviewCount', 'lastReviewedAt', 'nextReviewAt'];
const now = () => new Date().toISOString();
const uuid = () => globalThis.crypto?.randomUUID?.() || `mobile-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const field = (value, key, fallback) => own(value, key) ? value[key] : fallback;
const fail = (message, status = 400) => {throw Object.assign(new Error(message), {status});};
const size = value => new TextEncoder().encode(JSON.stringify(value)).length;

function finiteJSON(value, seen = new Set()) {
  if (value === null || ['string', 'boolean'].includes(typeof value)) return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (!object(value) && !Array.isArray(value)) fail('Archives must contain valid finite JSON values.');
  if (seen.has(value)) fail('Archives must contain valid finite JSON values.');
  seen.add(value);
  for (const item of Object.values(value)) finiteJSON(item, seen);
  seen.delete(value);
}

function text(value, name, limit, required = false) {
  if (typeof value !== 'string') fail(`${name} must be text.`);
  if ([...value].length > limit) fail(`${name} must be at most ${limit.toLocaleString('en-US')} characters.`);
  if (value.includes('\0')) fail(`${name} cannot contain a null character.`);
  if (required && !value.trim()) fail(`${name} is required.`);
  return name === 'title' ? value.trim() : value;
}

function timestamp(value, name) {
  if (typeof value !== 'string' || value.length > 64 || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/i.test(value) || !Number.isFinite(Date.parse(value))) {
    fail(`${name} must be an ISO timestamp with a time zone.`);
  }
  const [year, month, day] = value.slice(0, 10).split('-').map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const clock = value.slice(11).match(/^(\d{2}):(\d{2})(?::(\d{2}))?/);
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > days[month - 1] || +clock[1] > 23 || +clock[2] > 59 || +(clock[3] || 0) > 59) fail(`${name} must be an ISO timestamp with a time zone.`);
  return new Date(value).toISOString();
}

function sourceUrl(value) {
  const result = text(value, 'sourceUrl', 2048);
  if (!result) return result;
  try {
    const url = new URL(result);
    if (!/^https?:\/\//i.test(result) || !['https:', 'http:'].includes(url.protocol) || !url.hostname || url.username || url.password || /[\s\\]/.test(result)) throw new Error();
  } catch {fail('sourceUrl must be an http or https URL without embedded credentials.');}
  return result;
}

function coordinate(value, name, minimum = -1_000_000, maximum = 1_000_000) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) fail(`${name} must be a finite number between ${minimum} and ${maximum}.`);
  return value;
}

function list(value, name, limit = RECORD_LIMIT) {
  if (!Array.isArray(value) || value.length > limit) fail(`${name} must be a list of at most ${limit.toLocaleString('en-US')} records.`);
  return value;
}

function uniqueIds(values, name, field = 'id') {
  if (new Set(values.map(item => item[field])).size !== values.length) fail(`Import contains duplicate IDs in ${name}.`);
  return values;
}

function validateReview(data) {
  if (!object(data)) fail('Each review must be an object.');
  if (typeof data.grade !== 'string' || !own(REVIEW_DAYS, data.grade)) fail('grade must be again, hard, good, or easy.');
  const reviewedAt = timestamp(field(data, 'reviewedAt', now()), 'reviewedAt');
  const nextReviewAt = timestamp(field(data, 'nextReviewAt', new Date(Date.parse(reviewedAt) + REVIEW_DAYS[data.grade] * 86400_000).toISOString()), 'nextReviewAt');
  return {...copy(data), id: recordId(data.id), shardId: recordId(data.shardId), grade: data.grade, reviewedAt, nextReviewAt};
}

function validateBoard(data) {
  if (!object(data)) fail('Each board must be an object.');
  const stamp = now();
  const result = {...copy(data), id: recordId(data.id), title: text(field(data, 'title', ''), 'title', 240, true),
    description: text(field(data, 'description', ''), 'description', 20_000), sourceUrl: sourceUrl(field(data, 'sourceUrl', '')),
    createdAt: timestamp(field(data, 'createdAt', stamp), 'createdAt'), updatedAt: timestamp(field(data, 'updatedAt', stamp), 'updatedAt')};
  for (const key of ['items', 'sections']) {
    const items = list(field(data, key, []), `Board ${key}`, key === 'items' ? 20_000 : 1000);
    result[key] = items.map(value => {
      if (!object(value)) fail(`Each board ${key} entry must be an object.`);
      const box = {...copy(value), x: coordinate(field(value, 'x', 0), 'x'), y: coordinate(field(value, 'y', 0), 'y'),
        width: coordinate(field(value, 'width', key === 'items' ? 280 : 600), 'width', 1, 100_000),
        height: coordinate(field(value, 'height', key === 'items' ? 160 : 400), 'height', 1, 100_000)};
      if (key === 'items') {
        box.shardId = recordId(value.shardId);
        box.sectionId = value.sectionId ? recordId(value.sectionId) : '';
      } else {
        if (own(value, 'collapsed') && typeof value.collapsed !== 'boolean') fail('collapsed must be true or false.');
        Object.assign(box, {id: recordId(value.id), title: text(field(value, 'title', ''), 'section title', 240, true), collapsed: field(value, 'collapsed', false),
          shardId: field(value, 'shardId', '') !== '' ? recordId(value.shardId) : ''});
      }
      return box;
    });
    uniqueIds(result[key], `board ${key}`, key === 'items' ? 'shardId' : 'id');
  }
  const sectionIds = new Set(result.sections.map(item => item.id));
  if (result.items.some(item => item.sectionId && !sectionIds.has(item.sectionId))) fail('A board item refers to a missing section.');
  const viewport = field(data, 'viewport', {});
  if (!object(viewport)) fail('viewport must be an object.');
  result.viewport = {...copy(viewport), x: coordinate(field(viewport, 'x', 0), 'viewport x'), y: coordinate(field(viewport, 'y', 0), 'viewport y'), zoom: coordinate(field(viewport, 'zoom', 1), 'zoom', .005, 10)};
  return result;
}

function validateRevision(data) {
  if (!object(data)) fail('Each revision must be an object.');
  const shardId = recordId(data.shardId), snapshot = validateShard(data.snapshot, {imported: true});
  if (snapshot.id !== shardId) fail('Revision shard ID does not match its snapshot.');
  return {...copy(data), id: recordId(data.id), shardId, snapshot, createdAt: timestamp(field(data, 'createdAt', now()), 'createdAt'),
    reason: text(field(data, 'reason', 'imported'), 'reason', 100, true)};
}

function validateTrash(data) {
  if (!object(data)) fail('Each trash item must be an object.');
  const shard = validateShard(data.shard, {imported: true});
  const links = uniqueIds(list(field(data, 'links', []), 'Trash relationships').map(item => validateLink(item, {imported: true})), 'trash relationships');
  const reviews = uniqueIds(list(field(data, 'reviews', []), 'Trash reviews').map(validateReview), 'trash reviews');
  if (links.some(link => ![link.fromId, link.toId].includes(shard.id))) fail('Trash relationships must belong to the deleted shard.');
  if (reviews.some(review => review.shardId !== shard.id)) fail('Trash reviews must belong to the deleted shard.');
  return {...copy(data), id: recordId(data.id), deletedAt: timestamp(field(data, 'deletedAt', now()), 'deletedAt'), shard, links, reviews};
}

function normalizeImport(db, payload) {
  if (!object(payload) || payload.schemaVersion !== 1) fail('Import must contain schemaVersion: 1.');
  finiteJSON(payload);
  if (size(payload) > ARCHIVE_LIMIT) fail('Archives must be at most 256 MB.', 413);
  const validators = {shards: value => validateShard(value, {imported: true}), links: value => validateLink(value, {imported: true}),
    reviews: validateReview, assets: value => validateAsset(value, {imported: true}), revisions: validateRevision, trash: validateTrash, boards: validateBoard};
  const normalized = {...copy(payload), schemaVersion: 1};
  for (const key of KINDS) normalized[key] = uniqueIds(list(field(payload, key, []), key).map(validators[key]), key);
  if (normalized.assets.length > 2048 || normalized.assets.reduce((total, asset) => total + asset.size, 0) > 96 * 1024 * 1024) fail('An archive can contain at most 2,048 images totaling at most 96 MB.', 413);
  const current = db.archive, shardIds = new Set([...current.shards, ...normalized.shards].map(item => item.id));
  const existingLinks = new Set(current.links.map(item => item.id));
  const triple = item => JSON.stringify([item.fromId, item.toId, item.type]);
  const triples = new Set(current.links.map(triple));
  for (const link of normalized.links) {
    if (!shardIds.has(link.fromId) || !shardIds.has(link.toId)) fail('Import contains a relationship with a missing shard.');
    if (!existingLinks.has(link.id)) {
      if (triples.has(triple(link))) fail('Import contains a duplicate relationship with a different ID.', 409);
      triples.add(triple(link));
    }
  }
  if (normalized.reviews.some(review => !shardIds.has(review.shardId))) fail('Import contains a review with a missing shard.');
  const currentShardIds = new Set(current.shards.map(item => item.id)), deletedIds = new Set(current.trash.map(item => item.shard.id));
  if (normalized.shards.some(shard => deletedIds.has(shard.id) && !currentShardIds.has(shard.id))) fail('An incoming note is already in Trash. Restore it first to avoid unintentionally recreating deleted knowledge.', 409);
  const known = new Set([...shardIds, ...deletedIds, ...normalized.trash.map(item => item.shard.id)]);
  if (normalized.revisions.some(revision => !known.has(revision.shardId))) fail('Import contains a revision with a missing shard.');
  if (normalized.trash.some(item => item.links.some(link => !known.has(link.fromId) || !known.has(link.toId)))) fail('Import contains a trash relationship with a missing shard.');
  return normalized;
}

// Canonical JSON and SHA-256 give compact, collision-resistant undo receipts even for large image archives.
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (object(value)) return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  return JSON.stringify(value);
}

const HASH_CONSTANTS = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);
const rotate = (value, bits) => (value >>> bits) | (value << (32 - bits));

function fingerprint(value) {
  const encoded = canonical(value);
  if (encoded === undefined) return undefined;
  const input = new TextEncoder().encode(encoded), bytes = new Uint8Array(Math.ceil((input.length + 9) / 64) * 64);
  bytes.set(input); bytes[input.length] = 0x80;
  const view = new DataView(bytes.buffer), bits = input.length * 8;
  view.setUint32(bytes.length - 8, Math.floor(bits / 4294967296));
  view.setUint32(bytes.length - 4, bits >>> 0);
  const hash = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]), words = new Uint32Array(64);
  for (let offset = 0; offset < bytes.length; offset += 64) {
    for (let index = 0; index < 16; index++) words[index] = view.getUint32(offset + index * 4);
    for (let index = 16; index < 64; index++) {
      const x = words[index - 15], y = words[index - 2];
      words[index] = (words[index - 16] + (rotate(x, 7) ^ rotate(x, 18) ^ (x >>> 3)) + words[index - 7] + (rotate(y, 17) ^ rotate(y, 19) ^ (y >>> 10))) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = hash;
    for (let index = 0; index < 64; index++) {
      const first = (h + (rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25)) + ((e & f) ^ (~e & g)) + HASH_CONSTANTS[index] + words[index]) >>> 0;
      const second = ((rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      h = g; g = f; f = e; e = (d + first) >>> 0; d = c; c = b; b = a; a = (first + second) >>> 0;
    }
    for (const [index, word] of [a, b, c, d, e, f, g, h].entries()) hash[index] = (hash[index] + word) >>> 0;
  }
  return [...hash].map(word => word.toString(16).padStart(8, '0')).join('');
}

function references(item, key) {
  if (key === 'links') return [item.fromId, item.toId];
  if (key === 'reviews' || key === 'revisions') return [item.shardId];
  if (key === 'boards') return [...(Array.isArray(item.items) ? item.items : []), ...(Array.isArray(item.sections) ? item.sections : [])].filter(object).map(value => value.shardId).filter(Boolean);
  if (key === 'trash') return [item.shard?.id, ...(item.links ?? []).flatMap(link => [link.fromId, link.toId])].filter(Boolean);
  return [];
}

function wikiReferences(value) {
  return [...JSON.stringify(value).matchAll(/\[\[id:([A-Za-z0-9][A-Za-z0-9_.:-]{0,99})(?=[|\]])/g)].map(match => match[1]);
}

function previewImport(db, payload) {
  if (!object(payload)) fail('Import must contain a data object.');
  finiteJSON(payload);
  if (size(payload) > ARCHIVE_LIMIT) fail('Import preview exceeds the archive limits.', 413);
  const counts = {}, added = {}, skipped = {}, duplicates = [], conflicts = [], missing = [], warnings = [];
  const incoming = Object.fromEntries(KINDS.map(key => [key, Array.isArray(payload[key]) ? payload[key] : []]));
  if (Object.values(incoming).some(values => values.length > RECORD_LIMIT)) fail('Import preview exceeds the archive limits.', 413);
  const known = new Set([...db.archive.shards, ...incoming.shards].filter(object).map(item => item.id));
  const assets = new Set([...db.archive.assets, ...incoming.assets].filter(object).map(item => item.id));
  const existingContent = new Map(db.archive.shards.map(item => [JSON.stringify([item.title.trim().toLocaleLowerCase(), item.content]), item.id]));
  for (const key of KINDS) {
    counts[key] = incoming[key].length; added[key] = skipped[key] = 0;
    const existing = new Map(db.archive[key].map(item => [item.id, item])), seen = new Set();
    for (const item of incoming[key]) {
      if (!object(item) || typeof item.id !== 'string') continue;
      const id = item.id;
      if (seen.has(id)) duplicates.push({kind: key, id, reason: 'duplicate ID in archive'});
      seen.add(id);
      if (existing.has(id)) {
        skipped[key]++;
        duplicates.push({kind: key, id, reason: 'existing ID will be preserved'});
        const comparable = Object.entries(item).filter(([field]) => !['createdAt', 'updatedAt'].includes(field));
        if (comparable.some(([field, value]) => fingerprint(existing.get(id)[field]) !== fingerprint(key === 'shards' && field === 'title' && typeof value === 'string' ? value.trim() : value))) {
          conflicts.push({kind: key, id, reason: 'incoming content differs; existing content will be preserved'});
        }
      } else {
        added[key]++;
        if (key === 'shards' && typeof item.content === 'string') {
          const matched = existingContent.get(JSON.stringify([String(item.title ?? '').trim().toLocaleLowerCase(), item.content]));
          if (matched) duplicates.push({kind: key, id, existingId: matched, reason: 'same title and content under a different ID; both records will remain'});
        }
      }
      if (key === 'shards' && typeof item.content === 'string') {
        for (const assetId of new Set([...item.content.matchAll(/\]\(\/assets\/([A-Za-z0-9][A-Za-z0-9_.:-]{0,99})\)/g)].map(match => match[1]))) {
          if (!assets.has(assetId)) missing.push({kind: key, id, assetId, reason: 'missing local image'});
        }
      }
      for (const shardId of ['links', 'reviews', 'boards'].includes(key) ? references(item, key) : []) {
        if (typeof shardId !== 'string' || !known.has(shardId)) missing.push({kind: key, id, shardId, reason: 'missing note'});
      }
    }
  }
  let valid = true;
  try {normalizeImport(db, payload);} catch (error) {valid = false; warnings.push(error.message);}
  if (missing.some(item => item.kind === 'boards')) warnings.push('Missing notes on boards retain their saved positions and can be restored from Trash.');
  return {valid, counts, added, skipped, duplicates, conflicts, missing, warnings,
    coverage: {shards: counts.shards, links: counts.links, boards: counts.boards,
      boardItems: incoming.boards.filter(object).reduce((total, board) => total + (Array.isArray(board.items) ? board.items.length : 0), 0), assets: counts.assets}};
}

function reviewValues(shard) {return Object.fromEntries(REVIEW_FIELDS.map(key => [key, shard[key]]));}

function recomputeReview(db, shardId) {
  const shard = db.archive.shards.find(item => item.id === shardId);
  if (!shard) return;
  const reviews = db.archive.reviews.filter(item => item.shardId === shardId);
  const latest = reviews.reduce((value, item) => !value || item.reviewedAt >= value.reviewedAt ? item : value, null);
  Object.assign(shard, {reviewCount: reviews.length, lastReviewedAt: latest?.reviewedAt ?? null, nextReviewAt: latest?.nextReviewAt ?? null});
}

function commit(db, next) {
  for (const key of ['archive', 'drafts', 'backups', 'imports']) db[key] = next[key];
}

function importData(db, payload) {
  const normalized = normalizeImport(db, payload);
  if (db.imports.length >= 10_000) fail('Import receipt capacity exceeded. Nothing was imported.', 413);
  const next = copy(db), backup = saveBackup(next), stamp = now(), id = uuid();
  const previous = Object.fromEntries(KINDS.map(key => [key, new Set(next.archive[key].map(item => item.id))]));
  const beforeReviews = new Map(next.archive.shards.map(shard => [shard.id, reviewValues(shard)]));
  const summary = {added: {}, skipped: {}};
  for (const key of KINDS) {
    summary.added[key] = summary.skipped[key] = 0;
    for (const item of normalized[key]) {
      if (previous[key].has(item.id)) {summary.skipped[key]++; continue;}
      next.archive[key].push(copy(item)); summary.added[key]++;
    }
  }
  for (const shardId of new Set(normalized.reviews.filter(item => !previous.reviews.has(item.id)).map(item => item.shardId))) recomputeReview(next, shardId);
  const revisionShards = new Set(next.archive.revisions.map(item => item.shardId));
  for (const shard of next.archive.shards) {
    if (!revisionShards.has(shard.id)) next.archive.revisions.push({id: uuid(), shardId: shard.id, createdAt: stamp, reason: 'imported', snapshot: copy(shard)});
  }
  const records = Object.fromEntries(KINDS.map(key => [key, next.archive[key].filter(item => !previous[key].has(item.id)).map(item => ({id: item.id, fingerprint: fingerprint(item)}))]));
  const reviewUpdates = {};
  for (const shard of next.archive.shards) {
    const before = beforeReviews.get(shard.id), after = reviewValues(shard);
    if (before && fingerprint(before) !== fingerprint(after)) reviewUpdates[shard.id] = {before, after};
  }
  const sourceMetadata = Object.fromEntries(Object.entries(normalized).filter(([key]) => key !== 'schemaVersion' && !KINDS.includes(key)));
  const metadataConflicts = {};
  for (const [key, value] of Object.entries(sourceMetadata)) {
    if (!own(next.archive, key)) next.archive = {...next.archive, [key]: copy(value)};
    else if (fingerprint(next.archive[key]) !== fingerprint(value)) Object.defineProperty(metadataConflicts, key, {value: copy(value), enumerable: true});
  }
  if (Object.keys(metadataConflicts).length) {
    const history = Array.isArray(next.archive.mobileImportMetadata) ? next.archive.mobileImportMetadata : own(next.archive, 'mobileImportMetadata') ? [{metadata: {mobileImportMetadata: copy(next.archive.mobileImportMetadata)}}] : [];
    next.archive.mobileImportMetadata = [...history, {importId: id, createdAt: stamp, metadata: metadataConflicts}];
  }
  const receipt = {id, createdAt: stamp, undoneAt: null, title: typeof payload.title === 'string' ? payload.title : 'Imported archive',
    sourceUrl: normalized.boards.find(item => item.sourceUrl)?.sourceUrl ?? '', added: copy(summary.added), skipped: copy(summary.skipped),
    backupFilename: backup.filename, records, reviewUpdates, sourceMetadata};
  if (size(receipt) > 16 * 1024 * 1024) fail('Import receipt capacity exceeded. Nothing was imported.', 413);
  next.imports.push(receipt); commit(db, next);
  return {...publicState(db), importSummary: {...summary, backupFilename: backup.filename, importId: id}, importReceipt: publicReceipt(receipt)};
}

function publicReceipt(receipt) {
  const {records, reviewUpdates, ...result} = receipt;
  return copy(result);
}

function undoImport(db, id) {
  recordId(id);
  const current = db.imports.find(item => item.id === id);
  if (!current) fail('Import receipt not found.', 404);
  if (current.undoneAt) return {...publicState(db), undoSummary: {...copy(current.undoSummary), replayed: true}};
  const next = copy(db), backup = saveBackup(next), receipt = next.imports.find(item => item.id === id);
  const candidates = {}, skipped = [], skippedKeys = new Set();
  function skip(key, itemId, reason) {
    if (!candidates[key]?.delete(itemId)) return;
    const token = JSON.stringify([key, itemId]);
    if (!skippedKeys.has(token)) {skippedKeys.add(token); skipped.push({kind: key, id: itemId, reason});}
  }
  for (const key of KINDS) {
    candidates[key] = new Set();
    const existing = new Map(next.archive[key].map(item => [item.id, item]));
    for (const item of receipt.records?.[key] ?? []) {
      if (existing.has(item.id) && fingerprint(existing.get(item.id)) === item.fingerprint) candidates[key].add(item.id);
      else skipped.push({kind: key, id: item.id, reason: existing.has(item.id) ? 'modified after import' : 'already absent'});
    }
  }
  // Repeated closure preserves a retained note's references, its history, and that history's references.
  let changed;
  do {
    const before = KINDS.reduce((count, key) => count + candidates[key].size, 0), protectedShards = new Set();
    for (const key of KINDS) {
      if (key === 'assets') continue;
      for (const item of next.archive[key]) {
        if (candidates[key].has(item.id)) continue;
        for (const shardId of [...references(item, key), ...wikiReferences(item)]) protectedShards.add(shardId);
      }
    }
    for (const draft of Object.values(next.drafts)) {
      if (object(draft) && typeof draft.id === 'string') protectedShards.add(draft.id);
      for (const shardId of wikiReferences(draft)) protectedShards.add(shardId);
    }
    for (const shardId of protectedShards) skip('shards', shardId, 'referenced by work outside the unchanged import');
    for (const revision of next.archive.revisions) {
      if (!candidates.shards.has(revision.shardId)) skip('revisions', revision.id, 'history belongs to retained knowledge');
    }
    changed = before !== KINDS.reduce((count, key) => count + candidates[key].size, 0);
  } while (changed);
  const retainedText = JSON.stringify({records: Object.fromEntries(KINDS.filter(key => key !== 'assets').map(key => [key, next.archive[key].filter(item => !candidates[key].has(item.id))])), drafts: next.drafts});
  for (const assetId of [...candidates.assets]) {
    if (retainedText.includes('/assets/' + assetId)) skip('assets', assetId, 'used by retained knowledge');
  }
  const affectedReviews = new Set(next.archive.reviews.filter(item => candidates.reviews.has(item.id)).map(item => item.shardId));
  const before = new Map(next.archive.shards.map(shard => [shard.id, reviewValues(shard)]));
  const removed = {};
  for (const key of KINDS) {
    const prior = next.archive[key].length;
    next.archive[key] = next.archive[key].filter(item => !candidates[key].has(item.id));
    removed[key] = prior - next.archive[key].length;
  }
  for (const shardId of affectedReviews) {
    const shard = next.archive.shards.find(item => item.id === shardId), update = receipt.reviewUpdates?.[shardId];
    if (shard && update && fingerprint(before.get(shardId)) === fingerprint(update.after)) Object.assign(shard, copy(update.before));
    else recomputeReview(next, shardId);
  }
  const summary = {importId: id, removed, skipped, backupFilename: backup.filename, replayed: false};
  Object.assign(receipt, {undoneAt: now(), undoSummary: summary}); commit(db, next);
  return {...publicState(db), undoSummary: copy(summary)};
}

function backups(db) {
  return {backups: [...db.backups].reverse().map(snapshot => {
    const item = {filename: snapshot.filename, createdAt: snapshot.createdAt, size: snapshot.size,
      shardCount: snapshot.archive?.shards?.length ?? null, valid: true, error: null};
    try {normalizeImport(emptyDatabase(), snapshot.archive);} catch (error) {item.valid = false; item.error = error.message;}
    return item;
  })};
}

function restoreBackup(db, filename) {
  const snapshot = db.backups.find(item => item.filename === filename);
  if (typeof filename !== 'string' || !snapshot) fail("Choose a snapshot from this app's backup list.", 404);
  normalizeImport(emptyDatabase(), snapshot.archive);
  finiteJSON(snapshot.drafts ?? {}); finiteJSON(snapshot.imports ?? []);
  if (!object(snapshot.drafts ?? {}) || !Array.isArray(snapshot.imports ?? [])) fail('Snapshot is corrupt or is not a supported Shard Atlas database.');
  const next = copy(db), safety = saveBackup(next);
  next.archive = copy(snapshot.archive); next.drafts = copy(snapshot.drafts ?? {}); next.imports = copy(snapshot.imports ?? []);
  commit(db, next);
  return {...publicState(db), restoreSummary: {preRestoreBackupFilename: safety.filename}};
}

export function handleArchives(db, path, method, body = {}) {
  if (method === 'POST' && ['/api/import/preview', '/api/import-preview'].includes(path)) return previewImport(db, body?.data);
  if (method === 'POST' && path === '/api/import') return importData(db, body?.data);
  if (method === 'GET' && path === '/api/imports') return {imports: [...db.imports].reverse().map(publicReceipt)};
  if (method === 'POST' && /^\/api\/imports\/[^/]+\/undo$/.test(path)) return undoImport(db, decodeURIComponent(path.slice('/api/imports/'.length, -'/undo'.length)));
  if (method === 'GET' && path === '/api/backups') return backups(db);
  if (method === 'POST' && path === '/api/backup') {const result = saveBackup(db); return {filename: result.filename, createdAt: result.createdAt};}
  if (method === 'POST' && path === '/api/backups/restore') return restoreBackup(db, body?.filename);
  return undefined;
}
