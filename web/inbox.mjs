import {canonicalLink, copy, linkKey, newId, publicState, recordId, saveBackup, validateCodeSolution, validateLink, validateLinkEndpoints, validateShard} from './model.mjs';
import {fingerprint} from './archives.mjs';
import {validateRichKnowledge} from './knowledge-validation.mjs';

export const INBOX_LIMITS = Object.freeze({batchBytes: 8 * 1024 * 1024, fileBytes: 8 * 1024 * 1024 + 1024, totalBytes: 64 * 1024 * 1024, files: 500, entries: 5000, receipts: 10_000, receiptBytes: 8 * 1024 * 1024});
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = (message, status = 400) => {throw Object.assign(new Error(message), {status});};
const bytes = value => new TextEncoder().encode(JSON.stringify(value)).length;
const SHARD_FIELDS = new Set(['id', 'title', 'content', 'tags', 'kind', 'status', 'sourceUrl', 'languageVersion', 'eventDate', 'evidenceStatus', 'sources', 'publicationDate', 'verifiedDate', 'eventType', 'entities', 'entityType', 'inbox', 'facts', 'subjects', 'courses', 'notation', 'assumptions', 'perspectives', 'walkthroughs', 'comparisons', 'learningLog', 'verification', 'experiments', 'codeSolution']);
const LINK_FIELDS = new Set(['id', 'fromId', 'toId', 'type', 'note', 'scope', 'evidence', 'sourceUrl', 'sourceLocation', 'fromApproachId', 'toApproachId']);
const lower = value => value.toLocaleLowerCase('en-US');
const contentKey = shard => JSON.stringify([lower(shard.title.trim().replace(/\s+/g, ' ')), shard.content, fingerprint(validateCodeSolution(shard.codeSolution ?? {}))]);
const immutableLink = link => Object.fromEntries([...LINK_FIELDS].filter(key => key !== 'id').map(key => [key, link[key] ?? '']));

function finiteJSON(value, depth = 0) {
  if (depth > 64) fail('Inbox JSON is nested too deeply.');
  if (value === null || ['string', 'boolean'].includes(typeof value)) return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (!object(value) && !Array.isArray(value)) fail('Inbox batches must contain finite JSON values.');
  for (const item of Object.values(value)) finiteJSON(item, depth + 1);
}

function exactFields(value, fields, message) {
  if (!object(value) || Object.keys(value).some(key => !fields.has(key))) fail(message);
}

/** Immutable additions only. No archives, timestamps, assets, edits, or deletes. */
export function validateInboxEnvelope(envelope) {
  exactFields(envelope, new Set(['format', 'version', 'batch']), 'Use a shard-atlas-inbox version 1 envelope containing only format, version, and batch.');
  if (Object.keys(envelope).length !== 3 || envelope.format !== 'shard-atlas-inbox' || envelope.version !== 1) fail('Use a shard-atlas-inbox version 1 envelope containing only format, version, and batch.');
  const batch = envelope.batch;
  exactFields(batch, new Set(['requestId', 'shards', 'links']), 'A batch contains only requestId, shards, and links.');
  finiteJSON(batch);
  recordId(batch.requestId, 'requestId');
  if (bytes(batch) > INBOX_LIMITS.batchBytes) fail('A contribution must be at most 8 MB.', 413);
  const shards = own(batch, 'shards') ? batch.shards : [], links = own(batch, 'links') ? batch.links : [];
  for (const [name, records, limit] of [['shards', shards, 1000], ['links', links, 2000]]) {
    if (!Array.isArray(records) || records.length > limit) fail(`Contribution ${name} must be a list of at most ${limit} records.`);
    const ids = new Set();
    for (const item of records) {
      exactFields(item, name === 'shards' ? SHARD_FIELDS : LINK_FIELDS, `Contribution ${name} contain only stable identity and editable knowledge fields.`);
      const id = recordId(item.id, `${name} id`);
      if (ids.has(id)) fail(`Contribution contains duplicate IDs in ${name}.`);
      ids.add(id);
    }
  }
  if (!shards.length && !links.length) fail('A contribution must contain at least one shard or relationship.');
  return batch;
}

/** JSON.parse alone silently accepts duplicate keys; immutable batches must not. */
export function parseInboxJSON(source) {
  if (typeof source !== 'string') fail('Inbox files must be UTF-8 JSON.');
  const text = source.replace(/^\uFEFF/, '');
  let position = 0;
  const whitespace = () => {while (/[\x20\t\r\n]/.test(text[position] || '\0')) position++;};
  const string = () => {
    const start = position++;
    while (position < text.length) {
      const next = text[position++];
      if (next === '\\') {position++; continue;}
      if (next === '"') {
        try {return JSON.parse(text.slice(start, position));} catch {fail('This inbox file is not valid JSON.');}
      }
    }
    fail('This inbox file is not valid JSON.');
  };
  const value = depth => {
    if (depth > 64) fail('Inbox JSON is nested too deeply.');
    whitespace();
    const next = text[position];
    if (next === '"') return string();
    if (next === '{') {
      position++; whitespace();
      const entries = [], keys = new Set();
      if (text[position] === '}') {position++; return {};}
      while (position < text.length) {
        whitespace();
        if (text[position] !== '"') break;
        const key = string();
        if (keys.has(key)) fail('Inbox JSON contains a duplicate object key. Keep every field unambiguous.');
        keys.add(key); whitespace();
        if (text[position++] !== ':') break;
        entries.push([key, value(depth + 1)]); whitespace();
        if (text[position] === '}') {position++; return Object.fromEntries(entries);}
        if (text[position++] !== ',') break;
      }
      fail('This inbox file is not valid JSON.');
    }
    if (next === '[') {
      position++; whitespace();
      const result = [];
      if (text[position] === ']') {position++; return result;}
      while (position < text.length) {
        result.push(value(depth + 1)); whitespace();
        if (text[position] === ']') {position++; return result;}
        if (text[position++] !== ',') break;
      }
      fail('This inbox file is not valid JSON.');
    }
    const match = /^(?:null|true|false|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(position));
    if (!match) fail('This inbox file is not valid JSON.');
    position += match[0].length;
    const result = JSON.parse(match[0]);
    if (typeof result === 'number' && !Number.isFinite(result)) fail('Inbox batches must contain finite JSON values.');
    return result;
  };
  const result = value(0); whitespace();
  if (position !== text.length) fail('This inbox file is not valid JSON.');
  return result;
}

function normalizeLink(data) {
  const link = validateLink(data, {imported: true});
  for (const [key, limit] of [['scope', 5000], ['evidence', 10_000], ['sourceUrl', 2048], ['sourceLocation', 240]]) {
    const value = own(data, key) ? data[key] : '';
    if (typeof value !== 'string' || [...value].length > limit || value.includes('\0')) fail(`Relationship ${key} must be text within its length limit.`);
    if (key === 'sourceUrl' && value) {
      let parsed;
      try {parsed = new URL(value);} catch {fail('Relationship sourceUrl must be an http or https URL.');}
      if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password || /[\s\\]/.test(value)) fail('Relationship sourceUrl must be an http or https URL without credentials.');
    }
    link[key] = value;
  }
  return link;
}

function remapReferences(value, aliases) {
  if (typeof value === 'string') return value.split(/(```[\s\S]*?```|`[^`]+`)/g).map((part, index) => index % 2 ? part : part.replace(/\[\[id:([A-Za-z0-9][A-Za-z0-9_.:-]{0,99})(?=[|\]])/g, (match, id) => aliases.has(id) ? '[[id:' + aliases.get(id) : match)).join('');
  if (Array.isArray(value)) return value.map(item => remapReferences(item, aliases));
  if (object(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, key === 'shardId' && typeof item === 'string' ? aliases.get(item) ?? item : remapReferences(item, aliases)]));
  return value;
}

function replayReceipt(db, saved) {
  const receipt = {...copy(saved.receipt), replayed: true};
  const shards = new Map(db.archive.shards.map(item => [item.id, item]));
  const links = new Map(db.archive.links.map(item => [item.id, item]));
  receipt.presentShardIds = receipt.shards.filter(item => shards.has(item.id)).map(item => item.id);
  receipt.missingShardIds = receipt.shards.filter(item => !shards.has(item.id)).map(item => item.id);
  receipt.currentContentMatches = Array.isArray(saved.savedRecords) && saved.savedRecords.every(item => fingerprint((item.kind === 'shards' ? shards : links).get(item.id)) === item.fingerprint);
  if (!receipt.currentContentMatches) receipt.warning = 'Some notes or relationships were edited or deleted after this import. Your later changes were preserved.';
  return receipt;
}

export function importInbox(db, envelope, file = {}) {
  const batch = validateInboxEnvelope(envelope), digest = fingerprint(batch), receipts = db.inboxReceipts || [];
  const saved = receipts.find(item => item.receipt.requestId === batch.requestId);
  if (saved) {
    if (saved.fingerprint !== digest) fail('This requestId was already used with different content. Keep the original file unchanged; create a new requestId for a new contribution.', 409);
    return replayReceipt(db, saved);
  }
  const shards = new Map(db.archive.shards.map(item => [item.id, item]));
  const links = new Map(db.archive.links.map(item => [item.id, item]));
  const deleted = new Set(db.archive.trash.map(item => item.shard.id));
  const duplicates = new Map(db.archive.shards.map(item => [contentKey(item), item]));
  const tags = new Map(db.archive.shards.flatMap(item => item.tags).map(tag => [lower(tag), tag]));
  const incoming = {shards: [], links: []}, shardReceipts = [], linkReceipts = [], idMap = new Map();
  for (const data of batch.shards || []) {
    if (own(data, 'tags') && !Array.isArray(data.tags)) fail('tags must be a list of text entries.');
    validateRichKnowledge(data);
    // imported:true also retains optional academic/technical metadata verbatim.
    const values = {...copy(data), tags: [...new Set((data.tags || []).map(tag => {
      if (typeof tag !== 'string') fail('tags must contain text.');
      const trimmed = tag.trim(), key = lower(trimmed);
      if (!tags.has(key)) tags.set(key, trimmed);
      return tags.get(key);
    }))]};
    const shard = validateShard(values, {imported: true});
    let current = shards.get(shard.id), reason;
    if (current) {
      if (current.title !== shard.title || current.content !== shard.content || fingerprint(validateCodeSolution(current.codeSolution ?? {})) !== fingerprint(shard.codeSolution)) fail(`Shard ID ${shard.id} already belongs to different content. Existing notes were preserved.`, 409);
      reason = 'id_exists';
    } else if (deleted.has(shard.id)) fail(`Shard ID ${shard.id} is in Trash. Restore it instead of reusing its ID.`, 409);
    else if (duplicates.has(contentKey(shard))) {current = duplicates.get(contentKey(shard)); reason = 'content_duplicate';}
    if (!current) {
      current = shard; incoming.shards.push(shard); shards.set(shard.id, shard); duplicates.set(contentKey(shard), shard);
    }
    idMap.set(shard.id, current.id);
    shardReceipts.push({inputId: shard.id, id: current.id, title: current.title, outcome: reason ? 'existing' : 'added', ...(reason ? {reason} : {})});
  }
  const aliases = new Map([...idMap].filter(([from, to]) => from !== to));
  incoming.shards = incoming.shards.map(shard => ({...shard, ...Object.fromEntries(['content', 'perspectives', 'walkthroughs', 'comparisons', 'learningLog', 'verification'].filter(key => own(shard, key)).map(key => [key, remapReferences(shard[key], aliases)])), codeSolution: {...shard.codeSolution, ...Object.fromEntries(['purpose', 'complexityNotes', 'assumptions', 'pitfalls'].map(key => [key, remapReferences(shard.codeSolution[key], aliases)])), approaches: shard.codeSolution.approaches.map(approach => ({...approach, ...Object.fromEntries(['summary', 'complexityNotes', 'assumptions', 'pitfalls'].map(key => [key, remapReferences(approach[key], aliases)]))}))}}));
  const triples = new Map(db.archive.links.map(link => [linkKey(link), link]));
  for (const data of batch.links || []) {
    let link = normalizeLink(data);
    link.fromId = idMap.get(link.fromId) ?? link.fromId;
    link.toId = idMap.get(link.toId) ?? link.toId;
    link = canonicalLink(link);
    if (!shards.has(link.fromId) || !shards.has(link.toId)) fail('Contribution contains a relationship with a missing shard.');
    if (link.fromId === link.toId && !(link.type === 'alternative_to' && link.fromApproachId && link.toApproachId && link.fromApproachId !== link.toApproachId)) fail('A relationship became a self-link after duplicate notes were matched. Remove that relationship and retry.');
    validateLinkEndpoints(link, shards);
    let current = links.get(link.id), reason;
    if (current) {
      if (fingerprint(immutableLink(current)) !== fingerprint(immutableLink(link))) fail(`Relationship ID ${link.id} already belongs to different content. Existing relationships were preserved.`, 409);
      reason = 'id_exists';
    } else if (triples.has(linkKey(link))) {current = triples.get(linkKey(link)); reason = 'relationship_exists';}
    if (!current) {current = link; incoming.links.push(link); links.set(link.id, link); triples.set(linkKey(link), link);}
    linkReceipts.push({inputId: link.id, id: current.id, fromId: current.fromId, toId: current.toId, type: current.type, fromApproachId: current.fromApproachId || '', toApproachId: current.toApproachId || '', outcome: reason ? 'existing' : 'added', ...(reason ? {reason} : {})});
  }
  const stamp = new Date().toISOString();
  const archive = {...db.archive, shards: [...db.archive.shards, ...incoming.shards], links: [...db.archive.links, ...incoming.links],
    revisions: [...db.archive.revisions, ...incoming.shards.map(shard => ({id: newId(), shardId: shard.id, createdAt: stamp, reason: 'drive-inbox', snapshot: copy(shard)}))]};
  if (Object.values(archive).some(value => Array.isArray(value) && value.length > 100_000) || bytes(archive) > 256 * 1024 * 1024) fail('This addition would exceed the portable archive capacity. Nothing was imported.', 413);
  const next = copy(db), backup = saveBackup(next);
  next.archive = archive;
  const receipt = {requestId: batch.requestId, createdAt: stamp, replayed: false, verified: true, currentContentMatches: true,
    added: {shards: incoming.shards.length, links: incoming.links.length}, skipped: {shards: shardReceipts.length - incoming.shards.length, links: linkReceipts.length - incoming.links.length},
    shards: shardReceipts, links: linkReceipts, idMap: Object.fromEntries(idMap), backupFilename: backup.filename,
    presentShardIds: shardReceipts.map(item => item.id), missingShardIds: [], file: {id: String(file.id || '').slice(0, 240), name: String(file.name || 'Inbox batch').slice(0, 500)}};
  const savedRecords = [...shardReceipts.map(item => ({kind: 'shards', id: item.id, fingerprint: fingerprint(incoming.shards.find(shard => shard.id === item.id) || shards.get(item.id))})),
    ...linkReceipts.map(item => ({kind: 'links', id: item.id, fingerprint: fingerprint(links.get(item.id))}))];
  const entry = {fingerprint: digest, receipt, savedRecords};
  if (receipts.length >= INBOX_LIMITS.receipts || bytes(receipts) + bytes(entry) > INBOX_LIMITS.receiptBytes) fail('The saved inbox receipt capacity is full. Nothing was saved.', 413);
  next.inboxReceipts = [...receipts, entry];
  // BrowserStore commits this object and its receipt in one IndexedDB transaction.
  Object.assign(db, next);
  return copy(receipt);
}

export function validateDriveSettings(settings) {
  exactFields(settings, new Set(['clientId', 'folderId', 'expectedEmail']), 'Drive settings contain only clientId, folderId, and expectedEmail.');
  const result = {clientId: String(settings.clientId || '').trim(), folderId: String(settings.folderId || '').trim(), expectedEmail: String(settings.expectedEmail || '').trim()};
  if (result.clientId && !/^[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$/.test(result.clientId)) fail('Enter a Google Web OAuth client ID ending in .apps.googleusercontent.com.');
  if (result.folderId && !/^[A-Za-z0-9_-]{10,200}$/.test(result.folderId)) fail('Enter the inbox folder ID from its Google Drive URL.');
  if (result.expectedEmail && (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(result.expectedEmail) || result.expectedEmail.length > 254)) fail('Enter a valid expected Google account email.');
  return result;
}

export function handleInbox(db, path, method, body = {}) {
  if (method === 'GET' && path === '/api/drive/status') return {settings: copy(db.driveInbox?.settings || {}), lastRun: copy(db.driveInbox?.lastRun || null), receipts: (db.inboxReceipts || [])
    .filter(item => item.operation !== 'edit' && item.receipt?.operation !== 'edit')
    .slice(-30).reverse().map(item => replayReceipt(db, item))};
  if (method === 'PUT' && path === '/api/drive/settings') {
    db.driveInbox = {...(db.driveInbox || {}), settings: validateDriveSettings(body)};
    return copy(db.driveInbox.settings);
  }
  if (method === 'POST' && path === '/api/drive/import') return {receipt: importInbox(db, body.envelope, body.file), state: publicState(db)};
  if (method === 'PUT' && path === '/api/drive/status') {
    finiteJSON(body);
    if (bytes(body) > 256 * 1024 || !Array.isArray(body.files) || body.files.length > INBOX_LIMITS.files) fail('Inbox sync status is too large.');
    db.driveInbox = {...(db.driveInbox || {}), lastRun: copy(body)};
    return {ok: true};
  }
  return undefined;
}
