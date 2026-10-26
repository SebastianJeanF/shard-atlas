/* The shared interface calls this boundary; each host supplies its own services. */
(function (root) {
  'use strict';
  let viewedRevision = null;
  const stateRevisions = new WeakMap();
  async function nativeRequest(input, options = {}) {
    const url = new URL(typeof input === 'string' ? input : input.url, root.location?.href || 'http://127.0.0.1');
    const method = (options.method || input?.method || 'GET').toUpperCase();
    const knowledgeWrite = !['GET', 'HEAD'].includes(method) && url.pathname.startsWith('/api/')
      && !/^\/api\/(?:library-sync(?:\/|$)|cloud-backups(?:\/|$)|drafts(?:\/|$)|import\/preview$|import-preview$|backup$)/.test(url.pathname)
      && !/^\/api\/assets\/[^/]+\/text$/.test(url.pathname);
    if (knowledgeWrite && viewedRevision !== null) {
      const headers = new Headers(options.headers || {});
      headers.set('X-Shard-Atlas-View-Revision', viewedRevision);
      options = {...options, headers};
    }
    const response = await root.fetch(input, options);
    if (method === 'GET' && ['/api/state', '/api/data'].includes(url.pathname) && response?.ok
        && response.headers?.has('X-Shard-Atlas-Library-Revision')) {
      const revision = response.headers.get('X-Shard-Atlas-Library-Revision');
      const parse = response.json.bind(response);
      response.json = async () => {
        const data = await parse();
        if (data && typeof data === 'object') stateRevisions.set(data, revision);
        return data;
      };
    }
    return response;
  }
  const defaults = {
    request: nativeRequest,
    acceptState(data) { if (data && stateRevisions.has(data)) viewedRevision = stateRevisions.get(data); },
    imageSource: path => path,
    canRefreshDialog: dialog => ['ai-dialog', 'library-sync-dialog', 'app-release-dialog', 'cloud-backups-dialog'].includes(dialog.id),
    didSave() {},
    installIntegrations(context) {
      root.DriveInbox?.install(context);
      root.document?.addEventListener('shard-atlas-library-updated', () => { void context.refreshAtlas(true).catch(() => {}); });
    },
    messages: {
      draftSaved: 'Draft saved on this Mac.',
      aiReady: 'Ready to copy. Share these instructions with your chat.',
      readingImage: 'Reading text from your image on this Mac…',
    },
  };
  let host = {...defaults, messages: {...defaults.messages}};
  root.ShardAtlasPlatform = Object.freeze({
    configure(options = {}) {
      for (const key of ['request', 'acceptState', 'imageSource', 'canRefreshDialog', 'didSave', 'installIntegrations']) {
        if (options[key] !== undefined && typeof options[key] !== 'function') throw new TypeError(key + ' must be a function.');
      }
      host = {...host, ...options, messages: {...host.messages, ...options.messages}};
    },
    request: (input, options) => host.request(input, options),
    acceptState: data => host.acceptState(data),
    imageSource: path => host.imageSource(path),
    canRefreshDialog: dialog => host.canRefreshDialog(dialog),
    didSave: detail => host.didSave(detail),
    installIntegrations: context => host.installIntegrations(context),
    message: key => host.messages[key],
  });
})(window);
