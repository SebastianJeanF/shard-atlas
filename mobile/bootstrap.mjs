import {BrowserStore} from './persistence.mjs';
import {markdownZip} from './exports.mjs';

const $ = selector => document.querySelector(selector);
const originalFetch = window.fetch.bind(window);
const images = new Map();
let store, installationPrompt, downloadUrls = [], reading = false;
const isPhone = () => matchMedia('(max-width: 600px)').matches;

function synchronizeImages(database) {
  const ids = new Set();
  for (const asset of database.archive.assets || []) {
    ids.add(asset.id);
    if (images.get(asset.id)?.data === asset.data) continue;
    const old = images.get(asset.id);
    if (old) URL.revokeObjectURL(old.url);
    const bytes = Uint8Array.from(atob(asset.data), char => char.charCodeAt(0));
    images.set(asset.id, {data: asset.data, url: URL.createObjectURL(new Blob([bytes], {type: asset.mimeType}))});
  }
  for (const [id, asset] of images) if (!ids.has(id)) { URL.revokeObjectURL(asset.url); images.delete(id); }
}

function message(text) {
  const toast = $('#toast');
  toast.textContent = text; toast.hidden = false;
  clearTimeout(message.timer);
  message.timer = setTimeout(() => { toast.hidden = true; }, 6000);
}

async function localFetch(input, options = {}) {
  const url = new URL(typeof input === 'string' ? input : input.url, location.href);
  if (url.origin !== location.origin || !url.pathname.startsWith('/api/')) return originalFetch(input, options);
  try {
    const method = (options.method || 'GET').toUpperCase();
    const body = options.body ? JSON.parse(options.body) : {};
    const {result, database} = await store.request(url.pathname, method, body);
    synchronizeImages(database);
    return new Response(JSON.stringify(result), {status: 200, headers: {'Content-Type':'application/json'}});
  } catch (error) {
    return new Response(JSON.stringify({error: error.message}), {status: error.status || 400, headers: {'Content-Type':'application/json'}});
  }
}

async function downloadArchive(markdown = false) {
  const {result: archive} = await store.request('/api/export');
  const data = markdown ? markdownZip(archive) : JSON.stringify(archive, null, 2);
  const blob = new Blob([data], {type: markdown ? 'application/zip' : 'application/json'});
  const url = URL.createObjectURL(blob);
  downloadUrls.push(url);
  // Keep recent downloads valid for Safari's asynchronous download handoff.
  if (downloadUrls.length > 5) URL.revokeObjectURL(downloadUrls.shift());
  const link = document.createElement('a');
  link.href = url;
  link.download = 'shard-atlas-' + new Date().toISOString().slice(0, 10) + (markdown ? '-notes.zip' : '.json');
  document.body.append(link); link.click(); link.remove();
  message('Archive prepared. Save it to Files or share it with your Mac.');
}

function showLibrary() {
  reading = false; document.body.classList.remove('phone-reading');
  window.scrollTo({top: 0, behavior: 'instant'});
}
function showNote() {
  if (!isPhone()) return;
  reading = true; document.body.classList.add('phone-reading');
  window.scrollTo({top: 0, behavior: 'instant'});
}

function customizeShell() {
  document.body.classList.add('phone-app');
  $('.local-status > span:last-child').childNodes[0].textContent = 'Saved on this device';
  $('#save-status').textContent = 'Offline storage · Export to keep a copy.';
  $('#settings-dialog > .dialog-intro').textContent = 'This atlas is stored in this browser on this device. To bring your Mac collection here, export its Complete archive, save it to Files, then choose Import. Changes do not sync automatically. Keep an exported copy outside the app; clearing website data also removes local snapshots.';
  for (const option of document.querySelectorAll('#settings-dialog .settings-option')) {
    if (option.querySelector('[data-action="backup"]')) {
      option.querySelector('h3').textContent = 'Local recovery snapshot';
      option.querySelector('p').textContent = 'Keep a recovery point inside this device. Export JSON for a separate backup.';
      option.querySelector('button').textContent = 'Save snapshot';
    }
  }
  const ai = $('#ai-dialog');
  ai.querySelector('.ai-steps').innerHTML = '<li><strong>Ask your AI for a Shard Atlas import.</strong><span>Copy the instructions below and share the explanation or source you want to keep.</span></li><li><strong>Share an export when useful.</strong><span>A chat can check your existing notes only when you provide a current export or a connected local integration.</span></li><li><strong>Preview the returned JSON file.</strong><span>Import it here to read each shard before saving it on this device.</span></li>';
  ai.querySelector('.ai-other-chats h3').textContent = 'Prepare a file in another chat';
  ai.querySelector('.ai-other-chats p').textContent = 'Copy these instructions into your chat. It can prepare a JSON file with explanations, connections, and embedded images. Save the file to Files, then preview it here.';
  $('#ai-refresh-status').textContent = 'Refresh reads changes saved in another tab on this device.';

  const install = document.createElement('dialog');
  install.id = 'phone-install'; install.className = 'small-dialog';
  install.innerHTML = '<div class="dialog-heading"><div><span class="eyebrow">YOUR ATLAS, WITHIN REACH</span><h2>Add Shard Atlas to your phone</h2></div><button class="icon-button" aria-label="Close installation steps" data-phone="close-install">×</button></div><ol class="phone-install-steps"><li>Open this page in <strong>Safari</strong>.</li><li>Tap <strong>Share</strong> (you may need to open Safari’s menu first).</li><li>Choose <strong>Add to Home Screen</strong>.</li><li>Turn on <strong>Open as Web App</strong>, then tap <strong>Add</strong>.</li></ol><p class="dialog-intro">Open the Shard Atlas icon, then import your collection there. Let the “Ready offline” message appear before going offline.</p><p class="dialog-intro">Your Mac and phone each keep their own collection. Use Complete archive export and Import to bring a copy across. Existing IDs are kept; importing an edited shard with the same ID preserves the version already on this device.</p><button class="primary full-width" data-phone="close-install">Got it</button>';
  document.body.append(install);
  const nav = document.createElement('nav');
  nav.className = 'phone-nav'; nav.setAttribute('aria-label', 'Phone navigation');
  nav.innerHTML = '<button data-view="library"><span aria-hidden="true">▤</span>Library</button><button data-view="atlas"><span aria-hidden="true">◉</span>Topic map</button><button data-view="timeline"><span aria-hidden="true">↳</span>Timeline</button><button data-action="new"><span aria-hidden="true">＋</span>New shard</button>';
  document.body.append(nav);
  const back = document.createElement('button');
  back.className = 'secondary phone-back'; back.dataset.phone = 'back'; back.textContent = '‹ All shards';
  $('.topbar').insertBefore(back, $('.search-box'));
  const help = document.createElement('button');
  help.className = 'nav-item'; help.dataset.phone = 'install'; help.textContent = '↗ Add to Home Screen';
  $('.sidebar-bottom').insertBefore(help, $('.sidebar-bottom').firstChild);
  const offline = document.createElement('div');
  offline.id = 'phone-offline-status'; offline.className = 'phone-offline-status'; offline.setAttribute('role', 'status');
  offline.textContent = 'Preparing offline access…';
  $('.sidebar-bottom').append(offline);

  document.addEventListener('click', event => {
    const button = event.target.closest('button,a');
    if (!button) {
      if (document.body.classList.contains('sidebar-open') && !event.target.closest('.sidebar')) document.body.classList.remove('sidebar-open');
      return;
    }
    if (button.matches('a[href="/api/export"],a[href="/api/export/markdown"]')) {
      event.preventDefault(); event.stopImmediatePropagation();
      void downloadArchive(button.getAttribute('href').endsWith('markdown')).catch(error => message(error.message)); return;
    }
    if (button.dataset.phone) {
      event.preventDefault(); event.stopImmediatePropagation();
      if (button.dataset.phone === 'back') showLibrary();
      else if (button.dataset.phone === 'install') {
        document.body.classList.remove('sidebar-open');
        if (installationPrompt) { installationPrompt.prompt(); installationPrompt = null; }
        else install.showModal();
      } else if (button.dataset.phone === 'close-install') install.close();
      return;
    }
    if (button.dataset.view || button.dataset.tag || ['clear-filters','clear-topic-search'].includes(button.dataset.action)) showLibrary();
    if (button.dataset.shardId || button.dataset.graphId || button.dataset.action === 'read-selected') showNote();
    if (button.dataset.view || button.dataset.tag || button.dataset.action) document.body.classList.remove('sidebar-open');
  }, true);
  document.addEventListener('click', event => { if (event.target.closest('[data-graph-id]')) showNote(); }, true);
  $('#search').addEventListener('input', showLibrary);
  document.addEventListener('shard-atlas-saved', showNote);
  $('#topic-search').addEventListener('input', showLibrary);
  const observer = new MutationObserver(() => {
    const label = $('#view-label')?.textContent;
    const view = {'Library':'library','Topic map':'atlas','C++ timeline':'timeline'}[label];
    for (const button of nav.querySelectorAll('[data-view]')) {
      const selected = button.dataset.view === view;
      button.setAttribute('aria-current', selected ? 'page' : 'false');
    }
    const list = $('.shard-list .empty-state');
    if (list && !$('#search').value && !list.querySelector('[data-action="import"]')) {
      const importButton = document.createElement('button');
      importButton.className = 'primary full-width'; importButton.dataset.action = 'import';
      importButton.textContent = 'Import my Mac atlas'; list.prepend(importButton);
      list.querySelector('p').textContent = 'Import a Complete archive from your Mac, or capture a new idea on this device.';
    }
  });
  observer.observe($('#workspace'), {childList: true});
  if (matchMedia('(display-mode: standalone)').matches || navigator.standalone) help.hidden = true;
}

async function prepareOffline() {
  const status = $('#phone-offline-status');
  if (!('serviceWorker' in navigator)) { status.textContent = 'Offline shell unavailable in this browser.'; return; }
  try {
    const registration = await navigator.serviceWorker.register('/sw.js');
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Offline setup timed out.')), 30000);
      const finish = callback => value => {clearTimeout(timeout); callback(value);};
      navigator.serviceWorker.ready.then(finish(resolve), finish(reject));
      const installing = registration.installing;
      if (installing) installing.addEventListener('statechange', () => {
        if (installing.state === 'redundant') finish(reject)(new Error('Offline installation did not finish.'));
      });
    });
    status.textContent = 'Ready offline · Notes stay on this device.';
    if (!localStorage.getItem('shard-atlas-offline-ready')) {
      message('Ready offline. Add Shard Atlas to your Home Screen.');
      localStorage.setItem('shard-atlas-offline-ready', 'yes');
    }
    const update = () => {
      if (registration.waiting) {
        status.textContent = 'Update ready. Close all Shard Atlas windows, then reopen.';
      }
    };
    update(); registration.addEventListener('updatefound', () => registration.installing?.addEventListener('statechange', update));
  } catch {
    status.textContent = 'Offline setup did not finish. Reopen while connected.';
  }
}

window.addEventListener('beforeinstallprompt', event => { event.preventDefault(); installationPrompt = event; });
window.addEventListener('resize', () => { if (!isPhone()) document.body.classList.remove('phone-reading'); else if (reading) showNote(); });

try {
  store = new BrowserStore();
  const {database} = await store.request('/api/state');
  synchronizeImages(database);
  window.shardAtlasMobile = {fetch: localFetch, imageSource: path => images.get(path.replace(/^\/assets\//, ''))?.url};
  customizeShell();
  await import('./app.js');
  void navigator.storage?.persist?.().catch(() => false);
  void prepareOffline();
} catch (error) {
  $('#workspace').replaceChildren();
  const container = document.createElement('div'); container.className = 'error-state';
  const title = document.createElement('h1'); title.textContent = 'Your atlas could not open.';
  const detail = document.createElement('p'); detail.textContent = error.message;
  const retry = document.createElement('button'); retry.className = 'primary'; retry.textContent = 'Try again'; retry.onclick = () => location.reload();
  container.append(title, detail, retry); $('#workspace').append(container);
}
