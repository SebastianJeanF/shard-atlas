// The desktop importer reads a server-configured Google Drive folder. No provider
// credentials or arbitrary filesystem paths cross this UI boundary.
(() => {
function install({api, writeRequest, withBusy, refreshAtlas}) {
  const dialog = document.querySelector('#ai-dialog');
  const status = document.querySelector('#drive-inbox-status');
  const path = document.querySelector('#drive-inbox-path');
  const files = document.querySelector('#drive-inbox-files');
  if (!dialog || !status || !path || !files) return;
  const buttons = [...dialog.querySelectorAll('[data-drive-action]')];
  let running = false;

  function render(result, synced) {
    path.textContent = result.path || '';
    const counts = result.counts || {};
    if (!result.available) {
      status.textContent = result.error || 'The Google Drive folder is not ready. Check that Drive for desktop has downloaded your Inbox.';
    } else if (synced) {
      const imported = counts.imported || 0, errors = counts.errors || 0;
      status.textContent = `${imported} ${imported === 1 ? 'batch' : 'batches'} imported · ${counts.replayed || 0} already imported · ${errors} ${errors === 1 ? 'needs' : 'need'} attention.`;
    } else {
      const count = counts.files || 0;
      status.textContent = `${count} JSON ${count === 1 ? 'file' : 'files'} found. Choose Sync additions to import new batches.`;
    }
    files.replaceChildren();
    for (const file of result.files || []) {
      const row = document.createElement('li');
      const label = document.createElement('strong');
      const outcome = {imported:'Imported',replayed:'Already imported',pending:'Ready to check',error:'Needs attention'}[file.status] || file.status;
      label.textContent = `${file.name}: ${outcome}`;
      row.append(label);
      if (file.receipt && file.status === 'imported') {
        const details = document.createElement('p');
        const count = file.receipt.added?.shards || 0;
        details.textContent = `${count} ${count === 1 ? 'note' : 'notes'} added, ${file.receipt.skipped?.shards || 0} reused.`;
        row.append(details);
      }
      for (const message of [file.error, ...(file.warnings || [])].filter(Boolean)) {
        const note = document.createElement('p');
        note.textContent = message;
        row.append(note);
      }
      files.append(row);
    }
    for (const warning of result.warnings || []) {
      const row = document.createElement('li');
      row.textContent = warning;
      files.append(row);
    }
  }

  async function run(sync = false) {
    if (running) return;
    running = true;
    buttons.forEach(button => { button.disabled = true; });
    status.textContent = sync ? 'Importing additions from your synced Drive folder…' : 'Checking your synced Drive folder…';
    try {
      const result = sync
        ? await withBusy(() => writeRequest('/api/drive-inbox/sync', 'POST', {}))
        : await api('/api/drive-inbox');
      render(result, sync);
      if (sync && result.available) {
        try {
          const refresh = await refreshAtlas(true);
          if (refresh.skipped) status.textContent += ' Finish editing, then refresh your notes.';
        } catch {
          status.textContent += ' Your import results are saved. Refresh your notes when the app reconnects.';
        }
      }
    } catch (error) {
      status.textContent = error.message || 'The inbox could not be checked. Try again.';
    } finally {
      running = false;
      buttons.forEach(button => { button.disabled = false; });
    }
  }
  dialog.addEventListener('click', event => {
    const button = event.target.closest('[data-drive-action]');
    if (button) void run(button.dataset.driveAction === 'sync');
  });
  new MutationObserver(() => {
    if (dialog.open) void run();
  }).observe(dialog, {attributes:true, attributeFilter:['open']});
}
window.DriveInbox = {install};
})();
