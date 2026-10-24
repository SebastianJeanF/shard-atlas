import {emptyDatabase, handleCore, saveBackup} from './model.mjs';
import {fingerprint, handleArchives} from './archives.mjs';
import {handleInbox} from './inbox.mjs';

// One read/modify/write transaction prevents a second tab from overwriting a
// change made by this tab. Resolve only after the write commits successfully.
export class BrowserStore {
  constructor(indexedDB = globalThis.indexedDB, {deferStateObservation = false} = {}) {
    this.listeners = new Set();
    this.observedRevision = null;
    this.observedArchiveFingerprint = null;
    this.deferStateObservation = deferStateObservation;
    if (!indexedDB) throw new Error('This browser cannot store your atlas. Open it in Safari with website storage enabled.');
    this.ready = new Promise((resolve, reject) => {
      const request = indexedDB.open('shard-atlas-phone', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('collection');
      request.onsuccess = () => {
        const database = request.result;
        database.onversionchange = () => database.close();
        resolve(database);
      };
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error('Close other Shard Atlas tabs and reopen the app to update storage.'));
    });
  }

  async request(path, method = 'GET', body = {}) {
    const readonly = method === 'GET' || path === '/api/import/preview' || path === '/api/import-preview';
    const saved = await this.atomic(data => {
      const knowledgeWrite = !readonly && !/^\/api\/(?:drafts|drive\/settings|backup$)/.test(path);
      if (knowledgeWrite && this.observedRevision !== null && data.librarySync && data.librarySync.revision !== this.observedRevision && fingerprint(data.archive) !== this.observedArchiveFingerprint) {
        // A suspended dirty tab can outlive its edit lease. Preserve the current
        // shared copy and force its later stale save through cloud conflict CAS.
        saveBackup(data);
        data.librarySync.forceConflictBase = this.observedRevision;
        data.librarySync.baseFingerprint = null;
        data.librarySync.state = 'pending';
      }
      let result = handleInbox(data, path, method, body);
      if (result === undefined) result = handleArchives(data, path, method, body);
      if (result === undefined) result = handleCore(data, path, method, body);
      if (result === undefined) throw Object.assign(new Error('This operation is unavailable in the phone app.'), {status: 404});
      if (!readonly) data.localGeneration = (data.localGeneration || 0) + 1;
      return result;
    }, {readonly, notify: !readonly});
    if ((path === '/api/state' || path === '/api/data') && !this.deferStateObservation || !readonly && !/^\/api\/(?:drafts|drive\/settings|backup$)/.test(path)) this.acceptState(saved.database);
    return saved;
  }

  // A production UI acknowledges only snapshots it actually renders. A state
  // read discarded after an editor opens must not advance that editor's base.
  acceptState(databaseSnapshot) {
    this.observedRevision = databaseSnapshot.librarySync?.revision || '';
    this.observedArchiveFingerprint = fingerprint(databaseSnapshot.archive);
  }

  subscribe(listener) {this.listeners.add(listener); return () => this.listeners.delete(listener);}

  // Mutators must be synchronous: network and hashing run outside the IDB
  // transaction, then generation/lease guards are checked atomically on apply.
  async atomic(mutator, {readonly = false, notify = false} = {}) {
    const database = await this.ready;
    return new Promise((resolve, reject) => {
      const transaction = database.transaction('collection', readonly ? 'readonly' : 'readwrite');
      const collection = transaction.objectStore('collection');
      const request = collection.get('atlas');
      let result, saved, failure;
      request.onsuccess = () => {
        try {
          const data = request.result || emptyDatabase();
          result = mutator(data);
          if (result && typeof result.then === 'function') throw new Error('Storage transactions cannot wait for asynchronous work.');
          saved = data;
          if (!readonly) collection.put(data, 'atlas');
        } catch (error) {
          failure = error;
          transaction.abort();
        }
      };
      transaction.oncomplete = () => {
        resolve({result, database: saved});
        if (notify) for (const listener of this.listeners) {try {listener();} catch { /* A UI callback must not turn a committed save into a failure. */ }}
      };
      transaction.onabort = () => reject(failure || storageError(transaction.error));
      transaction.onerror = () => { failure ||= storageError(transaction.error); };
    });
  }
}

function storageError(error) {
  if (error?.name === 'QuotaExceededError') return new Error('Your device has insufficient storage. This change was not saved. Export your atlas and free some space before trying again.');
  return error || new Error('Your device could not save the change. Your previous saved atlas is retained.');
}
