import {LibraryStorage} from '../../sync/storage.mjs';
import {validateCapsule} from '../../sync/client.mjs';
import {ID_PATTERN, MAX_MANIFEST_BYTES, SyncError, validateManifest} from '../../sync/protocol.mjs';
import {linkKey, validateLink, validateLinkEndpoints, validateShard} from '../../web/model.mjs';
import {readCloudCapsule, CloudCapsuleError} from './cloud-capsule.mjs';
import {libraryNamespace} from './cloud-library-context.mjs';

// Image strings stream around this separate non-image metadata bound.
export const MAX_READ_ONLY_SNAPSHOT_BYTES = 16 * 1024 * 1024;
const caches = new WeakMap();
const messages = {
  read_only_storage_unavailable: 'The private cloud library is unavailable. Retry after the connection is restored.',
  read_only_snapshot_too_large: 'The non-image library metadata exceeds the 16 MiB remote tool limit. Library synchronization is unaffected; use the local Shard Atlas tools for this library.',
  read_only_snapshot_invalid: 'The current cloud snapshot could not be verified. No library content was returned.',
  read_only_library_changed: 'The shared library changed during this read. Retry to read one current revision.',
};

export class CloudLibraryReadError extends Error {
  constructor(code, status = 503) {super(messages[code]); this.name = 'CloudLibraryReadError'; this.code = code; this.status = status;}
}
const fail = (code = 'read_only_snapshot_invalid', status) => {throw new CloudLibraryReadError(code, status);};
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const validRevision = value => typeof value === 'string' && (value === '' || ID_PATTERN.test(value));
const timestamp = () => new Date().toISOString();
const validAcceptedAt = value => typeof value === 'string' && value.length <= 64
  && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/.test(value)
  && Number.isFinite(Date.parse(value));

function readonlyStorage(env) {
  if (!env || !env.DB || !env.BUCKET || typeof env.DB.prepare !== 'function' || typeof env.BUCKET.get !== 'function') fail('read_only_storage_unavailable');
  const storage = new LibraryStorage(env.DB, env.BUCKET, libraryNamespace(env));
  // The loader has no callable publication, blob-write, or receipt operation.
  return {libraryId: storage.libraryId, head: () => storage.head(), commit: revision => storage.commit(revision), blob: hash => storage.blob(hash)};
}

function cacheFor(env) {
  let namespaces = caches.get(env.DB);
  if (!namespaces) {namespaces = new Map(); caches.set(env.DB, namespaces);}
  const namespace = libraryNamespace(env);
  let state = namespaces.get(namespace);
  if (!state || state.bucket !== env.BUCKET) {
    state = {bucket: env.BUCKET, current: null, loading: null};
    namespaces.set(namespace, state);
  }
  return state;
}

function freeze(value) {
  const pending = [value], seen = new Set();
  while (pending.length) {
    const item = pending.pop();
    if (item === null || typeof item !== 'object' || seen.has(item)) continue;
    seen.add(item);
    for (const child of Object.values(item)) if (child !== null && typeof child === 'object') pending.push(child);
    Object.freeze(item);
  }
  return value;
}

async function head(storage) {
  const revision = await storage.head();
  if (!validRevision(revision)) fail();
  return revision;
}

function validateCurrentRecords(archive) {
  if (archive.shards.length > 100_000 || archive.links.length > 100_000) fail();
  // Reuse the exact current-record schema without cloning or interpreting
  // images, Trash, revisions, boards, or other unreturned recovery material.
  // Only one current record is normalized at a time for validation; outward
  // queries receive the original source text and apply their field allowlists.
  try {
    const shards = new Map(), linkIds = new Set(), semantics = new Set();
    for (const record of archive.shards) {
      const shard = validateShard(record, {imported: true});
      if (shards.has(shard.id)) fail();
      // Endpoint validation only needs approach identities, not another copy of
      // each explanation, structured walkthrough, or exact implementation.
      shards.set(shard.id, {id: shard.id, codeSolution: {approaches: shard.codeSolution.approaches.map(approach => ({id: approach.id}))}});
    }
    for (const record of archive.links) {
      const link = validateLink(record, {imported: true}), semantic = linkKey(link);
      if (linkIds.has(link.id) || semantics.has(semantic)) fail();
      linkIds.add(link.id); semantics.add(semantic);
      validateLinkEndpoints(link, shards);
    }
  } catch {fail();}
}

async function loadRevision(storage, revision) {
  const commit = await storage.commit(revision);
  if (!object(commit) || commit.id !== revision || commit.library_id !== storage.libraryId || commit.status !== 'accepted'
      || !validAcceptedAt(commit.created_at)
      || typeof commit.manifest !== 'string' || commit.manifest.length > MAX_MANIFEST_BYTES
      || new TextEncoder().encode(commit.manifest).byteLength > MAX_MANIFEST_BYTES) fail();
  const manifest = validateManifest(JSON.parse(commit.manifest));
  const capsule = validateCapsule(await readCloudCapsule(storage, manifest, {metadataBytes: MAX_READ_ONLY_SNAPSHOT_BYTES, validateImages: false}));
  if (!object(capsule.archive)) fail();
  validateCurrentRecords(capsule.archive);
  return freeze({revision, snapshotHash: manifest.sha256, acceptedAt: commit.created_at,
    archive: {shards: capsule.archive.shards, links: capsule.archive.links}});
}

async function revisionData(storage, state, revision) {
  if (state.current?.revision === revision) return state.current;
  // Serialize large snapshot decoding within one binding pair, including when
  // concurrent callers observe different heads. Never retain two full parses.
  while (state.loading) {
    const loaded = await state.loading;
    if (loaded.revision === revision) return loaded;
  }
  if (state.current?.revision === revision) return state.current;
  const loading = loadRevision(storage, revision);
  state.loading = loading;
  try {return await loading;}
  finally {if (state.loading === loading) state.loading = null;}
}

export async function readCloudLibrary(env) {
  try {
    const storage = readonlyStorage(env), state = cacheFor(env);
    for (let attempt = 0; attempt < 2; attempt++) {
      const revision = await head(storage);
      if (state.current?.revision !== revision) state.current = null;
      const current = revision ? await revisionData(storage, state, revision)
        : freeze({revision: '', snapshotHash: null, acceptedAt: null, archive: {shards: [], links: []}});
      // Cached data still requires both live head checks. A failed check never
      // falls back to an earlier snapshot or advertises it as current.
      if (await head(storage) !== revision) continue;
      state.current = current;
      return Object.freeze({...current, checkedAt: timestamp()});
    }
    fail('read_only_library_changed', 409);
  } catch (error) {
    if (error instanceof CloudLibraryReadError) throw error;
    if (error instanceof CloudCapsuleError) fail(error.code === 'cloud_snapshot_too_large' ? 'read_only_snapshot_too_large' : error.code === 'cloud_library_unavailable' ? 'read_only_storage_unavailable' : 'read_only_snapshot_invalid', error.status);
    // Validation and provider exceptions can contain private JSON, SQL, or keys.
    // Only fixed, bounded messages and codes cross this module's boundary.
    if (error instanceof SyncError || error?.status === 400 || error?.status === 422 || error instanceof SyntaxError || error instanceof TypeError || error instanceof RangeError) fail();
    fail('read_only_storage_unavailable');
  }
}
