/* Software freshness is independent of the saved library's synchronization. */
(function (root) {
  'use strict';
  const keys = ['releaseId', 'frontendId', 'backendId', 'hostedId', 'nativeId'];
  const labels = {checking: 'Checking app version…', up_to_date: 'App up to date', update_available: 'App update available', restart_required: 'Restart required', native_update_required: 'Mac app update required', versions_differ: 'App versions differ', unknown: 'App version unknown', offline: 'App check unavailable offline'};
  const messages = {
    checking: 'Checking this app against the latest published release.',
    up_to_date: 'The loaded app matches the latest published release for this device.',
    update_available: 'A different interface has been published. Save your work, then close all Shard Atlas website windows and reopen.',
    restart_required: 'Updated application files are installed. Save your work, quit Shard Atlas normally, and reopen it.',
    native_update_required: 'This Mac window needs an updated app build. Save your work, then rebuild and install the current Mac app.',
    versions_differ: 'This installation differs from the published release. It may contain newer development work or an older installation; compare the versions before replacing it.',
    unknown: 'The latest published app version could not be verified. Your saved library remains available.',
    offline: 'Connect to check the latest published app version. Your saved library remains available.',
  };
  function validManifest(value) {
    return value?.schemaVersion === 1 && value.application === 'shard-atlas' && keys.every(key => /^[a-f0-9]{64}$/.test(value[key] || ''));
  }
  function classify(current, published) {
    if (!validManifest(current) || !validManifest(published)) return 'unknown';
    return current.frontendId === published.frontendId ? 'up_to_date' : 'update_available';
  }
  function install() {
    if (!root.document || root.document.getElementById('app-release-dialog')) return;
    const document = root.document;
    const native = root.isShardAtlasDesktop === true;
    // Retain the identity loaded with this document. Fetching build-info later
    // could report a newer disk copy that this window has never loaded.
    const loaded = root.SHARD_ATLAS_RELEASE ? {...root.SHARD_ATLAS_RELEASE} : null;
    const nativeId = root.SHARD_ATLAS_NATIVE?.nativeId || '';
    let status = {state: 'checking'}, running = null;
    const nav = document.createElement('button');
    nav.type = 'button'; nav.className = 'nav-item app-release-nav'; nav.setAttribute('aria-label', 'Application version status');
    const banner = document.createElement('button');
    banner.type = 'button'; banner.className = 'app-release-banner'; banner.hidden = true;
    banner.setAttribute('aria-label', 'Open application update details');
    const dialog = document.createElement('dialog');
    dialog.id = 'app-release-dialog'; dialog.className = 'settings-dialog app-release-dialog';
    dialog.setAttribute('aria-labelledby', 'app-release-title');
    dialog.innerHTML = '<div class="dialog-heading"><div><span class="eyebrow">APPLICATION SOFTWARE</span><h2 id="app-release-title">App version</h2></div><button type="button" class="icon-button" aria-label="Close app version">×</button></div><p class="app-release-state" role="status" aria-live="polite"></p><p class="app-release-message"></p><p class="app-release-time"></p><div class="app-release-actions"><button type="button" class="primary" data-release="check">Check again</button><button type="button" class="secondary" data-release="reload" hidden>Reload website</button></div><p class="app-release-work" role="status"></p><details class="app-release-details"><summary>Version details</summary><dl></dl></details><p class="app-release-footnote">Library sync shows whether your saved knowledge is shared. This check shows whether the application software matches the published release.</p>';
    document.body.append(dialog);
    document.querySelector('.sidebar-bottom')?.prepend(nav);
    document.querySelector('.topbar')?.after(banner);
    const open = () => {dialog.showModal(); void check();};
    nav.addEventListener('click', open); banner.addEventListener('click', open);
    dialog.querySelector('[aria-label="Close app version"]').addEventListener('click', () => dialog.close());
    function render(value) {
      status = value;
      const state = Object.hasOwn(labels, value.state) ? value.state : 'unknown';
      const label = labels[state];
      nav.textContent = '◉ ' + label; nav.dataset.releaseState = state;
      banner.textContent = label + ' · View details'; banner.dataset.releaseState = state;
      banner.hidden = !['update_available', 'restart_required', 'native_update_required', 'versions_differ'].includes(state);
      dialog.querySelector('.app-release-state').textContent = label;
      dialog.querySelector('.app-release-message').textContent = value.message || messages[state];
      dialog.querySelector('.app-release-time').textContent = value.checkedAt ? 'App checked: ' + new Date(value.checkedAt).toLocaleString() : 'A successful app version check has not completed.';
      dialog.querySelector('[data-release="check"]').disabled = state === 'checking';
      dialog.querySelector('[data-release="reload"]').hidden = native || state !== 'update_available';
      const details = dialog.querySelector('.app-release-details dl');
      details.replaceChildren();
      for (const [name, manifest] of [['Loaded', loaded], ['Published', value.published], ['On this Mac', value.disk]]) {
        if (!manifest) continue;
        const term = document.createElement('dt'), description = document.createElement('dd');
        term.textContent = name; description.textContent = manifest.releaseId || 'Unknown';
        details.append(term, description);
      }
      if (native) {
        const term = document.createElement('dt'), description = document.createElement('dd');
        term.textContent = 'Compiled Mac window'; description.textContent = nativeId || 'Missing build identity'; details.append(term, description);
      }
    }
    async function check() {
      if (running) return running;
      const previous = status;
      render({...previous, state: 'checking', message: messages.checking});
      running = (async () => {
        if (!native && root.navigator?.onLine === false) {render({state: 'offline', message: messages.offline}); return;}
        const controller = new AbortController();
        const timeout = root.setTimeout(() => controller.abort(), 15_000);
        try {
          const path = native ? '/api/release-status?' + new URLSearchParams({frontendId: loaded?.frontendId || '', nativeId}) : '/api/release';
          const response = await root.ShardAtlasPlatform.request(path, {cache: 'no-store', credentials: 'same-origin', signal: controller.signal, headers: {'Accept': 'application/json'}});
          if (!response.ok) throw new Error(response.status === 401 || response.status === 403 ? 'Sign in to check the published app version.' : 'The published app version could not be checked. Try again while connected.');
          const result = await response.json();
          if (root.navigator?.onLine === false && (!native || !['restart_required', 'native_update_required'].includes(result.state))) {render({state: 'offline', message: messages.offline}); return;}
          if (native) {
            const safeState = Object.hasOwn(labels, result.state) ? result.state : 'unknown';
            if (safeState === 'up_to_date' && (!validManifest(loaded) || !validManifest(result.published) || loaded.frontendId !== result.published.frontendId || nativeId !== result.published.nativeId)) {
              render({...result, state: 'unknown', message: 'The loaded Mac app identity could not be verified against the published release.'});
            } else render({...result, state: safeState});
          } else {
            const state = classify(loaded, result);
            render({state, message: messages[state], current: loaded, published: validManifest(result) ? result : null, checkedAt: state === 'unknown' ? null : new Date().toISOString()});
          }
        } catch (error) {
          render({state: root.navigator?.onLine === false ? 'offline' : 'unknown', message: error.name === 'AbortError' ? 'The app version check timed out. Try again while connected.' : error.message || messages.unknown});
        } finally {root.clearTimeout(timeout);}
      })().finally(() => {running = null;});
      return running;
    }
    dialog.addEventListener('click', async event => {
      const action = event.target.closest('[data-release]')?.dataset.release;
      if (action === 'check') await check();
      if (action === 'reload') {
        const work = dialog.querySelector('.app-release-work');
        if (root.ShardAtlasHasUnsavedLibraryChanges?.() !== false) {work.textContent = 'Finish or save your open work before reloading. Your editor has been kept open.'; return;}
        // A waiting worker cannot replace another open tab safely. Keep its
        // normal activation lifecycle and ask the user to close all windows.
        const registration = await root.navigator.serviceWorker?.getRegistration?.().catch(() => null);
        if (registration?.waiting) {work.textContent = 'The update is ready. Close all Shard Atlas website windows, then reopen to install it.'; return;}
        root.location.reload();
      }
    });
    root.addEventListener('focus', () => void check());
    root.addEventListener('online', () => void check());
    root.addEventListener('offline', () => {render({state: 'offline', message: messages.offline}); if (native) void check();});
    document.addEventListener('visibilitychange', () => {if (document.visibilityState === 'visible') void check();});
    root.setInterval(() => {if (document.visibilityState !== 'hidden') void check();}, 60_000);
    render(status); void check();
    return {check, get status() {return status;}};
  }
  root.ShardAtlasReleaseUI = Object.freeze({install, classify, validManifest});
})(window);
