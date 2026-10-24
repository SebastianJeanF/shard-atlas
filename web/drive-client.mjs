import {INBOX_LIMITS, parseInboxJSON, validateDriveSettings, validateInboxEnvelope} from './inbox.mjs';

export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.readonly';
const DRIVE_API = 'https://www.googleapis.com/drive/v3/';
const FILE_FIELDS = 'id,name,mimeType,size,parents,trashed';
const fail = (message, details = {}) => {throw Object.assign(new Error(message), details);};
const FILE_ID = /^[A-Za-z0-9_-]{10,200}$/;
const isBatch = file => typeof file?.name === 'string' && /\.json$/i.test(file.name) && !String(file.mimeType || '').startsWith('application/vnd.google-apps.');

export async function readBoundedText(response, maximum, onBytes = () => {}) {
  const declared = response.headers.get('Content-Length');
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > maximum)) {
    await response.body?.cancel().catch(() => {});
    fail('This Drive response exceeds the permitted size.', {status: 413});
  }
  if (!response.body?.getReader) fail('This browser cannot safely stream Drive files. Update the browser, or use Preview a file.');
  const reader = response.body.getReader(), decoder = new TextDecoder('utf-8', {fatal: true});
  let size = 0, result = '';
  try {
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      size += value.byteLength; onBytes(value.byteLength);
      if (size > maximum) fail('This Drive response exceeds the permitted size.', {status: 413});
      result += decoder.decode(value, {stream: true});
    }
    return result + decoder.decode();
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** Provider credentials are intentionally never written to browser storage. */
export class DriveInboxClient {
  #accessToken = null;
  #expiresAt = 0;
  #connecting = false;
  #syncing = false;

  constructor(settings, {fetch = globalThis.fetch.bind(globalThis), now = () => Date.now(), onState = () => {}} = {}) {
    this.settings = validateDriveSettings(settings);
    this.fetch = fetch; this.now = now; this.onState = onState;
    this.email = ''; this.status = 'disconnected';
  }

  get connected() {return !!this.#accessToken && this.now() < this.#expiresAt;}
  get syncing() {return this.#syncing;}

  disconnect() {
    this.#accessToken = null; this.#expiresAt = 0; this.email = ''; this.status = 'disconnected'; this.onState();
  }

  async connect(google = globalThis.google) {
    if (this.#connecting || this.#syncing) fail('Please wait for the current Drive operation to finish.');
    if (!this.settings.clientId || !this.settings.folderId) fail('Save a Google Web OAuth client ID and inbox folder ID first.');
    if (!google?.accounts?.oauth2?.initTokenClient) fail('Google sign-in could not load. Check your connection and browser content blockers, then try again.');
    this.#connecting = true; this.status = 'connecting'; this.onState();
    try {
      // There is no awaited operation before this call: preserve the click's
      // user activation so Google can open its authorization popup on mobile.
      const token = await new Promise((resolve, reject) => {
        const client = google.accounts.oauth2.initTokenClient({
          client_id: this.settings.clientId, scope: DRIVE_SCOPE, include_granted_scopes: false,
          login_hint: this.settings.expectedEmail || undefined,
          callback: response => {
            if (response.error) reject(new Error(response.error_description || 'Google authorization was declined.'));
            else if (!response.access_token || !google.accounts.oauth2.hasGrantedAllScopes(response, DRIVE_SCOPE)) reject(new Error('Google Drive read access was not granted.'));
            else resolve(response);
          },
          error_callback: error => reject(new Error(error.type === 'popup_closed' ? 'Google sign-in was closed. Connect again when ready.' : error.type === 'popup_failed_to_open' ? 'The browser blocked Google sign-in. Allow popups for Shard Atlas, then connect again.' : 'Google sign-in did not complete. Try connecting again.')),
        });
        client.requestAccessToken({prompt: 'select_account'});
      });
      const lifetime = Number(token.expires_in);
      if (!Number.isFinite(lifetime) || lifetime <= 0) fail('Google returned an invalid session lifetime. Please connect again.');
      this.#accessToken = token.access_token; this.#expiresAt = this.now() + Math.max(0, lifetime - 30) * 1000;
      const about = await this.request('about', {fields: 'user(emailAddress,displayName)'}, 64 * 1024);
      if (typeof about.user?.emailAddress !== 'string') fail('Google did not return the connected account. Please reconnect.');
      this.email = about.user.emailAddress;
      if (this.settings.expectedEmail && this.email.toLowerCase() !== this.settings.expectedEmail.toLowerCase()) fail(`Connected as ${this.email}. Use ${this.settings.expectedEmail} for this inbox.`);
      const folder = await this.request('files/' + this.settings.folderId, {fields: 'id,name,mimeType,trashed'}, 64 * 1024);
      if (folder.trashed || folder.mimeType !== 'application/vnd.google-apps.folder' || folder.id !== this.settings.folderId) fail('The configured inbox is not an available Google Drive folder.');
      this.status = 'connected'; this.onState();
      return {email: this.email, folderName: folder.name};
    } catch (error) {
      this.disconnect(); throw error;
    } finally {this.#connecting = false; this.onState();}
  }

  async response(path, parameters = {}) {
    if (!this.connected) {
      this.#accessToken = null; this.status = 'expired'; this.onState();
      fail('Your Google Drive session expired. Choose Reconnect Google Drive.', {reconnect: true});
    }
    const url = new URL(path, DRIVE_API);
    if (url.origin !== 'https://www.googleapis.com' || !url.pathname.startsWith('/drive/v3/')) fail('Unsupported Google Drive request.');
    url.search = new URLSearchParams(parameters).toString();
    let response;
    try {response = await this.fetch(url.href, {method: 'GET', headers: {Authorization: 'Bearer ' + this.#accessToken}, cache: 'no-store', credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(30_000)});} catch (error) {
      fail(error.name === 'TimeoutError' || error.name === 'AbortError' ? 'Google Drive took too long to respond. Sync again when your connection is ready.' : 'Google Drive could not be reached. Check your connection and try again.');
    }
    if (response.status === 401) {
      this.#accessToken = null; this.status = 'expired'; this.onState();
      fail('Your Google Drive session expired. Choose Reconnect Google Drive.', {reconnect: true});
    }
    if (!response.ok) {
      let detail = '', reasons = [];
      try {
        const error = JSON.parse(await readBoundedText(response, 64 * 1024)).error;
        detail = error?.message || ''; reasons = Array.isArray(error?.errors) ? error.errors.map(item => item.reason) : [];
      } catch {}
      const retry = response.headers.get('Retry-After');
      const stop = response.status === 429 || response.status === 503 && !!retry || reasons.some(reason => ['rateLimitExceeded', 'userRateLimitExceeded', 'dailyLimitExceeded'].includes(reason));
      fail((detail ? String(detail).slice(0, 500) : `Google Drive returned an error (${response.status}).`) + (retry ? ` Try again after ${/^\d+$/.test(retry) ? retry + ' seconds' : retry}.` : ''), {status: response.status, stop});
    }
    return response;
  }

  async request(path, parameters = {}, maximum = 2 * 1024 * 1024) {
    const response = await this.response(path, parameters);
    try {return parseInboxJSON(await readBoundedText(response, maximum));} catch (error) {
      if (error.status) throw error;
      fail('Google Drive returned an unreadable response. Try again.');
    }
  }

  async listFiles() {
    const files = [], seen = new Set(), pages = new Set();
    let pageToken = '', scanned = 0;
    do {
      const page = await this.request('files', {q: `'${this.settings.folderId}' in parents and trashed = false`, fields: `nextPageToken,incompleteSearch,files(${FILE_FIELDS})`, pageSize: '100', orderBy: 'name', ...(pageToken ? {pageToken} : {})});
      if (!Array.isArray(page.files) || page.incompleteSearch) fail('Google Drive could not return the complete inbox. Try again.');
      scanned += page.files.length;
      if (scanned > INBOX_LIMITS.entries) fail('The inbox contains too many entries. Keep at most 5,000 direct children in this folder.');
      for (const file of page.files) {
        if (!isBatch(file)) continue;
        if (!FILE_ID.test(file.id) || !Array.isArray(file.parents) || !file.parents.includes(this.settings.folderId) || file.trashed) fail('Google Drive returned an invalid inbox entry.');
        if (!seen.has(file.id)) {files.push(file); seen.add(file.id);}
        if (files.length > INBOX_LIMITS.files) fail('The inbox contains too many JSON files. Keep at most 500 batches in this folder.');
      }
      pageToken = page.nextPageToken || '';
      if (pageToken) {
        if (typeof pageToken !== 'string' || pageToken.length > 4096 || pages.has(pageToken) || pages.size >= 100) fail('Google Drive returned invalid pagination. Try again.');
        pages.add(pageToken);
      }
    } while (pageToken);
    return files;
  }

  async sync({importBatch, onProgress = () => {}}) {
    if (this.#syncing || this.#connecting) fail('Please wait for the current Drive operation to finish.');
    this.#syncing = true; this.onState();
    const result = {startedAt: new Date(this.now()).toISOString(), completedAt: null, files: [], email: this.email};
    let downloaded = 0;
    try {
      const files = await this.listFiles();
      for (const file of files) {
        const status = {id: file.id, name: file.name.slice(0, 500)};
        try {
          if (downloaded >= INBOX_LIMITS.totalBytes) fail('This sync reached its 64 MB download limit. Split the inbox into smaller groups.');
          // Recheck membership immediately before downloading; never follow a
          // shortcut or a provider-returned download URL outside this folder.
          const metadata = await this.request('files/' + file.id, {fields: FILE_FIELDS}, 64 * 1024);
          if (metadata.id !== file.id || !isBatch(metadata) || metadata.trashed || !metadata.parents?.includes(this.settings.folderId)) fail('This file is no longer an ordinary JSON file in the configured inbox.');
          const declared = Number(metadata.size);
          if (!Number.isSafeInteger(declared) || declared < 0 || declared > INBOX_LIMITS.fileBytes || declared > INBOX_LIMITS.totalBytes - downloaded) fail('This inbox file exceeds the permitted size.');
          const response = await this.response('files/' + file.id, {alt: 'media'});
          const text = await readBoundedText(response, Math.min(INBOX_LIMITS.fileBytes, INBOX_LIMITS.totalBytes - downloaded), count => {downloaded += count;});
          const envelope = parseInboxJSON(text); validateInboxEnvelope(envelope);
          const receipt = await importBatch(envelope, {id: file.id, name: file.name});
          Object.assign(status, {status: receipt.replayed ? 'replayed' : 'imported', requestId: receipt.requestId, added: receipt.added, skipped: receipt.skipped, warning: receipt.warning || ''});
        } catch (error) {
          Object.assign(status, {status: 'error', message: error.message});
          if (error.reconnect || error.stop) result.stoppedReason = error.message;
        }
        result.files.push(status); onProgress({...result, files: [...result.files], total: files.length});
        if (result.stoppedReason) break;
      }
      result.completedAt = new Date(this.now()).toISOString(); result.downloadedBytes = downloaded;
      return result;
    } finally {this.#syncing = false; this.onState();}
  }
}
