import {copy, emptyDatabase, newId, publicState, saveBackup} from './model.mjs';
import {fingerprint, handleArchives} from './archives.mjs';
import {LibraryClient, preparePendingSnapshot, validateCapsule} from './sync/client.mjs';

const defaultState = () => ({version: 1, configured: true, initialized: false, revision: '', baseFingerprint: null,
  state: 'pending', message: 'Checking your shared library.', outbox: null, conflict: null, lastSyncedAt: null});
const stateOf = db => db.librarySync ||= defaultState();
const count = db => db.archive.shards.length;
const nonempty = db => Object.values(db.archive).some(value => Array.isArray(value) && value.length) || (db.inboxReceipts || []).length;
const fail = (message, status = 409) => {throw Object.assign(new Error(message), {status});};

export function libraryCapsule(db) {
  return {...copy(db.librarySync?.capsuleExtras || {}), format: 'shard-atlas-library', version: 1, archive: copy(db.archive),
    contributionReceipts: (db.inboxReceipts || []).map(entry => ({...copy(entry), requestId: entry.receipt.requestId}))};
}

function validateIncoming(capsule) {
  validateCapsule(capsule);
  // Reuse all existing finite JSON, record, attachment, and relationship checks,
  // then retain the original bytes/fields instead of normalizing the snapshot.
  const preview = handleArchives(emptyDatabase(), '/api/import/preview', 'POST', {data: capsule.archive});
  if (preview?.valid !== true) fail(preview?.warnings?.[0] || 'The shared library snapshot is invalid. Your local collection is retained.', 422);
  const receipts = capsule.contributionReceipts || [];
  if (!Array.isArray(receipts) || receipts.length > 10_000 || new TextEncoder().encode(JSON.stringify(receipts)).byteLength > 8 * 1024 * 1024) fail('The shared library contains unsupported contribution receipts.', 422);
  const ids = new Set();
  for (const item of receipts) {
    const requestId = item?.requestId || item?.receipt?.requestId;
    if (typeof requestId !== 'string' || requestId !== item?.receipt?.requestId || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$/.test(requestId) || !/^[a-f0-9]{64}$/.test(item?.fingerprint || '') || !Array.isArray(item.receipt.shards) || !Array.isArray(item.receipt.links) || ids.has(requestId)) fail('The shared library contains an invalid contribution receipt.', 422);
    ids.add(requestId);
  }
  return capsule;
}

function applyCapsule(db, capsule) {
  const receipts = new Map((db.inboxReceipts || []).map(entry => [entry.receipt.requestId, copy(entry)]));
  for (const incoming of capsule.contributionReceipts || []) {
    const id = incoming.receipt.requestId, saved = receipts.get(id);
    if (saved && saved.fingerprint !== incoming.fingerprint) fail('This library has conflicting history for an immutable Drive batch. Your existing collection and receipts are retained.');
    receipts.set(id, {...copy(incoming), ...saved, requestId: id});
  }
  const mergedReceipts = [...receipts.values()];
  if (mergedReceipts.length > 10_000 || new TextEncoder().encode(JSON.stringify(mergedReceipts)).byteLength > 8 * 1024 * 1024) fail('The merged contribution history exceeds the safe receipt capacity. Your existing collection is retained.', 413);
  const backup = saveBackup(db);
  db.archive = copy(capsule.archive);
  db.inboxReceipts = mergedReceipts;
  // Drafts, local backup history, Drive settings and local import-undo receipts
  // belong to this device. A synchronized collection must not replace them.
  const extras = {...copy(capsule)};
  for (const key of ['format', 'version', 'archive', 'contributionReceipts']) delete extras[key];
  stateOf(db).capsuleExtras = extras;
  db.localGeneration = (db.localGeneration || 0) + 1;
  return backup;
}

export class BrowserLibrarySync {
  constructor(store, {client = new LibraryClient(), onChange = () => {}, canApplyRemote = () => !globalThis.window || globalThis.window.ShardAtlasCanApplyLibrary?.() === true, isEditing, pollMs = 20_000, now = () => Date.now()} = {}) {
    this.store = store;
    this.client = client;
    this.onChange = onChange;
    this.canApplyRemote = canApplyRemote;
    this.isEditing = isEditing || (() => typeof globalThis.window?.ShardAtlasHasUnsavedLibraryChanges === 'function'
      ? globalThis.window.ShardAtlasHasUnsavedLibraryChanges() : !this.canApplyRemote());
    this.pollMs = Math.max(15_000, pollMs);
    this.now = now;
    this.owner = newId();
    this.running = null;
    this.events = globalThis.window;
    this.wake = () => this.schedule();
  }

  start() {
    if (this.interval) return;
    this.unsubscribe = this.store.subscribe(() => this.schedule());
    this.events?.addEventListener('online', this.wake);
    this.events?.addEventListener('focus', this.wake);
    this.editInput = () => {void this.markEditing(true);};
    this.editClick = () => {setTimeout(() => {void this.markEditing(this.isEditing());}, 0);};
    this.events?.document?.addEventListener('input', this.editInput, true);
    this.events?.document?.addEventListener('click', this.editClick, true);
    this.editInterval = setInterval(() => {void this.markEditing(this.isEditing());}, 2000);
    this.editInterval.unref?.();
    void this.markEditing(this.isEditing());
    this.interval = setInterval(() => this.run().catch(() => {}), this.pollMs);
    this.interval.unref?.();
    this.run().catch(() => {});
  }
  stop() {
    clearInterval(this.interval); clearTimeout(this.scheduled);
    clearInterval(this.editInterval);
    void this.markEditing(false);
    this.interval = null; this.scheduled = null;
    this.unsubscribe?.();
    this.events?.removeEventListener('online', this.wake);
    this.events?.removeEventListener('focus', this.wake);
    this.events?.document?.removeEventListener('input', this.editInput, true);
    this.events?.document?.removeEventListener('click', this.editClick, true);
  }
  schedule() {
    clearTimeout(this.scheduled);
    this.scheduled = setTimeout(() => this.run().catch(() => {}), 400);
    this.scheduled.unref?.();
  }
  async read() {return (await this.store.atomic(db => db, {readonly: true})).database;}
  statusFrom(db) {
    const state = db.librarySync || defaultState();
    const pending = state.state === 'synced' && (db.localGeneration || 0) !== (state.syncedGeneration || 0);
    const observation = state.cloudCheck || {state: 'unknown', checkedAt: null, revision: ''};
    const recent = observation.checkedAt && this.now() - Date.parse(observation.checkedAt) <= Math.max(60_000, this.pollMs * 2);
    const cloudCheck = observation.state === 'unavailable' || recent ? observation : {...observation, state: 'unknown'};
    return {configured: state.configured, state: pending ? 'pending' : state.state, message: pending ? 'Your latest changes are waiting to synchronize.' : state.message,
      lastSyncedAt: state.lastSyncedAt, localCount: count(db), remoteCount: state.remoteCount ?? null, revision: state.revision,
      remoteRevision: state.remoteRevision || '', conflictId: state.conflict?.id || null, pending: !!state.outbox,
      cloudCheck, incomingAvailable: cloudCheck.state === 'incoming', syncing: !!this.running};
  }
  async status() {return this.statusFrom(await this.read());}
  async markEditing(editing) {
    try {
      await this.store.atomic(db => {
        const leases = stateOf(db).editingLeases ||= {};
        for (const [owner, lease] of Object.entries(leases)) if (lease.until <= this.now()) delete leases[owner];
        if (editing) leases[this.owner] = {until: this.now() + 60_000};
        else delete leases[this.owner];
      });
    } catch { /* Local edits remain protected by the generation and stale-base guards. */ }
  }
  canApply(db) {
    return this.canApplyRemote() && !Object.entries(db.librarySync?.editingLeases || {}).some(([owner, lease]) => owner !== this.owner && lease.until > this.now());
  }
  async owned(mutator) {
    return this.store.atomic(db => {
      if (stateOf(db).lease?.owner !== this.owner) fail('Another tab is synchronizing this collection. Try again shortly.');
      return mutator(db, stateOf(db));
    });
  }
  async acquire() {
    return (await this.store.atomic(db => {
      const state = stateOf(db);
      if (state.version !== 1) fail('Update Shard Atlas before synchronizing this collection.', 426);
      if (state.lease && state.lease.owner !== this.owner && state.lease.until > this.now()) return false;
      state.lease = {owner: this.owner, until: this.now() + 60_000};
      return true;
    })).result;
  }
  async release() {
    await this.store.atomic(db => {if (stateOf(db).lease?.owner === this.owner) delete stateOf(db).lease;});
  }
  async setStatus(state, message, extra = {}) {
    await this.owned((db, sync) => Object.assign(sync, {state, message, ...extra}));
  }
  async observeHead(head) {
    await this.owned((db, sync) => {
      sync.cloudCheck = {state: head.revision === sync.revision ? 'current' : 'incoming',
        checkedAt: new Date(this.now()).toISOString(), revision: head.revision};
    });
  }
  async acknowledge(receipt, pending) {
    await this.owned((db, sync) => {
      if (sync.outbox?.mutationId !== pending.mutationId) fail('Pending changes changed while synchronizing. Retry safely.');
      if (receipt.status === 'conflict') {
        sync.conflict = {id: receipt.id, remoteRevision: receipt.revision || receipt.observedRevision, localFingerprint: fingerprint(libraryCapsule(db))};
        Object.assign(sync, {state: 'conflict', remoteRevision: sync.conflict.remoteRevision,
          message: 'This device and your shared library both changed. Both versions are saved; choose which collection to continue with.'});
      } else {
        sync.revision = receipt.id;
        sync.baseFingerprint = pending.fingerprint;
        sync.initialized = true; sync.outbox = null; sync.conflict = null;
        if (pending.resolve) delete sync.forceConflictBase;
        sync.lastSyncedAt = new Date(this.now()).toISOString();
        sync.syncedGeneration = pending.generation;
        sync.cloudCheck = {state: 'current', checkedAt: sync.lastSyncedAt, revision: receipt.id};
        Object.assign(sync, {state: 'synced', message: 'Your library is synchronized.', configured: true});
      }
    });
    if (receipt.status === 'accepted') {
      const current = await this.read();
      if (!current.librarySync.forceConflictBase && this.store.observedArchiveFingerprint === fingerprint(current.archive)) this.store.observedRevision = receipt.id;
    }
    return receipt.status;
  }
  async stage(db, baseRevision, {resolve = false} = {}) {
    const capsule = libraryCapsule(db), digest = fingerprint(capsule);
    const pending = {...await preparePendingSnapshot(capsule, baseRevision), fingerprint: digest, generation: db.localGeneration || 0, resolve};
    await this.owned((current, sync) => {
      if ((current.localGeneration || 0) !== pending.generation) fail('Your collection changed while preparing synchronization. The latest changes are retained; retry.');
      if (sync.outbox && !resolve) fail('A previous change is still waiting to synchronize.');
      if (resolve) saveBackup(current);
      sync.outbox = pending;
      sync.state = 'pending'; sync.message = 'Uploading your saved changes.';
    });
    return pending;
  }
  async apply(remote, head, expectedGeneration) {
    validateIncoming(remote);
    const result = await this.owned((db, sync) => {
      if ((db.localGeneration || 0) !== expectedGeneration) fail('Your collection changed while downloading. The latest changes are retained; retry.');
      if (!this.canApply(db)) {
        Object.assign(sync, {state: sync.conflict ? 'conflict' : 'pending', message: 'Finish or save your open edit to receive the latest shared collection.'});
        return false;
      }
      const backup = applyCapsule(db, remote);
      delete sync.forceConflictBase;
      const remoteFingerprint = fingerprint({...copy(remote), contributionReceipts: (remote.contributionReceipts || []).map(entry => ({...copy(entry), requestId: entry.receipt.requestId}))});
      const pendingReceipts = fingerprint(libraryCapsule(db)) !== remoteFingerprint;
      Object.assign(sync, {initialized: true, revision: head.revision, baseFingerprint: remoteFingerprint, outbox: null, conflict: null,
        remoteRevision: head.revision, remoteCount: remote.archive.shards.length, state: 'synced', configured: true,
        message: pendingReceipts ? 'Your local import history is waiting to synchronize.' : 'Your library is synchronized.', lastSyncedAt: new Date(this.now()).toISOString(), syncedGeneration: db.localGeneration,
        lastBackupFilename: backup.filename, cloudCheck: {state: 'current', checkedAt: new Date(this.now()).toISOString(), revision: head.revision}});
      if (pendingReceipts) sync.state = 'pending';
      return publicState(db);
    });
    if (result.result === false) return null;
    this.onChange(result.database);
    if (this.events && globalThis.CustomEvent) this.events.dispatchEvent(new CustomEvent('shard-atlas-library-updated'));
    return result.database;
  }
  async perform() {
    // Continue after an accepted retry so later local edits get their own base.
    for (let pass = 0; pass < 3; pass++) {
      let db = await this.read(), state = stateOf(db);
      // Check only the accepted revision while an editor or a conflict blocks
      // replacement. Keep every snapshot, pending mutation and base unchanged.
      const savedDirty = state.initialized ? fingerprint(libraryCapsule(db)) !== state.baseFingerprint : !!nonempty(db);
      if (state.conflict || !this.canApply(db) && !state.outbox && !savedDirty) {
        const head = await this.client.head({summary: true});
        await this.observeHead(head);
        if (!state.conflict) await this.setStatus('pending', head.revision !== state.revision
          ? 'New saved data is available. Finish or save your open edit to receive it.'
          : 'Your editor is protected. Saved data will synchronize after you finish editing.');
        return;
      }
      if (state.outbox) {
        if (await this.acknowledge(await this.client.publish(state.outbox), state.outbox) === 'conflict') return;
        continue;
      }
      const head = await this.client.head();
      await this.observeHead(head);
      db = await this.read(); state = stateOf(db);
      const localFingerprint = fingerprint(libraryCapsule(db));
      const dirty = state.initialized ? localFingerprint !== state.baseFingerprint : !!nonempty(db);
      await this.owned((current, sync) => Object.assign(sync, {remoteRevision: head.revision, remoteCount: head.commit ? null : 0, configured: true}));
      if (!head.revision && !dirty) {
        await this.owned((current, sync) => Object.assign(sync, {initialized: true, revision: '', baseFingerprint: localFingerprint,
          state: 'synced', message: 'Your library is synchronized.', lastSyncedAt: new Date(this.now()).toISOString(), syncedGeneration: db.localGeneration || 0}));
        return;
      }
      if (head.revision !== state.revision && !dirty) {
        await this.apply(await this.client.download(head.commit), head, db.localGeneration || 0);
        return;
      }
      if (!state.initialized && head.revision && dirty) {
        const remote = validateIncoming(await this.client.download(head.commit));
        if (fingerprint(remote) === localFingerprint) {
          await this.owned((current, sync) => Object.assign(sync, {initialized: true, revision: head.revision, baseFingerprint: localFingerprint,
            state: 'synced', message: 'Your library is synchronized.', remoteCount: remote.archive.shards.length,
            lastSyncedAt: new Date(this.now()).toISOString(), syncedGeneration: db.localGeneration || 0,
            cloudCheck: {state: 'current', checkedAt: new Date(this.now()).toISOString(), revision: head.revision}}));
          return;
        }
        await this.owned((current, sync) => {sync.remoteCount = remote.archive.shards.length;});
      }
      if (dirty) {
        const pending = await this.stage(db, state.forceConflictBase ?? state.revision);
        if (await this.acknowledge(await this.client.publish(pending), pending) === 'conflict') return;
        continue;
      }
      await this.owned((current, sync) => Object.assign(sync, {state: 'synced', message: 'Your library is synchronized.',
        lastSyncedAt: new Date(this.now()).toISOString(), syncedGeneration: db.localGeneration || 0, remoteCount: count(db)}));
      return;
    }
  }
  async exclusive(operation) {
    if (!await this.acquire()) return;
    const heartbeat = setInterval(() => this.owned((db, sync) => {sync.lease.until = this.now() + 60_000;}).catch(() => {}), 15_000);
    heartbeat.unref?.();
    try {await operation();}
    catch (error) {
      const state = error.code === 'incompatible_version' || error.status === 426 ? 'update_required' : error.code === 'sign_in_required' || error.status === 401 ? 'sign-in-required' : error.status === 0 || error.code === 'offline' ? 'offline' : 'pending';
      await this.owned((db, sync) => {
        const preservedState = sync.conflict ? sync.state : state;
        Object.assign(sync, {state: preservedState, message: error.message || 'Synchronization could not finish. Your local collection is retained.',
          configured: error.code !== 'not_configured', cloudCheck: {state: 'unavailable', checkedAt: new Date(this.now()).toISOString(), revision: sync.cloudCheck?.revision || '', message: error.message}});
      }).catch(() => {});
    } finally {clearInterval(heartbeat); await this.release();}
  }
  async run() {
    if (!this.running) this.running = this.exclusive(() => this.perform()).finally(() => {this.running = null;});
    await this.running;
    return this.status();
  }
  async resolve(choice) {
    if (!['cloud', 'device'].includes(choice)) fail('Choose the shared collection or this device.');
    if (this.running) await this.running;
    await this.exclusive(async () => {
      const db = await this.read(), sync = stateOf(db);
      if (!sync.conflict) fail('There is no collection conflict to resolve.');
      if (!this.canApply(db)) {
        await this.setStatus('conflict', 'Finish or save your open edit before resolving this collection conflict.');
        return;
      }
      const localFingerprint = fingerprint(libraryCapsule(db));
      if (sync.conflict.localFingerprint !== localFingerprint) {
        await this.owned((current, state) => {
          state.conflict.localFingerprint = localFingerprint;
          state.message = 'This device changed again. Review your choice and select a collection again.';
        });
        return;
      }
      const head = await this.client.head();
      if (head.revision !== sync.conflict.remoteRevision) {
        await this.owned((current, state) => {
          state.conflict.remoteRevision = head.revision; state.remoteRevision = head.revision;
          state.message = 'The shared collection changed again. Review your choice and select a collection again.';
        });
        return;
      }
      if (choice === 'cloud') await this.apply(await this.client.download(head.commit), head, db.localGeneration || 0);
      else {
        const pending = await this.stage(db, head.revision, {resolve: true});
        await this.acknowledge(await this.client.publish(pending), pending);
      }
    });
    return this.status();
  }
  async request(path, method = 'GET', body = {}) {
    const url = new URL(path, 'https://local.invalid');
    if (!url.pathname.startsWith('/api/library-sync/')) return undefined;
    const route = url.pathname.slice('/api/library-sync/'.length);
    if (route === 'status' && method === 'GET') return {result: await this.status()};
    if (route === 'editing' && method === 'POST') {await this.markEditing(body.editing === true); return {result: await this.status()};}
    if (route === 'run' && method === 'POST') {const result = await this.run(); return {result, database: await this.read()};}
    if (route === 'resolve' && method === 'POST') {const result = await this.resolve(body.choice); return {result, database: await this.read()};}
    if (route === 'download' && method === 'GET') {
      const variant = url.searchParams.get('variant') || body.variant || 'device';
      const result = variant === 'cloud' ? await this.client.download((await this.client.head()).commit) : libraryCapsule(await this.read());
      return {result};
    }
    fail('This library synchronization operation was not found.', 404);
  }
}
