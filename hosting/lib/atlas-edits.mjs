import {AtlasContributionError, cloudMutationTransport as transport, withCloudMutationStorage} from './atlas-contributions.mjs';
import {HASH_PATTERN, ID_PATTERN, sha256} from '../../sync/protocol.mjs';
import {copy, linkKey, recordId, validateLink, validateLinkEndpoints, validateShard} from '../../web/model.mjs';
import {fingerprint} from '../../web/archives.mjs';
import {INBOX_LIMITS} from '../../web/inbox.mjs';
import {validateImageAttachments, attachImagesToContent, prepareImageAttachments, validateImageReceipt, compareImageReceiptAssets} from './cloud-image-attachments.mjs';

export const CLOUD_EDIT_LIMITS = Object.freeze({batchBytes: 256 * 1024, shards: 20, links: 100, snapshotBytes: 16 * 1024 * 1024});
const messages = Object.freeze({
  invalid_edit: 'Use an edits-only batch with existing stable IDs, nonempty changes, at most 20 notes and 100 relationships, and the checked cloud revision.',
  edit_too_large: 'This edit exceeds the 256 KiB batch limit. Split genuinely separate edits into reviewed requests.',
  cloud_snapshot_too_large: 'This edit exceeds the hosted snapshot or receipt capacity. Use the Shard Atlas app to review this edit; library synchronization is unaffected.',
  cloud_library_invalid: 'The complete cloud library or edit receipt could not be verified. Existing knowledge was preserved.',
  cloud_library_unavailable: 'The cloud edit could not finish. Retry the exact same request ID and batch when the connection is available.',
  cloud_library_changed: 'The shared library changed. Read the current records and review the unchanged edit before retrying its request ID with the checked revision.',
  edit_conflict: 'An edited record is missing or would conflict with saved relationships or solution approaches. Read the current records and review the edit; existing knowledge was preserved.',
  request_id_reused: 'This request ID already belongs to different content or another operation. Preserve the original request; use a new request only for a genuinely new reviewed edit.',
  request_conflicted: 'This edit was not accepted because another cloud change won. Refresh and review the library before preparing a new request; never invent retry IDs automatically.',
  save_outcome_unknown: 'The edit may have been saved, but its current result could not be verified. Retry the exact same request ID and batch; do not create a new request.',
  cloud_busy: 'Another cloud save is being checked. Retry the exact same request ID and batch shortly; do not create a new request.',
  image_attachment_invalid: 'An image attachment is invalid. Check its explicit shard target, verified upload ID, caption, and placement. Existing knowledge was preserved.',
  image_upload_unavailable: 'An image upload is unavailable, expired, or belongs to a different owner. Re-upload the same original image and review this save. Existing knowledge was preserved.',
});
export class AtlasEditError extends Error {
  constructor(code, status = 503) {
    const known = Object.hasOwn(messages, code) ? code : 'cloud_library_unavailable';
    super(messages[known]); this.name = 'AtlasEditError'; this.code = known; this.status = status;
  }
}
const fail = (code, status) => {throw new AtlasEditError(code, status);};
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const encoder = new TextEncoder();
const bytes = value => encoder.encode(JSON.stringify(value)).byteLength;
const validRevision = value => typeof value === 'string' && (value === '' || ID_PATTERN.test(value));
const validStamp = value => typeof value === 'string' && value.length <= 64 && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value));
const forbidden = new Set(['__proto__', 'prototype', 'constructor']);
const shardFields = new Set(['title', 'content', 'prompt', 'tags', 'kind', 'status', 'sourceUrl', 'languageVersion', 'eventDate',
  'evidenceStatus', 'sources', 'publicationDate', 'verifiedDate', 'eventType', 'entities', 'entityType', 'inbox', 'facts',
  'subjects', 'courses', 'notation', 'assumptions', 'perspectives', 'walkthroughs', 'comparisons', 'learningLog', 'verification', 'experiments', 'codeSolution']);
const linkFields = new Set(['fromId', 'toId', 'type', 'note', 'scope', 'evidence', 'sourceUrl', 'sourceLocation', 'fromApproachId', 'toApproachId']);
const codeFields = new Set(['role', 'aliases', 'purpose', 'code', 'headers', 'timeComplexity', 'spaceComplexity', 'complexityNotes', 'assumptions', 'pitfalls', 'approaches']);
const approachFields = new Set(['id', 'title', 'summary', 'code', 'headers', 'timeComplexity', 'spaceComplexity', 'complexityNotes', 'assumptions', 'pitfalls']);
const sourceFields = new Set(['url', 'title', 'publishedDate', 'accessedDate', 'note']);
const factFields = new Set(['label', 'value', 'unit', 'sourceUrl', 'asOf']);
const linkTypes = new Set(['depends_on', 'explains', 'contrasts_with', 'example_of', 'related_to', 'part_of', 'supports', 'contradicts', 'supersedes', 'released_by', 'uses', 'implements', 'alternative_to']);
function exact(value, fields) {
  if (!object(value) || Object.keys(value).some(key => !fields.has(key))) fail('invalid_edit', 400);
}
function finite(value, depth = 0, allowedEmpty = new WeakSet()) {
  if (depth > 64 || value === null) fail('invalid_edit', 400);
  if (['string', 'boolean'].includes(typeof value) || typeof value === 'number' && Number.isFinite(value)) return;
  if (!object(value) && !Array.isArray(value)) fail('invalid_edit', 400);
  if (object(value) && !Object.keys(value).length && !allowedEmpty.has(value)) fail('invalid_edit', 400);
  for (const [key, item] of Object.entries(value)) {
    if (forbidden.has(key)) fail('invalid_edit', 400);
    finite(item, depth + 1, allowedEmpty);
  }
}
function shardPatch(changes) {
  exact(changes, shardFields);
  if (own(changes, 'codeSolution')) {
    exact(changes.codeSolution, codeFields);
    if (own(changes.codeSolution, 'approaches')) {
      const approaches = changes.codeSolution.approaches;
      if (!Array.isArray(approaches) || approaches.length > 100) fail('invalid_edit', 400);
      const ids = new Set();
      for (const item of approaches) {
        exact(item, approachFields); recordId(item.id);
        if (ids.has(item.id)) fail('invalid_edit', 400);
        ids.add(item.id);
      }
    }
  }
  for (const [key, fields] of [['sources', sourceFields], ['facts', factFields]]) if (own(changes, key)) {
    if (!Array.isArray(changes[key])) fail('invalid_edit', 400);
    for (const item of changes[key]) exact(item, fields);
  }
}

export function validateCloudEditArguments(args) {
  try {
    exact(args, new Set(['batch', 'expectedRevision']));
    if (!own(args, 'batch') || !own(args, 'expectedRevision') || !validRevision(args.expectedRevision)) fail('invalid_edit', 400);
    const batch = args.batch;
    exact(batch, new Set(['requestId', 'shards', 'links', 'images']));
    if (!['requestId', 'shards', 'links'].every(key => own(batch, key))) fail('invalid_edit', 400);
    if (!Array.isArray(batch.shards) || !Array.isArray(batch.links)) fail('invalid_edit', 400);
    if (own(batch, 'images')) validateImageAttachments(batch.images, batch.shards.map(shard => shard?.id));
    const imageTargets = new Set((batch.images ?? []).map(image => image.shardId)), allowedEmpty = new WeakSet();
    for (const shard of batch.shards) if (imageTargets.has(shard?.id) && object(shard.changes)) allowedEmpty.add(shard.changes);
    finite(batch, 0, allowedEmpty); recordId(batch.requestId, 'requestId');
    if (bytes(batch) > CLOUD_EDIT_LIMITS.batchBytes) fail('edit_too_large', 413);
    for (const [kind, fields] of [['shards', shardFields], ['links', linkFields]]) {
      if (!Array.isArray(batch[kind]) || batch[kind].length > CLOUD_EDIT_LIMITS[kind]) fail('invalid_edit', 400);
      const ids = new Set();
      for (const entry of batch[kind]) {
        exact(entry, new Set(['id', 'changes'])); recordId(entry.id);
        exact(entry.changes, fields);
        if (!Object.keys(entry.changes).length && !(kind === 'shards' && imageTargets.has(entry.id)) || ids.has(entry.id)) fail('invalid_edit', 400);
        ids.add(entry.id);
        if (kind === 'shards') {
          shardPatch(entry.changes);
          const current = validateShard({id: entry.id, title: 'Edit validation', content: '', tags: [],
            createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z'}, {imported: true});
          // Sparse patches may rely on existing cross-field context. Provide
          // possible valid context here; validate the actual merge after load.
          current.verification = {status: 'unverified', note: 'Existing verification', sourceUrl: 'https://example.invalid', sourceLocation: 'Existing', checkedAt: ''};
          current.codeSolution.approaches = (entry.changes.codeSolution?.approaches || []).map(item => ({id: item.id, title: 'Existing approach', code: 'existing'}));
          validateShard(merge(current, entry.changes), {imported: true});
        } else {
          const used = new Set([entry.changes.fromId, entry.changes.toId]);
          const placeholder = prefix => {while (used.has(prefix)) prefix += '_'; used.add(prefix); return prefix;};
          validateLink({id: entry.id, fromId: placeholder('edit_validation_from'), toId: placeholder('edit_validation_to'),
            type: 'alternative_to', fromApproachId: 'existing_from_approach', toApproachId: 'existing_to_approach',
            createdAt: '2026-01-01T00:00:00.000Z', ...entry.changes}, {imported: true});
        }
      }
    }
    if (!batch.shards.length && !batch.links.length) fail('invalid_edit', 400);
    return {batch, expectedRevision: args.expectedRevision};
  } catch (error) {
    if (error instanceof AtlasEditError) throw error;
    fail('invalid_edit', 400);
  }
}

function merge(current, patch, path = '') {
  const result = {...(object(current) ? current : {})};
  for (const [key, value] of Object.entries(patch)) {
    const nextPath = path ? path + '.' + key : key;
    if (nextPath === 'codeSolution.approaches') {
      const prior = Array.isArray(current?.[key]) ? current[key] : [], byId = new Map(prior.map(item => [item.id, item]));
      const changes = new Map(value.map(item => [item.id, item]));
      for (const item of value) if (!byId.has(item.id) && (typeof item.title !== 'string' || !item.title.trim() || typeof item.code !== 'string' || !item.code.trim())) fail('invalid_edit', 400);
      result[key] = prior.map(item => changes.has(item.id) ? merge(item, changes.get(item.id), nextPath + '[]') : item);
      result[key].push(...value.filter(item => !byId.has(item.id)).map(item => copy(item)));
    } else result[key] = object(value) ? merge(current?.[key], value, nextPath) : copy(value);
  }
  return result;
}

// Use the common validator's normalization only for explicitly edited fields.
// Existing optional omissions and unknown extensions are never filled or erased.
function normalizedChanges(current, patch, normalized, path = '') {
  const result = {...(object(current) ? current : {})};
  for (const [key, value] of Object.entries(patch)) {
    const nextPath = path ? path + '.' + key : key;
    if (nextPath === 'codeSolution.approaches') {
      const prior = Array.isArray(current?.[key]) ? current[key] : [], byId = new Map(prior.map(item => [item.id, item]));
      const changes = new Map(value.map(item => [item.id, item])), checked = new Map(normalized[key].map(item => [item.id, item]));
      result[key] = prior.map(item => changes.has(item.id) ? normalizedChanges(item, changes.get(item.id), checked.get(item.id), nextPath + '[]') : item);
      result[key].push(...value.filter(item => !byId.has(item.id)).map(item => copy(checked.get(item.id))));
    } else result[key] = object(value) ? normalizedChanges(current?.[key], value, normalized[key], nextPath) : copy(normalized[key]);
  }
  return result;
}

function editedRecord(kind, current, changes, stamp) {
  const merged = merge(current, changes);
  const checked = kind === 'shards' ? validateShard(merged, {imported: true}) : validateLink(merged, {imported: true});
  const result = normalizedChanges(current, changes, checked);
  if (kind === 'links') {
    const identities = ['fromId', 'toId', 'type', 'fromApproachId', 'toApproachId'];
    const changedIdentity = identities.some(field => own(changes, field) && (merged[field] ?? '') !== (current[field] ?? ''));
    if (changedIdentity) {
      // Canonical orientation moves both endpoints and approach associations as
      // one identity, including a newly needed optional counterpart field.
      for (const field of identities) result[field] = checked[field];
    } else {
      // Editing an explanation must not normalize a valid legacy orientation or
      // fill omitted optional identities, including an identity-only no-op.
      for (const field of identities) if (own(current, field)) result[field] = current[field]; else delete result[field];
    }
  }
  if (fingerprint(result) === fingerprint(current)) return current;
  return kind === 'shards' ? {...result, updatedAt: stamp} : result;
}

function validateFinal(capsule, shards, links) {
  const identities = new Set();
  for (const link of links.values()) {
    validateLinkEndpoints(link, shards);
    const key = linkKey(link);
    if (identities.has(key)) fail('edit_conflict', 409);
    identities.add(key);
  }
  // Trash may still refer to live solution approaches. Preserve those restore
  // paths even though this route never edits or exposes deleted records.
  for (const item of capsule.archive.trash) for (const link of item.links || []) {
    for (const [endpoint, field] of [['fromId', 'fromApproachId'], ['toId', 'toApproachId']]) {
      const shard = shards.get(link[endpoint]);
      if (shard && link[field] && !(shard.codeSolution?.approaches || []).some(approach => approach.id === link[field])) fail('edit_conflict', 409);
    }
  }
}
const batchHash = batch => fingerprint({operation: 'edit', batch});

function imageChanges(kind, current, changes, images) {
  const attachments = kind === 'shards' ? images.filter(image => image.shardId === current.id) : [];
  return attachments.length ? {...changes, content: attachImagesToContent(own(changes, 'content') ? changes.content : current.content, attachments)} : changes;
}

function planEdit(capsule, batch, stamp, acceptedRevision, {images = [], savedAssets = []} = {}) {
  const maps = {shards: new Map(capsule.archive.shards.map(record => [record.id, record])), links: new Map(capsule.archive.links.map(record => [record.id, record]))};
  const entries = {shards: [], links: []}, edited = {shards: 0, links: 0}, unchanged = {shards: 0, links: 0};
  const savedRecords = [], beforeRecords = [], revisions = [], shardRevisions = [];
  try {
    for (const kind of ['shards', 'links']) for (const {id, changes} of batch[kind]) {
      const current = maps[kind].get(id);
      if (!current) fail('edit_conflict', 409);
      const next = editedRecord(kind, current, imageChanges(kind, current, changes, images), stamp), changed = next !== current;
      maps[kind].set(id, next); (changed ? edited : unchanged)[kind]++;
      if (changed) {
        if (kind === 'shards') {
          const beforeRevisionId = crypto.randomUUID(), afterRevisionId = crypto.randomUUID();
          revisions.push({id: beforeRevisionId, shardId: id, createdAt: stamp, reason: 'before ai edit', snapshot: current},
            {id: afterRevisionId, shardId: id, createdAt: stamp, reason: 'ai-edit', snapshot: next});
          shardRevisions.push({id, beforeRevisionId, afterRevisionId});
        } else beforeRecords.push({kind, id, record: current});
      }
      entries[kind].push({inputId: id, id, outcome: changed ? 'edited' : 'unchanged', ...(kind === 'shards' ? {title: next.title} : {
        fromId: next.fromId, toId: next.toId, type: next.type, fromApproachId: next.fromApproachId || '', toApproachId: next.toApproachId || ''})});
      savedRecords.push({kind, id, fingerprint: fingerprint(next)});
    }
    validateFinal(capsule, maps.shards, maps.links);
  } catch (error) {
    if (error instanceof AtlasEditError) throw error;
    if (error?.code === 'invalid_image_attachment') fail('image_attachment_invalid', error.status);
    fail('edit_conflict', 409);
  }
  const receipt = {requestId: batch.requestId, operation: 'edit', createdAt: stamp, replayed: false, verified: true, currentContentMatches: true,
    // Older browser import-history renderers expect this additions count.
    // Zero is truthful: this operation edits records and never adds them.
    added: {shards: 0, links: 0}, edited, unchanged, shards: entries.shards, links: entries.links, shardRevisions, acceptedRevision,
    ...(images.length ? {images} : {})};
  const entry = {requestId: batch.requestId, operation: 'edit', fingerprint: batchHash(batch), receipt, savedRecords, beforeRecords,
    ...(images.length ? {savedAssets} : {})};
  const receipts = [...(capsule.contributionReceipts ?? []), entry];
  if (receipts.length > INBOX_LIMITS.receipts || bytes(receipts) > INBOX_LIMITS.receiptBytes) fail('cloud_snapshot_too_large', 413);
  return {...capsule, archive: {...capsule.archive,
    shards: capsule.archive.shards.map(record => maps.shards.get(record.id)), links: capsule.archive.links.map(record => maps.links.get(record.id)),
    revisions: [...capsule.archive.revisions, ...revisions]}, contributionReceipts: receipts};
}

function matchingEntry(capsule, batch) {
  const entry = (capsule.contributionReceipts ?? []).find(item => item.requestId === batch.requestId);
  if (entry && (entry.operation !== 'edit' || entry.fingerprint !== batchHash(batch))) fail('request_id_reused', 409);
  if (entry) validateReceipt(entry, batch);
  return entry;
}

function validateReceipt(entry, batch) {
  try {validateImageReceipt(entry, batch);} catch {fail('cloud_library_invalid');}
  const receipt = entry.receipt;
  if (entry.operation !== 'edit' || receipt?.operation !== 'edit' || receipt.requestId !== batch.requestId || !validStamp(receipt.createdAt)
      || receipt.verified !== true || !object(receipt.edited) || !object(receipt.unchanged) || !validRevision(receipt.acceptedRevision) || !receipt.acceptedRevision
      || !Array.isArray(entry.savedRecords) || !Array.isArray(entry.beforeRecords) || !Array.isArray(receipt.shardRevisions)) fail('cloud_library_invalid');
  const expected = new Map(), changed = new Set();
  for (const kind of ['shards', 'links']) {
    if (!Array.isArray(receipt[kind]) || receipt[kind].length !== batch[kind].length || !Number.isSafeInteger(receipt.edited[kind]) || receipt.edited[kind] < 0
        || !Number.isSafeInteger(receipt.unchanged[kind]) || receipt.unchanged[kind] < 0 || receipt.edited[kind] + receipt.unchanged[kind] !== batch[kind].length) fail('cloud_library_invalid');
    const ids = new Set(batch[kind].map(item => item.id)); let count = 0;
    for (const record of receipt[kind]) {
      if (!object(record) || record.id !== record.inputId || !ids.delete(record.id) || !['edited', 'unchanged'].includes(record.outcome)) fail('cloud_library_invalid');
      if (kind === 'shards' && (typeof record.title !== 'string' || [...record.title].length > 240)) fail('cloud_library_invalid');
      if (kind === 'links' && (!linkTypes.has(record.type) || !ID_PATTERN.test(record.fromId || '') || !ID_PATTERN.test(record.toId || '')
          || ['fromApproachId', 'toApproachId'].some(field => typeof record[field] !== 'string' || record[field] !== '' && !ID_PATTERN.test(record[field])))) fail('cloud_library_invalid');
      expected.set(kind + ':' + record.id, true);
      if (record.outcome === 'edited') {changed.add(kind + ':' + record.id); count++;}
    }
    if (count !== receipt.edited[kind]) fail('cloud_library_invalid');
  }
  if (entry.savedRecords.length !== expected.size || entry.beforeRecords.length !== receipt.edited.links || receipt.shardRevisions.length !== receipt.edited.shards) fail('cloud_library_invalid');
  const saved = new Set(), before = new Set();
  for (const item of entry.savedRecords) {
    const key = item?.kind + ':' + item?.id;
    if (!object(item) || !expected.has(key) || saved.has(key) || typeof item.fingerprint !== 'string' || !HASH_PATTERN.test(item.fingerprint)) fail('cloud_library_invalid');
    saved.add(key);
  }
  for (const item of entry.beforeRecords) {
    const key = item?.kind + ':' + item?.id;
    if (!object(item) || item.kind !== 'links' || !changed.has(key) || before.has(key) || !object(item.record) || item.record.id !== item.id) fail('cloud_library_invalid');
    before.add(key);
  }
  for (const item of receipt.shardRevisions) {
    const key = 'shards:' + item?.id;
    if (!object(item) || !changed.has(key) || before.has(key) || typeof item.beforeRevisionId !== 'string' || !ID_PATTERN.test(item.beforeRevisionId)
        || typeof item.afterRevisionId !== 'string' || !ID_PATTERN.test(item.afterRevisionId) || item.beforeRevisionId === item.afterRevisionId) fail('cloud_library_invalid');
    before.add(key);
  }
}

function currentReceipt(entry, batch, current, {acceptedRevision, replayed = true, imageCheck = {missingAssetIds: [], changedAssetIds: []}} = {}) {
  validateReceipt(entry, batch);
  const maps = {shards: new Map(current.capsule.archive.shards.map(record => [record.id, record])), links: new Map(current.capsule.archive.links.map(record => [record.id, record]))};
  const missingShardIds = [], missingLinkIds = [], changedShardIds = [], changedLinkIds = [];
  for (const item of entry.savedRecords) {
    const current = maps[item.kind].get(item.id);
    if (!current) (item.kind === 'shards' ? missingShardIds : missingLinkIds).push(item.id);
    else if (fingerprint(current) !== item.fingerprint) (item.kind === 'shards' ? changedShardIds : changedLinkIds).push(item.id);
  }
  const matches = !missingShardIds.length && !missingLinkIds.length && !changedShardIds.length && !changedLinkIds.length && !imageCheck.missingAssetIds.length && !imageCheck.changedAssetIds.length;
  return {requestId: batch.requestId, operation: 'edit', replayed, verified: matches, originalSaveVerified: entry.receipt.verified === true,
    currentContentMatches: matches, createdAt: entry.receipt.createdAt, acceptedRevision: acceptedRevision ?? entry.receipt.acceptedRevision, currentRevision: current.revision,
    edited: {shards: entry.receipt.edited.shards, links: entry.receipt.edited.links}, unchanged: {shards: entry.receipt.unchanged.shards, links: entry.receipt.unchanged.links},
    shards: entry.receipt.shards.map(({inputId, id, outcome, title}) => ({inputId, id, outcome, title})),
    links: entry.receipt.links.map(({inputId, id, outcome, fromId, toId, type, fromApproachId, toApproachId}) => ({inputId, id, outcome, fromId, toId, type, fromApproachId, toApproachId})),
    shardRevisions: entry.receipt.shardRevisions.map(({id, beforeRevisionId, afterRevisionId}) => ({id, beforeRevisionId, afterRevisionId})),
    presentShardIds: entry.receipt.shards.filter(item => maps.shards.has(item.id)).map(item => item.id), missingShardIds, missingLinkIds, changedShardIds, changedLinkIds,
    ...(entry.receipt.images?.length ? {images: entry.receipt.images, ...imageCheck} : {}),
    ...(!matches ? {warnings: ['This edit was saved previously. Later changes or deletions were preserved; the edit was not applied again.']} : {})};
}

async function priorReceipt(storage, row, batch) {
  const capsule = await transport.capsuleForCommit(storage, row, {allowConflict: true});
  const entry = matchingEntry(capsule, batch);
  if (!entry) fail('cloud_library_invalid');
  if (row.status === 'conflict') fail('request_conflicted', 409);
  const imageCheck = await compareImageReceiptAssets(capsule, entry);
  const observed = {revision: row.id, capsule: {archive: {shards: capsule.archive.shards, links: capsule.archive.links}}};
  if (entry.receipt.acceptedRevision !== row.id || !currentReceipt(entry, batch, observed, {imageCheck}).currentContentMatches) fail('cloud_library_invalid');
  const originals = new Map(entry.beforeRecords.map(item => [item.kind + ':' + item.id, item.record]));
  const revisions = new Map(capsule.archive.revisions.filter(object).map(item => [item.id, item]));
  try {
    for (const item of entry.receipt.shardRevisions) {
      const before = revisions.get(item.beforeRevisionId), after = revisions.get(item.afterRevisionId);
      if (before?.shardId !== item.id || before.snapshot?.id !== item.id || after?.shardId !== item.id || after.snapshot?.id !== item.id
          || fingerprint(after.snapshot) !== fingerprint(observed.capsule.archive.shards.find(record => record.id === item.id))) fail('cloud_library_invalid');
      originals.set('shards:' + item.id, before.snapshot);
    }
    for (const kind of ['shards', 'links']) for (const item of batch[kind]) {
      const after = observed.capsule.archive[kind].find(record => record.id === item.id);
      const before = originals.get(kind + ':' + item.id) ?? after;
      if (fingerprint(editedRecord(kind, before, imageChanges(kind, before, item.changes, entry.receipt.images ?? []), entry.receipt.createdAt)) !== fingerprint(after)) fail('cloud_library_invalid');
    }
  } catch {fail('cloud_library_invalid');}
  return {entry, observed, imageCheck};
}

async function finishAccepted(storage, row, batch, replayed) {
  const prior = await priorReceipt(storage, row, batch);
  const current = await transport.currentRevision(storage) === row.id && await transport.currentRevision(storage) === row.id ? prior.observed : await transport.loadCurrent(storage);
  const imageCheck = current === prior.observed ? prior.imageCheck : await compareImageReceiptAssets(current.capsule, prior.entry);
  return currentReceipt(prior.entry, batch, current, {acceptedRevision: row.id, replayed, imageCheck});
}

async function publishEdit(storage, current, batch, mutationId, onAttempt, attachmentState) {
  const id = crypto.randomUUID(), stamp = new Date().toISOString();
  const next = planEdit(attachmentState.capsule, batch, stamp, id, attachmentState);
  const pending = await transport.prepareCloudSnapshot(next, current.revision, mutationId, storage);
  for (const chunk of pending.chunks) {
    let stored = await storage.blobInfo(chunk.sha256);
    if (!stored) {await storage.putBlob(chunk.sha256, chunk.data); stored = await storage.blobInfo(chunk.sha256);}
    if (!stored || stored.size !== chunk.bytes) fail('cloud_library_unavailable');
  }
  const commitFingerprint = await sha256(encoder.encode(JSON.stringify({baseRevision: current.revision, manifest: pending.manifest})));
  onAttempt();
  const row = await storage.publish({id, mutationId, baseRevision: current.revision, fingerprint: commitFingerprint, manifest: pending.manifest, createdAt: stamp});
  if (!row || row.mutation_id !== mutationId) fail('save_outcome_unknown');
  return {row, replayed: row.id !== id};
}

async function edit(storage, {batch, expectedRevision}, env, options) {
  let publicationAttempted = false;
  try {
    const mutationId = 'mcp-edit-' + await sha256(encoder.encode(batch.requestId));
    const previous = await storage.receipt(mutationId);
    if (previous) {
      publicationAttempted = previous.status === 'accepted';
      return await finishAccepted(storage, previous, batch, true);
    }
    if (await storage.receipt('mcp-add-' + await sha256(encoder.encode(batch.requestId)))) fail('request_id_reused', 409);
    let current = await transport.loadCurrent(storage);
    const existing = matchingEntry(current.capsule, batch);
    if (existing) return currentReceipt(existing, batch, current, {imageCheck: await compareImageReceiptAssets(current.capsule, existing)});
    if (current.revision !== expectedRevision) fail('cloud_library_changed', 409);
    let attachmentState;
    try {attachmentState = await prepareImageAttachments(env, current.capsule, batch.images, options.ownerId);}
    catch (error) {fail(error?.code === 'invalid_image_attachment' ? 'image_attachment_invalid' : 'image_upload_unavailable', error?.status || 400);}
    const published = await publishEdit(storage, current, batch, mutationId, () => {publicationAttempted = true;}, attachmentState);
    current = null;
    if (published.row.status === 'conflict') {await priorReceipt(storage, published.row, batch); fail('request_conflicted', 409);}
    return await finishAccepted(storage, published.row, batch, published.replayed);
  } catch (error) {
    if (error instanceof AtlasContributionError) error = new AtlasEditError(error.code, error.status);
    if (error instanceof AtlasEditError) {
      if (publicationAttempted && !['request_id_reused', 'request_conflicted'].includes(error.code)) fail('save_outcome_unknown');
      throw error;
    }
    fail(publicationAttempted ? 'save_outcome_unknown' : 'cloud_library_unavailable');
  }
}

export async function editCloudKnowledge(env, args, options = {}) {
  const validated = validateCloudEditArguments(args);
  try {return await withCloudMutationStorage(env, storage => edit(storage, validated, env, options));}
  catch (error) {
    if (error instanceof AtlasEditError) throw error;
    if (error instanceof AtlasContributionError) throw new AtlasEditError(error.code, error.status);
    fail('cloud_library_unavailable');
  }
}
