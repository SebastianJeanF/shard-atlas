import {LibraryStorage} from '../../sync/storage.mjs';
import {validateCapsule} from '../../sync/client.mjs';
import {ARCHIVE_VERSION, CHUNK_BYTES, HASH_PATTERN, ID_PATTERN, MAX_MANIFEST_BYTES, PROTOCOL_VERSION, sha256, validateManifest} from '../../sync/protocol.mjs';
import {canonicalLink, copy, linkKey, recordId, validateCodeSolution, validateLink, validateLinkEndpoints, validateShard} from '../../web/model.mjs';
import {fingerprint} from '../../web/archives.mjs';
import {INBOX_LIMITS, validateInboxEnvelope} from '../../web/inbox.mjs';
import {validateRichKnowledge} from '../../web/knowledge-validation.mjs';

export const CLOUD_CONTRIBUTION_LIMITS = Object.freeze({batchBytes: 256 * 1024, shards: 20, links: 100, snapshotBytes: 16 * 1024 * 1024});
const queues = new WeakMap();
const messages = Object.freeze({
  invalid_contribution: 'Use one additions-only batch with valid stable IDs, at most 20 notes and 100 relationships, and the expected cloud revision.',
  contribution_too_large: 'This addition exceeds the 256 KiB batch limit. Split genuinely separate additions into reviewed requests.',
  cloud_snapshot_too_large: 'This library exceeds the 16 MiB cloud addition limit. Use the local Shard Atlas tools; library synchronization is unaffected.',
  cloud_library_invalid: 'The complete cloud library could not be verified. Existing knowledge was preserved.',
  cloud_library_unavailable: 'The cloud addition could not finish. Retry the exact same request ID and batch when the connection is available.',
  cloud_library_changed: 'The shared library changed. Search and read the current library, then retry the unchanged batch and request ID with its reviewed revision.',
  contribution_conflict: 'A proposed ID or relationship conflicts with saved knowledge. Read the current records and review the addition; existing knowledge was preserved.',
  request_id_reused: 'This request ID already belongs to different content. Preserve the original request; use a new request only for a genuinely new reviewed addition.',
  request_conflicted: 'This request was not accepted because another cloud change won. Refresh and review the library before preparing a new request; never retry with invented IDs automatically.',
  save_outcome_unknown: 'The request may have been saved, but its current result could not be verified. Retry the exact same request ID and batch; do not create a new request.',
  cloud_busy: 'Another cloud addition is being checked. Retry the exact same request ID and batch shortly; do not create a new request.',
});

export class AtlasContributionError extends Error {
  constructor(code, status = 503) {
    const known = Object.hasOwn(messages, code) ? code : 'cloud_library_unavailable';
    super(messages[known]); this.name = 'AtlasContributionError'; this.code = known; this.status = status;
  }
}
const fail = (code, status) => {throw new AtlasContributionError(code, status);};
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const encoder = new TextEncoder();
const lower = value => value.toLocaleLowerCase('en-US');
const validRevision = value => typeof value === 'string' && (value === '' || ID_PATTERN.test(value));
const validTimestamp = value => typeof value === 'string' && value.length <= 64
  && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/.test(value) && Number.isFinite(Date.parse(value));
const contentKey = shard => JSON.stringify([lower(shard.title.trim().replace(/\s+/g, ' ')), shard.content ?? '', fingerprint(validateCodeSolution(shard.codeSolution ?? {}))]);
const linkFields = ['fromId', 'toId', 'type', 'note', 'scope', 'evidence', 'sourceUrl', 'sourceLocation', 'fromApproachId', 'toApproachId'];

export function validateCloudContributionArguments(args) {
  try {
    if (!object(args) || Object.keys(args).some(key => !['batch', 'expectedRevision'].includes(key))
        || !own(args, 'batch') || !own(args, 'expectedRevision') || !validRevision(args.expectedRevision)
        || !object(args.batch) || !Array.isArray(args.batch.shards) || !Array.isArray(args.batch.links)) fail('invalid_contribution', 400);
    const batch = validateInboxEnvelope({format: 'shard-atlas-inbox', version: 1, batch: args.batch});
    if (batch.shards.length > CLOUD_CONTRIBUTION_LIMITS.shards || batch.links.length > CLOUD_CONTRIBUTION_LIMITS.links) fail('invalid_contribution', 400);
    if (encoder.encode(JSON.stringify(batch)).byteLength > CLOUD_CONTRIBUTION_LIMITS.batchBytes) fail('contribution_too_large', 413);
    for (const shard of batch.shards) {
      if (!own(shard, 'title') || !own(shard, 'content') || !own(shard, 'tags')) fail('invalid_contribution', 400);
      validateRichKnowledge(shard); validateShard(shard, {imported: true});
    }
    for (const link of batch.links) {
      if (!own(link, 'fromId') || !own(link, 'toId') || !own(link, 'type')) fail('invalid_contribution', 400);
      validateLink(link, {imported: true});
    }
    return {batch, expectedRevision: args.expectedRevision};
  } catch (error) {
    if (error instanceof AtlasContributionError) throw error;
    fail('invalid_contribution', 400);
  }
}

function storageFor(env) {
  if (!env || !env.DB || !env.BUCKET || typeof env.DB.prepare !== 'function' || typeof env.DB.batch !== 'function'
      || typeof env.BUCKET.get !== 'function' || typeof env.BUCKET.head !== 'function' || typeof env.BUCKET.put !== 'function') fail('cloud_library_unavailable');
  return new LibraryStorage(env.DB, env.BUCKET, 'owner');
}

async function currentRevision(storage) {
  const revision = await storage.head();
  if (!validRevision(revision)) fail('cloud_library_invalid');
  return revision;
}

async function capsuleForCommit(storage, commit, {allowConflict = false} = {}) {
  if (!object(commit) || !validRevision(commit.id) || !commit.id || commit.library_id !== 'owner'
      || !['accepted', ...(allowConflict ? ['conflict'] : [])].includes(commit.status) || !validTimestamp(commit.created_at)
      || typeof commit.manifest !== 'string' || commit.manifest.length > MAX_MANIFEST_BYTES
      || encoder.encode(commit.manifest).byteLength > MAX_MANIFEST_BYTES) fail('cloud_library_invalid');
  let manifest;
  try {manifest = validateManifest(JSON.parse(commit.manifest));} catch {fail('cloud_library_invalid');}
  if (manifest.bytes > CLOUD_CONTRIBUTION_LIMITS.snapshotBytes) fail('cloud_snapshot_too_large', 413);
  return decodeCapsule(storage, manifest);
}

async function decodeCapsule(storage, manifest) {
  const bytes = new Uint8Array(manifest.bytes);
  let offset = 0;
  for (const chunk of manifest.chunks) {
    const blob = await storage.blob(chunk.sha256);
    if (!blob || blob.size !== chunk.bytes || !blob.body || typeof blob.body.getReader !== 'function') fail('cloud_library_invalid');
    const reader = blob.body.getReader(), part = new Uint8Array(chunk.bytes);
    let length = 0;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        if (!(next.value instanceof Uint8Array) || length + next.value.byteLength > part.byteLength) fail('cloud_library_invalid');
        part.set(next.value, length); length += next.value.byteLength;
      }
    } finally {await reader.cancel().catch(() => {}); reader.releaseLock();}
    if (length !== chunk.bytes || await sha256(part) !== chunk.sha256) fail('cloud_library_invalid');
    bytes.set(part, offset); offset += part.byteLength;
  }
  if (offset !== manifest.bytes || await sha256(bytes) !== manifest.sha256) fail('cloud_library_invalid');
  try {
    const capsule = validateCapsule(JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes)));
    validateCurrent(capsule);
    return capsule;
  } catch (error) {
    if (error instanceof AtlasContributionError) throw error;
    fail('cloud_library_invalid');
  }
}

function validateCurrent(capsule) {
  const archive = capsule.archive;
  if (Object.values(archive).some(value => Array.isArray(value) && value.length > 100_000)) fail('cloud_library_invalid');
  const shards = new Map(), links = new Set(), identities = new Set();
  for (const record of archive.shards) {
    const shard = validateShard(record, {imported: true});
    if (shards.has(shard.id)) fail('cloud_library_invalid');
    shards.set(shard.id, {codeSolution: {approaches: shard.codeSolution.approaches.map(approach => ({id: approach.id}))}});
  }
  for (const record of archive.links) {
    const link = validateLink(record, {imported: true}), key = linkKey(link);
    if (links.has(link.id) || identities.has(key)) fail('cloud_library_invalid');
    links.add(link.id); identities.add(key); validateLinkEndpoints(link, shards);
  }
  const receipts = own(capsule, 'contributionReceipts') ? capsule.contributionReceipts : [];
  if (!Array.isArray(receipts) || receipts.length > INBOX_LIMITS.receipts || encoder.encode(JSON.stringify(receipts)).byteLength > INBOX_LIMITS.receiptBytes) fail('cloud_library_invalid');
  const requests = new Set();
  for (const entry of receipts) {
    if (!object(entry) || typeof entry.requestId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$/.test(entry.requestId)
        || requests.has(entry.requestId) || typeof entry.fingerprint !== 'string' || !HASH_PATTERN.test(entry.fingerprint)
        || !object(entry.receipt) || entry.receipt.requestId !== entry.requestId
        || !Array.isArray(entry.receipt.shards) || !Array.isArray(entry.receipt.links)) fail('cloud_library_invalid');
    for (const record of [...entry.receipt.shards, ...entry.receipt.links]) recordId(record?.id);
    requests.add(entry.requestId);
  }
}

const emptyCapsule = () => ({format: 'shard-atlas-library', version: 1,
  archive: {schemaVersion: 1, shards: [], links: [], reviews: [], boards: [], assets: [], revisions: [], trash: []}, contributionReceipts: []});

async function loadCurrent(storage) {
  const revision = await currentRevision(storage);
  const commit = revision ? await storage.commit(revision) : null;
  if (revision && commit?.id !== revision) fail('cloud_library_invalid');
  const capsule = revision ? await capsuleForCommit(storage, commit) : emptyCapsule();
  if (await currentRevision(storage) !== revision) fail('cloud_library_changed', 409);
  return {revision, capsule};
}

// Remap explicit note links in explanation fields while preserving literal code,
// including tilde fences, long backtick fences, inline code, and exact newlines.
function remapText(text, aliases) {
  let fence = null, inline = 0;
  return text.replace(/[^\r\n]+|\r\n|[\r\n]/g, line => {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (fence) {
      if (marker && marker[1][0] === fence.character && marker[1].length >= fence.length && !marker[2].trim()) fence = null;
      return line;
    }
    if (marker) {fence = {character: marker[1][0], length: marker[1].length}; return line;}
    if (/^(?: {4}|\t)/.test(line)) return line;
    return line.replace(/\\.|`+|\[\[id:([A-Za-z0-9][A-Za-z0-9_.:-]{0,99})(?=[|\]])/g, (whole, id) => {
      if (whole[0] === '\\') return whole;
      if (whole[0] === '`') {if (!inline) inline = whole.length; else if (inline === whole.length) inline = 0; return whole;}
      return !inline && aliases.has(id) ? '[[id:' + aliases.get(id) : whole;
    });
  });
}

function remapValue(value, aliases) {
  if (typeof value === 'string') return remapText(value, aliases);
  if (Array.isArray(value)) return value.map(item => remapValue(item, aliases));
  if (object(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, key === 'shardId' && typeof item === 'string' ? aliases.get(item) ?? item : remapValue(item, aliases)]));
  return value;
}

function remapShard(shard, aliases) {
  const result = {...shard};
  for (const field of ['content', 'perspectives', 'walkthroughs', 'comparisons', 'learningLog', 'verification']) if (own(shard, field)) result[field] = remapValue(shard[field], aliases);
  result.codeSolution = {...shard.codeSolution};
  for (const field of ['purpose', 'complexityNotes', 'assumptions', 'pitfalls']) result.codeSolution[field] = remapValue(shard.codeSolution[field], aliases);
  result.codeSolution.approaches = shard.codeSolution.approaches.map(approach => {
    const result = {...approach};
    for (const field of ['summary', 'complexityNotes', 'assumptions', 'pitfalls']) result[field] = remapValue(approach[field], aliases);
    return result;
  });
  return result;
}

function planAddition(capsule, batch, {stamp, acceptedRevision}) {
  const shards = new Map(capsule.archive.shards.map(record => [record.id, record]));
  const links = new Map(capsule.archive.links.map(record => [record.id, record]));
  const duplicates = new Map(capsule.archive.shards.map(record => [contentKey(record), record]));
  const tags = new Map(capsule.archive.shards.flatMap(record => record.tags ?? []).map(tag => [lower(tag), tag]));
  const deleted = new Set();
  for (const item of capsule.archive.trash) {
    if (!object(item) || !object(item.shard)) fail('cloud_library_invalid');
    try {deleted.add(recordId(item.shard.id));} catch {fail('cloud_library_invalid');}
  }
  let addedShards = [];
  const addedLinks = [], shardReceipts = [], linkReceipts = [], idMap = new Map();
  try {
    for (const data of batch.shards) {
      const values = {...copy(data), tags: [...new Set(data.tags.map(tag => {
        const value = tag.trim(), key = lower(value);
        if (!tags.has(key)) tags.set(key, value);
        return tags.get(key);
      }))], createdAt: stamp, updatedAt: stamp};
      const shard = validateShard(values, {imported: true});
      let current = shards.get(shard.id), reason;
      if (current) {
        if (current.title !== shard.title || current.content !== shard.content || fingerprint(validateCodeSolution(current.codeSolution ?? {})) !== fingerprint(shard.codeSolution)) fail('contribution_conflict', 409);
        reason = 'id_exists';
      } else if (deleted.has(shard.id)) fail('contribution_conflict', 409);
      else if (duplicates.has(contentKey(shard))) {current = duplicates.get(contentKey(shard)); reason = 'content_duplicate';}
      if (!current) {current = shard; addedShards.push(shard); shards.set(shard.id, shard); duplicates.set(contentKey(shard), shard);}
      idMap.set(shard.id, current.id);
      shardReceipts.push({inputId: shard.id, id: current.id, title: current.title, outcome: reason ? 'existing' : 'added', ...(reason ? {reason} : {})});
    }
    const aliases = new Map([...idMap].filter(([from, to]) => from !== to));
    addedShards = addedShards.map(shard => remapShard(shard, aliases));
    for (const shard of addedShards) shards.set(shard.id, shard);
    const semantics = new Map(capsule.archive.links.map(link => [linkKey(link), link]));
    for (const data of batch.links) {
      const link = canonicalLink(validateLink({...data, fromId: idMap.get(data.fromId) ?? data.fromId,
        toId: idMap.get(data.toId) ?? data.toId, createdAt: stamp}, {imported: true}));
      validateLinkEndpoints(link, shards);
      let current = links.get(link.id), reason;
      if (current) {
        if (linkFields.some(field => (current[field] ?? '') !== (link[field] ?? ''))) fail('contribution_conflict', 409);
        reason = 'id_exists';
      } else if (semantics.has(linkKey(link))) {current = semantics.get(linkKey(link)); reason = 'relationship_exists';}
      if (!current) {current = link; addedLinks.push(link); links.set(link.id, link); semantics.set(linkKey(link), link);}
      linkReceipts.push({inputId: link.id, id: current.id, fromId: current.fromId, toId: current.toId, type: current.type,
        fromApproachId: current.fromApproachId || '', toApproachId: current.toApproachId || '', outcome: reason ? 'existing' : 'added', ...(reason ? {reason} : {})});
    }
  } catch (error) {
    if (error instanceof AtlasContributionError) throw error;
    fail('contribution_conflict', 409);
  }
  const savedRecords = [...shardReceipts.map(record => ({kind: 'shards', id: record.id, fingerprint: fingerprint(shards.get(record.id))})),
    ...linkReceipts.map(record => ({kind: 'links', id: record.id, fingerprint: fingerprint(links.get(record.id))}))];
  const receipt = {requestId: batch.requestId, createdAt: stamp, replayed: false, verified: true, currentContentMatches: true,
    added: {shards: addedShards.length, links: addedLinks.length}, skipped: {shards: batch.shards.length - addedShards.length, links: batch.links.length - addedLinks.length},
    shards: shardReceipts, links: linkReceipts, idMap: Object.fromEntries(idMap), acceptedRevision,
    presentShardIds: shardReceipts.map(record => record.id), missingShardIds: []};
  const entry = {requestId: batch.requestId, fingerprint: fingerprint(batch), receipt, savedRecords};
  const receipts = capsule.contributionReceipts ?? [];
  if (receipts.length >= INBOX_LIMITS.receipts || encoder.encode(JSON.stringify([...receipts, entry])).byteLength > INBOX_LIMITS.receiptBytes) fail('cloud_snapshot_too_large', 413);
  return {...capsule, archive: {...capsule.archive, shards: [...capsule.archive.shards, ...addedShards], links: [...capsule.archive.links, ...addedLinks],
    revisions: [...capsule.archive.revisions, ...addedShards.map(shard => ({id: crypto.randomUUID(), shardId: shard.id, createdAt: stamp, reason: 'ai-contribution', snapshot: shard}))]},
  contributionReceipts: [...receipts, entry]};
}

function matchingEntry(capsule, batch) {
  const entry = (capsule.contributionReceipts ?? []).find(item => item.requestId === batch.requestId);
  if (entry && entry.fingerprint !== fingerprint(batch)) fail('request_id_reused', 409);
  if (entry) validateReceipt(entry, batch);
  return entry;
}

function validateReceipt(entry, batch) {
  try {checkedReceipt(entry, batch);} catch (error) {
    if (error instanceof AtlasContributionError) throw error;
    fail('cloud_library_invalid');
  }
}

function checkedReceipt(entry, batch) {
  const receipt = entry.receipt;
  if (!object(receipt) || receipt.requestId !== batch.requestId || !validTimestamp(receipt.createdAt)
      || !object(receipt.idMap) || !object(receipt.added) || !object(receipt.skipped)
      || receipt.shards.length !== batch.shards.length || receipt.links.length !== batch.links.length) fail('cloud_library_invalid');
  for (const [kind, inputs] of [['shards', batch.shards], ['links', batch.links]]) {
    const seen = new Set(), ids = new Set(inputs.map(item => item.id));
    if (!Number.isSafeInteger(receipt.added[kind]) || receipt.added[kind] < 0 || !Number.isSafeInteger(receipt.skipped[kind])
        || receipt.skipped[kind] < 0 || receipt.added[kind] + receipt.skipped[kind] !== inputs.length) fail('cloud_library_invalid');
    for (const record of receipt[kind]) {
      if (!object(record) || !ids.has(record.inputId) || seen.has(record.inputId) || !['added', 'existing'].includes(record.outcome)) fail('cloud_library_invalid');
      recordId(record.id); seen.add(record.inputId);
      if (record.reason && !['id_exists', 'content_duplicate', 'relationship_exists'].includes(record.reason)) fail('cloud_library_invalid');
      if (kind === 'shards' && (receipt.idMap[record.inputId] !== record.id || typeof record.title !== 'string' || record.title.length > 480 || [...record.title].length > 240)) fail('cloud_library_invalid');
      if (kind === 'links') {
        recordId(record.fromId); recordId(record.toId);
        if (typeof record.type !== 'string' || record.type.length > 40) fail('cloud_library_invalid');
        validateLink({...record, note: '', createdAt: receipt.createdAt}, {imported: true});
      }
    }
  }
}

function verifyLegacyReceipt(receipt, batch, shards, links, changedShardIds, changedLinkIds) {
  const proposedShards = new Map(batch.shards.map(record => [record.id, record]));
  const proposedLinks = new Map(batch.links.map(record => [record.id, record]));
  const aliases = new Map(Object.entries(receipt.idMap).filter(([from, to]) => from !== to));
  const ignored = new Set(['id', 'createdAt', 'updatedAt', 'reviewCount', 'lastReviewedAt', 'nextReviewAt', 'prompt', 'tags']);
  try {
    for (const entry of receipt.shards) {
      const saved = shards.get(entry.id);
      if (!saved) continue;
      let expected = validateShard({...proposedShards.get(entry.inputId), createdAt: receipt.createdAt, updatedAt: receipt.createdAt}, {imported: true});
      if (entry.outcome === 'added') expected = remapShard(expected, aliases);
      const current = validateShard(saved, {imported: true});
      let matches = contentKey(current) === contentKey(expected);
      if (entry.outcome === 'added') {
        matches &&= Object.keys(expected).filter(key => !ignored.has(key)).every(key => fingerprint(current[key]) === fingerprint(expected[key]));
        matches &&= fingerprint([...new Set(current.tags.map(lower))].sort()) === fingerprint([...new Set(expected.tags.map(tag => lower(tag.trim())))].sort());
      }
      if (!matches) changedShardIds.push(entry.id);
    }
    for (const entry of receipt.links) {
      const saved = links.get(entry.id);
      if (!saved) continue;
      const proposed = proposedLinks.get(entry.inputId);
      const expected = validateLink({...proposed, fromId: receipt.idMap[proposed.fromId] ?? proposed.fromId,
        toId: receipt.idMap[proposed.toId] ?? proposed.toId, createdAt: receipt.createdAt}, {imported: true});
      const current = validateLink(saved, {imported: true});
      const fields = entry.outcome === 'added' ? linkFields : ['fromId', 'toId', 'type', 'fromApproachId', 'toApproachId'];
      if (fields.some(field => (current[field] ?? '') !== (expected[field] ?? ''))
          || ['fromId', 'toId', 'type', 'fromApproachId', 'toApproachId'].some(field => (entry[field] ?? '') !== (expected[field] ?? ''))) changedLinkIds.push(entry.id);
    }
  } catch {fail('cloud_library_invalid');}
}

function currentReceipt(entry, batch, current, {acceptedRevision = null, replayed = true} = {}) {
  validateReceipt(entry, batch);
  const shards = new Map(current.capsule.archive.shards.map(record => [record.id, record]));
  const links = new Map(current.capsule.archive.links.map(record => [record.id, record]));
  const receipt = entry.receipt;
  const missingShardIds = receipt.shards.filter(record => !shards.has(record.id)).map(record => record.id);
  const missingLinkIds = receipt.links.filter(record => !links.has(record.id)).map(record => record.id);
  const changedShardIds = [], changedLinkIds = [];
  if (Array.isArray(entry.savedRecords)) {
    const expected = new Map();
    for (const kind of ['shards', 'links']) for (const record of receipt[kind]) {
      const key = kind + ':' + record.id; expected.set(key, (expected.get(key) || 0) + 1);
    }
    for (const record of entry.savedRecords) {
      if (!object(record) || !['shards', 'links'].includes(record.kind) || !HASH_PATTERN.test(record.fingerprint || '')) fail('cloud_library_invalid');
      const key = record.kind + ':' + record.id;
      if (!(expected.get(key) > 0)) fail('cloud_library_invalid');
      expected.set(key, expected.get(key) - 1);
      const saved = (record.kind === 'shards' ? shards : links).get(record.id);
      if (saved && fingerprint(saved) !== record.fingerprint) (record.kind === 'shards' ? changedShardIds : changedLinkIds).push(record.id);
    }
    if (entry.savedRecords.length !== receipt.shards.length + receipt.links.length || [...expected.values()].some(count => count !== 0)) fail('cloud_library_invalid');
  } else verifyLegacyReceipt(receipt, batch, shards, links, changedShardIds, changedLinkIds);
  const matches = !missingShardIds.length && !missingLinkIds.length && !changedShardIds.length && !changedLinkIds.length;
  return {requestId: batch.requestId, replayed, verified: matches, currentContentMatches: matches, originalSaveVerified: receipt.verified === true,
    createdAt: receipt.createdAt, acceptedRevision: acceptedRevision ?? (validRevision(receipt.acceptedRevision) ? receipt.acceptedRevision : null), currentRevision: current.revision,
    added: {shards: receipt.added.shards, links: receipt.added.links}, skipped: {shards: receipt.skipped.shards, links: receipt.skipped.links}, shards: receipt.shards.map(record => ({inputId: record.inputId, id: record.id, title: record.title, outcome: record.outcome, ...(record.reason ? {reason: record.reason} : {})})),
    links: receipt.links.map(record => ({inputId: record.inputId, id: record.id, fromId: record.fromId, toId: record.toId, type: record.type,
      fromApproachId: record.fromApproachId || '', toApproachId: record.toApproachId || '', outcome: record.outcome, ...(record.reason ? {reason: record.reason} : {})})),
    idMap: Object.fromEntries(receipt.shards.map(record => [record.inputId, record.id])), presentShardIds: receipt.shards.filter(record => shards.has(record.id)).map(record => record.id),
    missingShardIds, missingLinkIds, changedShardIds, changedLinkIds,
    ...(!matches ? {warnings: ['This request was saved previously. Later changes or deletions were preserved; no notes were added again.']} : {})};
}

async function priorReceipt(storage, row, batch) {
  const capsule = await capsuleForCommit(storage, row, {allowConflict: true});
  const entry = matchingEntry(capsule, batch);
  if (!entry) fail('cloud_library_invalid');
  if (row.status === 'conflict') fail('request_conflicted', 409);
  const observed = {revision: row.id, capsule: {archive: {shards: capsule.archive.shards, links: capsule.archive.links}}};
  if (!currentReceipt(entry, batch, observed).currentContentMatches) fail('cloud_library_invalid');
  // Only the small receipt escapes this function; historical images and recovery
  // payloads can be released before loading a newer current cloud revision.
  return {entry, observed};
}

async function finishAccepted(storage, row, batch, replayed) {
  const prior = await priorReceipt(storage, row, batch);
  let current;
  if (await currentRevision(storage) === row.id && await currentRevision(storage) === row.id) current = prior.observed;
  else current = await loadCurrent(storage);
  return currentReceipt(prior.entry, batch, current, {acceptedRevision: row.id, replayed});
}

async function prepareCloudSnapshot(capsule, baseRevision, mutationId) {
  validateCapsule(capsule);
  // A hosted request needs no durable device outbox. Serialize once and retain
  // subarray views into one bounded buffer instead of duplicating every chunk.
  const bytes = encoder.encode(JSON.stringify(capsule));
  if (bytes.byteLength > CLOUD_CONTRIBUTION_LIMITS.snapshotBytes) fail('cloud_snapshot_too_large', 413);
  const chunks = [];
  for (let offset = 0; offset < bytes.byteLength; offset += CHUNK_BYTES) {
    const data = bytes.subarray(offset, Math.min(offset + CHUNK_BYTES, bytes.byteLength));
    chunks.push({sha256: await sha256(data), bytes: data.byteLength, data});
  }
  return {mutationId, baseRevision, chunks, manifest: {protocolVersion: PROTOCOL_VERSION, archiveVersion: ARCHIVE_VERSION,
    format: 'shard-atlas-library-json', sha256: await sha256(bytes), bytes: bytes.byteLength,
    chunks: chunks.map(({sha256, bytes}) => ({sha256, bytes}))}};
}

async function publishAddition(storage, current, batch, mutationId, onAttempt) {
  const id = crypto.randomUUID(), stamp = new Date().toISOString();
  const next = planAddition(current.capsule, batch, {stamp, acceptedRevision: id});
  const pending = await prepareCloudSnapshot(next, current.revision, mutationId);
  for (let index = 0; index < pending.chunks.length; index++) {
    const chunk = pending.chunks[index], expected = pending.manifest.chunks[index];
    if (chunk.data.byteLength > CHUNK_BYTES || chunk.data.byteLength !== expected.bytes || await sha256(chunk.data) !== expected.sha256) fail('cloud_library_invalid');
    let stored = await storage.blobInfo(chunk.sha256);
    if (!stored) {await storage.putBlob(chunk.sha256, chunk.data); stored = await storage.blobInfo(chunk.sha256);}
    if (!stored || stored.size !== expected.bytes) fail('cloud_library_unavailable');
  }
  const commitFingerprint = await sha256(encoder.encode(JSON.stringify({baseRevision: current.revision, manifest: pending.manifest})));
  onAttempt();
  const row = await storage.publish({id, mutationId, baseRevision: current.revision, fingerprint: commitFingerprint, manifest: pending.manifest, createdAt: stamp});
  if (!row || row.mutation_id !== mutationId) fail('save_outcome_unknown');
  return {row, replayed: row.id !== id};
}

async function serialized(storage, operation) {
  let buckets = queues.get(storage.database);
  if (!buckets) {buckets = new WeakMap(); queues.set(storage.database, buckets);}
  let state = buckets.get(storage.bucket);
  if (!state) {state = {tail: Promise.resolve(), count: 0}; buckets.set(storage.bucket, state);}
  // Full capsules are decoded one at a time per binding pair. Bounded waiting
  // also prevents queued request bodies from becoming an unbounded memory sink.
  if (state.count >= 4) fail('cloud_busy', 429);
  state.count++;
  const result = state.tail.then(operation);
  state.tail = result.catch(() => {});
  try {return await result;} finally {state.count--;}
}

async function contribute(storage, {batch, expectedRevision}) {
  let publicationAttempted = false;
  try {
    const mutationId = 'mcp-add-' + await sha256(encoder.encode(batch.requestId));
    const previous = await storage.receipt(mutationId);
    if (previous) {
      publicationAttempted = previous.status === 'accepted';
      return await finishAccepted(storage, previous, batch, true);
    }
    let current = await loadCurrent(storage);
    const existing = matchingEntry(current.capsule, batch);
    if (existing) return currentReceipt(existing, batch, current);
    if (current.revision !== expectedRevision) fail('cloud_library_changed', 409);
    const published = await publishAddition(storage, current, batch, mutationId, () => {publicationAttempted = true;});
    current = null;
    if (published.row.status === 'conflict') {await priorReceipt(storage, published.row, batch); fail('request_conflicted', 409);}
    return await finishAccepted(storage, published.row, batch, published.replayed);
  } catch (error) {
    if (error instanceof AtlasContributionError) {
      if (publicationAttempted && !['request_id_reused', 'request_conflicted'].includes(error.code)) fail('save_outcome_unknown');
      throw error;
    }
    fail(publicationAttempted ? 'save_outcome_unknown' : 'cloud_library_unavailable');
  }
}

export async function contributeCloudKnowledge(env, args) {
  const validated = validateCloudContributionArguments(args);
  let storage;
  try {storage = storageFor(env);} catch (error) {
    if (error instanceof AtlasContributionError) throw error;
    fail('cloud_library_unavailable');
  }
  return serialized(storage, () => contribute(storage, validated));
}
