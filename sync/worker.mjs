import {CHUNK_BYTES, HASH_PATTERN, ID_PATTERN, MAX_MANIFEST_BYTES, PROTOCOL_VERSION, SYNC_HEADER, SyncError, readBounded, sha256, validateManifest} from './protocol.mjs';
import {LibraryStorage, publicCommit} from './storage.mjs';

const prefix = '/api/library';
const commonHeaders = {'cache-control': 'no-store, private', 'x-content-type-options': 'nosniff', [SYNC_HEADER]: String(PROTOCOL_VERSION)};
const json = (value, status = 200) => Response.json(value, {status, headers: commonHeaders});

export async function authorizeLibraryRequest(request, env, {requireProtocol = true} = {}) {
  // This endpoint deliberately serves one shared owner library. The Sites
  // dispatch gate MUST remain owner-private, including when service access is
  // enabled: dispatch consumes its own bearer token before invoking the Worker.
  if (env.SHARD_ATLAS_OWNER_PRIVATE !== 'true') throw new SyncError('Private library access has not been configured.', 503, 'not_configured');
  const identity = request.headers.get('oai-authenticated-user-id');
  if (identity) {
    const expected = env.SHARD_ATLAS_OWNER_EMAIL?.trim().toLowerCase();
    if (expected && request.headers.get('oai-authenticated-user-email')?.trim().toLowerCase() !== expected) throw new SyncError('This account cannot access the library.', 403, 'forbidden');
  } else {
    const serviceSecret = request.headers.get('X-Shard-Atlas-Service');
    // An explicitly configured list is authoritative, including an empty list.
    // This lets a lost device be revoked without rotating every other device.
    let expectedHashes;
    if (env.SHARD_ATLAS_SERVICE_SECRET_SHA256_ALLOWLIST !== undefined) {
      try {expectedHashes = JSON.parse(env.SHARD_ATLAS_SERVICE_SECRET_SHA256_ALLOWLIST);}
      catch {throw new SyncError('Private device access has not been configured correctly.', 503, 'not_configured');}
      if (!Array.isArray(expectedHashes) || expectedHashes.length > 64 || expectedHashes.some(hash => typeof hash !== 'string' || !HASH_PATTERN.test(hash))) throw new SyncError('Private device access has not been configured correctly.', 503, 'not_configured');
    } else {
      expectedHashes = HASH_PATTERN.test(env.SHARD_ATLAS_SERVICE_SECRET_SHA256 || '') ? [env.SHARD_ATLAS_SERVICE_SECRET_SHA256] : [];
    }
    if (env.SHARD_ATLAS_ALLOW_SERVICE_ACCESS !== 'true' || !serviceSecret || serviceSecret.length > 1024) throw new SyncError('Sign in to synchronize your library.', 401, 'sign_in_required');
    const actualHash = await sha256(new TextEncoder().encode(serviceSecret));
    let matched = 0;
    for (const expectedHash of expectedHashes) {
      let difference = 0;
      for (let index = 0; index < 64; index++) difference |= expectedHash.charCodeAt(index) ^ actualHash.charCodeAt(index);
      matched |= Number(difference === 0);
    }
    if (!matched) throw new SyncError('This device cannot access the library.', 403, 'forbidden');
  }
  if (requireProtocol && request.headers.get(SYNC_HEADER) !== String(PROTOCOL_VERSION)) throw new SyncError('Update Shard Atlas before synchronizing this library.', 426, 'incompatible_version');
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    const origin = request.headers.get('origin');
    if (origin && origin !== new URL(request.url).origin) throw new SyncError('Cross-origin library changes are not allowed.', 403, 'forbidden');
  }
}

export async function handleLibraryRequest(request, env, {storage, clock = () => new Date().toISOString(), uuid = () => crypto.randomUUID()} = {}) {
  const url = new URL(request.url);
  if (url.pathname !== prefix && !url.pathname.startsWith(`${prefix}/`)) return null;
  try {
    await authorizeLibraryRequest(request, env);
    if (!storage && (!env.DB || !env.BUCKET)) throw new SyncError('Shared library storage is unavailable.', 503, 'not_configured');
    storage ||= new LibraryStorage(env.DB, env.BUCKET);
    const path = url.pathname.slice(prefix.length), method = request.method;
    if (path === '/head' && method === 'GET') {
      const revision = await storage.head();
      if (url.searchParams.get('summary') === '1') return json({protocolVersion: PROTOCOL_VERSION, revision});
      return json({protocolVersion: PROTOCOL_VERSION, revision, commit: revision ? publicCommit(await storage.commit(revision), true) : null});
    }
    if ((path === '/history' || path === '/conflicts') && method === 'GET') {
      const cursor = url.searchParams.get('cursor') || '0';
      if (!/^\d{1,5}$/.test(cursor) || Number(cursor) > 10_000) throw new SyncError('Invalid history cursor.');
      return json(await storage.history({conflicts: path === '/conflicts', offset: Number(cursor)}));
    }
    const commitMatch = path.match(/^\/commits\/([a-zA-Z0-9_.:-]+)$/);
    if (commitMatch && method === 'GET') {
      if (!ID_PATTERN.test(commitMatch[1])) throw new SyncError('Invalid revision ID.');
      const commit = await storage.commit(commitMatch[1]);
      if (!commit) throw new SyncError('This saved revision was not found.', 404, 'not_found');
      return json(publicCommit(commit, true));
    }
    const blobMatch = path.match(/^\/blobs\/([a-f0-9]{64})$/);
    if (blobMatch && method === 'PUT') {
      const bytes = await readBounded(request, CHUNK_BYTES);
      if (!bytes.byteLength) throw new SyncError('Empty snapshot chunks are not allowed.');
      if (await sha256(bytes) !== blobMatch[1]) throw new SyncError('Snapshot chunk failed its integrity check.', 422, 'digest_mismatch');
      const existing = await storage.blobInfo(blobMatch[1]);
      if (!existing) await storage.putBlob(blobMatch[1], bytes);
      else if (existing.size !== bytes.byteLength) throw new SyncError('Stored snapshot chunk has an unexpected size.', 500, 'storage_integrity');
      return json({sha256: blobMatch[1], bytes: bytes.byteLength});
    }
    if (blobMatch && method === 'GET') {
      const object = await storage.blob(blobMatch[1]);
      if (!object) throw new SyncError('This snapshot chunk was not found.', 404, 'not_found');
      return new Response(object.body, {headers: {...commonHeaders, 'content-type': 'application/octet-stream', 'content-length': String(object.size), etag: `"${blobMatch[1]}"`}});
    }
    if (path === '/commits' && method === 'POST') {
      if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) throw new SyncError('Snapshot commits require JSON.', 415, 'invalid_content_type');
      let body;
      try {body = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(await readBounded(request, MAX_MANIFEST_BYTES)));}
      catch (error) {if (error instanceof SyncError) throw error; throw new SyncError('The snapshot commit is not valid JSON.');}
      if (!ID_PATTERN.test(body?.mutationId) || typeof body?.mutationId !== 'string' || typeof body?.baseRevision !== 'string' || (body.baseRevision !== '' && !ID_PATTERN.test(body.baseRevision))) throw new SyncError('A stable mutation ID and base revision are required.');
      const manifest = validateManifest(body.manifest);
      const fingerprint = await sha256(new TextEncoder().encode(JSON.stringify({baseRevision: body.baseRevision, manifest})));
      let receipt = await storage.receipt(body.mutationId);
      if (!receipt) {
        // Check each referenced immutable object before the atomic publication.
        // Identical chunks can occur more than once in a large JSON archive.
        for (const chunk of new Map(manifest.chunks.map(chunk => [chunk.sha256, chunk])).values()) {
          const object = await storage.blobInfo(chunk.sha256);
          if (!object || object.size !== chunk.bytes) throw new SyncError('Upload every snapshot chunk before committing.', 409, 'missing_chunk');
        }
        receipt = await storage.publish({id: uuid(), mutationId: body.mutationId, baseRevision: body.baseRevision, fingerprint, manifest, createdAt: clock()});
      }
      if (!receipt || receipt.fingerprint !== fingerprint) throw new SyncError('This mutation ID was already used for different content. Keep the original pending change or use a new ID.', 409, 'mutation_reused');
      return json({...publicCommit(receipt, true), revision: await storage.head()}, receipt.status === 'conflict' ? 409 : 200);
    }
    if (/^\/blobs\//.test(path) && !HASH_PATTERN.test(path.slice(7))) throw new SyncError('Invalid snapshot digest.');
    throw new SyncError('This library operation was not found.', 404, 'not_found');
  } catch (error) {
    if (error instanceof SyncError) return json({error: error.message, code: error.code}, error.status);
    // Do not expose database statements, object keys, or private content in errors.
    return json({error: 'The shared library could not complete this operation. Your local collection is retained.', code: 'storage_error'}, 503);
  }
}
