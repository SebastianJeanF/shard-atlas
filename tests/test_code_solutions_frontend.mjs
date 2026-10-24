import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const context=vm.createContext({window:{},Date,crypto:{randomUUID:()=>`test-${++idSequence}`}});
let idSequence=0;
vm.runInContext(fs.readFileSync(new URL('../static/code-solutions.js',import.meta.url),'utf8'),context);
const code=context.window.CodeSolutions;
const native=value=>JSON.parse(JSON.stringify(value));
const decode=value=>String(value).replace(/&(amp|quot|#39|lt|gt);/g,(_,key)=>({amp:'&',quot:'"','#39':"'",lt:'<',gt:'>'}[key]));
const attrs=value=>Object.fromEntries([...value.matchAll(/([\w-]+)(?:="([^"]*)")?/g)].map(match=>[match[1],decode(match[2]??'')]));
let passed=0;
const check=(title,test)=>{test();passed++;console.log(`✓ ${title}`);};
const reference=value=>({role:'snippet',aliases:[],purpose:'',code:'',headers:[],timeComplexity:'',spaceComplexity:'',complexityNotes:'',assumptions:[],pitfalls:[],approaches:[],...value});
const approach=value=>({id:'approach-1',title:'Kahn’s algorithm',summary:'Use indegrees and a queue.',code:'return result;\n',headers:['<queue>'],timeComplexity:'O(V + E)',spaceComplexity:'O(V + E)',complexityNotes:'V vertices; E edges.',assumptions:[],pitfalls:[],...value});

// Small tree fixture parses rendered controls, so read tests exercise actual template values.
// Textarea newline handling matches HTML parsing, including initial-LF stripping.
class Element {
  constructor(tag='div',attributes={}) {this.tag=tag;this.attributes=attributes;this.dataset={};this.children=[];this.parentElement=null;this.listeners={};this.hidden='hidden'in attributes;this.disabled='disabled'in attributes;this.value=attributes.value||'';this.text='';for(const[key,value]of Object.entries(attributes))if(key.startsWith('data-'))this.dataset[key.slice(5).replace(/-([a-z])/g,(_,letter)=>letter.toUpperCase())]=value;}
  matches(selector){const match=selector.match(/^\[([\w-]+)(?:="([^"]*)")?\]$/);return match?Object.hasOwn(this.attributes,match[1])&&(match[2]===undefined||this.attributes[match[1]]===match[2]):this.tag===selector;}
  querySelectorAll(selector){return this.children.flatMap(child=>[...(child.matches(selector)?[child]:[]),...child.querySelectorAll(selector)]);}
  querySelector(selector){return this.querySelectorAll(selector)[0]||null;}
  closest(selector){return this.matches(selector)?this:this.parentElement?.closest(selector)||null;}
  contains(element){return element===this||this.children.some(child=>child.contains(element));}
  append(child){child.parentElement=this;this.children.push(child);}
  get previousElementSibling(){return this.parentElement?.children[this.parentElement.children.indexOf(this)-1]||null;}
  get nextElementSibling(){return this.parentElement?.children[this.parentElement.children.indexOf(this)+1]||null;}
  get lastElementChild(){return this.children.at(-1);}
  remove(){if(this.parentElement){const siblings=this.parentElement.children;siblings.splice(siblings.indexOf(this),1);this.parentElement=null;}}
  insertBefore(child,before){child.remove();const index=this.children.indexOf(before);child.parentElement=this;this.children.splice(index<0?this.children.length:index,0,child);}
  insertAdjacentHTML(position,html){assert.equal(position,'beforeend');for(const child of parse(html).children.slice())this.append(child);}
  addEventListener(type,listener){(this.listeners[type]||=[]).push(listener);}
  fire(type,target=this){for(const listener of this.listeners[type]||[])listener({target,preventDefault(){},stopPropagation(){}});}
  focus(){this.focused=true;}
}
function parse(html){
  const root=new Element(),stack=[root];
  for(const token of html.match(/<\/?[a-z][^>]*>|[^<]+/gi)||[]){
    const top=stack.at(-1);
    if(token.startsWith('</')){const current=stack.pop();if(current.tag==='textarea')current.value=decode(current.text.replace(/^\r?\n/,'')).replace(/\r\n?/g,'\n');if(current.tag==='select'){const options=current.querySelectorAll('option');current.value=(options.find(option=>'selected'in option.attributes)||options[0])?.attributes.value||'';}continue;}
    if(token.startsWith('<')){const match=token.match(/^<([\w-]+)([\s\S]*?)>$/),element=new Element(match[1],attrs(match[2]));top.append(element);if(!['input','br','hr','img'].includes(element.tag))stack.push(element);}
    else top.text+=token;
  }
  return root;
}
const editor=value=>parse(code.renderEditor({codeSolution:value})).querySelector('[data-code-editor]');
const valueOf=root=>code.readEditor(root,{validate:false}).codeSolution;
const field=(root,key)=>root.querySelector(`[data-code-field="${key}"]`);
const action=(root,key)=>root.querySelector(`[data-code-action="${key}"]`);

check('legacy shards remain ordinary notes with an optional code editor',()=>{
  assert.equal(code.renderDetail({title:'Legacy'}),'');
  assert.equal(code.role({codeSolution:{role:'unknown'}}),'');
  assert.equal(valueOf(editor(reference({role:''}))).role,'');
  const root=editor(reference({role:''}));assert.equal(root.querySelector('[data-code-visible="active"]').hidden,true);
});
check('direct code captures start empty and solved problems keep a stable blank approach',()=>{
  for(const role of ['snippet','algorithm','problem']){
    const value=code.newReference(role),root=editor(value),draft=valueOf(root);
    assert.equal(draft.role,role);assert.equal(draft.code,'');assert.deepEqual(native(draft.aliases),[]);
    assert.equal(draft.approaches.length,role==='problem'?1:0);
    if(role==='problem'){
      const id=draft.approaches[0].id;assert.ok(id);assert.equal(draft.approaches[0].title,'');assert.equal(draft.approaches[0].code,'');
      assert.equal(valueOf(editor(draft)).approaches[0].id,id,'Reopening an unfinished draft must reuse its approach identity');
      const row=root.querySelector('[data-code-approach]'),source='\n\treturn input;  \r\n';field(row,'title').value='Identity';field(row,'code').value=source;
      const saved=code.readEditor(root).codeSolution;assert.equal(saved.approaches[0].id,id);assert.equal(saved.approaches[0].code,source);
    }
  }
  assert.notEqual(code.newReference('problem').approaches[0].id,code.newReference('problem').approaches[0].id);
  assert.equal(code.newReference('unknown').role,'');
});
check('capture menu and failed role lookup expose only explicit creation actions',()=>{
  const menu=code.renderCaptureMenu();assert.ok(menu.includes('<details'));assert.ok(menu.includes('New code reference'));
  for(const role of ['snippet','algorithm','problem']){
    assert.ok(menu.includes(`data-code-role="${role}"`));
    const empty=code.renderEmptyCapture(role);assert.ok(empty.includes(`data-code-role="${role}"`));assert.ok(empty.includes('data-capture-query="true"'));
  }
  for(const role of ['all','none','<img>','__proto__','constructor','toString'])assert.equal(code.renderEmptyCapture(role),'');
});
check('snippet fields roundtrip without losing exact C++ whitespace or optional metadata',()=>{
  const value=reference({aliases:['reverse digits','integer reversal'],purpose:'Reverse decimal digits.',code:'\n#include <limits>\r\nint reverse(int x) {\r\n    return x;\r\n}\r\n',headers:['<limits>'],timeComplexity:'O(log |x|)',spaceComplexity:'O(1)',complexityNotes:'Decimal digits in a fixed-width input.',assumptions:['Signed 32-bit input.'],pitfalls:['Return 0 if reversing would overflow.']});
  assert.deepEqual(native(code.readEditor(editor(value)).codeSolution),value);
});
check('edited code replaces the preserved source rather than restoring stale content',()=>{
  const root=editor(reference({code:'int x;\r\n'}));field(root,'code').value='int y;\n';
  assert.equal(valueOf(root).code,'int y;\n');
});
check('all editor controls use code-prefixed unique names and avoid required paperwork',()=>{
  const root=editor(reference({role:'problem',approaches:[approach({}),approach({id:'approach-2',title:'DFS'})]}));
  const fields=[...root.querySelectorAll('[data-code-field]'),...root.querySelectorAll('[data-code-list]')];
  assert.ok(fields.every(control=>control.attributes.name.startsWith('code-')));
  const ids=fields.map(control=>control.attributes.id);assert.equal(ids.length,new Set(ids).size);
  assert.doesNotThrow(()=>code.readEditor(editor(reference({code:'return x;\n'}))));
});
check('problem approaches retain order, IDs and separate complexity contracts',()=>{
  const value=reference({role:'problem',purpose:'Return a valid ordering or an empty array.',approaches:[approach({}),approach({id:'approach-dfs',title:'DFS',timeComplexity:'O(V + E)',spaceComplexity:'O(V)',pitfalls:['Detect a back edge.']})]});
  assert.deepEqual(native(code.readEditor(editor(value)).codeSolution),value);
});
check('snippet and algorithm variants remain visible, editable and exact without primary code',()=>{
  for(const role of ['snippet','algorithm']){
    const first='\n#include <queue>\r\nbool less(int a, int b) {\r\n\treturn a < b;  \r\n}\r\n',second='\n// λ alternative\r\nreturn value;\r\n';
    const value=reference({role,code:'',approaches:[approach({id:'variant-one',title:'Function comparator',code:first}),approach({id:'variant-two',title:'Lambda comparator',code:second,pitfalls:['Keep variant context.']})]}),root=editor(value),sources=[],connections=[];
    const markup=code.renderDetail({codeSolution:value},{renderCode:source=>{sources.push(source);return '<pre>Exact source</pre>';},renderApproachConnections:item=>{connections.push(item.id);return '<span>Variant connection</span>';}});
    assert.deepEqual(sources,[first,second]);assert.deepEqual(connections,['variant-one','variant-two']);
    for(const text of ['Implementation approaches','Function comparator','Lambda comparator','Keep variant context.','data-code-approach-id="variant-one"','data-code-approach-id="variant-two"'])assert.ok(markup.includes(text));
    assert.equal((markup.match(/aria-label="C\+\+ syntax colors"/g)||[]).length,1);
    assert.equal(root.querySelector('[data-code-visible="reference"]').hidden,false);assert.equal(root.querySelector('[data-code-visible="approaches"]').hidden,false);assert.ok(action(root,'add'));
    assert.deepEqual(native(code.readEditor(root).codeSolution),value);
    const rows=root.querySelectorAll('[data-code-approach]');field(rows[1],'summary').value='A revised variant reminder.';
    const changed=code.readEditor(root).codeSolution;assert.equal(changed.approaches[1].summary,'A revised variant reminder.');assert.equal(changed.approaches[0].code,first);assert.equal(changed.approaches[1].code,second);assert.deepEqual(native(changed.approaches.map(item=>item.id)),['variant-one','variant-two']);
    assert.deepEqual(native(code.readEditor(editor(changed)).codeSolution),native(changed));
  }
});
check('nonproblem primary code coexists with optional variants and role changes preserve both',()=>{
  for(const role of ['snippet','algorithm']){
    const primary='\nint primary() {\r\n\treturn 0;  \r\n}\r\n',variant='\nint variant() { return 1; }\r\n';
    const value=reference({role,code:primary,approaches:[approach({id:'retained-variant',code:variant})]}),root=editor(value),sources=[];
    const detail=code.renderDetail({codeSolution:value},{renderCode:source=>{sources.push(source);return source===primary?'<pre>Primary implementation</pre>':'<pre>Variant implementation</pre>';}});assert.deepEqual(new Set(sources),new Set([primary,variant]));assert.ok(detail.indexOf('Primary implementation')<detail.indexOf('Variant implementation'));
    code.bindEditor(root);assert.equal(root.querySelector('[data-code-approaches-title]').textContent,'Implementation approaches');assert.equal(root.querySelector('[data-code-approaches-optional]').hidden,false);
    field(root,'role').value='problem';root.fire('change');assert.equal(root.querySelector('[data-code-visible="reference"]').hidden,true);assert.equal(root.querySelector('[data-code-visible="approaches"]').hidden,false);
    field(root,'role').value=role;root.fire('change');assert.equal(root.querySelector('[data-code-visible="reference"]').hidden,false);assert.deepEqual(native(code.readEditor(root).codeSolution),value);
    root.fire('click',action(root,'add'));const row=root.querySelectorAll('[data-code-approach]').at(-1),newId=valueOf(root).approaches.at(-1).id;field(row,'title').value='Added implementation';field(row,'code').value='return 2;\n';
    const saved=code.readEditor(root).codeSolution;assert.equal(saved.code,primary);assert.equal(saved.approaches[0].id,'retained-variant');assert.equal(saved.approaches[0].code,variant);assert.equal(saved.approaches[1].id,newId);assert.equal(saved.approaches[1].code,'return 2;\n');
  }
  for(const role of ['snippet','algorithm'])assert.equal(code.newReference(role).approaches.length,0);
});
check('drafts retain unfinished approaches, while save removes wholly blank rows',()=>{
  const blank=approach({id:'blank-id',title:'',summary:'',code:'',headers:[],timeComplexity:'',spaceComplexity:'',complexityNotes:''});
  const root=editor(reference({role:'problem',approaches:[blank]}));
  assert.equal(valueOf(root).approaches[0].id,'blank-id');
  assert.equal(code.readEditor(root).codeSolution.approaches.length,0);
  field(root.querySelector('[data-code-approach]'),'code').value='// unfinished\n';
  assert.equal(valueOf(root).approaches[0].code,'// unfinished\n');
  assert.throws(()=>code.readEditor(root),/needs a name/);
});
check('role changes preserve inactive code and unfinished approaches in drafts',()=>{
  const root=editor(reference({code:'int saved;\n',approaches:[approach({id:'draft-id',title:'',summary:'Trying DFS'})]}));let changes=0;
  code.bindEditor(root,()=>{changes++;});
  field(root,'role').value='problem';root.fire('change');
  assert.equal(root.querySelector('[data-code-visible="reference"]').hidden,true);
  assert.equal(root.querySelector('[data-code-visible="approaches"]').hidden,false);
  field(root,'role').value='';root.fire('change');
  assert.equal(root.querySelector('[data-code-visible="active"]').hidden,true);
  assert.equal(valueOf(root).code,'int saved;\n');assert.equal(valueOf(root).approaches[0].id,'draft-id');assert.equal(changes,2);
});
check('inserting, reordering, removing and reopening approaches preserves stable IDs',()=>{
  const root=editor(reference({role:'problem',approaches:[approach({id:'first'}),approach({id:'second',title:'DFS'})]}));
  code.bindEditor(root);root.fire('click',action(root,'add'));
  let rows=root.querySelectorAll('[data-code-approach]');const added=valueOf(root).approaches.at(-1).id;
  assert.ok(added.startsWith('approach-test-'));field(rows.at(-1),'title').value='Third';
  root.fire('click',action(rows.at(-1),'up'));
  assert.deepEqual(native(valueOf(root).approaches.map(item=>item.id)),['first',added,'second']);
  const restored=editor(valueOf(root));assert.deepEqual(native(valueOf(restored).approaches.map(item=>item.id)),['first',added,'second']);
  rows=root.querySelectorAll('[data-code-approach]');root.fire('click',action(rows[1],'remove'));
  assert.deepEqual(native(valueOf(root).approaches.map(item=>item.id)),['first','second']);
});
check('detail sends exact code directly to the renderer and shows the palette once',()=>{
  const sources=[],received=[];const source='\nint x = 0;\r\n';
  const html=code.renderDetail({codeSolution:reference({role:'problem',approaches:[approach({code:source}),approach({id:'second',title:'DFS',code:'return {};\n'})]})},{renderCode:value=>{sources.push(value);return '<div class="rendered-code"></div>';},renderApproachConnections:item=>{received.push(item.id);return '<div class="approach-connections"></div>';}});
  assert.deepEqual(sources,[source,'return {};\n']);assert.deepEqual(received,['approach-1','second']);
  assert.equal((html.match(/aria-label="C\+\+ syntax colors"/g)||[]).length,1);
  assert.equal((html.match(/class="approach-connections"/g)||[]).length,2);
});
check('unsafe authored text is escaped across editor and detail, including code and IDs',()=>{
  const bad='<img src=x onerror=alert(1)>',value=reference({role:'problem',aliases:[bad],purpose:bad,code:bad,headers:[bad],pitfalls:[bad],timeComplexity:bad,approaches:[approach({id:'" onmouseover="bad()',title:bad,summary:bad,code:bad})]});
  for(const html of [code.renderEditor({codeSolution:value}),code.renderDetail({codeSolution:value})]){assert.ok(!html.includes('<img'));assert.ok(!html.includes(' onmouseover="bad()'));assert.ok(html.includes('&lt;img'));}
});
check('malformed imported fields and failed optional callbacks do not break detail rendering',()=>{
  for(const shard of [null,{codeSolution:null},{codeSolution:[]},{codeSolution:{role:'problem',approaches:[null,5,{headers:null,pitfalls:[null,'Caution'],code:4}],aliases:[null,5],purpose:{}}}]){
    assert.doesNotThrow(()=>code.renderDetail(shard,{renderCode:()=>{throw new Error('Unavailable');},renderMarkdown:()=>{throw new Error('Unavailable');},renderApproachConnections:()=>{throw new Error('Unavailable');}}));
    assert.doesNotThrow(()=>code.renderEditor(shard));
  }
});
check('quick references expose complexity and caveats without opening a tutorial',()=>{
  const html=code.renderDetail({codeSolution:reference({purpose:'Reverse digits.',code:'return 0;\n',timeComplexity:'O(d)',spaceComplexity:'O(1)',complexityNotes:'d counts decimal digits.',headers:['<limits>'],assumptions:['32-bit input'],pitfalls:['Check overflow before multiplying.']})});
  for(const text of ['Quick reference','O(d)','O(1)','d counts decimal digits.','Headers','Assumptions','Pitfalls','Check overflow before multiplying.'])assert.ok(html.includes(text));
  assert.ok(!html.includes('<details'));
});
check('search covers aliases and nested code contracts while title and aliases rank first',()=>{
  const shard={title:'Count set bits',codeSolution:reference({aliases:['popcount','count ones'],pitfalls:['unsigned-width'],approaches:[approach({title:'Kernighan',complexityNotes:'set-bit-count'})]})};
  for(const text of ['popcount','unsigned-width','Kernighan','set-bit-count'])assert.ok(code.searchText(shard).includes(text));
  assert.ok(code.searchRank(shard,'popcount')>code.searchRank({title:'Other',codeSolution:reference({purpose:'popcount'})},'popcount'));
  assert.ok(code.searchRank(shard,'count set bits')>code.searchRank(shard,'popcount'));
  assert.equal(code.searchRank(shard,''),0);
});
check('validation matches backend bounds and rejects duplicate approach identifiers',()=>{
  assert.throws(()=>code.readEditor(editor(reference({code:'x'.repeat(100001)}))),/100,000/);
  assert.throws(()=>code.readEditor(editor(reference({timeComplexity:'x'.repeat(501)}))),/500/);
  assert.throws(()=>code.readEditor(editor(reference({headers:['x'.repeat(241)]}))),/240/);
  assert.throws(()=>code.readEditor(editor(reference({role:'problem',approaches:[approach({}),approach({title:'DFS'})]}))),/own identifier/);
});
check('binding is idempotent and draft callbacks retain incomplete metadata',()=>{
  const root=editor(reference({role:'problem',approaches:[approach({title:'',summary:'Half-written'})]}));let calls=0;
  code.bindEditor(root,result=>{calls++;assert.equal(result.codeSolution.approaches[0].title,'');});
  code.bindEditor(root,()=>{throw new Error('Duplicate listener');});root.fire('input');root.fire('change');assert.equal(calls,2);
});
console.log(`${passed} code reference frontend checks passed.`);
