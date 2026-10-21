import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const context=vm.createContext({window:{},URL});
vm.runInContext(fs.readFileSync(new URL('../static/learning.js',import.meta.url),'utf8'),context);
const learning=context.window.LearningAtlas;
const native=value=>JSON.parse(JSON.stringify(value));
let passed=0;
const check=(title,test)=>{test();passed++;console.log(`✓ ${title}`);};
const source={sourceUrl:'',sourceLocation:''};
const perspective=value=>({title:'A geometric view',viewpoint:'Geometry',content:'A self-contained explanation.',assumptions:[],...source,...value});
const step=value=>({title:'First operation',expression:'x + 1 = 3',explanation:'Keep one operation together.',justification:'Add the same scalar on both sides.',...value});
const walkthrough=value=>({title:'A short derivation',kind:'derivation',goal:'Find the unknown.',steps:[step({})],conclusion:'The expression follows.',...source,...value});
const alternative=value=>({name:'Method A',shardId:'',summary:'A method.',assumptions:[],strengths:[],limitations:[],cost:'',...value});
const comparison=value=>({title:'Two methods',question:'Which assumptions differ?',alternatives:[alternative({}),alternative({name:'Method B'})],conclusion:'Use the assumptions to decide.',...source,...value});
const log=value=>({kind:'question',prompt:'Why does the step follow?',status:'open',resolution:'',history:[],...source,...value});
const verification=value=>({status:'unverified',note:'',checkedAt:'',...source,...value});
const metadata=value=>({perspectives:[],walkthroughs:[],comparisons:[],learningLog:[],verification:verification({}),...value});

function mockRow(kind,value) {
  const fields=[],lists=[],children=[];
  const row={dataset:{learningRow:kind},querySelectorAll:selector=>{
    if(selector==='[data-learning-field]')return [...fields,...children.flatMap(child=>child.querySelectorAll(selector))];
    if(selector==='[data-learning-list]')return [...lists,...children.flatMap(child=>child.querySelectorAll(selector))];
    const match=selector.match(/^\[data-learning-row="([^"]+)"\]$/);
    return match?children.flatMap(child=>[...(child.dataset.learningRow===match[1]?[child]:[]),...child.querySelectorAll(selector)]):[];
  }};
  for(const [key,item] of Object.entries(value)) {
    if(['steps','alternatives','history'].includes(key))children.push(...item.map(entry=>mockRow({steps:'step',alternatives:'alternative',history:'history'}[key],entry)));
    else if(Array.isArray(item))lists.push({dataset:{learningList:key},value:item.join('\n'),closest:()=>row});
    else fields.push({dataset:{learningField:key},value:item,closest:()=>row});
  }
  return row;
}
function editor(value=metadata({})) {
  const children=[...value.perspectives.map(item=>mockRow('perspective',item)),...value.walkthroughs.map(item=>mockRow('walkthrough',item)),...value.comparisons.map(item=>mockRow('comparison',item)),...value.learningLog.map(item=>mockRow('log',item)),mockRow('verification',value.verification)];
  const listeners={};
  return {dataset:{},listeners,matches:selector=>selector==='[data-learning-editor]',querySelector:selector=>selector==='[data-learning-row="verification"]'?children.at(-1):null,querySelectorAll:selector=>{const match=selector.match(/^\[data-learning-row="([^"]+)"\]$/);return match?children.flatMap(child=>[...(child.dataset.learningRow===match[1]?[child]:[]),...child.querySelectorAll(selector)]):[];},addEventListener:(type,listener)=>{listeners[type]=listener;}};
}

check('legacy notes render distinct content verification without fabricated explanations',()=>{
  const html=learning.renderDetail({title:'Legacy'});
  assert.ok(html.includes('Content verification'));
  assert.ok(html.includes('Unverified'));
  assert.ok(html.includes('Your understanding is tracked separately.'));
  assert.ok(!html.includes('learning-detail-section'));
});
check('detail escapes authored fields and ignores unsafe source URLs',()=>{
  const html=learning.renderDetail({perspectives:[perspective({title:'<img src=x onerror=alert(1)>',content:'<script>bad()</script>',sourceUrl:'javascript:alert(1)',sourceLocation:'<location>'})],verification:verification({note:'<note>'})});
  assert.ok(!html.includes('<script>'));
  assert.ok(!html.includes('<img src=x'));
  assert.ok(!html.includes('href="javascript:'));
  assert.ok(html.includes('&lt;location&gt;'));
});
check('all detail sections tolerate malformed incoming nested values',()=>{
  assert.doesNotThrow(()=>learning.renderDetail({perspectives:[null,17,{}],walkthroughs:[null,{title:'Trace',steps:[null,17,{}]}],comparisons:[null,{alternatives:[null,{}]}],learningLog:[null,{history:[null,{}]}],verification:null}));
  assert.doesNotThrow(()=>learning.renderEditor({perspectives:[null],walkthroughs:[{steps:[null]}],comparisons:[{alternatives:[null]}],learningLog:[{history:[null]}],verification:[]}));
});
check('trusted Markdown and math callbacks receive their intended source',()=>{
  const md=[],math=[];
  const html=learning.renderDetail({perspectives:[perspective({content:'**Geometric**'})],walkthroughs:[walkthrough({steps:[step({expression:'x=2'})]})]},{renderMarkdown:value=>{md.push(value);return `<p class="rendered">${value}</p>`;},renderMath:(value,display)=>{math.push([value,display]);return '<span class="rendered-math">math</span>';}});
  assert.ok(md.includes('**Geometric**'));
  assert.deepEqual(native(math),[['x=2',true]]);
  assert.ok(html.includes('rendered-math'));
});
check('method comparisons resolve linked concept titles and preserve missing references',()=>{
  const html=learning.renderDetail({comparisons:[comparison({alternatives:[alternative({shardId:'known'}),alternative({name:'Second',shardId:'missing'})]})]},{resolveShard:id=>id==='known'?{id:'known',title:'Shared concept'}:null});
  assert.ok(html.includes('data-shard-id="known"'));
  assert.ok(html.includes('Shared concept'));
  assert.ok(html.includes('Linked concept outside this atlas'));
});
check('incoming comparison links can use the import preview navigation context',()=>{
  const calls=[];
  const html=learning.renderDetail({comparisons:[comparison({alternatives:[alternative({shardId:'incoming'}),alternative({name:'Second'})]})]},{resolveShard:id=>id==='incoming'?{id:'incoming',title:'Pending concept'}:null,renderConceptLink:shard=>{calls.push(shard.id);return '<button data-preview-index="2">Pending concept</button>';}});
  assert.deepEqual(calls,['incoming']);
  assert.ok(html.includes('data-preview-index="2"'));
  assert.ok(!html.includes('data-shard-id="incoming"'));
});
check('editor exposes useful labels and title dropdowns without raw JSON',()=>{
  const html=learning.renderEditor(metadata({comparisons:[comparison({alternatives:[alternative({shardId:'known'}),alternative({name:'Second'})]})]}),{shards:[{id:'known',title:'Friendly concept'}]});
  for(const label of ['Learning &amp; explanation','Method comparisons','Alternative name','Linked concept','Friendly concept','Computational cost','Content verification'])assert.ok(html.includes(label));
  assert.ok(!html.includes('data-action='));
  assert.ok(!html.includes('JSON'));
});
check('editor generated input IDs remain unique across nested sections',()=>{
  const html=learning.renderEditor(metadata({perspectives:[perspective({}),perspective({title:'Another'})],walkthroughs:[walkthrough({steps:[step({}),step({title:'Second'})]})],comparisons:[comparison({})],learningLog:[log({history:[{date:'2026',note:'Observed'}]})]}));
  const ids=[...html.matchAll(/\bid="([^"]+)"/g)].map(match=>match[1]);
  assert.equal(ids.length,new Set(ids).size);
});
check('all metadata roundtrips with nested order, local notes and Markdown whitespace',()=>{
  const value=metadata({perspectives:[perspective({content:'  code indentation\n\n**Explanation**'})],walkthroughs:[walkthrough({steps:[step({title:'First'}),step({title:'Second',expression:'x=2'})]})],comparisons:[comparison({alternatives:[alternative({name:'A',strengths:['Simple']}),alternative({name:'B',limitations:['More work']})]})],learningLog:[log({history:[{date:'2026-10',note:'Initial question'},{date:'2026-10-21',note:'Clarified the input'}]})],verification:verification({status:'source-checked',note:'Compared the statement to the source.',sourceLocation:'Page 4',checkedAt:'2026-10-21'})});
  assert.deepEqual(native(learning.readEditor(editor(value))),value);
});
check('draft reads preserve unfinished nested rows while validated saves remove wholly blank rows',()=>{
  const value=metadata({perspectives:[perspective({title:'',viewpoint:'',content:''})],walkthroughs:[walkthrough({title:'',goal:'',conclusion:'',steps:[step({title:'',expression:'',explanation:'',justification:''})]})],comparisons:[comparison({title:'',question:'',conclusion:'',alternatives:[alternative({name:'',summary:''}),alternative({name:'',summary:''})]})],learningLog:[log({prompt:'',history:[{date:'',note:''}]})]});
  const draft=learning.readEditor(editor(value),{validate:false});
  assert.equal(draft.walkthroughs[0].steps.length,1);
  assert.equal(draft.comparisons[0].alternatives.length,2);
  assert.equal(draft.learningLog[0].history.length,1);
  const saved=learning.readEditor(editor(value));
  for(const key of ['perspectives','walkthroughs','comparisons','learningLog'])assert.equal(saved[key].length,0);
});
check('partial perspective rows require an explanation and title',()=>{
  assert.throws(()=>learning.readEditor(editor(metadata({perspectives:[perspective({content:''})]}))),/explanation is required/);
  assert.throws(()=>learning.readEditor(editor(metadata({perspectives:[perspective({title:''})]}))),/title is required/);
});
check('walkthroughs require a valid step and preserve meaningful incomplete steps for correction',()=>{
  assert.throws(()=>learning.readEditor(editor(metadata({walkthroughs:[walkthrough({steps:[]})]}))),/steps must contain 1 to 100/);
  assert.throws(()=>learning.readEditor(editor(metadata({walkthroughs:[walkthrough({steps:[step({expression:'',explanation:'',justification:'Because...'})]})]}))),/needs an expression or explanation/);
  assert.throws(()=>learning.readEditor(editor(metadata({walkthroughs:[walkthrough({kind:'quiz'})]}))),/choose Derivation or Algorithm trace/);
});
check('comparisons require two named alternatives and bounded lists',()=>{
  assert.throws(()=>learning.readEditor(editor(metadata({comparisons:[comparison({alternatives:[alternative({})]})]}))),/alternatives must contain 2 to 10/);
  assert.throws(()=>learning.readEditor(editor(metadata({comparisons:[comparison({alternatives:[alternative({name:'',summary:'Partial'}),alternative({name:'B'})]})]}))),/name is required/);
  assert.throws(()=>learning.readEditor(editor(metadata({comparisons:[comparison({alternatives:[alternative({strengths:Array.from({length:31},()=> 'A strength')}),alternative({name:'B'})]})]}))),/strengths must contain at most 30/);
});
check('resolved misconceptions require a resolution and dated history retains original questions',()=>{
  assert.throws(()=>learning.readEditor(editor(metadata({learningLog:[log({status:'resolved'})]}))),/resolution is required/);
  assert.throws(()=>learning.readEditor(editor(metadata({learningLog:[log({history:[{date:'2026-10-21',note:''}]})]}))),/note is required/);
  const result=learning.readEditor(editor(metadata({learningLog:[log({kind:'misconception',prompt:'Original incorrect thought',status:'resolved',resolution:'Corrected reasoning',history:[{date:'2026',note:'Original context'}]})]})));
  assert.equal(result.learningLog[0].prompt,'Original incorrect thought');
});
check('source checked requires both an explanatory note and a source reference',()=>{
  assert.throws(()=>learning.readEditor(editor(metadata({verification:verification({status:'source-checked'})}))),/Verification note is required/);
  assert.throws(()=>learning.readEditor(editor(metadata({verification:verification({status:'source-checked',note:'Checked'})}))),/source link or source location/);
  assert.equal(learning.readEditor(editor(metadata({verification:verification({status:'source-checked',note:'Checked against notes',sourceLocation:'§2'})}))).verification.status,'source-checked');
});
check('partial ISO dates use real calendar validation including leap years',()=>{
  for(const value of ['2026','2026-10','2024-02-29'])assert.doesNotThrow(()=>learning.readEditor(editor(metadata({verification:verification({checkedAt:value})}))));
  for(const value of ['0000','2026-13','2026-02-29','2026-10-32','10/21/2026'])assert.throws(()=>learning.readEditor(editor(metadata({verification:verification({checkedAt:value})}))),/valid YYYY/);
});
check('all source-bearing feature rows reject unsafe URL protocols',()=>{
  for(const value of [metadata({perspectives:[perspective({sourceUrl:'javascript:bad()'})]}),metadata({walkthroughs:[walkthrough({sourceUrl:'data:text/plain,bad'})]}),metadata({comparisons:[comparison({sourceUrl:'file:///tmp/source'})]}),metadata({learningLog:[log({sourceUrl:'ftp://example.org'})]}),metadata({verification:verification({sourceUrl:'javascript:bad()'})})])assert.throws(()=>learning.readEditor(editor(value)),/http or https/);
});
check('search text includes nested explanations, history, assumptions and verification evidence',()=>{
  const value=metadata({walkthroughs:[walkthrough({steps:[step({justification:'InvariantToken'})]})],comparisons:[comparison({alternatives:[alternative({strengths:['StrengthToken']}),alternative({name:'B'})]})],learningLog:[log({history:[{date:'2026',note:'HistoryToken'}]})],verification:verification({note:'EvidenceToken'})});
  const result=learning.searchText(value);for(const token of ['InvariantToken','StrengthToken','HistoryToken','EvidenceToken'])assert.ok(result.includes(token));
  assert.doesNotThrow(()=>learning.searchText({perspectives:[null]}));
});
check('editor binding is idempotent and reports recoverable draft metadata on input',()=>{
  const root=editor(metadata({perspectives:[perspective({content:''})]}));let calls=0;
  learning.bindEditor(root,result=>{calls++;assert.equal(result.perspectives[0].content,'');});
  learning.bindEditor(root,()=>{throw new Error('Duplicate listener');});
  root.listeners.input();root.listeners.change();assert.equal(calls,2);
});
check('walkthrough controls navigate bounded steps and toggle the full explanation',()=>{
  let handler,bindings=0;
  const container={addEventListener:(_,listener)=>{handler=listener;bindings++;}};
  const steps=[{hidden:false},{hidden:true},{hidden:true}],status={textContent:''};
  const buttons={previous:{disabled:true},next:{disabled:false},all:{textContent:'',setAttribute:(name,value)=>{buttons.all[name]=value;}}};
  const player={dataset:{current:'0',showAll:'false'},querySelectorAll:()=>steps,querySelector:selector=>selector==='.learning-step-position'?status:buttons[selector.match(/"([^"]+)"/)[1]]};
  const activate=action=>{const button={dataset:{learningNav:action},closest:()=>player};handler({target:{closest:()=>button},preventDefault(){},stopPropagation(){}});};
  learning.bindDetail(container);learning.bindDetail(container);assert.equal(bindings,1);
  activate('next');assert.deepEqual(steps.map(value=>value.hidden),[true,false,true]);assert.equal(status.textContent,'Step 2 of 3');
  activate('next');activate('next');assert.equal(player.dataset.current,'2');assert.equal(buttons.next.disabled,true);
  activate('all');assert.deepEqual(steps.map(value=>value.hidden),[false,false,false]);assert.equal(buttons.all['aria-pressed'],'true');assert.equal(buttons.previous.disabled,true);
  activate('all');assert.deepEqual(steps.map(value=>value.hidden),[true,true,false]);activate('previous');assert.equal(player.dataset.current,'1');
});
console.log(`${passed} learning frontend checks passed.`);
