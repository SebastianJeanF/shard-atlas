import {ARCHIVE_VERSION, CHUNK_BYTES, MAX_ARCHIVE_BYTES, PROTOCOL_VERSION, SYNC_HEADER, SyncError, sha256, validateManifest} from './protocol.mjs';

export function validateCapsule(capsule) {
  if (!capsule || capsule.format !== 'shard-atlas-library' || capsule.version !== ARCHIVE_VERSION || capsule.archive?.schemaVersion !== 1) throw new SyncError('Update Shard Atlas before opening this library snapshot.', 426, 'incompatible_version');
  for (const kind of ['shards', 'links', 'reviews', 'boards', 'assets', 'revisions', 'trash']) {
    if (!Array.isArray(capsule.archive[kind])) throw new SyncError(`The library snapshot is missing ${kind}.`, 422, 'invalid_snapshot');
  }
  return capsule;
}

// Persist this complete object in the client's durable outbox BEFORE sending.
// Keep its mutationId and baseRevision unchanged across retries and app restarts.
export async function preparePendingSnapshot(capsule, baseRevision, mutationId = crypto.randomUUID()) {
  validateCapsule(capsule);
  if (typeof baseRevision !== 'string') throw new SyncError('The previous cloud revision is required.');
  const bytes = new TextEncoder().encode(JSON.stringify(capsule));
  if (bytes.byteLength > MAX_ARCHIVE_BYTES) throw new SyncError('The snapshot exceeds the 256 MiB library limit.', 413, 'snapshot_too_large');
  const chunks = [];
  for (let offset = 0; offset < bytes.byteLength; offset += CHUNK_BYTES) {
    const data = bytes.slice(offset, offset + CHUNK_BYTES);
    chunks.push({sha256: await sha256(data), bytes: data.byteLength, data});
  }
  const manifest = {protocolVersion: PROTOCOL_VERSION, archiveVersion: ARCHIVE_VERSION, format: 'shard-atlas-library-json',
    sha256: await sha256(bytes), bytes: bytes.byteLength, chunks: chunks.map(({sha256, bytes}) => ({sha256, bytes}))};
  return {mutationId, baseRevision, manifest, chunks};
}

export class LibraryClient {
  constructor({fetch: request = globalThis.fetch.bind(globalThis), baseUrl = '', headers = {}} = {}) {
    this.fetch = request;
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.headers = headers;
  }
  async request(path, options = {}, allowConflict = false) {
    let response;
    try {
      response = await this.fetch(`${this.baseUrl}/api/library${path}`, {...options, credentials: 'same-origin', cache: 'no-store',
        headers: {...this.headers, [SYNC_HEADER]: String(PROTOCOL_VERSION), ...options.headers}});
    } catch (error) {throw new SyncError('Connection unavailable. Your local collection and pending changes are retained.', 0, 'offline');}
    if (response.headers.get(SYNC_HEADER) !== String(PROTOCOL_VERSION)) {
      if (response.status === 426) throw new SyncError('Update Shard Atlas before synchronizing this collection.', 426, 'incompatible_version');
      throw new SyncError('Sign in to Shard Atlas in this browser, then retry synchronization.', 401, 'sign_in_required');
    }
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      if (allowConflict && response.status === 409 && error.status === 'conflict') return error;
      throw new SyncError(error.error || 'The library operation could not finish.', response.status, error.code || 'request_failed');
    }
    return response;
  }
  async head({summary = false} = {}) {return (await this.request(`/head${summary ? '?summary=1' : ''}`)).json();}
  async history(cursor = '') {return (await this.request(`/history${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`)).json();}
  async conflicts(cursor = '') {return (await this.request(`/conflicts${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`)).json();}
  async commit(id) {return (await this.request(`/commits/${encodeURIComponent(id)}`)).json();}
  async publish(pending) {
    const manifest = validateManifest(pending.manifest);
    if (!Array.isArray(pending.chunks) || pending.chunks.length !== manifest.chunks.length) throw new SyncError('The pending snapshot is incomplete.', 422, 'invalid_outbox');
    const uploaded = new Set();
    for (let index = 0; index < manifest.chunks.length; index++) {
      const chunk = manifest.chunks[index], data = pending.chunks[index].data;
      if (!(data instanceof Uint8Array) || data.byteLength !== chunk.bytes || await sha256(data) !== chunk.sha256) throw new SyncError('The pending snapshot failed its integrity check. Your local collection is retained.', 422, 'invalid_outbox');
      if (!uploaded.has(chunk.sha256)) {
        await this.request(`/blobs/${chunk.sha256}`, {method: 'PUT', headers: {'content-type': 'application/octet-stream'}, body: data});
        uploaded.add(chunk.sha256);
      }
    }
    const result = await this.request('/commits', {method: 'POST', headers: {'content-type': 'application/json'},
      body: JSON.stringify({mutationId: pending.mutationId, baseRevision: pending.baseRevision, manifest})}, true);
    return result instanceof Response ? result.json() : result;
  }
  async download(commit) {
    if (!commit) throw new SyncError('The shared library is empty.', 404, 'not_found');
    const manifest = validateManifest(commit.manifest);
    const bytes = new Uint8Array(manifest.bytes);
    let offset = 0;
    for (const chunk of manifest.chunks) {
      const response = await this.request(`/blobs/${chunk.sha256}`);
      const data = new Uint8Array(await response.arrayBuffer());
      if (data.byteLength !== chunk.bytes || await sha256(data) !== chunk.sha256) throw new SyncError('Downloaded snapshot failed its integrity check. Your local collection is retained.', 422, 'digest_mismatch');
      bytes.set(data, offset);
      offset += data.byteLength;
    }
    if (await sha256(bytes) !== manifest.sha256) throw new SyncError('Downloaded library failed its integrity check. Your local collection is retained.', 422, 'digest_mismatch');
    let capsule;
    try {capsule = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes));}
    catch {throw new SyncError('Downloaded library is not valid JSON. Your local collection is retained.', 422, 'invalid_snapshot');}
    return validateCapsule(capsule);
  }
}
