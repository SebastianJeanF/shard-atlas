// Pure read-only queries over the loader's validated accepted-cloud records.
// Explicit projections keep recovery, device state and unknown extensions out.
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fold = value => value.normalize('NFKC').toLowerCase();
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const recency = value => {const time = Date.parse(value); return Number.isFinite(time) ? time : -Infinity;};
const encoder = new TextEncoder();
export const ATLAS_QUERY_LIMITS = Object.freeze({searchBytes: 128 * 1024, readBytes: 256 * 1024,
  queryTerms: 32, searchResults: 50, readIds: 20, availableTags: 500, links: 200});

export class AtlasQueryError extends Error {
  constructor(message, code = 'invalid_arguments', status = 400) {super(message); this.name = 'AtlasQueryError'; this.code = code; this.status = status;}
}
const invalid = message => {throw new AtlasQueryError(message);};
function argumentsObject(args, fields) {
  if (!object(args) || Object.keys(args).some(key => !fields.includes(key))) invalid('Use only the supported query arguments.');
}
export function validateSearchArguments(args) {
  argumentsObject(args, ['query', 'limit', 'role', 'tags', 'tag_match']);
  if (typeof args.query !== 'string' || [...args.query].length > 1000) invalid('query must be text of at most 1,000 characters.');
  const terms = [...new Set(fold(args.query).trim().split(/\s+/).filter(Boolean))];
  if (terms.length > ATLAS_QUERY_LIMITS.queryTerms) invalid('Use a short query with at most 32 distinct search terms.');
  const limit = own(args, 'limit') ? args.limit : 12;
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) invalid('limit must be an integer from 1 to 50.');
  const role = own(args, 'role') ? args.role : '', tag_match = own(args, 'tag_match') ? args.tag_match : 'all';
  if (!['', 'snippet', 'algorithm', 'problem'].includes(role) || !['all', 'any'].includes(tag_match)) invalid('Use a supported code role and tag_match all or any.');
  const tags = own(args, 'tags') ? args.tags : [];
  if (!Array.isArray(tags) || tags.length > 30 || tags.some(tag => typeof tag !== 'string' || !tag.trim() || [...tag].length > 80)) invalid('tags must contain at most 30 unique nonempty names of at most 80 characters.');
  const normalizedTags = tags.map(tag => tag.trim());
  if (new Set(normalizedTags.map(fold)).size !== normalizedTags.length) invalid('tags must contain unique topic names.');
  return {query: args.query, limit, role, tags: normalizedTags, tag_match};
}
export function validateReadArguments(args) {
  argumentsObject(args, ['ids', 'expectedRevision']);
  if (!Array.isArray(args.ids) || args.ids.length < 1 || args.ids.length > 20 || args.ids.some(id => typeof id !== 'string' || !ID.test(id))
      || new Set(args.ids).size !== args.ids.length) invalid('ids must contain 1–20 unique stable shard identifiers of at most 128 characters.');
  const result = {ids: [...args.ids]};
  if (own(args, 'expectedRevision')) {
    if (typeof args.expectedRevision !== 'string' || args.expectedRevision !== '' && !ID.test(args.expectedRevision)) invalid('expectedRevision must be empty or a stable cloud revision of at most 128 characters.');
    result.expectedRevision = args.expectedRevision;
  }
  return result;
}

const fields = names => Object.fromEntries(names.split(' ').map(name => [name, true]));
const source = fields('sourceUrl sourceLocation');
const codeDetails = {...fields('code timeComplexity spaceComplexity complexityNotes'), headers: [true], assumptions: [true], pitfalls: [true]};
const config = {...fields('a b c startX startY learningRate maxIterations tolerance discount'),
  states: [fields('id label terminal initialValue')], actions: [fields('id label')],
  transitions: [{...fields('stateId actionId'), outcomes: [fields('nextStateId probability reward')]}]};
const SHARD = {...fields('id title content prompt kind status sourceUrl languageVersion eventDate createdAt updatedAt evidenceStatus publicationDate verifiedDate eventType entityType inbox'),
  tags: [true], entities: [true], subjects: [true], assumptions: [true],
  sources: [fields('url title publishedDate accessedDate note')], facts: [fields('label value unit sourceUrl asOf')],
  courses: [fields('courseCode courseTitle term lecture position sourceUrl sourceLocation context')],
  notation: [fields('symbol meaning shape role scope')],
  perspectives: [{...fields('title viewpoint content'), ...source, assumptions: [true]}],
  walkthroughs: [{...fields('title kind goal conclusion'), ...source, steps: [fields('title expression explanation justification')]}],
  comparisons: [{...fields('title question conclusion'), ...source,
    alternatives: [{...fields('name shardId summary cost'), assumptions: [true], strengths: [true], limitations: [true]}]}],
  learningLog: [{...fields('kind prompt status resolution'), ...source}],
  verification: {...fields('status note checkedAt'), ...source},
  experiments: [{...fields('id type title description algorithmVersion'), ...source, config, comparisonConfig: config}],
  codeSolution: {...fields('role purpose'), ...codeDetails, aliases: [true],
    approaches: [{...fields('id title summary'), ...codeDetails}]},
};
const LINK = fields('id fromId toId type note createdAt fromApproachId toApproachId scope evidence sourceUrl sourceLocation');

function project(value, shape, omitted, path = '') {
  if (shape === true) return value === null || ['string', 'number', 'boolean'].includes(typeof value) ? value : undefined;
  if (value === null) return null;
  if (Array.isArray(shape)) return Array.isArray(value) ? value.map(item => project(item, shape[0], omitted, path + '[]')).filter(item => item !== undefined) : undefined;
  if (!object(value)) return undefined;
  const result = {};
  for (const key of Object.keys(shape)) if (own(value, key)) {
    const item = project(value[key], shape[key], omitted, path ? path + '.' + key : key);
    if (item !== undefined) result[key] = item;
  }
  for (const key of Object.keys(value)) if (!own(shape, key)) {
    omitted.add(path === 'learningLog[]' && key === 'history' ? 'learningLog[].history'
      : ['reviewCount', 'lastReviewedAt', 'nextReviewAt'].includes(key) && !path ? 'reviewMetadata' : 'unsupportedExtensionFields');
  }
  return result;
}
function records(archive) {
  if (!object(archive) || !Array.isArray(archive.shards) || !Array.isArray(archive.links)) throw new AtlasQueryError('The accepted library is unavailable for this query.', 'invalid_library', 502);
  const ids = new Set(), shards = [];
  for (const shard of archive.shards) {
    if (!object(shard) || typeof shard.id !== 'string' || !ID.test(shard.id) || ids.has(shard.id)
        || typeof shard.title !== 'string' || typeof shard.content !== 'string' || !Array.isArray(shard.tags) || shard.tags.some(tag => typeof tag !== 'string')) {
      throw new AtlasQueryError('The accepted library contains unsupported current records.', 'invalid_library', 502);
    }
    ids.add(shard.id);
    const omitted = new Set();
    shards.push({record: project(shard, SHARD, omitted), omitted: [...omitted].sort(compare)});
  }
  const links = [], linkIds = new Set();
  for (const link of archive.links) {
    if (!object(link) || typeof link.id !== 'string' || !ID.test(link.id) || linkIds.has(link.id) || !ids.has(link.fromId) || !ids.has(link.toId)) throw new AtlasQueryError('The accepted library contains unsupported relationships.', 'invalid_library', 502);
    linkIds.add(link.id);
    links.push(project(link, LINK, new Set()));
  }
  return {shards, links};
}

// Count JSON bytes without serializing a potentially oversized whole shard.
function jsonBytes(value, limit = Infinity) {
  if (value === null || typeof value !== 'object') return encoder.encode(JSON.stringify(value)).byteLength;
  let size = 2, count = 0;
  for (const [key, item] of Array.isArray(value) ? value.map((item, index) => [index, item]) : Object.entries(value)) {
    if (count++) size++;
    if (!Array.isArray(value)) size += encoder.encode(JSON.stringify(key)).byteLength + 1;
    size += jsonBytes(item, limit - size);
    if (size > limit) return Infinity;
  }
  return size;
}
function strings(value, into = []) {
  if (typeof value === 'string') into.push(value);
  else if (Array.isArray(value)) for (const item of value) strings(item, into);
  else if (object(value)) for (const item of Object.values(value)) strings(item, into);
  return into;
}
function excerpt(value, terms) {
  const chars = Array.from(value), normalized = fold(value);
  const offset = Math.min(...terms.map(term => normalized.indexOf(term)).filter(index => index >= 0), Infinity);
  // The search uses a normalized string, but the excerpt always uses the saved
  // text. Approximate context is sufficient; no code is normalized or rewritten.
  const start = Number.isFinite(offset) ? Math.max(0, Math.min(chars.length, offset) - 70) : 0;
  const truncated = start > 0 || chars.length > start + 260;
  return {excerpt: (start ? '…' : '') + chars.slice(start, start + 260).join('') + (chars.length > start + 260 ? '…' : ''), excerptTruncated: truncated};
}
function searchFields(shard, connected) {
  const solution = shard.codeSolution || {}, approaches = solution.approaches || [];
  const learning = strings({...shard, id: '', title: '', content: '', tags: [], codeSolution: {...solution, code: '', aliases: [], approaches: approaches.map(item => ({...item, code: ''}))}});
  return {id: [shard.id], title: [shard.title], alias: solution.aliases || [], tag: shard.tags,
    body: [shard.content, shard.prompt || '', solution.purpose || '', ...approaches.map(item => item.summary || '')],
    code: [solution.code || '', ...approaches.map(item => item.code || '')], learning, connection: connected || []};
}

export function searchAtlas(archive, input) {
  const args = validateSearchArguments(input), {shards, links} = records(archive);
  const terms = [...new Set(fold(args.query).trim().split(/\s+/).filter(Boolean))], phrase = fold(args.query).trim();
  const connected = new Map();
  for (const link of links) for (const id of new Set([link.fromId, link.toId])) {
    const values = connected.get(id) || [];
    values.push(...['type', 'note', 'scope', 'evidence', 'sourceUrl', 'sourceLocation'].map(key => link[key] || ''));
    connected.set(id, values);
  }
  const candidates = [], allTags = new Set();
  for (const {record: shard} of shards) {
    for (const tag of shard.tags) allTags.add(tag);
    if (args.role && shard.codeSolution?.role !== args.role) continue;
    const selected = args.tags.map(tag => shard.tags.some(saved => fold(saved) === fold(tag)));
    if (selected.length && !(args.tag_match === 'all' ? selected.every(Boolean) : selected.some(Boolean))) continue;
    const fields = searchFields(shard, connected.get(shard.id));
    const normalized = Object.fromEntries(Object.entries(fields).map(([key, values]) => [key, values.map(fold)]));
    if (!terms.every(term => Object.values(normalized).some(values => values.some(value => value.includes(term))))) continue;
    const names = [...normalized.title, ...normalized.alias];
    let score = terms.length ? 1000 * (names.includes(phrase) || normalized.id.includes(phrase)) + 100 * names.some(name => name.includes(phrase)) : 0;
    for (const term of terms) for (const [key, weight] of [['title', 20], ['alias', 20], ['tag', 8], ['body', 2], ['code', 1]]) if (normalized[key].some(value => value.includes(term))) score += weight;
    const excerptValue = [...fields.body, ...fields.code, ...fields.learning, ...fields.connection].find(value => value && terms.some(term => fold(value).includes(term))) || shard.content || shard.codeSolution?.purpose || '';
    candidates.push({shard, score, excerptValue});
  }
  candidates.sort((a, b) => b.score - a.score || compare(recency(b.shard.updatedAt), recency(a.shard.updatedAt)) || compare(a.shard.id, b.shard.id));
  const tags = [...allTags].sort((a, b) => compare(fold(a), fold(b)) || compare(a, b));
  const availableTags = [];
  let tagBytes = 2;
  for (const tag of tags.slice(0, ATLAS_QUERY_LIMITS.availableTags)) {
    const size = jsonBytes(tag) + 1;
    if (tagBytes + size > 64 * 1024) break;
    availableTags.push(tag); tagBytes += size;
  }
  const result = {query: args.query, total: candidates.length, matches: [], availableTags,
    totalAvailableTags: tags.length, tagsTruncated: availableTags.length < tags.length, truncated: false};
  let used = jsonBytes(result);
  for (const {shard, excerptValue} of candidates.slice(0, args.limit)) {
    const fieldsTruncated = [];
    const limited = (values, name, maximum) => {if (values.length > maximum) fieldsTruncated.push(name); return values.slice(0, maximum);};
    const match = {id: shard.id, title: shard.title, tags: limited(shard.tags, 'tags', 32), role: shard.codeSolution?.role || '',
      aliases: limited(shard.codeSolution?.aliases || [], 'aliases', 16), subjects: limited(shard.subjects || [], 'subjects', 20),
      kind: shard.kind || '', status: shard.status || '', sourceUrl: shard.sourceUrl || '', languageVersion: shard.languageVersion || '', updatedAt: shard.updatedAt || '',
      ...excerpt(excerptValue, terms), fieldsTruncated};
    const size = jsonBytes(match, ATLAS_QUERY_LIMITS.searchBytes - used - 2048) + (result.matches.length ? 1 : 0);
    if (used + size > ATLAS_QUERY_LIMITS.searchBytes - 2048) break;
    result.matches.push(match); used += size;
  }
  result.truncated = result.matches.length < result.total || result.tagsTruncated || result.matches.some(item => item.fieldsTruncated.length > 0);
  return result;
}

export function readAtlas(archive, input) {
  const {ids} = validateReadArguments(input), {shards, links} = records(archive);
  const byId = new Map(shards.map(item => [item.record.id, item])), wanted = new Set(ids);
  const incident = links.filter(link => wanted.has(link.fromId) || wanted.has(link.toId)).sort((a, b) => compare(a.id, b.id));
  const result = {shards: [], links: [], missingIds: ids.filter(id => !byId.has(id)), connectedTitles: {}, omittedIds: [], omittedFields: {},
    linksTotal: incident.length, linksTruncated: false, truncated: false};
  const budget = ATLAS_QUERY_LIMITS.readBytes - 8192;
  let used = jsonBytes(result), omittedFieldCount = 0, connectedTitleCount = 0;
  for (const id of ids) {
    const entry = byId.get(id);
    if (!entry) continue;
    const size = jsonBytes(entry.record, budget - used) + (result.shards.length ? 1 : 0)
      + (entry.omitted.length ? jsonBytes(id) + 1 + jsonBytes(entry.omitted) + (omittedFieldCount ? 1 : 0) : 0);
    if (used + size > budget) {used += jsonBytes(id) + (result.omittedIds.length ? 1 : 0); result.omittedIds.push(id); continue;}
    result.shards.push(entry.record);
    used += size;
    if (entry.omitted.length) {result.omittedFields[id] = entry.omitted; omittedFieldCount++;}
  }
  for (const link of incident.slice(0, ATLAS_QUERY_LIMITS.links)) {
    const titles = new Map();
    for (const id of [link.fromId, link.toId]) if (!wanted.has(id) && !own(result.connectedTitles, id)) titles.set(id, byId.get(id).record.title);
    let size = jsonBytes(link, budget - used) + (result.links.length ? 1 : 0), titleCount = connectedTitleCount;
    for (const [id, title] of titles) size += jsonBytes(id) + 1 + jsonBytes(title) + (titleCount++ ? 1 : 0);
    if (used + size > budget) break;
    result.links.push(link); used += size;
    for (const [id, title] of titles) result.connectedTitles[id] = title;
    connectedTitleCount = titleCount;
  }
  result.linksTruncated = result.links.length < result.linksTotal;
  result.truncated = result.omittedIds.length > 0 || result.linksTruncated;
  if (result.omittedIds.length) result.omissionReason = 'response_byte_limit; request fewer IDs or inspect the complete note in Shard Atlas';
  return result;
}
