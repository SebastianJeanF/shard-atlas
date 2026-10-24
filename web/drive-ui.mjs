import {DriveInboxClient} from './drive-client.mjs';
import {validateDriveSettings} from './inbox.mjs';

export function resolveDriveSettings(configuration = {}, saved = {}) {
  const settings = {clientId: '', folderId: '', expectedEmail: '', ...configuration, ...saved};
  // A blank client saved before deployment must not hide the app's later setup.
  // Keep nonblank custom clients and all other device-specific choices.
  if (typeof saved.clientId === 'string' && !saved.clientId.trim() && typeof configuration.clientId === 'string') settings.clientId = configuration.clientId;
  return validateDriveSettings(settings);
}

let googleLibrary;
function loadGoogleLibrary() {
  if (globalThis.google?.accounts?.oauth2) return Promise.resolve();
  if (googleLibrary) return googleLibrary;
  googleLibrary = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    const timer = setTimeout(() => {script.remove(); reject(new Error('Google sign-in could not load. Check your connection or content blocker, then reopen Google Drive.'));}, 15_000);
    script.src = 'https://accounts.google.com/gsi/client'; script.async = true; script.referrerPolicy = 'strict-origin-when-cross-origin';
    script.onload = () => {clearTimeout(timer); resolve();};
    script.onerror = () => {clearTimeout(timer); script.remove(); reject(new Error('Google sign-in could not load. Check your connection or content blocker, then reopen Google Drive.'));};
    document.head.append(script);
  }).catch(error => {googleLibrary = null; throw error;});
  return googleLibrary;
}

export async function mountDriveInbox({store, fetch, message}) {
  const dialog = document.createElement('dialog'); dialog.id = 'drive-dialog'; dialog.className = 'history-dialog drive-dialog';
  dialog.setAttribute('aria-labelledby', 'drive-title');
  dialog.innerHTML = '<div class="dialog-heading"><div><span class="eyebrow">CAPTURE FROM ANY DEVICE</span><h2 id="drive-title">Google Drive inbox</h2></div><button type="button" class="icon-button" data-drive="close" aria-label="Close Google Drive">×</button></div>' +
    '<p class="dialog-intro">Read additions from your shared inbox into this device’s atlas. Your Mac can import the same files when it is online. Existing notes and Drive files are preserved.</p>' +
    '<p id="drive-connection" class="drive-connection" role="status">Opening Drive settings…</p>' +
    '<div class="drive-actions"><button type="button" class="primary" id="drive-connect" disabled>Connect Google Drive</button><button type="button" class="secondary" id="drive-sync" disabled>Sync inbox</button><button type="button" class="text-button" id="drive-disconnect" hidden>Disconnect</button></div>' +
    '<p id="drive-error" class="form-error" role="alert" hidden></p>' +
    '<details id="drive-settings"><summary>Connection settings</summary><form id="drive-settings-form"><label class="field">Google Web OAuth client ID<input name="clientId" placeholder="…apps.googleusercontent.com" autocomplete="off" spellcheck="false"></label><label class="field">Inbox folder ID<input name="folderId" autocomplete="off" spellcheck="false"></label><label class="field">Expected Google account<input name="expectedEmail" type="email" autocomplete="email"></label><p class="dialog-intro">A one-time Google Cloud setup is needed: enable Drive API, add this site as an authorized JavaScript origin, and create a Web application OAuth client. Enter its public client ID here. <a href="https://developers.google.com/identity/oauth2/web/guides/get-google-api-clientid" target="_blank" rel="noopener noreferrer">Google’s setup guide ↗</a></p><p class="dialog-intro">Google’s read-only permission covers your Drive. Shard Atlas reads JSON files only from the configured inbox. This connection cannot upload, edit, or delete Drive files. Authorization stays in memory; reconnect when your session expires.</p><button type="submit" class="secondary">Save settings</button></form></details>' +
    '<p id="drive-folder" class="drive-folder"></p><section class="drive-results" aria-labelledby="drive-results-title"><h3 id="drive-results-title">Latest sync</h3><p id="drive-summary" role="status">No inbox sync has run on this device.</p><ul id="drive-results"></ul></section>' +
    '<details class="drive-receipts"><summary>Recent import receipts</summary><ul id="drive-receipts"></ul><p class="dialog-intro">Receipts belong to this device’s collection and its recovery snapshots. They prevent replays from undoing later edits or deletions. Keep inbox batches unchanged.</p></details>';
  document.body.append(dialog);
  const $ = selector => dialog.querySelector(selector), form = $('#drive-settings-form');
  const open = document.createElement('button'); open.type = 'button'; open.className = 'secondary'; open.textContent = 'Google Drive';
  document.querySelector('#ai-dialog .ai-actions').prepend(open);
  let settings = {}, client, loading = true, googleReady = false;
  const error = value => {$('#drive-error').textContent = value || ''; $('#drive-error').hidden = !value;};
  const date = value => value ? new Date(value).toLocaleString() : '';
  function renderConnection() {
    const connected = client?.connected, connecting = client?.status === 'connecting', syncing = client?.syncing;
    const expired = client?.status === 'expired' || client?.status === 'connected' && !connected;
    $('#drive-connect').textContent = expired || connected ? 'Reconnect Google Drive' : 'Connect Google Drive';
    $('#drive-connect').disabled = loading || !googleReady || connecting || syncing || !settings.clientId || !settings.folderId;
    $('#drive-sync').disabled = !connected || syncing || connecting;
    $('#drive-sync').textContent = syncing ? 'Syncing…' : 'Sync inbox';
    $('#drive-disconnect').hidden = !connected; $('#drive-disconnect').disabled = syncing;
    for (const input of form.elements) input.disabled = loading || connecting || syncing;
    $('#drive-connection').textContent = loading ? 'Opening Drive settings…' : syncing ? `Syncing as ${client.email}…` : connecting ? 'Complete Google’s sign-in window…' : connected ? `Connected as ${client.email}` : !settings.clientId ? 'Add a Google Web OAuth client ID in Connection settings to enable Connect.' : expired ? 'Your Google session expired. Reconnect to read the inbox.' : 'Connect Google Drive to read the inbox.';
    $('#drive-folder').replaceChildren();
    if (settings.folderId) {const link = document.createElement('a'); link.href = 'https://drive.google.com/drive/folders/' + settings.folderId; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.textContent = 'Open inbox in Google Drive ↗'; $('#drive-folder').append(link);}
  }
  function renderRun(run) {
    const list = $('#drive-results'); list.replaceChildren();
    if (!run) {$('#drive-summary').textContent = 'No inbox sync has run on this device.'; return;}
    const files = run.files || [], errors = files.filter(file => file.status === 'error').length, imported = files.filter(file => file.status === 'imported').length, replays = files.filter(file => file.status === 'replayed').length;
    $('#drive-summary').textContent = run.error ? run.error : `${run.completedAt ? 'Completed ' + date(run.completedAt) : 'Syncing'} · ${imported} imported · ${replays} already processed · ${errors} failed${run.stoppedReason ? ' · ' + run.stoppedReason : ''}` + (!files.length && run.completedAt ? ' · Inbox has no JSON batches.' : '');
    for (const file of files) {
      const item = document.createElement('li'), title = document.createElement('strong'), detail = document.createElement('span');
      title.textContent = String(file.name || 'Inbox batch');
      detail.textContent = file.status === 'error' ? 'Could not import: ' + file.message : file.status === 'replayed' ? 'Already processed. No changes made.' : `${file.added?.shards || 0} notes and ${file.added?.links || 0} relationships added; ${file.skipped?.shards || 0} notes reused.`;
      if (file.warning) detail.textContent += ' ' + file.warning;
      item.className = file.status === 'error' ? 'drive-result-error' : 'drive-result-success'; item.append(title, detail); list.append(item);
    }
  }
  async function renderReceipts() {
    const {result} = await store.request('/api/drive/status');
    const list = $('#drive-receipts'); list.replaceChildren();
    for (const receipt of result.receipts) {
      const item = document.createElement('li'), heading = document.createElement('strong'), detail = document.createElement('span');
      heading.textContent = `${receipt.file?.name || receipt.requestId} · ${date(receipt.createdAt)}`;
      detail.textContent = `${receipt.added.shards} notes and ${receipt.added.links} relationships added.` + (receipt.warning ? ' ' + receipt.warning : '');
      item.append(heading, detail); list.append(item);
    }
    if (!result.receipts.length) {const item = document.createElement('li'); item.textContent = 'No inbox import receipts yet.'; list.append(item);}
    return result;
  }
  async function prepareGoogle() {
    googleReady = false; renderConnection();
    try {await loadGoogleLibrary(); googleReady = true; renderConnection();} catch (failure) {error(failure.message);}
  }
  function setClient() {client?.disconnect(); client = new DriveInboxClient(settings, {fetch, onState: renderConnection}); renderConnection();}
  open.addEventListener('click', async () => {
    document.querySelector('#ai-dialog').close(); dialog.showModal(); error('');
    try {const status = await renderReceipts(); renderRun(status.lastRun);} catch (failure) {error(failure.message);}
    void prepareGoogle();
  });
  $('[data-drive="close"]').addEventListener('click', () => dialog.close());
  $('#drive-connect').addEventListener('click', () => {
    error('');
    void client.connect().then(() => message('Google Drive connected. Choose Sync inbox to import additions.')).catch(failure => error(failure.message));
  });
  $('#drive-disconnect').addEventListener('click', () => {client.disconnect(); error('');});
  form.addEventListener('submit', async event => {
    event.preventDefault(); error('');
    try {
      const next = validateDriveSettings(Object.fromEntries(new FormData(form)));
      await store.request('/api/drive/settings', 'PUT', next);
      settings = next; setClient(); message('Drive settings saved on this device.');
      if (!googleReady) void prepareGoogle();
    } catch (failure) {error(failure.message);}
  });
  $('#drive-sync').addEventListener('click', async () => {
    error('');
    let run;
    try {
      run = await client.sync({
        importBatch: async (envelope, file) => {
          const {result} = await store.request('/api/drive/import', 'POST', {envelope, file});
          document.dispatchEvent(new CustomEvent('shard-atlas-inbox-imported'));
          return result.receipt;
        }, onProgress: renderRun,
      });
      await store.request('/api/drive/status', 'PUT', run);
      renderRun(run); await renderReceipts();
      message(run.files.some(file => file.status === 'error') || run.stoppedReason ? 'Sync finished with issues. Review the file results.' : 'Inbox checked. Your additions are saved on this device.');
    } catch (failure) {
      error(failure.message);
      if (!run) {
        run = {startedAt: new Date().toISOString(), completedAt: new Date().toISOString(), files: [], error: failure.message};
        await store.request('/api/drive/status', 'PUT', run).catch(() => {}); renderRun(run);
      }
    }
  });
  try {
    const [configuration, status] = await Promise.allSettled([fetch('/drive-config.json', {cache: 'no-store'}).then(response => response.ok ? response.json() : {}), store.request('/api/drive/status')]);
    if (status.status === 'rejected') throw status.reason;
    settings = resolveDriveSettings(configuration.status === 'fulfilled' ? configuration.value : {}, status.value.result.settings);
    for (const [key, value] of Object.entries(settings)) form.elements.namedItem(key).value = value;
    loading = false; setClient(); renderRun(status.value.result.lastRun);
    if (!settings.clientId) $('#drive-settings').open = true;
  } catch (failure) {loading = false; error(failure.message); renderConnection(); $('#drive-settings').open = true;}
  setInterval(() => {if (dialog.open) renderConnection();}, 15_000);
}
