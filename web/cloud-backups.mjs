import {copy, newId} from './model.mjs';
import {cloudBackupMode} from './backup-policy.mjs';

const CHUNK_BYTES = 4 * 1024 * 1024;
const MAX_BYTES = 256 * 1024 * 1024;
const encoder = new TextEncoder();
const failure = (message, status = 503) => Object.assign(new Error(message), {status});

export class BrowserCloudBackups {
  constructor(store, {fetch = globalThis.fetch.bind(globalThis), crypto = globalThis.crypto} = {}) {
    this.store = store;
    this.fetch = fetch;
    this.crypto = crypto;
    this.current = null;
    this.running = null;
    this.migrating = null;
    store.recoveryUploader = snapshot => this.preserve(snapshot);
  }

  async api(path, {method = 'GET', body, bytes} = {}) {
    const response = await this.fetch('/api/cloud-backups' + path, {method, cache: 'no-store',
      headers: {'Content-Type': bytes ? 'application/octet-stream' : 'application/json'},
      ...(bytes ? {body: bytes} : body === undefined ? {} : {body: JSON.stringify(body)})});
    let result;
    try {result = await response.json();} catch {throw failure('The backup service did not return a valid response.');}
    if (!response.ok) throw failure(result.error?.message || result.error || 'Cloud recovery could not finish. Your previous data is retained.', response.status);
    return result;
  }

  async refresh() {
    const status = await this.api('/status');
    this.current = status;
    // A new installation keeps its existing local policy until the independent
    // Drive path has a verified receipt and the owner enables managed mode.
    if (status.configured && status.managed && status.mode === 'cloud' && status.localHistoryAllowed === false
        && status.lastVerified?.driveFileId) {
      const policy = (await this.store.atomic(db => copy(db.cloudBackupPolicy), {readonly: true})).result;
      if (policy?.mode !== 'cloud' || !policy.verified || !policy.deviceId) {
        await this.store.atomic(db => {
          db.cloudBackupPolicy = {...db.cloudBackupPolicy, mode: 'cloud', verified: true,
            deviceId: db.cloudBackupPolicy?.deviceId || `browser-${newId()}`};
        });
      }
    }
    const localPolicy = await this.localPolicy();
    if (localPolicy.mode === 'cloud' && localPolicy.retainedSnapshots && !this.migrating) {
      this.migrating = this.migrateLegacyOne().catch(async error => {
        await this.store.atomic(db => {if (db.cloudBackupPolicy) db.cloudBackupPolicy.lastMigrationError = error.message;});
      }).finally(() => {this.migrating = null;});
    }
    return {...status, localPolicy};
  }

  async localPolicy() {
    return (await this.store.atomic(db => ({mode: cloudBackupMode(db) ? 'cloud' : 'local',
      retainedSnapshots: db.backups?.length || 0, pending: false,
      migrationError: db.cloudBackupPolicy?.lastMigrationError || null,
      lastDeviceCheckpoint: copy(db.cloudBackupPolicy?.lastDeviceCheckpoint || null)}), {readonly: true})).result;
  }

  async digest(bytes) {
    return [...new Uint8Array(await this.crypto.subtle.digest('SHA-256', bytes))].map(value => value.toString(16).padStart(2, '0')).join('');
  }

  async preserve(snapshot, {reason = 'browser-safety', createdAt} = {}) {
    const policy = (await this.store.atomic(db => copy(db.cloudBackupPolicy), {readonly: true})).result;
    if (policy?.mode !== 'cloud' || !policy.verified || !policy.deviceId) throw failure('Cloud recovery has not been enabled for this device.');
    const original = encoder.encode(JSON.stringify({format: 'shard-atlas-device-browser', version: 1, ...snapshot}));
    if (original.byteLength > MAX_BYTES) throw failure('This device recovery copy exceeds the supported size. Your previous data is retained.', 413);
    let bytes = original, format = 'shard-atlas-device-browser-json';
    if (typeof globalThis.CompressionStream === 'function') {
      bytes = new Uint8Array(await new Response(new Blob([original]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer());
      format += '-gzip';
    }
    if (bytes.byteLength > MAX_BYTES) throw failure('This device recovery copy exceeds the supported size. Your previous data is retained.', 413);
    const sha256 = await this.digest(bytes), originalSha256 = await this.digest(original), chunks = [];
    for (let offset = 0; offset < bytes.byteLength; offset += CHUNK_BYTES) {
      const chunk = bytes.subarray(offset, offset + CHUNK_BYTES), hash = await this.digest(chunk);
      await this.api('/device-snapshots/blobs/' + hash, {method: 'PUT', bytes: chunk});
      chunks.push({sha256: hash, bytes: chunk.byteLength});
    }
    const receipt = await this.api('/device-snapshots/request', {method: 'POST', body: {
      requestId: `browser-${policy.deviceId.slice(-8)}-${sha256}`, deviceId: policy.deviceId, reason, ...(createdAt ? {createdAt} : {}),
      format, sha256, bytes: bytes.byteLength, originalSha256, originalBytes: original.byteLength, chunks,
    }});
    if (!receipt.verified || !receipt.durable || receipt.sha256 !== sha256 || receipt.bytes !== bytes.byteLength) {
      throw failure('The cloud recovery copy failed verification. Your previous data is retained.');
    }
    return receipt;
  }

  async migrateLegacyOne() {
    const db = (await this.store.atomic(value => value, {readonly: true})).database;
    if (!cloudBackupMode(db) || !db.backups?.length) return;
    const migrations = db.cloudBackupPolicy.legacyMigrations || {};
    const entry = db.backups.find(value => !migrations[value.filename]) || db.backups[0];
    const original = JSON.stringify(entry), originalHash = await this.digest(encoder.encode(original)), saved = migrations[entry.filename];
    if (saved && saved.sourceHash !== originalHash) {
      await this.store.atomic(current => {if (current.cloudBackupPolicy.legacyMigrations?.[entry.filename]?.checkpointId === saved.checkpointId) delete current.cloudBackupPolicy.legacyMigrations[entry.filename];});
      return;
    }
    if (!saved) {
      const snapshot = {archive: copy(entry.archive), drafts: copy(entry.drafts || {}), imports: copy(entry.imports || []),
        inboxReceipts: copy(entry.inboxReceipts || []), capsuleExtras: copy(entry.capsuleExtras || {})};
      const receipt = await this.preserve(snapshot, {reason: 'browser-history-migration', createdAt: entry.createdAt});
      await this.store.atomic(current => {
        const candidate = current.backups.find(value => value.filename === entry.filename);
        if (!candidate || JSON.stringify(candidate) !== original) return;
        (current.cloudBackupPolicy.legacyMigrations ||= {})[entry.filename] = {checkpointId: receipt.id, sourceHash: originalHash};
        delete current.cloudBackupPolicy.lastMigrationError;
      });
      return;
    }
    // An R2 staging receipt protects new safety operations, but old local
    // history is removed only after its independent Drive copy is verified.
    let cursor, remote;
    for (let page = 0; page < 101; page++) {
      const result = await this.api('/catalog?kind=device&limit=100' + (cursor === undefined ? '' : '&cursor=' + encodeURIComponent(cursor)));
      remote = result.items?.find(value => value.id === saved.checkpointId);
      if (remote || result.nextCursor === null || result.nextCursor === undefined) break;
      cursor = result.nextCursor;
    }
    if (!remote?.driveVerified || !remote.driveFileId) return;
    await this.store.atomic(current => {
      const index = current.backups.findIndex(value => value.filename === entry.filename && JSON.stringify(value) === original);
      if (index < 0 || current.cloudBackupPolicy.legacyMigrations?.[entry.filename]?.checkpointId !== remote.id) return;
      current.backups.splice(index, 1);
      delete current.cloudBackupPolicy.legacyMigrations[entry.filename];
      delete current.cloudBackupPolicy.lastMigrationError;
    });
  }

  start() {
    if (this.interval) return;
    const refresh = () => {
      if (this.running) return;
      this.running = this.refresh().catch(() => null).finally(() => {this.running = null;});
    };
    this.wake = refresh;
    globalThis.window?.addEventListener('online', refresh);
    globalThis.window?.addEventListener('focus', refresh);
    this.interval = setInterval(refresh, 60_000);
    this.interval.unref?.();
    refresh();
  }

  stop() {
    clearInterval(this.interval);
    this.interval = null;
    globalThis.window?.removeEventListener('online', this.wake);
    globalThis.window?.removeEventListener('focus', this.wake);
  }
}
