/* Read-only cross-atlas navigation. No route data enters saved knowledge. */
(function (root) {
  'use strict';
  const SITE = 'https://shard-atlas.deltamaster64.chatgpt.site';
  const SHARD_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$/;
  const HISTORY_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
  const COLLECTION_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$/;
  const MAX_URL_LENGTH = 8192;
  function bounded(value) {
    if (typeof value !== 'string' || value.length > MAX_URL_LENGTH) throw new Error('The atlas link is too long. Open the app and find the record directly; no record IDs or knowledge have been changed.');
    return value;
  }
  const fullMatch = (value, pattern) => typeof value === 'string' && value.match(pattern)?.[0] === value;
  function validate(route) {
    if (!route || !fullMatch(route.shardId, SHARD_ID)) throw new Error('The shard link has an invalid record ID.');
    const collection = route.historyCollection, record = route.historyRecord;
    if ((collection == null) !== (record == null) || (collection != null && (!fullMatch(collection, COLLECTION_ID) || !fullMatch(record, HISTORY_ID)))) {
      throw new Error('The History Atlas return link needs valid collection and record IDs.');
    }
    return {shardId: route.shardId, ...(collection == null ? {} : {historyCollection: collection, historyRecord: record})};
  }
  function parameters(params, allowed) {
    const result = {};
    for (const [key, value] of params) {
      if (!allowed.includes(key) || Object.hasOwn(result, key)) throw new Error('The atlas link has unsupported or repeated parameters.');
      result[key] = value;
    }
    return result;
  }
  function parse(value, {qa = false, baseUrl = SITE} = {}) {
    const url = new URL(bounded(value), baseUrl);
    bounded(url.href);
    const scheme = qa ? 'shardatlas-qa:' : 'shardatlas:';
    if (url.protocol === scheme) {
      if (url.hostname !== 'shard' || url.port || url.username || url.password || url.hash) throw new Error('This is not a supported shard link.');
      let shardId;
      try { shardId = decodeURIComponent(url.pathname.slice(1)); } catch { throw new Error('The shard link has invalid encoding.'); }
      return validate({shardId, ...parameters(url.searchParams, ['historyCollection', 'historyRecord'])});
    }
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== new URL(baseUrl).origin || url.username || url.password) throw new Error('Open a link for this Shard Atlas application.');
    const params = new URLSearchParams(url.hash.slice(1));
    if (!params.has('shard')) return null;
    const fields = parameters(params, ['shard', 'historyCollection', 'historyRecord']);
    return validate({shardId: fields.shard, ...(fields.historyCollection === undefined ? {} : {historyCollection: fields.historyCollection}), ...(fields.historyRecord === undefined ? {} : {historyRecord: fields.historyRecord})});
  }
  function fragment(value) {
    const route = validate(value), params = new URLSearchParams({shard: route.shardId});
    if (route.historyCollection != null) { params.set('historyCollection', route.historyCollection); params.set('historyRecord', route.historyRecord); }
    return bounded('#' + params);
  }
  function returnLinks(value, {qa = false} = {}) {
    const route = validate(value);
    if (route.historyCollection == null) return null;
    const query = new URLSearchParams({collection: route.historyCollection});
    const browser = new URL('http://127.0.0.1:18766/');
    browser.search = new URLSearchParams({event: route.historyRecord, atlas: route.historyCollection});
    return {native: bounded(`${qa ? 'historyatlas-qa' : 'historyatlas'}://event/${encodeURIComponent(route.historyRecord)}?${query}`), browser: bounded(browser.href)};
  }
  function createRouter({qa = false, baseUrl = SITE, ready = () => true, canNavigate = () => true,
    hasShard, selectShard, showMissing, changed = () => {}, replaceUrl = () => {}, message = () => {}}) {
    let route = null, status = 'idle';
    const snapshot = () => ({route: route && {...route}, status});
    function setStatus(next) { const differs = status !== next; status = next; return differs; }
    function flush() {
      if (!route || !ready()) return snapshot();
      if (status === 'opened' && hasShard(route.shardId)) return snapshot();
      if (!canNavigate()) {
        // Never replace protected workspace DOM: experiment previews and canvas
        // gestures can contain unsaved state that is not represented in data.
        if (setStatus('deferred')) message('Finish or close the current edit or dialog to open the requested shard. Its link is retained.');
        return snapshot();
      }
      if (!hasShard(route.shardId)) {
        if (setStatus('missing')) { showMissing(route.shardId); changed(snapshot()); }
      } else if (status !== 'opened') {
        status = 'opened'; selectShard(route.shardId); changed(snapshot());
      }
      return snapshot();
    }
    return Object.freeze({
      current: snapshot,
      open(value) {
        const next = parse(value, {qa, baseUrl});
        if (!next) return {accepted: false, ...snapshot()};
        route = next; status = 'pending'; replaceUrl(fragment(route)); flush();
        return {accepted: true, ...snapshot()};
      },
      flush,
      selected(id) {
        if (!route) return;
        route = validate({...route, shardId: id}); status = 'opened'; replaceUrl(fragment(route));
      },
    });
  }
  root.ShardAtlasNavigation = Object.freeze({SITE, parse, fragment, returnLinks, createRouter});
})(typeof window === 'undefined' ? globalThis : window);
