import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const context = vm.createContext({window: {}});
vm.runInContext(fs.readFileSync(new URL('../static/import-review.js', import.meta.url), 'utf8'), context);
const {build} = context.window.ShardImportReview;
const archive = {schemaVersion:1, shards:[
  {id:'a',title:'A',content:'![current](/assets/a-photo)'},
  {id:'b',title:'B',content:'B'},
  {id:'c',title:'C',content:'C'}
], links:[
  {id:'ab',fromId:'a',toId:'b',type:'depends_on'},
  {id:'ac',fromId:'a',toId:'c',type:'related_to'},
  {id:'saved',fromId:'a',toId:'saved',type:'explains'}
],assets:[{id:'a-photo'},{id:'old-photo'},{id:'unused-photo'}],
revisions:[{id:'ra',shardId:'a',snapshot:{content:'![old](/assets/old-photo)'}},{id:'rb',shardId:'b'}],
reviews:[{id:'review-a',shardId:'a'},{id:'review-b',shardId:'b'}],boards:[{id:'board'}],trash:[{id:'trash'}]};
assert.equal(build(archive,new Set([0,1,2])).data,archive,'Full archive keeps legacy recovery records exactly');
const snapshot = JSON.stringify(archive);
const subset=build(archive,new Set([0]),new Map(),['saved']);
assert.deepEqual(Array.from(subset.data.links,link=>link.id),['saved']);
assert.deepEqual(Array.from(subset.data.assets,asset=>asset.id),['a-photo','old-photo']);
assert.equal(subset.data.revisions.length,1);
assert.equal(subset.data.reviews.length,1);
assert.equal(subset.omittedLinks,2);
assert.equal(subset.omittedRecovery,2);
assert.equal(JSON.stringify(archive),snapshot,'Review must not mutate source archive');
const reused=build(archive,new Set([0,1]),new Map([['b','saved']]),['saved']);
assert.equal(reused.data.shards.length,1);
assert.equal(reused.data.links.length,2);
assert.equal(reused.data.links[0].toId,'saved');
assert.equal(reused.data.revisions.length,1,'Reusing a card does not change its history');
const deselectedReuse=build(archive,new Set([0]),new Map([['b','saved']]),['saved']);
assert.equal(deselectedReuse.data.links.length,1,'An unchecked reused candidate cannot redirect a dependency');
const empty=build(archive,new Set());
assert.equal(empty.data.shards.length,0);
assert.equal(empty.data.links.length,0);
assert.equal(empty.data.assets.length,0);
const collapse=build({...archive,links:[{id:'x',fromId:'a',toId:'b',type:'related_to'}]},new Set([0,1]),new Map([['a','saved'],['b','saved']]),['saved']);
assert.equal(collapse.data.links.length,0,'Reusing two candidates cannot create a self-link');
const withReferences={...archive,shards:archive.shards.map(shard=>shard.id==='a'?{...shard,content:'Read [[id:b|B]]. Keep `[[id:b|literal]]` unchanged.'}:shard),revisions:[{id:'ra',shardId:'a',snapshot:{content:'Earlier [[id:b|B]].'}}]};
const rewritten=build(withReferences,new Set([0,1]),new Map([['b','saved']]),['saved']);
assert.equal(rewritten.data.shards[0].content,'Read [[id:saved|B]]. Keep `[[id:b|literal]]` unchanged.');
assert.equal(rewritten.data.revisions[0].snapshot.content,'Earlier [[id:saved|B]].');
assert.equal(withReferences.revisions[0].snapshot.content,'Earlier [[id:b|B]].','Alias resolution preserves the source archive');
const existingEdge=build(archive,new Set([0,1]),new Map([['b','saved']]),['saved'],[{fromId:'a',toId:'saved',type:'depends_on'}]);
assert.equal(existingEdge.data.links.some(link=>link.type==='depends_on'),false,'Alias reuse cannot duplicate an existing relationship');
const rich={...archive,shards:archive.shards.map(shard=>shard.id==='a'?{...shard,
  perspectives:[{title:'Intuition',content:'Compare [[id:b|B]]. ![perspective](/assets/perspective)'}],
  walkthroughs:[{title:'Trace',steps:[{explanation:'Use [[id:b]]; keep `[[id:b]]` literal.'}]}],
  comparisons:[{title:'Methods',alternatives:[{name:'B',shardId:'b',summary:'[[id:b]]'},{name:'A',shardId:'a'}]}],
  learningLog:[{prompt:'Why [[id:b]]?',history:[{note:'Image ![history](/assets/history)'}]}]}:shard),
  revisions:[{id:'ra',shardId:'a',snapshot:{content:'Old',perspectives:[{content:'Old [[id:b]]. ![old](/assets/old-perspective)'}],comparisons:[{alternatives:[{shardId:'b'}]}]}}],
  assets:[...archive.assets,{id:'perspective'},{id:'history'},{id:'old-perspective'}]};
const richBefore=JSON.stringify(rich);
const richResult=build(rich,new Set([0,1]),new Map([['b','saved']]),['saved']);
const richShard=richResult.data.shards[0];
assert.match(richShard.perspectives[0].content,/\[\[id:saved\|B\]\]/);
assert.equal(richShard.comparisons[0].alternatives[0].shardId,'saved');
assert.equal(richShard.walkthroughs[0].steps[0].explanation,'Use [[id:saved]]; keep `[[id:b]]` literal.');
assert.equal(richResult.data.revisions[0].snapshot.comparisons[0].alternatives[0].shardId,'saved');
assert.deepEqual(Array.from(richResult.data.assets,asset=>asset.id),['a-photo','perspective','history','old-perspective']);
assert.equal(JSON.stringify(rich),richBefore,'Nested selection preserves original archive and history');
const withExperiment={...archive,shards:archive.shards.map(shard=>shard.id==='a'?{...shard,experiments:[{id:'b',type:'value-iteration',description:'![setup](/assets/experiment-image)',config:{states:[{id:'b',label:'Model state'}],actions:[{id:'b'}],transitions:[{stateId:'b',actionId:'b',outcomes:[{nextStateId:'b',probability:1,reward:2}]}]}}]}:shard),assets:[...archive.assets,{id:'experiment-image'}]};
const selectedExperiment=build(withExperiment,new Set([0,1]),new Map([['b','saved']]),['saved']);
assert.equal(JSON.stringify(selectedExperiment.data.shards[0].experiments),JSON.stringify(withExperiment.shards[0].experiments),'Model IDs and saved numerical settings are independent of concept alias reuse');
assert.ok(selectedExperiment.data.assets.some(asset=>asset.id==='experiment-image'),'Experiment source material remains portable in partial imports');
console.log('Import selection checks passed.');
