// Exercise the application integration using the actual filtering, reference,
// connection, and form functions, without opening a personal collection.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source=fs.readFileSync(new URL('../../web-dist/app.js',import.meta.url),'utf8');
const html=fs.readFileSync(new URL('../../web-dist/index.html',import.meta.url),'utf8');
const native=value=>JSON.parse(JSON.stringify(value));
const decode=value=>String(value).replace(/&(amp|quot|#39|lt|gt);/g,(_,key)=>({amp:'&',quot:'"','#39':"'",lt:'<',gt:'>'}[key]));
const slice=(start,end)=>{const a=source.indexOf(start),b=source.indexOf(end,a+start.length);assert.ok(a>=0&&b>a,`Missing application boundary ${start}`);return source.slice(a,b);};
const nodes=new Map();
class Node {
  constructor(value=''){this.value=value;this.defaultValue=value;this.innerHTML='';this.dataset={};this.hidden=false;this.open=false;}
  showModal(){this.open=true;}
  focus(){}
}
class FormDataFixture {
  constructor(form){this.values=Object.entries(form.elements).filter(([,control])=>!control.disabled).map(([key,control])=>[key,control.value]);}
  [Symbol.iterator](){return this.values[Symbol.iterator]();}
}
const ensure=id=>{if(!nodes.has(id))nodes.set(id,new Node());return nodes.get(id);};
function hiddenInput(initial='') {
  const control=new Node(initial);
  // Hidden inputs use the value IDL attribute in default mode: a .value write
  // changes the HTML value/defaultValue too, so native reset retains it.
  Object.defineProperty(control,'value',{get:()=>control.defaultValue,set:value=>{control.defaultValue=String(value);}});
  return control;
}
function editorFormFixture() {
  const markup=html.match(/<form id="editor-form">([\s\S]*?)<\/form>/)?.[1]||'';
  const hidden=new Map([...markup.matchAll(/<input\b([^>]*)>/g)].filter(match=>/type="hidden"/.test(match[1])).map(match=>[match[1].match(/name="([^"]*)"/)?.[1],decode(match[1].match(/value="([^"]*)"/)?.[1]||'')]));
  const form={id:'editor-form',elements:{},dataset:{baseline:'original'},reset(){for(const control of Object.values(this.elements))control.value=control.defaultValue;}};
  for(const key of app.editorFields)form.elements[key]=hidden.has(key)?hiddenInput(hidden.get(key)):new Node();
  return form;
}
const document={querySelector:selector=>ensure(selector)};
const storage=new Map();
const context=vm.createContext({window:{},document,FormData:FormDataFixture,Date,URL,localStorage:{getItem:key=>storage.get(key),setItem:(key,value)=>storage.set(key,value)},setTimeout:()=>1,clearTimeout:()=>{}});
vm.runInContext(fs.readFileSync(new URL('../../web-dist/code-solutions.js',import.meta.url),'utf8'),context);
vm.runInContext([
  source.slice(0,source.indexOf('function toast(')),
  slice('let cachedShards=','const dateLabel='),
  slice('function subjectMemberships(','function renderAcademicMetadata('),
  slice('const codeRoles=','function updateTagSuggestions('),
  slice('function highlightCpp(','function markdown('),
  slice('function filteredShards(','function sidebarTopics('),
  slice('function renderDetail(s)','function graphSvg('),
  slice('function draftForm(kind)','function dirtyKind(kind)'),
  slice('function snapshotDraft(','function renderDraftShelf('),
  slice('function openEditor(','function renderLinkApproaches('),
  slice('function renderLinkApproaches(','function restoreDraft('),
  slice('async function runAction(','\nconst safeUrl='),
  `function markdown(value,context=null){return context?.renderTest?context.renderTest(value):'<p>'+esc(value)+'</p>';}
   function renderShardReleaseChips(){return '';}
   function renderConnectionContext(){return '';}
   function renderAcademicMetadata(){return '';}
   function renderLearningMetadata(){return '';}
   function renderExperimentMetadata(){return '';}
   function renderSources(){return '';}
   function renderShardHeading(shard){return '<h2>'+esc(shard.title)+'</h2>';}
   function dateLabel(value){return value;}
   function academicFormData(){return {};}
   function learningFormData(){return {};}
   function experimentFormData(){return {};}
   function installAcademicEditor(){}
   function installLearningEditor(){}
   function installExperimentEditor(){}
   function renderStructuredEditor(){}
   function renderImageRecognition(){}
   function updateTagSuggestions(){}
   function renderDraftShelf(){}
   function draftStatus(){}
   async function importReviewAction(){return false;}
   async function legacyBoardAction(){return false;}
   function scheduleDraft(kind){window.lastDraftKind=kind;window.lastDraft=snapshotDraft(kind);}
   function toast(message){throw new Error(message);}
   window.TestApp={state,codeRole,filteredShards,renderDetail,renderCodeMetadata,renderCodeRelationships,renderSavedConnection,renderExactCode,formValues,formSnapshot,codeFormData,installCodeEditor,openEditor,runAction,snapshotDraft,editorFields,renderLinkApproaches,renderLinkTargets,openLink,setEditorDraft:value=>{drafts.editor=value;},setEditingId:value=>{editingId=value;},setConnectionIds:(from,to)=>{linkingId=from;editingLinkId=to;}};`
].join('\n'),context);
const app=context.window.TestApp;
const reference=value=>({role:'snippet',aliases:[],purpose:'',code:'',headers:[],timeComplexity:'',spaceComplexity:'',complexityNotes:'',assumptions:[],pitfalls:[],approaches:[],...value});
const shard=value=>({id:'note',title:'Note',kind:'concept',status:'learning',content:'',tags:[],sourceUrl:'',languageVersion:'',createdAt:'2026-01-01',updatedAt:'2026-01-01',...value});
const approach=value=>({id:'kahn',title:'Kahn',summary:'Use indegrees.',code:'return order;\n',headers:[],timeComplexity:'O(V + E)',spaceComplexity:'O(V)',complexityNotes:'V vertices and E edges.',assumptions:[],pitfalls:[],...value});
const reset=(shards=[],links=[])=>{Object.assign(app.state,{data:{shards,links},query:'',tags:[],tagMode:'all',codeRole:'all',kind:'all',status:'all',subject:'Generic',verificationFilter:'all',sort:'updated'});};
const ids=()=>native(app.filteredShards().map(item=>item.id));
let passed=0;
const failures=[];
const check=(title,test)=>{try{test();passed++;console.log(`✓ ${title}`);}catch(error){failures.push({title,error});console.error(`✗ ${title}\n${error.stack}`);}};

check('the code module loads before application code and both editors have mount points',()=>{
  assert.ok(html.indexOf('src="/code-solutions.js"')<html.indexOf('src="/bootstrap.mjs"'));
  const bootstrap=fs.readFileSync(new URL('../../web-dist/bootstrap.mjs',import.meta.url),'utf8');
  assert.ok(bootstrap.includes("await import('./app.js')"));
  assert.ok(html.includes('href="/code-solutions.css"'));
  for(const id of ['code-solution-editor','import-code-solution-editor','link-from-approach','link-to-approach'])assert.ok(html.includes(`id="${id}"`));
});
check('actual library search ranks exact titles and aliases above newer incidental matches',()=>{
  reset([
    shard({id:'body',title:'Bit tricks',content:'popcount',updatedAt:'2026-10-23'}),
    shard({id:'alias',title:'Count set bits',codeSolution:reference({aliases:['popcount','population count'],code:'return std::popcount(x);\n'}),updatedAt:'2026-02-01'}),
    shard({id:'title',title:'popcount',updatedAt:'2026-01-01'}),
    shard({id:'irrelevant',title:'Queue'})
  ]);app.state.query='popcount';assert.deepEqual(ids(),['title','alias','body']);
  app.state.query='population count';assert.deepEqual(ids(),['alias']);
});
check('library all/any topic matching composes with code-role and ordinary-note filters',()=>{
  reset([
    shard({id:'both',tags:['Integers','Bits'],codeSolution:reference({})}),
    shard({id:'integer',tags:['Integers'],codeSolution:reference({})}),
    shard({id:'bits',tags:['Bits'],codeSolution:reference({role:'algorithm'})}),
    shard({id:'plain',tags:['Integers']}),
    shard({id:'other',tags:['Graphs'],codeSolution:reference({role:'problem'})})
  ]);app.state.tags=['Integers','Bits'];assert.deepEqual(ids(),['both']);
  app.state.tagMode='any';assert.deepEqual(ids().sort(),['bits','both','integer','plain']);
  app.state.codeRole='snippet';assert.deepEqual(ids().sort(),['both','integer']);
  app.state.codeRole='none';assert.deepEqual(ids(),['plain']);
  app.state.codeRole='problem';assert.deepEqual(ids(),[]);
  app.state.tags=[];assert.deepEqual(ids(),['other']);
});
check('nested approach names, caveats and aliases participate in the real library haystack',()=>{
  reset([shard({id:'problem',codeSolution:reference({role:'problem',approaches:[approach({title:'Kahn cycle check',pitfalls:['processed-count'],complexityNotes:'edge-list-cost'})]})})]);
  for(const query of ['Kahn cycle','processed-count','edge-list-cost']){app.state.query=query;assert.deepEqual(ids(),['problem']);}
});
check('quick references use the actual C++ highlighter without consuming source whitespace',()=>{
  const source='\n#include <vector>\r\nint reverse(int x) {\r\n    return x;\r\n}\r\n';
  const item=shard({codeSolution:reference({purpose:'Reverse digits.',code:source,timeComplexity:'O(d)',spaceComplexity:'O(1)',pitfalls:['Guard overflow.']})});
  reset([item]);const result=app.renderCodeMetadata(item),match=result.match(/<pre><code>([\s\S]*?)<\/code><\/pre>/);
  assert.ok(match);assert.equal(decode(match[1].replace(/<[^>]*>/g,'')),source);
  assert.equal(JSON.parse(decode(result.match(/data-code-source="([^"]*)"/)[1])),source);
  assert.ok(match[1].includes('syn-keyword'));assert.ok(result.includes('Guard overflow.'));assert.ok(result.includes('O(d)'));assert.ok(result.includes('data-action="copy-code"'));
});
check('incoming code-reference prose receives the import preview link context',()=>{
  const item=shard({codeSolution:reference({role:'problem',purpose:'[[Incoming technique]]',approaches:[approach({summary:'[[Another incoming technique]]'})]})});
  const received=[],result=app.renderCodeMetadata(item,{context:{renderTest:value=>{received.push(value);return '<p class="incoming-context">Resolved incoming link</p>';}}});
  assert.deepEqual(received.sort(),['[[Incoming technique]]','[[Another incoming technique]]'].sort());
  assert.equal((result.match(/class="incoming-context"/g)||[]).length,2);
});
check('full shard detail puts quick code before expandable notes',()=>{
  const item=shard({id:'reverse',content:'A longer explanation.',codeSolution:reference({code:'return n;\n'})});reset([item]);
  const result=app.renderDetail(item);assert.ok(result.indexOf('code-reference-detail')<result.indexOf('code-extra-explanation'));
  assert.ok(result.includes('<summary>Explanation &amp; notes</summary>'));assert.ok(!result.includes('code-extra-explanation" open'));
});
check('uses connections are scoped to the matching approach and visible inversely on the technique',()=>{
  const problem=shard({id:'course',title:'Course Schedule II',codeSolution:reference({role:'problem',approaches:[approach({}),approach({id:'dfs',title:'DFS'})]})});
  const kahn=shard({id:'kahn-algo',title:'Kahn’s algorithm',codeSolution:reference({role:'algorithm'})}),dfs=shard({id:'dfs-algo',title:'DFS topological sorting',codeSolution:reference({role:'algorithm'})});
  reset([problem,kahn,dfs],[{id:'kahn-use',fromId:'course',fromApproachId:'kahn',toId:'kahn-algo',toApproachId:'',type:'uses',note:'An indegree queue gives the ordering.'},{id:'dfs-use',fromId:'course',fromApproachId:'dfs',toId:'dfs-algo',type:'uses',note:'Finish times give the ordering.'}]);
  const kahnPanel=app.renderCodeRelationships(problem,'kahn');assert.ok(kahnPanel.includes('<h3>Uses'));assert.ok(kahnPanel.includes('Kahn’s algorithm'));assert.ok(!kahnPanel.includes('DFS topological sorting'));assert.ok(kahnPanel.includes('data-approach-id="kahn"'));
  const inverse=app.renderCodeRelationships(kahn);assert.ok(inverse.includes('<h3>Used in'));assert.ok(inverse.includes('Course Schedule II · Kahn'));assert.ok(inverse.includes('is used in'));assert.ok(inverse.includes('An indegree queue gives the ordering.'));
  const detail=app.renderCodeMetadata(problem,{connections:true});assert.ok(detail.includes('data-code-approach-id="dfs"'));assert.ok(detail.includes('Finish times give the ordering.'));
});
check('same-problem alternative links display from the approach being viewed',()=>{
  const problem=shard({id:'course',title:'Course Schedule II',codeSolution:reference({role:'problem',approaches:[approach({}),approach({id:'dfs',title:'DFS'})]})});
  reset([problem],[{id:'alternative',fromId:'course',toId:'course',fromApproachId:'kahn',toApproachId:'dfs',type:'alternative_to'}]);
  const dfsPanel=app.renderCodeRelationships(problem,'dfs');assert.ok(dfsPanel.includes('DFS is an alternative to'));assert.ok(dfsPanel.includes('Course Schedule II · Kahn'));
});
check('connection dropdowns scope endpoints and allow alternatives inside one solved problem',()=>{
  const select=()=>{const control=new Node();let markup='';Object.defineProperty(control,'innerHTML',{get:()=>markup,set:value=>{markup=value;const options=[...value.matchAll(/<option([^>]*)>/g)],selected=options.find(match=>/\bselected\b/.test(match[1]))||options[0];control.value=decode(selected?.[1].match(/value="([^"]*)"/)?.[1]||'');}});return control;};
  const form={id:'link-form',elements:{},dataset:{},reset(){for(const control of Object.values(this.elements))control.value='';}};
  for(const key of ['type','toId','fromApproachId','toApproachId'])form.elements[key]=select();for(const key of ['note','scope','evidence','sourceUrl','sourceLocation'])form.elements[key]=new Node();
  nodes.set('#link-form',form);nodes.set('#link-target',form.elements.toId);
  const problem=shard({id:'course',title:'Course Schedule II',codeSolution:reference({role:'problem',approaches:[approach({}),approach({id:'dfs',title:'DFS'})]})}),technique=shard({id:'technique',title:'Kahn’s algorithm',codeSolution:reference({role:'algorithm'})});reset([problem,technique]);
  app.openLink('course',null,null,'dfs');assert.equal(form.elements.type.value,'uses');assert.equal(form.elements.fromApproachId.value,'dfs');assert.equal(form.elements.toId.value,'technique');assert.equal(form.elements.toApproachId.value,'');assert.equal(ensure('#link-from-approach-field').hidden,false);assert.equal(ensure('#link-to-approach-field').hidden,true);
  form.elements.type.value='alternative_to';app.renderLinkTargets('','course');assert.equal(form.elements.toId.value,'course');app.renderLinkApproaches({fromApproachId:'dfs',toApproachId:'kahn'});assert.equal(form.elements.fromApproachId.value,'dfs');assert.equal(form.elements.toApproachId.value,'kahn');assert.equal(ensure('#link-to-approach-field').hidden,false);
  form.elements.toId.value='technique';app.renderLinkApproaches({toApproachId:''});assert.equal(form.elements.fromApproachId.value,'dfs');assert.equal(form.elements.toApproachId.value,'');assert.equal(ensure('#link-to-approach-field').hidden,true);
  app.renderLinkApproaches({fromApproachId:'unavailable-saved-id'});assert.equal(form.elements.fromApproachId.value,'unavailable-saved-id');assert.ok(form.elements.fromApproachId.innerHTML.includes('Unavailable saved approach'));
});
check('editor integration serializes unfinished approach metadata into recoverable drafts',()=>{
  const form=editorFormFixture();form.elements['code-transient-title']=new Node('should be excluded');nodes.set('#editor-form',form);
  const container=ensure('#code-solution-editor');container.id='code-solution-editor';
  let notify;const actual=context.window.CodeSolutions;context.window.CodeSolutions={...actual,bindEditor:(_root,onChange)=>{notify=onChange;}};
  try{
    reset([]);const draft=reference({role:'problem',aliases:['scheduler'],approaches:[approach({id:'draft-stable',title:'',summary:'Still deciding',code:'\n// partial\n'})]});
    app.installCodeEditor({codeSolution:draft});notify({codeSolution:draft});
    assert.equal(context.window.lastDraftKind,'editor');assert.deepEqual(JSON.parse(context.window.lastDraft.values.codeSolution),draft);assert.ok(!Object.hasOwn(context.window.lastDraft.values,'code-transient-title'));
    app.openEditor(null,{editingId:null,values:{...native(context.window.lastDraft.values),title:'Unfinished course problem',kind:'concept'},baseline:'original'});
    assert.ok(container.innerHTML.includes('draft-stable'));assert.ok(container.innerHTML.includes('Still deciding'));assert.deepEqual(native(app.codeFormData(form).codeSolution),draft);
  }finally{context.window.CodeSolutions=actual;}
});
check('new captures clear reflected hidden metadata while existing shards and recovered drafts retain theirs',()=>{
  const form=editorFormFixture();nodes.set('#editor-form',form);
  const container=ensure('#code-solution-editor');container.id='code-solution-editor';
  let notify;const actual=context.window.CodeSolutions;context.window.CodeSolutions={...actual,bindEditor:(_root,onChange)=>{notify=onChange;}};
  const savedReference=reference({aliases:['lowbit','lowest set bit'],purpose:'Isolate the lowest set bit.',code:'unsigned lowbit(unsigned x) {\n    return x & -x;\n}\n',headers:['<cstdint>'],timeComplexity:'O(1)',spaceComplexity:'O(1)',complexityNotes:'Fixed-width unsigned input.',assumptions:['Unsigned integer input.'],pitfalls:['Zero returns zero.']});
  const original=shard({id:'prior-snippet',title:'Lowest set bit',codeSolution:savedReference,sources:[{title:'Prior source'}],facts:[{value:'Prior fact'}],subjects:['C++'],courses:[{id:'prior-course'}],notation:[{symbol:'x'}],assumptions:['Prior shard assumption'],perspectives:[{title:'Prior perspective'}],walkthroughs:[{title:'Prior walkthrough'}],comparisons:[{title:'Prior comparison'}],learningLog:[{prompt:'Prior question'}],verification:{status:'source-checked',note:'Prior evidence'},experiments:[{id:'prior-experiment'}],eventDate:'2026-10-23',eventType:'prior-event',publicationDate:'2026-10',verifiedDate:'2026-10-23',entityType:'prior-type',entities:['Prior entity'],inbox:true,evidenceStatus:'verified'});
  const originalSnapshot=JSON.stringify(original);
  const assertFresh=()=>{
    assert.deepEqual(native(app.codeFormData(form).codeSolution),{});
    for(const key of ['sources','facts','subjects','courses','notation','assumptions','perspectives','walkthroughs','comparisons','learningLog','experiments'])assert.deepEqual(JSON.parse(form.elements[key].value),[],`${key} must not leak from the previous shard`);
    assert.deepEqual(JSON.parse(form.elements.verification.value),{});
    for(const key of ['eventDate','eventType','publicationDate','verifiedDate','entityType','entities'])assert.equal(form.elements[key].value,'',`${key} must not leak from the previous shard`);
    assert.equal(form.elements.inbox.value,'false');assert.equal(form.elements.evidenceStatus.value,'unverified');
    assert.ok(!container.innerHTML.includes('lowbit'));assert.ok(!container.innerHTML.includes('Fixed-width unsigned input.'));
  };
  try{
    reset([original]);app.openEditor(original.id);assert.deepEqual(native(app.codeFormData(form).codeSolution),savedReference);
    const editedReference={...savedReference,aliases:['edited lowbit'],code:savedReference.code+'// edited draft\n'};notify({codeSolution:editedReference});
    assert.equal(form.elements.codeSolution.defaultValue,JSON.stringify(editedReference),'The fixture must reproduce real hidden-input default reflection');
    form.reset();assert.deepEqual(native(app.codeFormData(form).codeSolution),editedReference,'Native reset alone retains the last hidden metadata');
    app.openEditor();assertFresh();
    const newProblem=reference({role:'problem',purpose:'A new problem',approaches:[approach({id:'new-problem-approach',title:'Fresh approach',code:'// Fresh QA fixture\n'})]});notify({codeSolution:newProblem});
    const problemValue=app.codeFormData(form).codeSolution;assert.equal(problemValue.code,'');assert.deepEqual(native(problemValue.aliases),[]);assert.equal(problemValue.timeComplexity,'');assert.equal(problemValue.spaceComplexity,'');
    app.openEditor();assertFresh();
    app.openEditor(original.id);assert.deepEqual(native(app.codeFormData(form).codeSolution),savedReference,'Opening an existing snippet restores its own saved metadata after defaults clear');
    const recovered=reference({role:'problem',aliases:['recover this'],approaches:[approach({id:'recovered-stable',title:'',summary:'An incomplete idea',code:'\n// unfinished QA fixture\n'})]});
    app.openEditor(null,{editingId:null,values:{kind:'concept',title:'Recovered problem',codeSolution:JSON.stringify(recovered)},baseline:'before-draft'});
    assert.deepEqual(native(app.codeFormData(form).codeSolution),recovered);assert.ok(container.innerHTML.includes('recovered-stable'));assert.ok(container.innerHTML.includes('An incomplete idea'));
    assert.deepEqual(JSON.parse(form.elements.sources.value),[],'Fields absent from a recovered draft must not inherit the prior snippet');
    assert.equal(JSON.stringify(original),originalSnapshot,'Editing and fresh-capture initialization do not mutate saved source objects');
  }finally{context.window.CodeSolutions=actual;}
});
check('import editor changes remain represented in the unsaved-change snapshot',()=>{
  const importMarkup=html.match(/<form id="import-edit-form">([\s\S]*?)<\/form>/)?.[1]||'';
  assert.ok(/name="codeSolution"/.test(importMarkup),'The import form needs a serialized codeSolution field because code-* inputs are excluded.');
  const form={id:'import-edit-form',elements:{codeSolution:hiddenInput('{}')},dataset:{}},container=ensure('#import-code-solution-editor');container.id='import-code-solution-editor';nodes.set('#import-edit-form',form);
  let notify;const actual=context.window.CodeSolutions;context.window.CodeSolutions={...actual,bindEditor:(_root,onChange)=>{notify=onChange;}};
  try{app.installCodeEditor({codeSolution:reference({})},container);const before=app.formSnapshot(form);notify({codeSolution:reference({code:'return 1;\n'})});assert.notEqual(app.formSnapshot(form),before);}finally{context.window.CodeSolutions=actual;}
});
for(const role of ['snippet','algorithm','problem']){
  try{
    const form=editorFormFixture();nodes.set('#editor-form',form);ensure('#code-solution-editor').id='code-solution-editor';reset([]);app.state.tags=['Binary search','C++'];app.state.subject='CS';app.state.query='  lower_bound  ';
    await app.runAction('new-code',{dataset:{codeRole:role,captureQuery:'true'},closest:()=>null});
    const value=app.codeFormData(form).codeSolution;assert.equal(value.role,role);assert.equal(value.code,'');assert.equal(form.elements.content.value,'');assert.equal(form.elements.title.value,'lower_bound');assert.equal(form.elements.tags.value,'Binary search, C++');assert.deepEqual(JSON.parse(form.elements.subjects.value),['CS']);
    assert.equal(value.approaches.length,role==='problem'?1:0);
    const recovered=app.snapshotDraft('editor');app.openEditor(null,recovered,{role:'snippet',title:'must not replace draft'});assert.deepEqual(native(app.codeFormData(form).codeSolution),native(value));assert.equal(form.elements.title.value,'lower_bound');
    const before=app.formSnapshot(form);app.setEditorDraft(recovered);
    await assert.rejects(app.runAction('new-code',{dataset:{codeRole:'algorithm'},closest:()=>null}),/unfinished shard/);assert.equal(app.formSnapshot(form),before);
    app.setEditorDraft(null);app.openEditor();assert.deepEqual(native(app.codeFormData(form).codeSolution),{});assert.equal(form.elements.title.value,'','Ordinary New shard must remain blank');
    passed++;console.log(`✓ direct ${role} capture preserves context and protects recovered drafts`);
  }catch(error){failures.push({title:'direct code capture',error});console.error(error.stack);}
  finally{app.setEditorDraft(null);}
}
check('lookup capture bounds the editable title and keeps query text out of literal code',()=>{
  const form=editorFormFixture();nodes.set('#editor-form',form);reset([]);const title='😀'.repeat(241)+' return x;';app.openEditor(null,null,{role:'problem',title});const value=app.codeFormData(form).codeSolution;
  assert.equal([...form.elements.title.value].length,240);assert.equal(value.code,'');assert.equal(value.approaches[0].code,'');assert.equal(form.elements.content.value,'');
});
console.log(`${passed} code integration checks passed.`);
assert.equal(failures.length,0,`${failures.length} code integration checks failed.`);
