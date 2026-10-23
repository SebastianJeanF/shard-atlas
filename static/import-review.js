/* Build a selected, additive archive without changing the source file or saved notes. */
(() => {
  'use strict';
  const list = value => Array.isArray(value) ? value : [];
  const objects = value => list(value).filter(item => item && typeof item === 'object' && !Array.isArray(item));
  const learningFields = ['perspectives','walkthroughs','comparisons','learningLog','verification','codeSolution'];
  // Keep nested explanations and historical snapshots attached to stable concept IDs.
  function mapReferences(shard, rewriteText, rewriteId = value => value) {
    const walk = (value, key = '') => {
      if (Array.isArray(value)) return value.map(item => walk(item, key));
      if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name,item]) => [name,walk(item,name)]));
      if (typeof value !== 'string') return value;
      if (key === 'shardId') return value ? rewriteId(value) : value;
      return ['sourceUrl','sourceLocation','checkedAt','date','status','kind','code','id','role','headers'].includes(key) ? value : rewriteText(value);
    };
    const mapped = {...shard,content:rewriteText(String(shard?.content || ''))};
    for (const key of learningFields) if (key in shard) mapped[key] = walk(shard[key]);
    return mapped;
  }
  function textContent(shard) {
    const codeText=value=>{
      if(Array.isArray(value))return value.map(codeText).join('\n');
      if(value&&typeof value==='object')return Object.entries(value).filter(([key])=>!['code','headers','id','role'].includes(key)).map(([,item])=>codeText(item)).join('\n');
      return typeof value==='string'?value:'';
    };
    return [shard?.content || '',...[...learningFields,'experiments'].map(key => key==='codeSolution'?codeText(shard?.[key]):JSON.stringify(shard?.[key] ?? ''))].join('\n');
  }
  function build(archive, selected, reuse = new Map(), savedIds = [], savedLinks = []) {
    const incoming = objects(archive?.shards);
    const chosen = incoming.filter((_, index) => selected.has(index));
    const remap = new Map(chosen.filter(shard => reuse.has(shard.id)).map(shard => [shard.id, reuse.get(shard.id)]));
    if (chosen.length === incoming.length && !remap.size) return {data: archive, partial: false, omittedLinks: 0, omittedRecovery: 0};
    const rewriteLinks = content => String(content || '').split(/(```[\s\S]*?```|`[^`]+`)/g).map((part,index) => index%2 ? part : part.replace(/\[\[id:([^|\]]+)(\|[^\]]*)?\]\]/g, (whole,id,label='') => remap.has(id) ? `[[id:${remap.get(id)}${label}]]` : whole)).join('');
    const shards = chosen.filter(shard => !remap.has(shard.id)).map(shard => remap.size ? mapReferences(shard,rewriteLinks,id=>remap.get(id)||id) : shard);
    const pickedIds = new Set(shards.map(shard => shard.id));
    const involved = new Set([...pickedIds, ...remap.values()]);
    const known = new Set([...savedIds, ...pickedIds]);
    const mappedId = id => remap.get(id) || id;
    const identity = link => {
      const from=[link.fromId,link.fromApproachId||''],to=[link.toId,link.toApproachId||''];
      if(link.type==='alternative_to'&&JSON.stringify(from)>JSON.stringify(to))return JSON.stringify([to,from,link.type]);
      return JSON.stringify([from,to,link.type]);
    };
    const links = [], triples = new Set(list(savedLinks).map(identity));
    for (const link of objects(archive?.links)) {
      const fromId = mappedId(link.fromId), toId = mappedId(link.toId);
      const validSelfAlternative=link.type==='alternative_to'&&link.fromApproachId&&link.toApproachId&&link.fromApproachId!==link.toApproachId;
      if (!known.has(fromId) || !known.has(toId) || (fromId === toId&&!validSelfAlternative) || (!involved.has(fromId) && !involved.has(toId))) continue;
      const key = identity({...link,fromId,toId});
      if (triples.has(key)) continue;
      triples.add(key); links.push({...link, fromId, toId});
    }
    // Historical snapshots belong only to genuinely new selected cards, never a reused card.
    const revisions = objects(archive?.revisions).filter(record => pickedIds.has(record.shardId)).map(record => remap.size && record.snapshot ? {...record,snapshot:mapReferences(record.snapshot,rewriteLinks,id=>remap.get(id)||id)} : record);
    const reviews = objects(archive?.reviews).filter(record => pickedIds.has(record.shardId));
    const assetsNeeded = new Set();
    for (const shard of [...shards, ...revisions.map(record => record.snapshot)]) {
      for (const match of textContent(shard).matchAll(/\]\(\/assets\/([A-Za-z0-9][A-Za-z0-9_.:-]{0,99})\)/g)) assetsNeeded.add(match[1]);
    }
    const assets = objects(archive?.assets).filter(asset => assetsNeeded.has(asset.id));
    return {
      data: {schemaVersion: archive?.schemaVersion, shards, links, assets, revisions, reviews, trash: [], boards: []},
      partial: true,
      omittedLinks: list(archive?.links).length - links.length,
      omittedRecovery: list(archive?.boards).length + list(archive?.trash).length,
    };
  }
  window.ShardImportReview = Object.freeze({build,mapReferences,textContent});
})();
