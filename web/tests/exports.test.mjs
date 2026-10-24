import test from 'node:test';
import assert from 'node:assert/strict';
import {markdownZip} from '../../web-dist/exports.mjs';

// Read the standard uncompressed ZIP records actually handed to the browser.
function unzip(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder(), files = new Map();
  let offset = 0;
  while (view.getUint32(offset, true) === 0x04034b50) {
    assert.equal(view.getUint16(offset + 8, true), 0);
    const size = view.getUint32(offset + 18, true);
    const nameLength = view.getUint16(offset + 26, true), extraLength = view.getUint16(offset + 28, true);
    const name = decoder.decode(bytes.subarray(offset + 30, offset + 30 + nameLength));
    const start = offset + 30 + nameLength + extraLength;
    files.set(name, decoder.decode(bytes.subarray(start, start + size)));
    offset = start + size;
  }
  assert.equal(view.getUint32(offset, true), 0x02014b50);
  return files;
}

const archive = (shards, links = [], assets = []) => ({schemaVersion: 1, shards, links, assets, boards: [], reviews: [], revisions: [], trash: []});
const note = (files, id) => [...files].find(([path]) => path.endsWith('--' + id + '.md'))?.[1];

test('readable code export keeps exact source, contracts, and prose asset references separate', () => {
  const source = '\n\tconst char* path = "/assets/picture";  \r\nconst char* fence = "````";\n// [[id:original]]\n';
  const value = archive([{
    id: 'integer', title: 'Integer helper', tags: ['Integer processing'],
    content: 'Example image: ![result](/assets/picture)',
    codeSolution: {
      role: 'snippet', aliases: ['reverse integer', 'reverse digits'], purpose: 'Reverse decimal digits.',
      code: source, headers: ['<limits>', '<optional>'], timeComplexity: 'O(d)', spaceComplexity: 'O(1)',
      complexityNotes: 'd is the number of digits.', assumptions: ['Input is signed int.'], pitfalls: ['Reject overflow.'], approaches: [],
    },
  }], [], [{id: 'picture', data: 'AQID'}]);
  const before = JSON.stringify(value), files = unzip(markdownZip(value)), text = note(files, 'integer');
  assert.match(text, /## Code reference/);
  for (const label of ['Role: snippet', 'Aliases: reverse integer, reverse digits', 'Reverse decimal digits.', 'Required headers:', '- <limits>', '- <optional>', 'Time: O(d)', 'Space: O(1)', 'Complexity notes: d is the number of digits.', 'Assumptions:', '- Input is signed int.', 'Pitfalls:', '- Reject overflow.']) assert.ok(text.includes(label), label);
  assert.ok(text.includes('`````cpp\n' + source + '`````'));
  assert.ok(text.includes('Example image: ![result](../assets/picture)'));
  assert.equal(JSON.stringify(value), before);
  assert.deepEqual(JSON.parse(files.get('shard-atlas.json')), value);
});

test('problem approaches and scoped relationship labels retain their identities and evidence', () => {
  const firstCode = '\treturn 1;  ', secondCode = '\nreturn 2;\n\n';
  const value = archive([{
    id: 'course', title: 'Course Schedule II', content: 'Return a valid course order.',
    codeSolution: {role: 'problem', approaches: [
      {id: 'kahn', title: 'Kahn queue', summary: 'Remove zero-indegree vertices.', code: firstCode, timeComplexity: 'O(V + E)', assumptions: ['Edges point prerequisite to course.']},
      {id: 'dfs', title: 'DFS finishing order', summary: 'Reverse finishing order.', code: secondCode, spaceComplexity: 'O(V)', pitfalls: ['Detect back edges.']},
    ]},
  }, {id: 'toposort', title: 'Topological sorting', content: 'Order a DAG.'}], [
    {id: 'alternative', fromId: 'course', toId: 'course', fromApproachId: 'kahn', toApproachId: 'dfs', type: 'alternative_to', note: 'Two ways to order a DAG.', scope: 'Acyclic input', evidence: 'Both return valid topological orders.', sourceUrl: 'https://example.org/toposort', sourceLocation: 'Section 2'},
    {id: 'use', fromId: 'course', toId: 'toposort', fromApproachId: 'kahn', type: 'uses'},
  ]);
  const files = unzip(markdownZip(value)), text = note(files, 'course');
  assert.ok(text.includes('### Kahn queue\n\nApproach ID: kahn'));
  assert.ok(text.includes('### DFS finishing order\n\nApproach ID: dfs'));
  assert.ok(text.includes('```cpp\n' + firstCode + '\n```'));
  assert.ok(text.includes('```cpp\n' + secondCode + '```'));
  assert.match(text, /Course Schedule II \/ Kahn queue \(approach kahn\).* → alternative to → .*Course Schedule II \/ DFS finishing order \(approach dfs\)/);
  assert.match(text, /Course Schedule II \/ Kahn queue \(approach kahn\).* → uses → .*Topological sorting/);
  for (const label of ['Time: O(V + E)', 'Space: O(V)', 'Edges point prerequisite to course.', 'Detect back edges.', 'Scope: Acyclic input', 'Evidence: Both return valid topological orders.', 'Source: https://example.org/toposort', 'Source location: Section 2']) assert.ok(text.includes(label), label);
  assert.deepEqual(JSON.parse(files.get('relationships.json')), value.links);
});

test('legacy exports remain complete without empty code sections or source normalization', () => {
  const content = '\tconst char* source = "/assets/missing";\n\n```cpp\n// [[id:unchanged]]\n```\n';
  const value = archive([{id: 'legacy', title: 'Legacy note', content, codeSolution: {role: '', aliases: [], purpose: '', code: '', headers: [], timeComplexity: '', spaceComplexity: '', complexityNotes: '', assumptions: [], pitfalls: [], approaches: []}}]);
  const before = JSON.stringify(value), files = unzip(markdownZip(value)), text = note(files, 'legacy');
  assert.ok(text.includes(content));
  assert.ok(!text.includes('## Code reference'));
  assert.equal(JSON.stringify(value), before);
  assert.deepEqual(JSON.parse(files.get('shard-atlas.json')), value);
});
