import test from 'node:test';
import assert from 'node:assert/strict';
import {AtlasQueryError, ATLAS_QUERY_LIMITS, searchAtlas, readAtlas, validateSearchArguments, validateReadArguments} from '../hosting/lib/atlas-query.mjs';

const shard = (id, values = {}) => ({id, title: id, content: 'A self-contained technical explanation.', tags: ['C++'], kind: 'concept', status: 'learning',
  createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z', ...values});
const link = (id, fromId, toId, values = {}) => ({id, fromId, toId, type: 'uses', note: 'Uses the saved technique.', createdAt: '2026-01-02T00:00:00Z',
  fromApproachId: '', toApproachId: '', scope: '', evidence: '', sourceUrl: '', sourceLocation: '', ...values});
function freeze(value) {if (value && typeof value === 'object') {for (const child of Object.values(value)) freeze(child); Object.freeze(value);} return value;}
const bytes = value => new TextEncoder().encode(JSON.stringify(value)).byteLength;

test('argument validation rejects unsupported inputs before any library needs loading', () => {
  assert.deepEqual(validateSearchArguments({query: 'treap'}), {query: 'treap', limit: 12, role: '', tags: [], tag_match: 'all'});
  assert.deepEqual(validateReadArguments({ids: ['a']}), {ids: ['a']});
  assert.equal(Object.hasOwn(validateReadArguments({ids: ['a']}), 'expectedRevision'), false);
  assert.deepEqual(validateReadArguments({ids: ['a'], expectedRevision: ''}), {ids: ['a'], expectedRevision: ''});
  assert.equal(validateReadArguments({ids: ['a'.repeat(128)], expectedRevision: 'r'.repeat(128)}).ids[0].length, 128);
  for (const args of [null, [], {}, {query: {}}, {query: 'x'.repeat(1001)}, {query: 'a', limit: true}, {query: '', limit: 51},
    {query: 'a', role: 'admin'}, {query: '', tags: ['Trees', 'trees']}, {query: '', tags: [null]}, {query: '', tags: Array.from({length: 31}, (_, i) => String(i))},
    {query: '', tag_match: 'other'}, {query: '', private: true}, {query: Array.from({length: 33}, (_, i) => 'word' + i).join(' ')}]) {
    assert.throws(() => validateSearchArguments(args), error => error instanceof AtlasQueryError && error.code === 'invalid_arguments' && error.status === 400);
  }
  for (const args of [null, {}, {ids: []}, {ids: ['a', 'a']}, {ids: [1]}, {ids: ['bad id']}, {ids: ['x'.repeat(129)]}, {ids: ['a'], expectedRevision: null},
    {ids: ['a'], expectedRevision: 'bad revision'}, {ids: ['a'], private: true}]) assert.throws(() => validateReadArguments(args), AtlasQueryError);
});

test('search ranks exact titles and aliases ahead of incidental body matches and is deterministic', () => {
  const archive = {shards: [shard('body', {title: 'Randomized tree details', content: 'A treap can maintain an implicit index.', updatedAt: '2026-02-01T00:00:00Z'}),
    shard('named', {title: 'Treap', tags: ['Trees']}), shard('aliased', {title: 'Randomized binary search tree', codeSolution: {role: 'algorithm', aliases: ['treap'], code: ''}})], links: []};
  const result = searchAtlas(archive, {query: 'TREAP'});
  assert.equal(result.total, 3); assert.deepEqual(new Set(result.matches.slice(0, 2).map(item => item.id)), new Set(['named', 'aliased']));
  assert.equal(result.matches[2].id, 'body'); assert.ok(result.availableTags.includes('Trees'));
  assert.deepEqual(searchAtlas({...archive, shards: [...archive.shards].reverse()}, {query: 'TREAP'}), result);
  assert.equal(searchAtlas(archive, {query: '', limit: 1}).matches[0].id, 'body');
});

test('recent search compares timestamp instants across offsets and breaks equal instants by stable ID', () => {
  const archive = {shards: [shard('old-offset', {updatedAt: '2026-04-20T08:00:00+05:00'}),
    shard('z-tie-b', {updatedAt: '2026-04-20T04:00:00Z'}), shard('tie-a', {updatedAt: '2026-04-20T05:00:00+01:00'})], links: []};
  assert.deepEqual(searchAtlas(archive, {query: ''}).matches.map(item => item.id), ['tie-a', 'z-tie-b', 'old-offset']);
  assert.equal(readAtlas(archive, {ids: ['old-offset']}).shards[0].updatedAt, '2026-04-20T08:00:00+05:00');
});

test('token-AND search covers aliases, exact code, structured explanations, and saved relationship context', () => {
  const archive = {shards: [shard('treap', {title: 'Implicit indices', codeSolution: {role: 'algorithm', aliases: ['implicit treap'], code: '\nstd::size_t rank = left_size + 1;\r\n'},
    walkthroughs: [{title: 'Split trace', kind: 'trace', steps: [{expression: 'left_size + 1', explanation: 'Maintain subtree size.'}]}]}),
    shard('problem', {title: 'Range problem'})], links: [link('uses', 'problem', 'treap', {scope: 'rank split operation', evidence: 'The selected approach calls split.'})]};
  assert.deepEqual(searchAtlas(archive, {query: 'implicit std::size_t'}).matches.map(item => item.id), ['treap']);
  assert.equal(searchAtlas(archive, {query: 'subtree size'}).matches[0].id, 'treap');
  assert.equal(searchAtlas(archive, {query: 'rank split'}).total, 2);
  assert.equal(searchAtlas(archive, {query: 'implicit nonexistent'}).total, 0);
});

test('role and topic filters reuse saved capitalization without inventing connections', () => {
  const archive = {shards: [shard('tree', {tags: ['Trees', 'C++'], codeSolution: {role: 'algorithm', aliases: []}}),
    shard('snippet', {tags: ['C++', 'Bits'], codeSolution: {role: 'snippet', aliases: []}})], links: []};
  assert.deepEqual(searchAtlas(archive, {query: '', role: 'algorithm', tags: [' trees ']}).matches.map(item => item.id), ['tree']);
  assert.equal(searchAtlas(archive, {query: '', tags: ['Trees', 'Bits'], tag_match: 'all'}).total, 0);
  assert.equal(searchAtlas(archive, {query: '', tags: ['Trees', 'Bits'], tag_match: 'any'}).total, 2);
  assert.deepEqual(readAtlas(archive, {ids: ['tree', 'snippet']}).links, []);
});

test('full reads preserve literal C++ code, approach identity, typed direction, source metadata and timestamps', () => {
  const code = '\n\t#include <vector>\r\nint f() {\r\n\t// α [[id:literal]]\r\n\treturn 1;\r\n}\r\n';
  const archive = {shards: [shard('problem', {codeSolution: {role: 'problem', code: '', aliases: ['range edit'], approaches: [{id: 'stable-approach', title: 'Treap approach', code, headers: ['<vector>'], summary: 'Uses subtree sizes.'}]},
    sourceUrl: 'https://example.test/problem', sources: [{url: 'https://example.test/reference', title: 'Primary reference', note: 'Checked source'}], verification: {status: 'source-checked', note: 'Source reviewed', sourceUrl: 'https://example.test/reference', checkedAt: '2026-01-01'}}), shard('technique')],
    links: [link('edge', 'problem', 'technique', {fromApproachId: 'stable-approach', sourceUrl: 'https://example.test/reference', sourceLocation: 'Section 2', scope: 'This approach', evidence: 'Calls split and merge.'})]};
  const result = readAtlas(archive, {ids: ['problem', 'missing']});
  assert.equal(result.shards[0].codeSolution.approaches[0].code, code);
  assert.equal(result.shards[0].codeSolution.approaches[0].id, 'stable-approach');
  assert.deepEqual(result.links[0], archive.links[0]);
  assert.equal(result.shards[0].createdAt, archive.shards[0].createdAt);
  assert.deepEqual(result.shards[0].sources, archive.shards[0].sources);
  assert.deepEqual(result.connectedTitles, {technique: 'technique'}); assert.deepEqual(result.missingIds, ['missing']);
  assert.equal(result.truncated, false);
});

test('reads retain authored learning questions but omit history, recovery, credentials, image bytes and extensions', () => {
  const archive = {shards: [shard('a', {privateSecret: 'private-extension-marker', assets: [{data: 'private-image-marker'}],
    codeSolution: {role: 'snippet', code: 'int x;', serviceToken: 'nested-secret-marker'},
    learningLog: [{kind: 'question', prompt: 'Why is this invariant needed?', status: 'resolved', resolution: 'It preserves order.', sourceUrl: 'https://example.test', history: [{note: 'private-history-marker'}]}], reviewCount: 10})], links: []};
  for (const field of ['revisions', 'trash', 'assets', 'drafts', 'settings', 'reviews', 'boards', 'contributionReceipts']) Object.defineProperty(archive, field, {get() {throw new Error('Private archive sections must not be read');}});
  const result = readAtlas(archive, {ids: ['a']});
  assert.equal(result.shards[0].learningLog[0].prompt, 'Why is this invariant needed?');
  assert.equal(result.shards[0].learningLog[0].history, undefined);
  assert.ok(result.omittedFields.a.includes('learningLog[].history'));
  assert.ok(result.omittedFields.a.includes('unsupportedExtensionFields'));
  assert.ok(result.omittedFields.a.includes('reviewMetadata'));
  assert.doesNotMatch(JSON.stringify(result), /private-extension-marker|private-image-marker|nested-secret-marker|private-history-marker/);
  for (const query of ['private-extension-marker', 'nested-secret-marker', 'private-history-marker']) assert.equal(searchAtlas(archive, {query}).total, 0);
});

test('input records remain immutable and outward nested objects are independent copies', () => {
  const archive = freeze({shards: [shard('a', {codeSolution: {role: 'snippet', code: 'int x;\r\n', aliases: ['example'], approaches: [{id: 'v1', title: 'Variant', code: 'int y;\r\n'}]}})], links: []});
  const before = JSON.stringify(archive), result = readAtlas(archive, {ids: ['a']});
  result.shards[0].tags.push('Changed'); result.shards[0].codeSolution.approaches[0].code = 'changed';
  const searched = searchAtlas(archive, {query: 'example'}); searched.matches[0].aliases.push('Changed');
  assert.equal(JSON.stringify(archive), before);
});

test('read projection preserves absent fields and exact current values without manufacturing defaults', () => {
  const archive = {shards: [shard('a', {codeSolution: {code: '\n\tint x;\r\n', approaches: []},
    experiments: [{id: 'example', type: 'gradient-descent', title: 'Given setup', algorithmVersion: 1, config: {a: 1, b: 0, c: 1}, comparisonConfig: null}],
    unknownExtension: {private: 'not-returned'}})], links: []};
  const result = readAtlas(archive, {ids: ['a']}).shards[0];
  assert.equal(Object.hasOwn(result, 'subjects'), false);
  assert.equal(Object.hasOwn(result.codeSolution, 'role'), false);
  assert.equal(result.codeSolution.code, archive.shards[0].codeSolution.code);
  assert.equal(result.experiments[0].comparisonConfig, null);
  assert.deepEqual(result.experiments[0].config, {a: 1, b: 0, c: 1});
  assert.equal(Object.hasOwn(result, 'unknownExtension'), false);
});

test('read byte limits omit whole notes explicitly and never truncate code', () => {
  const content = 'c'.repeat(99_000), code = 'x'.repeat(99_000) + '\r\n';
  const archive = {shards: [shard('large-a', {content, codeSolution: {code}}), shard('large-b', {content, codeSolution: {code}}), shard('small')], links: []};
  const result = readAtlas(archive, {ids: ['large-a', 'large-b', 'small']});
  assert.deepEqual(result.shards.map(item => item.id), ['large-a', 'small']);
  assert.equal(result.shards[0].content, content); assert.equal(result.shards[0].codeSolution.code, code);
  assert.deepEqual(result.omittedIds, ['large-b']); assert.equal(result.truncated, true);
  assert.match(result.omissionReason, /response_byte_limit/); assert.ok(bytes(result) <= ATLAS_QUERY_LIMITS.readBytes);
});

test('search budgets bound multibyte topics and summaries with clear truncation', () => {
  const manyTags = Array.from({length: 600}, (_, index) => String(index).padStart(3, '0') + '🌳'.repeat(38));
  const archive = {shards: Array.from({length: 50}, (_, index) => shard('a' + index, {title: 'treap', tags: manyTags,
    codeSolution: {aliases: Array.from({length: 40}, (_, alias) => 'alias' + alias + 'x'.repeat(230))}})), links: []};
  const result = searchAtlas(archive, {query: 'treap', limit: 50});
  assert.equal(result.total, 50); assert.equal(result.totalAvailableTags, 600);
  assert.equal(result.tagsTruncated, true); assert.equal(result.truncated, true);
  assert.ok(result.matches.length > 0); assert.ok(result.matches[0].fieldsTruncated.includes('tags'));
  assert.ok(result.matches[0].fieldsTruncated.includes('aliases'));
  assert.ok(bytes(result) <= ATLAS_QUERY_LIMITS.searchBytes - 2048);
});

test('connection limits report the true total and preserve stored alternatives exactly once', () => {
  const archive = {shards: [shard('center'), ...Array.from({length: 205}, (_, index) => shard('neighbor' + index))],
    links: Array.from({length: 205}, (_, index) => link('edge' + String(index).padStart(3, '0'), 'center', 'neighbor' + index))};
  const result = readAtlas(archive, {ids: ['center']});
  assert.equal(result.linksTotal, 205); assert.equal(result.links.length, 200); assert.equal(result.linksTruncated, true); assert.equal(result.truncated, true);
  assert.ok(bytes(result) <= ATLAS_QUERY_LIMITS.readBytes);
  const alternatives = {shards: [shard('a', {codeSolution: {approaches: [{id: 'one', code: '1'}, {id: 'two', code: '2'}]}})],
    links: [link('alternative', 'a', 'a', {type: 'alternative_to', fromApproachId: 'one', toApproachId: 'two'})]};
  assert.deepEqual(readAtlas(alternatives, {ids: ['a']}).links, alternatives.links);
});

test('search excerpts explicitly disclose cuts while full read remains exact', () => {
  const content = 'prefix '.repeat(80) + 'treap invariant ' + 'suffix '.repeat(80), archive = {shards: [shard('a', {content})], links: []};
  const result = searchAtlas(archive, {query: 'invariant'});
  assert.equal(result.matches[0].excerptTruncated, true); assert.match(result.matches[0].excerpt, /invariant/);
  assert.ok(Array.from(result.matches[0].excerpt).length <= 262);
  assert.equal(readAtlas(archive, {ids: ['a']}).shards[0].content, content);
});

test('malformed or ambiguous current records fail without silently selecting a duplicate', () => {
  for (const archive of [{}, {shards: [shard('a'), shard('a')], links: []}, {shards: [shard('a')], links: [link('x', 'a', 'missing')]},
    {shards: [shard('a')], links: [link('x', 'a', 'a'), link('x', 'a', 'a')]}]) {
    assert.throws(() => readAtlas(archive, {ids: ['a']}), error => error instanceof AtlasQueryError && error.code === 'invalid_library');
  }
});
