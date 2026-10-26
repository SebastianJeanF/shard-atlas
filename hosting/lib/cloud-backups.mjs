// Complete cloud checkpoints are separate from AI note queries and device sync.
// The Site's dispatch gate remains owner-private. Export/upload tickets are
// short-lived headers, never URLs or substitutes for MCP owner authentication.
import {CHUNK_BYTES, MAX_ARCHIVE_BYTES, ID_PATTERN, HASH_PATTERN, SYNC_HEADER, SyncError, readBounded, sha256, validateManifest} from '../../sync/protocol.mjs';
import {LibraryStorage} from '../../sync/storage.mjs';
import {authorizeLibraryRequest} from '../../sync/worker.mjs';

export const CLOUD_BACKUP_LIMITS = Object.freeze({chunkBytes: CHUNK_BYTES, maximumBytes: MAX_ARCHIVE_BYTES, originalBytes: 512 * 1024 * 1024, ticketSeconds: 3600, leaseSeconds: 900});
const PREFIX = '/api/cloud-backups';
const HEADERS = {[SYNC_HEADER]: '1', 'cache-control': 'no-store, private', 'x-content-type-options': 'nosniff'};
const DEVICE_FORMATS = new Set(['shard-atlas-device-sqlite-gzip', 'shard-atlas-device-browser-json-gzip', 'shard-atlas-device-browser-json']);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const json = (value, status = 200) => Response.json(value, {status, headers: HEADERS});
const encode = value => new TextEncoder().encode(value);
export class CloudBackupError extends Error {
  constructor(message, code = 'invalid_request', status = 400) {super(message); this.code = code; this.status = status;}
}
const fail = (message, code, status) => {throw new CloudBackupError(message, code, status);};
function id(value, name = 'ID', empty = false) {
  if (typeof value !== 'string' || !(empty && value === '' || ID_PATTERN.test(value))) fail(`A valid ${name} is required.`);
  return value;
}
function digest(value) {if (typeof value !== 'string' || !HASH_PATTERN.test(value)) fail('A SHA-256 checksum is required.'); return value;}
function stamp(value) {const parsed = new Date(value); if (!Number.isFinite(parsed.getTime())) fail('A valid timestamp is required.'); return parsed.toISOString();}
function text(value, maximum = 160) {if (typeof value !== 'string' || value.length > maximum || /[\u0000-\u001f]/.test(value)) fail('Invalid checkpoint description.'); return value;}
function now(options) {return stamp(typeof options.now === 'function' ? options.now() : options.now ?? Date.now());}
function uuid(options) {return id(options.uuid ? options.uuid() : crypto.randomUUID());}
function configured(env) {return !!(env.DB && env.BUCKET && typeof env.SHARD_ATLAS_BACKUP_SIGNING_SECRET === 'string' && env.SHARD_ATLAS_BACKUP_SIGNING_SECRET.length >= 32);}
function authorize(env, options, requireConfiguration = true) {
  const owner = env.SHARD_ATLAS_OWNER_EMAIL?.trim().toLowerCase();
  if (env.SHARD_ATLAS_OWNER_PRIVATE !== 'true' || !owner) fail('Private backup access is not configured.', 'not_configured', 503);
  if (!options.identity?.userId || options.identity.email?.trim().toLowerCase() !== owner) fail('Sign in as the library owner to manage backups.', 'forbidden', 403);
  if (requireConfiguration && !configured(env)) fail('Cloud backups are not configured.', 'not_configured', 503);
  return owner;
}
function binding(env, options) {return options.storage || new LibraryStorage(env.DB, env.BUCKET);}
const rowById = (env, checkpointId) => env.DB.prepare('SELECT * FROM backup_checkpoints WHERE library_id = ? AND id = ?').bind('owner', checkpointId).first();
const rowByRequest = (env, requestId) => env.DB.prepare('SELECT * FROM backup_checkpoints WHERE library_id = ? AND request_id = ?').bind('owner', requestId).first();
const restoreById = (env, requestId) => env.DB.prepare('SELECT * FROM backup_restores WHERE library_id = ? AND id = ?').bind('owner', requestId).first();
const write = (env, sql, values) => env.DB.batch([env.DB.prepare(sql).bind(...values)]);
const deviceKey = hash => `backups/owner/device-blobs/${hash}`;
const parse = value => typeof value === 'string' && value ? JSON.parse(value) : null;
function checkpoint(row) {
  if (!row) return null;
  const manifest = parse(row.manifest), metadata = parse(row.metadata) || {};
  return {id: row.id, kind: row.kind, deviceId: row.device_id || undefined, sourceRevision: row.source_revision,
    manifest, sha256: manifest.sha256, sourceHash: manifest.sha256, bytes: manifest.bytes,
    originalSha256: manifest.originalSha256, originalBytes: manifest.originalBytes,
    filename: row.kind === 'device' ? `cloud:${row.id}` : `library-${row.id}.json.gz`,
    createdAt: row.created_at, updatedAt: row.updated_at, reason: row.reason, status: row.status,
    durable: true, verified: row.status === 'verified' || row.status === 'archived', driveVerified: !!row.drive_file_id && !!row.verified_at,
    driveFileId: row.drive_file_id || null, compressedSha256: row.compressed_sha256 || null,
    compressedBytes: row.compressed_bytes || null, verifiedAt: row.verified_at || null,
    lastError: row.last_error || null, counts: metadata.counts || null, archivedFolderId: row.archived_folder_id || null};
}
function deviceManifest(value) {
  if (!object(value) || !DEVICE_FORMATS.has(value.format)) fail('Unsupported device checkpoint format.');
  const checked = validateManifest({protocolVersion: 1, archiveVersion: 1, format: 'shard-atlas-library-json', sha256: value.sha256, bytes: value.bytes, chunks: value.chunks});
  digest(value.originalSha256);
  if (!Number.isSafeInteger(value.originalBytes) || value.originalBytes < 1 || value.originalBytes > CLOUD_BACKUP_LIMITS.originalBytes) fail('The original device checkpoint exceeds the 512 MiB limit.', 'snapshot_too_large', 413);
  if (value.format === 'shard-atlas-device-browser-json' && (value.originalSha256 !== value.sha256 || value.originalBytes !== value.bytes)) fail('Uncompressed device checkpoint checksums must agree.');
  return {...checked, format: value.format, originalSha256: value.originalSha256, originalBytes: value.originalBytes};
}
async function verifyChunks(env, storage, manifest, kind = 'library') {
  for (const chunk of new Map(manifest.chunks.map(value => [value.sha256, value])).values()) {
    const remote = kind === 'device' ? await env.BUCKET.head(deviceKey(chunk.sha256)) : await storage.blobInfo(chunk.sha256);
    if (!remote || remote.size !== chunk.bytes) fail('Upload every complete checkpoint chunk before saving its receipt.', 'missing_chunk', 409);
  }
}
async function saveCheckpoint(env, data, options) {
  const fingerprint = await sha256(encode(JSON.stringify({kind: data.kind, deviceId: data.deviceId || '', sourceRevision: data.sourceRevision || '', manifest: data.manifest})));
  let existing = await rowByRequest(env, data.requestId);
  if (existing && existing.fingerprint !== fingerprint) fail('This checkpoint request ID belongs to different content.', 'request_id_reused', 409);
  existing ||= await env.DB.prepare('SELECT * FROM backup_checkpoints WHERE library_id = ? AND source_key = ?').bind('owner', data.sourceKey).first();
  if (existing) {
    if (existing.fingerprint !== fingerprint) fail('This checkpoint identity belongs to different content.', 'request_id_reused', 409);
    return existing;
  }
  const createdAt = data.createdAt || now(options), checkpointId = uuid(options);
  await write(env, `INSERT OR IGNORE INTO backup_checkpoints
    (id, library_id, request_id, source_key, kind, device_id, source_revision, manifest, fingerprint, reason, status, created_at, updated_at, metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'staged', ?, ?, ?)`,
  [checkpointId, 'owner', data.requestId, data.sourceKey, data.kind, data.deviceId || '', data.sourceRevision || '', JSON.stringify(data.manifest), fingerprint, data.reason || 'scheduled', createdAt, createdAt, JSON.stringify(data.metadata || {})]);
  const saved = await rowByRequest(env, data.requestId) || await env.DB.prepare('SELECT * FROM backup_checkpoints WHERE library_id = ? AND source_key = ?').bind('owner', data.sourceKey).first();
  if (!saved || saved.fingerprint !== fingerprint) fail('Checkpoint completion is uncertain. Retry the identical request.', 'checkpoint_outcome_unknown', 503);
  return saved;
}
function b64(bytes) {let value = ''; for (const byte of bytes) value += String.fromCharCode(byte); return btoa(value).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');}
function unb64(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value) || value.length > 8192) fail('Invalid backup authorization.', 'invalid_ticket', 403);
  try {return Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - value.length % 4) % 4)), char => char.charCodeAt(0));}
  catch {fail('Invalid backup authorization.', 'invalid_ticket', 403);}
}
async function key(env) {return crypto.subtle.importKey('raw', encode(env.SHARD_ATLAS_BACKUP_SIGNING_SECRET), {name: 'HMAC', hash: 'SHA-256'}, false, ['sign', 'verify']);}
async function sign(env, purpose, payload, options) {
  const body = b64(encode(JSON.stringify({v: 1, purpose, owner: env.SHARD_ATLAS_OWNER_EMAIL.trim().toLowerCase(), expiresAt: Date.parse(now(options)) + CLOUD_BACKUP_LIMITS.ticketSeconds * 1000, ...payload})));
  return `${body}.${b64(new Uint8Array(await crypto.subtle.sign('HMAC', await key(env), encode(body))))}`;
}
async function verifyTicket(env, ticket, purpose, options) {
  if (!configured(env) || env.SHARD_ATLAS_OWNER_PRIVATE !== 'true') fail('Cloud backups are unavailable.', 'not_configured', 503);
  const parts = typeof ticket === 'string' ? ticket.split('.') : [];
  if (parts.length !== 2 || !await crypto.subtle.verify('HMAC', await key(env), unb64(parts[1]), encode(parts[0]))) fail('Backup authorization is invalid or expired.', 'invalid_ticket', 403);
  let claims; try {claims = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(unb64(parts[0])));} catch {fail('Backup authorization is invalid or expired.', 'invalid_ticket', 403);}
  if (claims.v !== 1 || claims.purpose !== purpose || claims.owner !== env.SHARD_ATLAS_OWNER_EMAIL?.trim().toLowerCase()
      || !Number.isSafeInteger(claims.expiresAt) || claims.expiresAt <= Date.parse(now(options))) fail('Backup authorization is invalid or expired.', 'invalid_ticket', 403);
  return claims;
}
async function descriptor(env, row, options, {claim = true, requestId} = {}) {
  let busy = false;
  if (claim && !['verified', 'archived'].includes(row.status)) {
    const leaseId = requestId || uuid(options), checkedAt = now(options), until = new Date(Date.parse(checkedAt) + CLOUD_BACKUP_LIMITS.leaseSeconds * 1000).toISOString();
    await write(env, `UPDATE backup_checkpoints SET lease_id = ?, lease_until = ?, status = 'uploading', updated_at = ?, last_error = ''
      WHERE library_id = ? AND id = ? AND status NOT IN ('verified', 'archived') AND (lease_until = '' OR lease_until <= ? OR lease_id = ?)`,
    [leaseId, until, checkedAt, 'owner', row.id, checkedAt, leaseId]);
    row = await rowById(env, row.id);
    busy = row.lease_id !== leaseId;
  }
  const ticket = await sign(env, 'backup-download', {checkpointId: row.id, sourceRevision: row.source_revision, sha256: parse(row.manifest).sha256}, options);
  return {checkpoint: checkpoint(row), transfer: {ticket, expiresAt: new Date(Date.parse(now(options)) + CLOUD_BACKUP_LIMITS.ticketSeconds * 1000).toISOString(),
    chunkPath: `${PREFIX}/transfers/${encodeURIComponent(row.id)}/blobs/{sha256}`},
    skip: ['verified', 'archived'].includes(row.status) || busy, busy, queued: !claim};
}
export async function prepareLibraryBackup(env, args = {}, options = {}) {
  authorize(env, options);
  if (!object(args)) fail('Backup arguments must be an object.');
  const storage = binding(env, options), requestId = args.requestId === undefined ? uuid(options) : id(args.requestId, 'request ID');
  let row;
  if (args.checkpointId !== undefined) {
    row = await rowById(env, id(args.checkpointId, 'checkpoint ID'));
    if (!row) fail('That checkpoint was not found.', 'not_found', 404);
  } else {
    const revision = await storage.head();
    if (!revision) return {skip: true, empty: true, checkpoint: null};
    const commit = await storage.commit(revision);
    if (!commit || commit.status !== 'accepted') fail('The accepted library revision is unavailable.', 'library_unavailable', 503);
    const manifest = validateManifest(parse(commit.manifest));
    await verifyChunks(env, storage, manifest);
    row = await saveCheckpoint(env, {kind: 'library', requestId, sourceKey: args.force ? `library:${revision}:${requestId}` : `library:${revision}`,
      sourceRevision: revision, manifest, reason: text(args.reason || 'scheduled')}, options);
  }
  return descriptor(env, row, options, {claim: args.claim !== false, requestId});
}
export async function prepareDeviceBackup(env, args = {}, options = {}) {
  authorize(env, options);
  const requestId = id(args.requestId, 'request ID'), manifest = deviceManifest(args.manifest || args), deviceId = id(args.deviceId || 'device', 'device ID');
  await verifyChunks(env, binding(env, options), manifest, 'device');
  const row = await saveCheckpoint(env, {kind: 'device', requestId, sourceKey: `device:${deviceId}:${manifest.sha256}`, deviceId, manifest,
    reason: text(args.reason || 'safety'), createdAt: args.createdAt ? stamp(args.createdAt) : undefined}, options);
  return {...checkpoint(row), filename: `cloud:${row.id}`, sourceHash: manifest.sha256, durable: true, verified: true, driveVerified: !!row.drive_file_id};
}
export async function listCloudBackups(env, args = {}, options = {}) {
  authorize(env, options);
  const offset = args.cursor === undefined ? 0 : Number(args.cursor), limit = args.limit ?? 50;
  if (!Number.isInteger(offset) || offset < 0 || offset > 10000 || !Number.isInteger(limit) || limit < 1 || limit > 100 || args.kind !== undefined && !['library', 'device'].includes(args.kind)) fail('Invalid backup page.');
  const clause = args.kind ? ' AND kind = ?' : '', parameters = ['owner', ...(args.kind ? [args.kind] : []), limit + 1, offset];
  const result = await env.DB.prepare(`SELECT * FROM backup_checkpoints WHERE library_id = ?${clause} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`).bind(...parameters).all();
  const rows = result.results || [];
  return {items: rows.slice(0, limit).map(checkpoint), nextCursor: rows.length > limit ? String(offset + limit) : null};
}
export async function cloudBackupStatus(env, args = {}, options = {}) {
  authorize(env, options, false);
  const available = configured(env), managed = available && env.SHARD_ATLAS_CLOUD_BACKUPS_ENABLED === 'true';
  if (!available) return {configured: false, managed: false, mode: 'local', localHistoryAllowed: true, state: 'not_configured', message: 'Cloud backups are not configured.', lastVerified: null, pendingCount: 0, catalogCount: 0};
  const [latest, attempt, totals, revision] = await Promise.all([
    env.DB.prepare("SELECT * FROM backup_checkpoints WHERE library_id = ? AND kind = 'library' AND status IN ('verified', 'archived') ORDER BY verified_at DESC, id DESC LIMIT 1").bind('owner').first(),
    env.DB.prepare('SELECT * FROM backup_checkpoints WHERE library_id = ? ORDER BY updated_at DESC, id DESC LIMIT 1').bind('owner').first(),
    env.DB.prepare("SELECT count(*) AS total, sum(CASE WHEN status IN ('staged', 'uploading', 'failed') THEN 1 ELSE 0 END) AS pending FROM backup_checkpoints WHERE library_id = ?").bind('owner').first(),
    binding(env, options).head(),
  ]);
  const current = !!latest && latest.source_revision === revision, failed = attempt?.status === 'failed';
  return {configured: true, managed, mode: managed ? 'cloud' : 'local', localHistoryAllowed: !managed,
    state: failed ? 'attention' : current ? 'current' : 'pending',
    message: failed ? 'A cloud backup needs attention. Your working library remains available.' : current ? 'Your saved cloud library has a verified Drive backup.' : 'A newer library is waiting for a verified Drive backup.',
    currentRevision: revision, expectedRevision: revision, lastVerified: checkpoint(latest), lastAttempt: checkpoint(attempt), pendingCount: Number(totals?.pending || 0), catalogCount: Number(totals?.total || 0), checkedAt: now(options),
    coverage: 'Saved cloud knowledge; device safety checkpoints separately retain drafts and import recovery. Private connection settings remain on each device.',
    retention: {mode: 'archive-only', hourly: 24, daily: 30, monthly: 12, permanentDeletion: false}};
}
export async function acknowledgeCloudBackup(env, args = {}, options = {}) {
  authorize(env, options);
  const row = await rowById(env, id(args.checkpointId, 'checkpoint ID'));
  if (!row) fail('That checkpoint was not found.', 'not_found', 404);
  const source = parse(row.manifest);
  if (digest(args.sourceSha256) !== source.sha256 || args.verification !== 'download-sha256') fail('The downloaded Drive checkpoint must match the prepared source.', 'verification_required', 409);
  const compressedHash = digest(args.compressedSha256), driveId = text(args.driveFileId, 256), verifiedAt = stamp(args.verifiedAt);
  if (!driveId || !/^[A-Za-z0-9_-]+$/.test(driveId) || !Number.isSafeInteger(args.compressedBytes) || args.compressedBytes < 1 || args.compressedBytes > MAX_ARCHIVE_BYTES) fail('Invalid verified Drive receipt.');
  if (Date.parse(verifiedAt) > Date.parse(now(options)) + 300000 || Date.parse(verifiedAt) < Date.parse(row.created_at) - 300000) fail('Invalid Drive verification time.');
  if (row.drive_file_id && (row.drive_file_id !== driveId || row.compressed_sha256 !== compressedHash || Number(row.compressed_bytes) !== args.compressedBytes)) fail('A different Drive result is already recorded for this checkpoint.', 'receipt_mismatch', 409);
  const counts = args.counts === undefined ? parse(row.metadata)?.counts : validateCounts(args.counts);
  await write(env, `UPDATE backup_checkpoints SET status = CASE WHEN status = 'archived' THEN status ELSE 'verified' END, drive_file_id = ?, compressed_sha256 = ?, compressed_bytes = ?, verified_at = ?, updated_at = ?, lease_id = '', lease_until = '', last_error = '', metadata = ? WHERE library_id = ? AND id = ? AND (drive_file_id = '' OR (drive_file_id = ? AND compressed_sha256 = ? AND compressed_bytes = ?))`,
    [driveId, compressedHash, args.compressedBytes, row.verified_at || verifiedAt, now(options), JSON.stringify({counts}), 'owner', row.id, driveId, compressedHash, args.compressedBytes]);
  const verified = await rowById(env, row.id);
  if (verified?.drive_file_id !== driveId || verified.compressed_sha256 !== compressedHash || Number(verified.compressed_bytes) !== args.compressedBytes) fail('A different Drive result is already recorded for this checkpoint.', 'receipt_mismatch', 409);
  return {checkpoint: checkpoint(verified), verified: true, driveVerified: true};
}
export async function failCloudBackup(env, args = {}, options = {}) {
  authorize(env, options);
  const code = ['upload_failed', 'verification_failed', 'authorization_required', 'rate_limited', 'transfer_failed'].includes(args.code) ? args.code : 'transfer_failed';
  const checkpointId = id(args.checkpointId, 'checkpoint ID');
  if (!await rowById(env, checkpointId)) fail('That checkpoint was not found.', 'not_found', 404);
  await write(env, "UPDATE backup_checkpoints SET status = CASE WHEN drive_file_id = '' THEN 'failed' ELSE status END, last_error = ?, updated_at = ?, lease_id = '', lease_until = '' WHERE library_id = ? AND id = ?", [code, now(options), 'owner', checkpointId]);
  return {recorded: true, code};
}
export async function archiveCloudBackup(env, args = {}, options = {}) {
  authorize(env, options);
  const row = await rowById(env, id(args.checkpointId, 'checkpoint ID'));
  if (!row || !row.drive_file_id) fail('Only a verified Drive checkpoint can be archived.', 'verification_required', 409);
  const folder = text(args.folderId, 256); if (!/^[A-Za-z0-9_-]+$/.test(folder)) fail('A valid archive folder is required.');
  await write(env, "UPDATE backup_checkpoints SET status = 'archived', archived_folder_id = ?, updated_at = ? WHERE library_id = ? AND id = ?", [folder, now(options), 'owner', row.id]);
  return {checkpoint: checkpoint(await rowById(env, row.id)), permanentDeletion: false};
}
function validateCounts(value) {
  if (!object(value) || Object.keys(value).length > 20 || Object.values(value).some(count => !Number.isSafeInteger(count) || count < 0) || Object.keys(value).some(name => !/^[a-zA-Z][a-zA-Z0-9]{0,30}$/.test(name))) fail('Invalid restoration counts.');
  return value;
}
function restoreRecord(row) {
  if (!row) return null;
  return {requestId: row.id, checkpointId: row.checkpoint_id, expectedRevision: row.expected_revision, status: row.status,
    createdAt: row.created_at, updatedAt: row.updated_at, manifest: parse(row.manifest), counts: parse(row.counts), acceptedRevision: row.accepted_revision || null,
    preRestoreCheckpointId: row.pre_restore_checkpoint_id || null};
}
export async function requestCloudRestore(env, args = {}, options = {}) {
  authorize(env, options);
  const requestId = id(args.requestId, 'restoration request ID'), checkpointId = id(args.checkpointId, 'checkpoint ID'), expected = id(args.expectedRevision, 'expected revision', true);
  const prior = await restoreById(env, requestId);
  if (prior) {
    if (prior.checkpoint_id !== checkpointId || prior.expected_revision !== expected) fail('This restoration request ID belongs to a different preview.', 'request_id_reused', 409);
    return {restore: restoreRecord(prior), queued: prior.status === 'queued', replayed: true};
  }
  const source = await rowById(env, checkpointId);
  if (!source || source.kind !== 'library' || !source.drive_file_id || !source.verified_at) fail('Choose a verified library backup from Drive.', 'verification_required', 409);
  if (await binding(env, options).head() !== expected) fail('Your cloud library changed. Refresh before requesting restoration.', 'cloud_library_changed', 409);
  const createdAt = now(options);
  await write(env, `INSERT OR IGNORE INTO backup_restores (id, library_id, checkpoint_id, expected_revision, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'queued', ?, ?)`, [requestId, 'owner', checkpointId, expected, createdAt, createdAt]);
  const saved = await restoreById(env, requestId);
  if (!saved || saved.checkpoint_id !== checkpointId || saved.expected_revision !== expected) fail('This restoration request ID belongs to a different preview.', 'request_id_reused', 409);
  return {...restoreRecord(saved), restore: restoreRecord(saved), queued: true, replayed: false};
}
async function restorePreview(env, row, options) {
  const current = options.currentRevision ?? await binding(env, options).head();
  if (['queued', 'uploading', 'prepared'].includes(row.status) && current !== row.expected_revision) {
    const record = {...restoreRecord(row), status: 'stale'};
    return {...record, restore: record, previewTicket: null, message: 'The cloud library changed. Request a fresh restoration preview.'};
  }
  const previewTicket = row.manifest && row.status === 'prepared' ? await sign(env, 'restore-preview', {requestId: row.id, expectedRevision: row.expected_revision, sha256: parse(row.manifest).sha256}, options) : null;
  return {...restoreRecord(row), restore: restoreRecord(row), previewTicket};
}
export async function listCloudRestores(env, args = {}, options = {}) {
  authorize(env, options);
  const result = await env.DB.prepare('SELECT * FROM backup_restores WHERE library_id = ? ORDER BY created_at DESC, id DESC LIMIT 100').bind('owner').all();
  const currentRevision = await binding(env, options).head();
  return {items: await Promise.all((result.results || []).map(row => restorePreview(env, row, {...options, currentRevision})))};
}
export async function prepareCloudRestore(env, args = {}, options = {}) {
  authorize(env, options);
  const requestId = id(args.requestId, 'restoration request ID'), row = await restoreById(env, requestId);
  if (!row) fail('Request a restoration preview first.', 'not_found', 404);
  if (row.status === 'accepted') return {...await restorePreview(env, row, options), replayed: true};
  if (!['queued', 'uploading', 'prepared'].includes(row.status)) fail('Request a new restoration preview after a conflict.', 'request_conflicted', 409);
  const source = await rowById(env, row.checkpoint_id), manifest = validateManifest(args.manifest);
  if (!source || digest(args.sourceSha256) !== parse(source.manifest).sha256 || args.validated !== true || args.receiptsPreserved !== true) fail('Validate the complete Drive backup and preserve current contribution receipts before preparing restoration.', 'validation_required', 409);
  const storage = binding(env, options);
  if (await storage.head() !== row.expected_revision) {
    await write(env, "UPDATE backup_restores SET status = 'stale', updated_at = ? WHERE library_id = ? AND id = ? AND status IN ('queued', 'uploading', 'prepared')", [now(options), 'owner', requestId]);
    fail('The cloud library changed after the restoration request. Request a fresh preview.', 'cloud_library_changed', 409);
  }
  const fingerprint = await sha256(encode(JSON.stringify({checkpointId: row.checkpoint_id, expectedRevision: row.expected_revision, manifest}))), counts = validateCounts(args.counts || {});
  if (row.fingerprint && row.fingerprint !== fingerprint) fail('This restoration request ID belongs to different prepared content.', 'request_id_reused', 409);
  let beforeId = row.pre_restore_checkpoint_id;
  if (!beforeId && row.expected_revision) {
    const before = await storage.commit(row.expected_revision);
    if (!before || before.status !== 'accepted') fail('The current library cannot be preserved.', 'library_unavailable', 503);
    const beforeManifest = validateManifest(parse(before.manifest)); await verifyChunks(env, storage, beforeManifest);
    const beforeRequest = `pre-restore-${(await sha256(encode(requestId))).slice(0, 64)}`;
    const preserved = await saveCheckpoint(env, {kind: 'library', requestId: beforeRequest, sourceKey: `library:${row.expected_revision}`, sourceRevision: row.expected_revision, manifest: beforeManifest, reason: 'pre-restore'}, options);
    beforeId = preserved.id;
  }
  let ready = true;
  for (const chunk of new Map(manifest.chunks.map(value => [value.sha256, value])).values()) {
    const uploaded = await storage.blobInfo(chunk.sha256);
    if (!uploaded || uploaded.size !== chunk.bytes) ready = false;
  }
  await write(env, "UPDATE backup_restores SET manifest = ?, fingerprint = ?, counts = ?, status = ?, pre_restore_checkpoint_id = ?, updated_at = ? WHERE library_id = ? AND id = ? AND status IN ('queued', 'uploading', 'prepared') AND (fingerprint = '' OR fingerprint = ?)",
    [JSON.stringify(manifest), fingerprint, JSON.stringify(counts), ready ? 'prepared' : 'uploading', beforeId || '', now(options), 'owner', requestId, fingerprint]);
  const updated = await restoreById(env, requestId);
  if (!updated || updated.fingerprint !== fingerprint) fail('This restoration request ID belongs to different prepared content.', 'request_id_reused', 409);
  const ticket = await sign(env, 'restore-upload', {requestId, sha256: manifest.sha256}, options);
  return {...await restorePreview(env, updated, options), uploadTransfer: {ticket, chunkPath: `${PREFIX}/restores/${encodeURIComponent(requestId)}/blobs/{sha256}`}, validated: true};
}
export async function commitCloudRestore(env, args = {}, options = {}) {
  authorize(env, options);
  const requestId = id(args.requestId, 'restoration request ID'), row = await restoreById(env, requestId);
  if (!row || !row.manifest) fail('A prepared restoration preview is required.', 'not_found', 404);
  if (args.confirm !== true) fail('Explicit confirmation is required to restore the library.', 'confirmation_required', 409);
  const storage = binding(env, options), manifest = validateManifest(parse(row.manifest)), mutationId = `restore-${await sha256(encode(requestId))}`;
  const fingerprint = await sha256(encode(JSON.stringify({baseRevision: row.expected_revision, manifest})));
  let receipt = await storage.receipt(mutationId), replayed = !!receipt;
  if (!receipt) {
    const claims = await verifyTicket(env, args.previewTicket, 'restore-preview', options);
    if (claims.requestId !== requestId || claims.expectedRevision !== row.expected_revision || claims.sha256 !== manifest.sha256) fail('The restoration preview does not match this request.', 'invalid_ticket', 403);
    if (await storage.head() !== row.expected_revision) {
      await write(env, "UPDATE backup_restores SET status = 'stale', updated_at = ? WHERE library_id = ? AND id = ? AND status IN ('queued', 'uploading', 'prepared')", [now(options), 'owner', requestId]);
      fail('Your cloud library changed. Request a new restoration preview.', 'cloud_library_changed', 409);
    }
    await verifyChunks(env, storage, manifest);
    try {receipt = await storage.publish({id: uuid(options), mutationId, baseRevision: row.expected_revision, fingerprint, manifest, createdAt: now(options)});}
    catch {fail('Restoration completion is uncertain. Retry the identical confirmed request.', 'restore_outcome_unknown', 503);}
  }
  if (receipt.fingerprint !== fingerprint) fail('This restoration request has a different durable result.', 'request_id_reused', 409);
  if (receipt.status !== 'accepted') {
    await write(env, "UPDATE backup_restores SET status = 'conflict', updated_at = ? WHERE library_id = ? AND id = ?", [now(options), 'owner', requestId]);
    fail('Another cloud change was saved first. Both copies are retained; request a new preview.', 'request_conflicted', 409);
  }
  let current;
  try {
    const committed = await storage.commit(receipt.id);
    if (!committed || parse(committed.manifest).sha256 !== manifest.sha256) throw new Error('readback');
    await write(env, "UPDATE backup_restores SET status = 'accepted', accepted_revision = ?, updated_at = ? WHERE library_id = ? AND id = ?", [receipt.id, now(options), 'owner', requestId]);
    current = await storage.head();
  } catch {fail('Restoration completion is uncertain. Retry the identical confirmed request.', 'restore_outcome_unknown', 503);}
  return {verified: true, acceptedRevision: receipt.id, currentRevision: current, currentContentMatches: current === receipt.id, replayed, preRestoreCheckpointId: row.pre_restore_checkpoint_id, restore: restoreRecord(await restoreById(env, requestId))};
}
async function requestIdentity(request, env) {
  const userId = request.headers.get('oai-authenticated-user-id'), email = request.headers.get('oai-authenticated-user-email');
  if (userId && email) {const identity = {userId, email}; authorize(env, {identity}, false); return identity;}
  await authorizeLibraryRequest(request, env, {requireProtocol: false});
  return {userId: 'service-device', email: env.SHARD_ATLAS_OWNER_EMAIL};
}
async function bodyJSON(request) {
  try {const bytes = await readBounded(request, 32 * 1024); return bytes.length ? JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes)) : {};}
  catch (error) {if (error instanceof SyncError) throw error; fail('Backup arguments must be valid UTF-8 JSON.');}
}
export async function handleCloudBackupRequest(request, env, options = {}) {
  const url = new URL(request.url);
  if (url.pathname !== PREFIX && !url.pathname.startsWith(`${PREFIX}/`)) return null;
  try {
    const path = url.pathname.slice(PREFIX.length), method = request.method;
    const transfer = path.match(/^\/transfers\/([A-Za-z0-9_.:-]+)\/blobs\/([a-f0-9]{64})$/);
    const restoreUpload = path.match(/^\/restores\/([A-Za-z0-9_.:-]+)\/blobs\/([a-f0-9]{64})$/);
    if (transfer && method === 'GET') {
      const claims = await verifyTicket(env, request.headers.get('X-Shard-Atlas-Backup-Ticket'), 'backup-download', options), row = await rowById(env, transfer[1]);
      if (!row || claims.checkpointId !== row.id || claims.sourceRevision !== row.source_revision || claims.sha256 !== parse(row.manifest).sha256) fail('Backup transfer authorization does not match.', 'invalid_ticket', 403);
      const chunk = parse(row.manifest).chunks.find(value => value.sha256 === transfer[2]);
      if (!chunk) fail('This chunk is outside the prepared backup.', 'invalid_ticket', 403);
      const remote = row.kind === 'device' ? await env.BUCKET.get(deviceKey(chunk.sha256)) : await binding(env, options).blob(chunk.sha256);
      if (!remote || remote.size !== chunk.bytes) fail('A prepared checkpoint chunk is unavailable.', 'missing_chunk', 409);
      return new Response(remote.body, {headers: {...HEADERS, 'content-type': 'application/octet-stream', 'content-length': String(chunk.bytes), etag: `"${chunk.sha256}"`}});
    }
    if (restoreUpload && method === 'PUT') {
      const claims = await verifyTicket(env, request.headers.get('X-Shard-Atlas-Backup-Ticket'), 'restore-upload', options), row = await restoreById(env, restoreUpload[1]);
      if (!row || !['uploading', 'prepared'].includes(row.status) || claims.requestId !== row.id || claims.sha256 !== parse(row.manifest).sha256) fail('Restoration upload authorization does not match.', 'invalid_ticket', 403);
      const chunk = parse(row.manifest).chunks.find(value => value.sha256 === restoreUpload[2]);
      if (!chunk) fail('This chunk is outside the prepared restoration.', 'invalid_ticket', 403);
      const bytes = await readBounded(request, CHUNK_BYTES);
      if (bytes.length !== chunk.bytes || await sha256(bytes) !== chunk.sha256) fail('The restoration chunk failed verification.', 'digest_mismatch', 422);
      await binding(env, options).putBlob(chunk.sha256, bytes);
      return json({sha256: chunk.sha256, bytes: chunk.bytes, durable: true, verified: true});
    }
    const identity = await requestIdentity(request, env), context = {...options, identity};
    const origin = request.headers.get('origin');
    if (!['GET', 'HEAD'].includes(method) && origin && origin !== url.origin) fail('Cross-origin backup changes are not allowed.', 'forbidden', 403);
    if (path === '/status' && method === 'GET') return json(await cloudBackupStatus(env, {}, context));
    if (path === '/catalog' && method === 'GET') return json(await listCloudBackups(env, Object.fromEntries([...url.searchParams].map(([name, value]) => [name, name === 'limit' ? Number(value) : value])), context));
    if (path === '/restores' && method === 'GET') return json(await listCloudRestores(env, {}, context));
    const device = path.match(/^\/device-snapshots\/blobs\/([a-f0-9]{64})$/);
    if (device && method === 'PUT') {
      authorize(env, context);
      const bytes = await readBounded(request, CHUNK_BYTES);
      if (!bytes.byteLength || await sha256(bytes) !== device[1]) fail('The device checkpoint chunk failed verification.', 'digest_mismatch', 422);
      const existing = await env.BUCKET.head(deviceKey(device[1]));
      if (existing && existing.size !== bytes.byteLength) fail('The stored device chunk is inconsistent.', 'storage_integrity', 503);
      if (!existing) await env.BUCKET.put(deviceKey(device[1]), bytes, {httpMetadata: {contentType: 'application/octet-stream'}});
      const verified = await env.BUCKET.head(deviceKey(device[1]));
      if (verified?.size !== bytes.byteLength) fail('The device chunk could not be verified.', 'storage_integrity', 503);
      return json({sha256: device[1], bytes: bytes.byteLength, durable: true, verified: true});
    }
    if (method !== 'POST') return json({error: 'This backup operation was not found.', code: 'not_found'}, 404);
    const args = await bodyJSON(request);
    if (!object(args)) fail('Backup arguments must be an object.');
    if (path === '/request') return json(await prepareLibraryBackup(env, {...args, claim: false}, context));
    if (path === '/device-snapshots/request') return json(await prepareDeviceBackup(env, args, context));
    if (path === '/acknowledge') return json(await acknowledgeCloudBackup(env, args, context));
    if (path === '/failure') return json(await failCloudBackup(env, args, context));
    if (path === '/archive') return json(await archiveCloudBackup(env, args, context));
    if (path === '/restore/request') return json(await requestCloudRestore(env, args, context));
    if (path === '/restore/preview') return json(await prepareCloudRestore(env, args, context));
    if (path === '/restore/confirm') return json(await commitCloudRestore(env, args, context));
    return json({error: 'This backup operation was not found.', code: 'not_found'}, 404);
  } catch (error) {
    if (error instanceof CloudBackupError || error instanceof SyncError) return json({error: error.message, code: error.code}, error.status);
    return json({error: 'Cloud backup completion could not be confirmed. Retry the same request.', code: 'backup_unavailable'}, 503);
  }
}
