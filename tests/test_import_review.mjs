import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const context = vm.createContext({window: {}});
vm.runInContext(fs.readFileSync(new URL('../static/import-review.js', import.meta.url), 'utf8'), context);
const {build,mapReferences,textContent} = context.window.ShardImportReview;
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

const literalCode='const char* marker = "[[id:b]]";\n// ![literal code image](/assets/code-only)\n';
const literalApproachCode='// [[id:b]] stays source text\n// ![literal approach image](/assets/approach-code-only)\nreturn order;\n';
const literalHeaders=['<vector>','[[id:b]]','![literal header image](/assets/header-only)'];
const codeArchive={schemaVersion:1,shards:[
  {id:'a',title:'Course Schedule II',content:'',codeSolution:{role:'problem',purpose:'Use [[id:b|the technique]]. ![purpose](/assets/code-purpose)',code:literalCode,headers:literalHeaders,approaches:[
    {id:'queue-approach',title:'Queue ordering',summary:'Apply [[id:b]]. ![summary](/assets/approach-summary)',code:literalApproachCode,headers:['[[id:b]]','![literal approach header](/assets/approach-header-only)']},
    {id:'stack-approach',title:'Stack ordering',summary:'Also uses [[id:b|the same technique]].',code:'return result;\n',headers:[]}
  ]}},
  {id:'b',title:'Ordering technique',content:'Reusable ordering.'},
  {id:'c',title:'Skipped unrelated shard',content:'![skipped](/assets/skipped-photo)'}
],links:[
  {id:'queue-use',fromId:'a',fromApproachId:'queue-approach',toId:'b',type:'uses'},
  {id:'stack-use',fromId:'a',fromApproachId:'stack-approach',toId:'b',type:'uses'},
  {id:'duplicate-queue-use',fromId:'a',fromApproachId:'queue-approach',toId:'b',type:'uses'},
  {id:'between-approaches',fromId:'a',fromApproachId:'queue-approach',toId:'a',toApproachId:'stack-approach',type:'alternative_to'},
  {id:'inverse-between-approaches',fromId:'a',fromApproachId:'stack-approach',toId:'a',toApproachId:'queue-approach',type:'alternative_to'},
  {id:'cross-shard-alternative',fromId:'a',fromApproachId:'queue-approach',toId:'b',type:'alternative_to'},
  {id:'inverse-cross-shard-alternative',fromId:'b',toId:'a',toApproachId:'queue-approach',type:'alternative_to'}
],revisions:[{id:'code-revision',shardId:'a',snapshot:{content:'',codeSolution:{role:'problem',purpose:'Earlier [[id:b]]. ![revision](/assets/revision-purpose)',code:'// [[id:b]] ![literal revision](/assets/revision-code-only)\n',headers:['![literal revision header](/assets/revision-header-only)'],approaches:[{id:'queue-approach',title:'Queue ordering',summary:'Earlier [[id:b|technique]].',code:literalApproachCode}]}}}],assets:[
  'code-purpose','approach-summary','revision-purpose','code-only','approach-code-only','header-only','approach-header-only','revision-code-only','revision-header-only','skipped-photo'
].map(id=>({id}))};
const codeBefore=JSON.stringify(codeArchive);
const selectedCode=build(codeArchive,new Set([0,1]),new Map([['b','saved-technique']]),['saved-technique']);
const codeShard=selectedCode.data.shards[0];
assert.deepEqual(Array.from(selectedCode.data.links.filter(link=>link.type==='uses'),link=>[link.id,link.fromApproachId,link.toId]),[
  ['queue-use','queue-approach','saved-technique'],['stack-use','stack-approach','saved-technique']
],'Two approaches using one technique are separate relationships; an exact duplicate is omitted');
assert.deepEqual(Array.from(selectedCode.data.links.filter(link=>link.type==='alternative_to'),link=>link.id),['between-approaches','cross-shard-alternative'],'Inverse alternatives share one canonical relationship');
const localAlternative=selectedCode.data.links.find(link=>link.id==='between-approaches');
assert.equal(localAlternative.fromId,'a');assert.equal(localAlternative.toId,'a');
assert.equal(localAlternative.fromApproachId,'queue-approach');assert.equal(localAlternative.toApproachId,'stack-approach','Distinct approaches within a problem remain valid endpoints');
assert.equal(codeShard.codeSolution.purpose,'Use [[id:saved-technique|the technique]]. ![purpose](/assets/code-purpose)');
assert.equal(codeShard.codeSolution.approaches[0].summary,'Apply [[id:saved-technique]]. ![summary](/assets/approach-summary)');
assert.equal(codeShard.codeSolution.approaches[1].summary,'Also uses [[id:saved-technique|the same technique]].');
assert.equal(codeShard.codeSolution.code,literalCode,'Top-level source code is copied exactly without wiki rewriting');
assert.equal(codeShard.codeSolution.approaches[0].code,literalApproachCode,'Approach source code is copied exactly without wiki rewriting');
assert.equal(JSON.stringify(codeShard.codeSolution.headers),JSON.stringify(literalHeaders),'Header names are literal source, not Markdown');
assert.equal(JSON.stringify(codeShard.codeSolution.approaches[0].headers),JSON.stringify(codeArchive.shards[0].codeSolution.approaches[0].headers));
assert.equal(selectedCode.data.revisions[0].snapshot.codeSolution.purpose,'Earlier [[id:saved-technique]]. ![revision](/assets/revision-purpose)');
assert.equal(selectedCode.data.revisions[0].snapshot.codeSolution.approaches[0].summary,'Earlier [[id:saved-technique|technique]].');
assert.equal(selectedCode.data.revisions[0].snapshot.codeSolution.code,codeArchive.revisions[0].snapshot.codeSolution.code);
assert.deepEqual(Array.from(selectedCode.data.assets,asset=>asset.id),['code-purpose','approach-summary','revision-purpose'],'Partial imports retain prose images, including history, but do not scan source code or headers for assets');
const prose=textContent(codeShard);
assert.ok(prose.includes('[[id:saved-technique]]'));
for(const literal of ['[[id:b]]','code-only','approach-code-only','header-only','approach-header-only'])assert.ok(!prose.includes(literal),`Literal code/header token ${literal} is excluded from reference scanning`);
const mappedCode=mapReferences(codeArchive.shards[0],value=>value.replaceAll('[[id:b]]','[[id:renamed]]'),value=>value==='b'?'renamed':value);
assert.equal(mappedCode.codeSolution.code,literalCode);assert.equal(mappedCode.codeSolution.approaches[0].code,literalApproachCode);
assert.equal(mappedCode.codeSolution.approaches[0].summary,'Apply [[id:renamed]]. ![summary](/assets/approach-summary)');
assert.equal(JSON.stringify(codeArchive),codeBefore,'Code-specific selection and reference rewriting never mutate the source archive');
const savedInverseCode=build(codeArchive,new Set([0,1]),new Map([['b','saved-technique']]),['saved-technique'],[
  {fromId:'saved-technique',toId:'a',toApproachId:'queue-approach',type:'alternative_to'},
  {fromId:'a',fromApproachId:'stack-approach',toId:'a',toApproachId:'queue-approach',type:'alternative_to'}
]);
assert.equal(savedInverseCode.data.links.some(link=>link.type==='alternative_to'),false,'Reversed alternatives already saved are not added again after alias reuse');
assert.deepEqual(Array.from(savedInverseCode.data.links,link=>link.id),['queue-use','stack-use'],'Alternative deduplication does not remove separate approach usages');
console.log('Import selection checks passed.');
