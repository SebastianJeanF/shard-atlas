/* Private library status. Device adapters retain drafts and pending edits locally. */
window.ShardAtlasLibraryUI = {displayState(current = {}) {
  const state = current.state || current.status || 'disabled';
  const urgent = ['conflict', 'migration_required', 'migration-required', 'update_required', 'incompatible_version', 'disabled', 'unconfigured', 'offline', 'sign-in-required', 'sign_in_required'];
  if (urgent.includes(state)) return state;
  if (current.cloudCheck?.state === 'unavailable') return 'check_unavailable';
  if (current.incomingAvailable) return 'incoming';
  if (current.syncing) return 'syncing';
  return state === 'synced' && (!current.cloudCheck || current.cloudCheck.state === 'unknown') ? 'unknown' : state;
}, install() {
  'use strict';
  if (document.getElementById('library-sync-dialog')) return;
  const clientId = window.crypto.randomUUID?.() || Array.from(window.crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
  let current = {}, loading = false;
  const labels = {synced: 'Library synced', pending: 'Changes waiting to sync', offline: 'Offline · changes saved here', conflict: 'Changes need review', migration_required: 'Library needs review', 'migration-required': 'Library needs review', 'sign-in-required': 'Sign in to sync', sign_in_required: 'Sign in to sync', disabled: 'Library sync not connected', unconfigured: 'Library sync not connected', idle: 'Checking library', syncing: 'Syncing library…', editing: 'Editor protected', incoming: 'New saved data available', check_unavailable: 'Data check unavailable', unknown: 'Data freshness unknown', update_required: 'Update required to sync', incompatible_version: 'Update required to sync'};
  const button = document.createElement('button');
  button.type = 'button'; button.className = 'nav-item library-sync-nav';
  button.setAttribute('aria-label', 'Library synchronization');
  button.textContent = '↻ Library sync';
  const dialog = document.createElement('dialog');
  dialog.id = 'library-sync-dialog'; dialog.className = 'settings-dialog library-sync-dialog';
  dialog.setAttribute('aria-labelledby', 'library-sync-title');
  dialog.innerHTML = '<div class="dialog-heading"><div><span class="eyebrow">YOUR LIBRARY DATA</span><h2 id="library-sync-title">Library sync</h2></div><button type="button" class="icon-button" aria-label="Close library sync">×</button></div><p class="library-sync-state" role="status" aria-live="polite"></p><p class="library-sync-message"></p><p class="library-sync-counts"></p><p class="library-sync-time"></p><p class="library-sync-checked"></p><div class="library-sync-actions"><button type="button" class="primary" data-sync="run">Sync now</button><button type="button" class="secondary" data-sync="export">Export this device’s copy</button></div><section class="library-sync-conflict" hidden><h3>Choose which copy to continue with</h3><p>Both copies are retained for recovery. Download this device’s copy before choosing. Your selection changes this device’s current library and will synchronize to your other devices.</p><div class="library-sync-actions"><button type="button" class="secondary" data-sync="cloud">Use cloud copy</button><button type="button" class="secondary" data-sync="device">Use this device’s copy</button></div></section><p class="library-sync-footnote">Your local copy stays available offline. Closed apps catch up when reopened. Unfinished editor drafts stay on the device where you started them.</p>';
  document.body.append(dialog);
  document.querySelector('.sidebar-bottom')?.prepend(button);
  const banner = document.createElement('button');
  banner.type = 'button'; banner.className = 'library-freshness-banner'; banner.hidden = true;
  banner.setAttribute('aria-label', 'Open library data status');
  document.querySelector('.topbar')?.after(banner);
  banner.addEventListener('click', () => {dialog.showModal(); void refresh();});
  dialog.querySelector('[aria-label="Close library sync"]').addEventListener('click', () => dialog.close());
  button.addEventListener('click', () => {dialog.showModal(); void refresh();});

  async function request(path, body) {
    const response = await window.ShardAtlasPlatform.request(path, body ? {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)} : {});
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Synchronization could not finish. Your local copy is retained.');
    return result;
  }
  function render(value) {
    current = value || {};
    const state = window.ShardAtlasLibraryUI.displayState(current);
    const configured = !!current.configured;
    const label = labels[state] || (configured ? 'Library sync' : labels.disabled);
    button.textContent = '↻ ' + label;
    button.dataset.syncState = state;
    banner.dataset.syncState = state;
    banner.hidden = !['incoming', 'check_unavailable', 'offline', 'conflict', 'migration_required', 'migration-required', 'update_required', 'incompatible_version', 'sign-in-required', 'sign_in_required'].includes(state);
    banner.textContent = 'Library · ' + label + ' · View details';
    dialog.querySelector('.library-sync-state').textContent = label;
    dialog.querySelector('.library-sync-message').textContent = current.message || (configured ? 'Your saved library is shared across your signed-in devices.' : 'This installation has not been connected to the private shared library yet.');
    const local = current.localCounts?.shards ?? current.localCount;
    const remote = current.remoteCounts?.shards ?? current.remoteCount;
    dialog.querySelector('.library-sync-counts').textContent = [Number.isInteger(local) ? `${local} shards on this device` : '', Number.isInteger(remote) ? `${remote} shards in the cloud copy` : ''].filter(Boolean).join(' · ');
    dialog.querySelector('.library-sync-time').textContent = current.lastSyncedAt ? 'Last synced: ' + new Date(current.lastSyncedAt).toLocaleString() : '';
    dialog.querySelector('.library-sync-checked').textContent = current.cloudCheck?.checkedAt ? 'Data checked: ' + new Date(current.cloudCheck.checkedAt).toLocaleString() : 'Data has not been checked yet.';
    dialog.querySelector('[data-sync="run"]').disabled = !configured || loading;
    const conflict = ['conflict', 'migration_required', 'migration-required'].includes(state);
    dialog.querySelector('.library-sync-conflict').hidden = !conflict;
    for (const control of dialog.querySelectorAll('[data-sync="cloud"], [data-sync="device"]')) control.disabled = loading;
  }
  async function refresh() {
    try {render(await request('/api/library-sync/status'));}
    catch (error) {render({...current, state: 'check_unavailable', status: 'check_unavailable', message: error.message, cloudCheck: {...current.cloudCheck, state: 'unavailable'}});}
  }
  async function download() {
    const anchor = document.createElement('a');
    anchor.href = '/api/export'; anchor.download = 'shard-atlas-before-sync.json';
    document.body.append(anchor); anchor.click(); anchor.remove();
  }
  dialog.addEventListener('click', async event => {
    const choice = event.target.closest('[data-sync]')?.dataset.sync;
    if (!choice || loading) return;
    if (choice === 'export') {try {await download();} catch (error) {dialog.querySelector('.library-sync-message').textContent = error.message;} return;}
    if (choice !== 'run' && !window.confirm(choice === 'cloud' ? 'Use the cloud copy as your current library? A safety copy of this device’s library is retained.' : 'Use this device’s library as the shared current copy? The earlier cloud copy is retained in recovery history.')) return;
    loading = true; render(current);
    try {
      const result = await request(choice === 'run' ? '/api/library-sync/run' : '/api/library-sync/resolve', choice === 'run' ? {} : {choice});
      render(result);
      document.dispatchEvent(new CustomEvent('shard-atlas-library-updated'));
    } catch (error) {dialog.querySelector('.library-sync-message').textContent = error.message;}
    finally {loading = false; await refresh();}
  });
  document.addEventListener('shard-atlas-library-status', () => void refresh());
  window.addEventListener('online', () => void refresh());
  let lastEditing, lastLease = 0;
  async function editingLease(forceEditing = false) {
    if (window.shardAtlasLibrarySync) return;
    const editing = forceEditing || (window.ShardAtlasHasUnsavedLibraryChanges?.() ?? !window.ShardAtlasCanApplyLibrary?.());
    if (editing === lastEditing && Date.now() - lastLease < 10_000) return;
    lastEditing = editing; lastLease = Date.now();
    try {await request('/api/library-sync/editing', {editing, clientId});} catch {}
  }
  document.addEventListener('input', () => void editingLease(true), true);
  document.addEventListener('click', () => setTimeout(() => void editingLease(), 0));
  setInterval(() => void editingLease(), 2000);
  setInterval(() => {if (document.visibilityState !== 'hidden') void refresh();}, 15_000);
  void editingLease();
  void refresh();
  return {refresh, get status() {return current;}};
}};
