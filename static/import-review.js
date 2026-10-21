/* Build a selected, additive archive without changing the source file or saved notes. */
(() => {
  'use strict';
  const list = value => Array.isArray(value) ? value : [];
  const objects = value => list(value).filter(item => item && typeof item === 'object' && !Array.isArray(item));
  function build(archive, selected, reuse = new Map(), savedIds = [], savedLinks = []) {
    const incoming = objects(archive?.shards);
    const chosen = incoming.filter((_, index) => selected.has(index));
    const remap = new Map(chosen.filter(shard => reuse.has(shard.id)).map(shard => [shard.id, reuse.get(shard.id)]));
    if (chosen.length === incoming.length && !remap.size) return {data: archive, partial: false, omittedLinks: 0, omittedRecovery: 0};
    const rewriteLinks = content => String(content || '').split(/(```[\s\S]*?```|`[^`]+`)/g).map((part,index) => index%2 ? part : part.replace(/\[\[id:([^|\]]+)(\|[^\]]*)?\]\]/g, (whole,id,label='') => remap.has(id) ? `[[id:${remap.get(id)}${label}]]` : whole)).join('');
    const shards = chosen.filter(shard => !remap.has(shard.id)).map(shard => remap.size ? {...shard,content:rewriteLinks(shard.content)} : shard);
    const pickedIds = new Set(shards.map(shard => shard.id));
    const involved = new Set([...pickedIds, ...remap.values()]);
    const known = new Set([...savedIds, ...pickedIds]);
    const mappedId = id => remap.get(id) || id;
    const links = [], triples = new Set(list(savedLinks).map(link => JSON.stringify([link.fromId,link.toId,link.type])));
    for (const link of objects(archive?.links)) {
      const fromId = mappedId(link.fromId), toId = mappedId(link.toId);
      if (!known.has(fromId) || !known.has(toId) || fromId === toId || (!involved.has(fromId) && !involved.has(toId))) continue;
      const key = JSON.stringify([fromId, toId, link.type]);
      if (triples.has(key)) continue;
      triples.add(key); links.push({...link, fromId, toId});
    }
    // Historical snapshots belong only to genuinely new selected cards, never a reused card.
    const revisions = objects(archive?.revisions).filter(record => pickedIds.has(record.shardId)).map(record => remap.size && record.snapshot ? {...record,snapshot:{...record.snapshot,content:rewriteLinks(record.snapshot.content)}} : record);
    const reviews = objects(archive?.reviews).filter(record => pickedIds.has(record.shardId));
    const assetsNeeded = new Set();
    for (const shard of [...shards, ...revisions.map(record => record.snapshot)]) {
      for (const match of String(shard?.content || '').matchAll(/\]\(\/assets\/([A-Za-z0-9][A-Za-z0-9_.:-]{0,99})\)/g)) assetsNeeded.add(match[1]);
    }
    const assets = objects(archive?.assets).filter(asset => assetsNeeded.has(asset.id));
    return {
      data: {schemaVersion: archive?.schemaVersion, shards, links, assets, revisions, reviews, trash: [], boards: []},
      partial: true,
      omittedLinks: list(archive?.links).length - links.length,
      omittedRecovery: list(archive?.boards).length + list(archive?.trash).length,
    };
  }
  window.ShardImportReview = Object.freeze({build});
})();
