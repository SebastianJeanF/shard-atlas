import {emptyDatabase, handleCore} from './model.mjs';
import {handleArchives} from './archives.mjs';

// One read/modify/write transaction prevents a second tab from overwriting a
// change made by this tab. Resolve only after the write commits successfully.
export class BrowserStore {
  constructor(indexedDB = globalThis.indexedDB) {
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
    const database = await this.ready;
    const readonly = method === 'GET' || path === '/api/import/preview' || path === '/api/import-preview';
    return new Promise((resolve, reject) => {
      const transaction = database.transaction('collection', readonly ? 'readonly' : 'readwrite');
      const collection = transaction.objectStore('collection');
      const request = collection.get('atlas');
      let result, saved, failure;
      request.onsuccess = () => {
        try {
          const data = request.result || emptyDatabase();
          result = handleArchives(data, path, method, body);
          if (result === undefined) result = handleCore(data, path, method, body);
          if (result === undefined) throw Object.assign(new Error('This operation is unavailable in the phone app.'), {status: 404});
          saved = data;
          if (!readonly) collection.put(data, 'atlas');
        } catch (error) {
          failure = error;
          transaction.abort();
        }
      };
      transaction.oncomplete = () => resolve({result, database: saved});
      transaction.onabort = () => reject(failure || storageError(transaction.error));
      transaction.onerror = () => { failure ||= storageError(transaction.error); };
    });
  }
}

function storageError(error) {
  if (error?.name === 'QuotaExceededError') return new Error('Your device has insufficient storage. This change was not saved. Export your atlas and free some space before trying again.');
  return error || new Error('Your device could not save the change. Your previous saved atlas is retained.');
}
