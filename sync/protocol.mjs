export const PROTOCOL_VERSION = 1;
export const ARCHIVE_VERSION = 1;
export const CHUNK_BYTES = 4 * 1024 * 1024;
export const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;
export const MAX_MANIFEST_BYTES = 32 * 1024;
export const SYNC_HEADER = 'X-Shard-Atlas-Sync';
export const HASH_PATTERN = /^[a-f0-9]{64}$/;
export const ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/;

export class SyncError extends Error {
  constructor(message, status = 400, code = 'invalid_request') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function validateManifest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SyncError('A snapshot manifest is required.');
  if (value.protocolVersion !== PROTOCOL_VERSION || value.archiveVersion !== ARCHIVE_VERSION) {
    throw new SyncError('Update Shard Atlas before synchronizing this library.', 426, 'incompatible_version');
  }
  if (value.format !== 'shard-atlas-library-json' || !HASH_PATTERN.test(value.sha256)) throw new SyncError('Invalid snapshot format or digest.');
  if (!Number.isSafeInteger(value.bytes) || value.bytes < 1 || value.bytes > MAX_ARCHIVE_BYTES) throw new SyncError('The snapshot exceeds the 256 MiB library limit.', 413, 'snapshot_too_large');
  if (!Array.isArray(value.chunks) || value.chunks.length < 1 || value.chunks.length > MAX_ARCHIVE_BYTES / CHUNK_BYTES) throw new SyncError('Invalid snapshot chunk list.');
  const chunks = value.chunks.map((chunk, index) => {
    if (!chunk || !HASH_PATTERN.test(chunk.sha256) || !Number.isSafeInteger(chunk.bytes) || chunk.bytes < 1 || chunk.bytes > CHUNK_BYTES) throw new SyncError('Invalid snapshot chunk.');
    if (index < value.chunks.length - 1 && chunk.bytes !== CHUNK_BYTES) throw new SyncError('Only the final snapshot chunk may be partial.');
    return {sha256: chunk.sha256, bytes: chunk.bytes};
  });
  if (chunks.reduce((sum, chunk) => sum + chunk.bytes, 0) !== value.bytes) throw new SyncError('Snapshot byte count does not match its chunks.');
  return {protocolVersion: PROTOCOL_VERSION, archiveVersion: ARCHIVE_VERSION, format: value.format, sha256: value.sha256, bytes: value.bytes, chunks};
}

export async function sha256(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

// Read bounded streams even when callers omit Content-Length or use chunked transfer.
export async function readBounded(request, maximum) {
  const declared = request.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maximum)) throw new SyncError('Request exceeds the synchronization limit.', 413, 'request_too_large');
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader(), chunks = [];
  let length = 0;
  try {
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maximum) {
        await reader.cancel();
        throw new SyncError('Request exceeds the synchronization limit.', 413, 'request_too_large');
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {bytes.set(chunk, offset); offset += chunk.byteLength;}
  return bytes;
}
