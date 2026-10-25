import {authorizeLibraryRequest} from './worker.mjs';
import {PROTOCOL_VERSION, SYNC_HEADER, SyncError} from './protocol.mjs';

const headers = {'cache-control': 'no-store, private', 'x-content-type-options': 'nosniff', [SYNC_HEADER]: String(PROTOCOL_VERSION)};

// Release discovery uses the same owner/device authentication, while remaining
// available to clients whose data protocol is no longer compatible.
export async function handleReleaseRequest(request, env, manifest) {
  if (!['/api/release', '/api/sync/release'].includes(new URL(request.url).pathname)) return null;
  try {
    await authorizeLibraryRequest(request, env, {requireProtocol: false});
    if (!['GET', 'HEAD'].includes(request.method)) return Response.json({error: 'Release checks require GET or HEAD.'}, {status: 405, headers: {...headers, allow: 'GET, HEAD'}});
    if (manifest?.schemaVersion !== 1 || manifest?.application !== 'shard-atlas' ||
        !['releaseId', 'frontendId', 'backendId', 'hostedId', 'nativeId'].every(key => /^[a-f0-9]{64}$/.test(manifest[key] || ''))) {
      return Response.json({error: 'Published release information is unavailable.'}, {status: 503, headers});
    }
    return new Response(request.method === 'HEAD' ? null : JSON.stringify(manifest), {headers: {...headers, 'content-type': 'application/json; charset=utf-8'}});
  } catch (error) {
    if (error instanceof SyncError) return Response.json({error: error.message, code: error.code}, {status: error.status, headers});
    return Response.json({error: 'Release check unavailable.'}, {status: 503, headers});
  }
}
