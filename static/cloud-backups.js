/* Drive recovery status is separate from live library synchronization. */
(function (root) {
  'use strict';
  const labels = {verified: 'Drive backup verified', pending: 'Drive backup pending', attention: 'Drive backup needs attention',
    unavailable: 'Drive backup check unavailable', unconfigured: 'Drive backups not enabled'};
  function displayState(value = {}) {
    if (value.checkUnavailable) return 'unavailable';
    if (!value.configured) return 'unconfigured';
    if (value.state === 'attention' || value.lastAttempt?.error || ['failed', 'error'].includes(value.lastAttempt?.status)) return 'attention';
    if (value.state === 'pending' || value.pendingCount > 0) return 'pending';
    return value.lastVerified?.driveFileId ? 'verified' : 'pending';
  }
  function sizeLabel(bytes) {
    if (!Number.isFinite(bytes) || bytes < 0) return '';
    return bytes < 1_000_000 ? Math.ceil(bytes / 1000) + ' KB' : (bytes / 1_000_000).toFixed(1) + ' MB';
  }
  const textTime = value => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString() : '';
  const requestId = () => root.crypto.randomUUID?.() || Array.from(root.crypto.getRandomValues(new Uint8Array(16)), value => value.toString(16).padStart(2, '0')).join('');
  root.ShardAtlasCloudBackupUI = {displayState, sizeLabel, install({message = () => {}} = {}) {
    if (document.getElementById('cloud-backups-dialog')) return;
    const settings = document.getElementById('settings-dialog');
    if (!settings) return;
    let current = {}, loading = false, catalog = [], catalogCursor = null, restores = [], active = false;
    const summary = document.createElement('section');
    summary.className = 'cloud-backups-summary';
    summary.innerHTML = '<div><h3>Google Drive backups</h3><p class="cloud-backups-summary-state" role="status" aria-live="polite">Checking backup status…</p><p class="cloud-backups-summary-time"></p></div><button type="button" class="secondary" data-cloud-backups="open">View backups</button>';
    settings.querySelector('.dialog-intro')?.after(summary);
    const dialog = document.createElement('dialog');
    dialog.id = 'cloud-backups-dialog'; dialog.className = 'history-dialog cloud-backups-dialog';
    dialog.setAttribute('aria-labelledby', 'cloud-backups-title');
    dialog.innerHTML = '<div class="dialog-heading"><div><span class="eyebrow">RECOVERY COPIES IN DRIVE</span><h2 id="cloud-backups-title">Cloud backups</h2></div><button type="button" class="icon-button" data-cloud-backups="close" aria-label="Close cloud backups">×</button></div><p class="cloud-backups-state" role="status" aria-live="polite"></p><p class="cloud-backups-message"></p><p class="cloud-backups-time"></p><p class="cloud-backups-local"></p><div class="cloud-backups-actions"><button type="button" class="primary" data-cloud-backups="request">Back up saved library</button><button type="button" class="secondary" data-cloud-backups="refresh">Refresh status</button></div><p class="dialog-intro">Backups protect your saved library separately from Library sync. A background service copies changed cloud versions into Drive, even while your devices are off.</p><p class="cloud-backups-error form-error" role="alert" hidden></p><section class="cloud-backups-restores" hidden><h3>Restore review</h3><div class="cloud-backups-restore-list"></div></section><section><h3>Verified library backups</h3><p class="dialog-intro">Review a recovery point before restoring. Your current cloud collection is preserved first. Devices with unfinished changes will require review.</p><div class="cloud-backups-catalog"></div></section>';
    document.body.append(dialog);
    const older = document.createElement('button');
    older.type = 'button'; older.className = 'secondary'; older.dataset.cloudBackups = 'older';
    older.textContent = 'Load older backups'; older.hidden = true;
    dialog.querySelector('.cloud-backups-catalog').after(older);

    function node(tag, content, className) {
      const element = document.createElement(tag); element.textContent = content;
      if (className) element.className = className;
      return element;
    }
    async function request(path, body) {
      const response = await root.ShardAtlasPlatform.request('/api/cloud-backups' + path, body === undefined ? {cache: 'no-store'}
        : {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)});
      let result;
      try {result = await response.json();} catch {throw new Error('The backup service did not return a valid response.');}
      if (!response.ok) throw new Error(result.error?.message || result.error || 'The backup service could not finish this request.');
      return result;
    }
    function showError(error) {
      const element = dialog.querySelector('.cloud-backups-error');
      element.textContent = error?.message || String(error); element.hidden = false;
    }
    function renderStatus(value) {
      current = value || {};
      const state = displayState(current), latest = current.lastVerified;
      active = current.localPolicy?.mode === 'cloud' || current.mode === 'cloud' && current.managed === true && !!latest?.driveFileId && current.localHistoryAllowed === false;
      summary.dataset.backupState = state;
      summary.querySelector('.cloud-backups-summary-state').textContent = labels[state];
      const time = latest ? 'Last verified: ' + textTime(latest.verifiedAt || latest.createdAt) : 'No verified Drive backup yet.';
      summary.querySelector('.cloud-backups-summary-time').textContent = time;
      dialog.querySelector('.cloud-backups-state').textContent = labels[state];
      dialog.querySelector('.cloud-backups-time').textContent = time + (latest?.compressedBytes ? ' · ' + sizeLabel(latest.compressedBytes) : '');
      dialog.querySelector('.cloud-backups-message').textContent = current.message || current.lastAttempt?.error
        || (current.pendingCount ? 'Your saved data is waiting for the background service to finish its Drive copy.'
          : current.configured ? 'The latest verified recovery copy is stored in Google Drive.' : 'Cloud backups have not been enabled for this installation.');
      const local = current.localPolicy;
      dialog.querySelector('.cloud-backups-local').textContent = local?.mode === 'cloud'
        ? (local.retainedSnapshots ? `${local.retainedSnapshots} older local recovery copies are being preserved in Drive before removal.`
          : local.pending || local.pendingSafetyUpload ? 'A device recovery copy is waiting to upload. Its previous data stays protected.' : 'This device keeps its working library without accumulating backup history.')
        : 'This device still keeps local recovery copies until cloud-managed backups are enabled and verified.';
      dialog.querySelector('[data-cloud-backups="request"]').disabled = loading || !current.configured;
      dialog.querySelector('[data-cloud-backups="refresh"]').disabled = loading;
      for (const option of settings.querySelectorAll('.settings-option')) {
        if (option.querySelector('[data-action="backup"], [data-action="backups"]')) option.hidden = active;
      }
      if (active) {
        settings.querySelector('.dialog-intro').textContent = 'This device keeps its working library for offline use. Library sync shares saved changes between connected devices. Dated recovery copies are kept in Google Drive, with device-only recovery uploaded separately before protected operations.';
        const path = document.getElementById('settings-path');
        if (path) path.textContent = path.textContent.replace(/\nBackups:[^\n]*/, '\nBackups: Google Drive through the cloud backup service');
      }
    }
    function renderCatalog() {
      const container = dialog.querySelector('.cloud-backups-catalog'); container.replaceChildren();
      older.hidden = catalogCursor === null || catalogCursor === undefined; older.disabled = loading;
      const verified = catalog.filter(item => item.kind === 'library' && (item.driveFileId || item.drive?.fileId) && ['verified', 'archived'].includes(item.status || 'verified'));
      if (!verified.length) {container.append(node('p', 'No verified library backups are available yet.', 'dialog-intro')); return;}
      for (const item of verified) {
        const card = document.createElement('div'); card.className = 'recovery-card';
        const details = document.createElement('div');
        details.append(node('h3', textTime(item.createdAt || item.verifiedAt) || 'Saved library backup'));
        details.append(node('p', [sizeLabel(item.compressedBytes), item.counts?.shards === undefined ? '' : item.counts.shards + (item.counts.shards === 1 ? ' shard' : ' shards')].filter(Boolean).join(' · ')));
        const button = node('button', 'Review restore', 'secondary'); button.type = 'button'; button.dataset.cloudBackups = 'review'; button.dataset.checkpointId = item.id; button.disabled = loading;
        card.append(details, button); container.append(card);
      }
    }
    function renderRestores() {
      const section = dialog.querySelector('.cloud-backups-restores'), container = dialog.querySelector('.cloud-backups-restore-list');
      section.hidden = !restores.length; container.replaceChildren();
      for (const item of restores) {
        const preview = item.preview || item, ticket = preview.previewTicket || item.previewTicket;
        const status = item.status || preview.status || 'ready';
        const ready = !!ticket && ['ready', 'preview_ready', 'prepared'].includes(status);
        const completed = ['accepted', 'restored', 'complete'].includes(status), stale = ['stale', 'conflict'].includes(status);
        const card = document.createElement('div'); card.className = 'recovery-card';
        const details = document.createElement('div');
        details.append(node('h3', ready ? 'Ready to review' : completed ? 'Restoration completed' : stale ? 'Restore review expired' : 'Preparing restore preview'));
        details.append(node('p', item.message || preview.message || (ready ? 'Confirm only if you want this saved collection to become your shared library.'
          : completed ? 'The restored collection was published. Connected devices receive it through Library sync.'
            : stale ? 'Your shared library changed. Request a fresh restore review before continuing.' : 'The background service is preparing this backup. Your library has not changed.')));
        const counts = preview.counts || preview.targetCounts;
        if (counts?.shards !== undefined) details.append(node('p', counts.shards + (counts.shards === 1 ? ' shard' : ' shards') + (counts.links === undefined ? '' : ' · ' + counts.links + (counts.links === 1 ? ' connection' : ' connections'))));
        card.append(details);
        if (ready) {
          const button = node('button', 'Restore this library', 'danger'); button.type = 'button'; button.dataset.cloudBackups = 'confirm'; button.dataset.restoreId = item.requestId || item.id; button.disabled = loading;
          card.append(button);
        }
        container.append(card);
      }
    }
    async function refresh({details = dialog.open} = {}) {
      try {
        const value = await request('/status'); summary.hidden = false; renderStatus(value);
        if (details && value.configured) {
          const results = await Promise.all([request('/catalog?kind=library'), request('/restores')]);
          catalog = results[0].items || results[0].backups || []; catalogCursor = results[0].nextCursor ?? null;
          restores = results[1].items || results[1].restores || [];
          renderCatalog(); renderRestores();
        }
      } catch (error) {
        // A stale/offline observation must never remain labeled verified.
        renderStatus({...current, checkUnavailable: true, message: error.message});
        if (dialog.open) showError(error);
      }
    }
    async function open() {
      if (settings.open) settings.close();
      dialog.showModal(); await refresh({details: true});
    }
    async function action(choice, target) {
      if (choice === 'close') {dialog.close(); return;}
      if (choice === 'open') {await open(); return;}
      if (loading) return;
      if (choice === 'refresh') {await refresh({details: true}); return;}
      if (choice === 'older') {
        if (catalogCursor === null || catalogCursor === undefined) return;
        loading = true; renderStatus(current); renderCatalog(); renderRestores();
        try {
          const page = await request('/catalog?kind=library&cursor=' + encodeURIComponent(catalogCursor));
          const known = new Set(catalog.map(item => item.id));
          catalog.push(...(page.items || page.backups || []).filter(item => !known.has(item.id)));
          catalogCursor = page.nextCursor ?? null;
        } catch (error) {showError(error);}
        finally {loading = false; renderStatus(current); renderCatalog(); renderRestores();}
        return;
      }
      if (!['request', 'review', 'confirm'].includes(choice)) return;
      if (choice !== 'request' && root.ShardAtlasHasUnsavedLibraryChanges?.()) {
        showError(new Error('Finish or save your open edit before preparing a restoration.')); return;
      }
      loading = true; dialog.querySelector('.cloud-backups-error').hidden = true; renderStatus(current); renderCatalog(); renderRestores();
      try {
        if (choice === 'request') {
          await request('/request', {requestId: requestId(), force: true});
          message('Backup requested. Drive verification will appear when the background service finishes.');
        } else if (choice === 'review') {
          const response = await root.ShardAtlasPlatform.request('/api/library-sync/status');
          const sync = await response.json();
          if (!response.ok || sync.conflictId || sync.pending || !['synced', 'ready'].includes(sync.state || sync.status)) throw new Error('Synchronize or review this device’s changes before requesting a restore.');
          await request('/restore/request', {requestId: requestId(), checkpointId: target.dataset.checkpointId, expectedRevision: sync.revision || sync.baseRevision || ''});
          message('Restore preview requested. Your shared library has not changed.');
        } else {
          const item = restores.find(value => (value.requestId || value.id) === target.dataset.restoreId), preview = item?.preview || item;
          const ticket = preview?.previewTicket || item?.previewTicket;
          if (!ticket) throw new Error('Refresh the restore preview before confirming.');
          if (!root.confirm('Restore this reviewed library backup? Your current cloud library is preserved first. The restored collection will synchronize to your devices.')) return;
          await request('/restore/confirm', {requestId: item.requestId || item.id, previewTicket: ticket, confirm: true});
          message('Restored collection published. Connected devices will receive it through Library sync.');
          document.dispatchEvent(new CustomEvent('shard-atlas-library-updated'));
        }
      } catch (error) {showError(error);}
      finally {loading = false; await refresh({details: true});}
    }
    for (const container of [summary, dialog]) container.addEventListener('click', event => {
      const button = event.target.closest('[data-cloud-backups]');
      if (button) void action(button.dataset.cloudBackups, button).catch(showError);
    });
    const wake = () => void refresh();
    root.addEventListener('online', wake); root.addEventListener('focus', wake);
    setInterval(() => {if (document.visibilityState !== 'hidden') void refresh();}, 60_000);
    void refresh();
    const instance = {open, refresh, get active() {return active;}};
    root.shardAtlasBackupUI = instance;
    return instance;
  }};
})(window);
