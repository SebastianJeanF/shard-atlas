/* Compact, optional code references on ordinary atlas shards. */
(() => {
  'use strict';
  const esc = value => String(value ?? '').replace(/[&<>"']/g, character => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character]));
  const string = value => typeof value === 'string' ? value : '';
  const strings = value => Array.isArray(value) ? value.filter(item => typeof item === 'string') : [];
  const objects = value => Array.isArray(value) ? value.filter(item => item && typeof item === 'object' && !Array.isArray(item)) : [];
  const roles = Object.freeze([['','None'],['snippet','Snippet'],['algorithm','Algorithm or data structure'],['problem','Solved problem']].map(Object.freeze));
  const listKeys = ['headers','assumptions','pitfalls'];
  const textKeys = ['purpose','code','timeComplexity','spaceComplexity','complexityNotes'];
  let sequence = 0;
  function metadata(shard = {}) { const value=shard?.codeSolution;return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
  function role(shard = {}) { const value=metadata(shard).role;return roles.some(([key])=>key===value)?value:''; }
  function aliases(shard = {}) { return strings(metadata(shard).aliases); }
  function empty() { return {role:'',aliases:[],purpose:'',code:'',headers:[],timeComplexity:'',spaceComplexity:'',complexityNotes:'',assumptions:[],pitfalls:[],approaches:[]}; }
  function newId() {return `approach-${globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${(++sequence).toString(36)}`}`;}
  function field(prefix,key,label,value,options = {}) {
    const id=`${prefix}-${key}`,attrs=`id="${id}" name="${id}" data-code-${options.list?'list':'field'}="${key}"${options.placeholder?` placeholder="${esc(options.placeholder)}"`:''}`;
    let control;
    if(options.choices)control=`<select ${attrs}>${options.choices.map(([key,title])=>`<option value="${esc(key)}"${key===value?' selected':''}>${esc(title)}</option>`).join('')}</select>`;
    else if(options.multiline||options.list)control=`<textarea ${attrs} rows="${options.rows||3}"${options.code?` class="code-source-input" spellcheck="false" autocapitalize="off" autocomplete="off" data-code-original="${esc(JSON.stringify(string(value)))}"`:''}>\n${esc(options.list?strings(value).join('\n'):string(value))}</textarea>`;
    else control=`<input ${attrs} type="text" value="${esc(value)}">`;
    return `<label class="field${options.wide?' code-editor-wide':''}" for="${id}">${label}${control}${options.hint?`<span class="field-hint">${esc(options.hint)}</span>`:''}</label>`;
  }
  function optionalFields(prefix,item) {
    return `<details class="code-editor-options"><summary>Complexity, headers &amp; caveats <span>optional</span></summary><div class="code-editor-grid">${field(prefix,'timeComplexity','Time complexity',item.timeComplexity,{placeholder:'O(n)'})}${field(prefix,'spaceComplexity','Extra space',item.spaceComplexity,{placeholder:'O(1)'})}${field(prefix,'complexityNotes','What the complexity assumes',item.complexityNotes,{multiline:true,wide:true,rows:2,placeholder:'n is the number of vertices; excludes the returned array.'})}${field(prefix,'headers','Required headers',item.headers,{list:true,wide:true,rows:2,hint:'One header per line, for example <vector>.'})}${field(prefix,'assumptions','Assumptions',item.assumptions,{list:true,hint:'One per line: input width, valid range, ordering…'})}${field(prefix,'pitfalls','Pitfalls',item.pitfalls,{list:true,hint:'One per line: overflow, empty input, signed shifts…'})}</div></details>`;
  }
  function renderApproach(item = {}) {
    const prefix=`code-approach-${++sequence}`,id=string(item.id)||newId();
    return `<fieldset class="code-approach-editor" data-code-approach="${esc(id)}"><legend>Solution approach</legend><div class="code-approach-controls"><button type="button" class="text-button" data-code-action="up" aria-label="Move approach up">↑</button><button type="button" class="text-button" data-code-action="down" aria-label="Move approach down">↓</button><button type="button" class="text-button" data-code-action="remove" aria-label="Remove approach">Remove</button></div>${field(prefix,'title','Approach name',item.title,{placeholder:'Kahn’s algorithm'})}${field(prefix,'summary','Idea & when to use it',item.summary,{multiline:true,rows:2})}${field(prefix,'code','C++ code',item.code,{multiline:true,code:true,rows:9})}${optionalFields(prefix,item)}<p class="code-editor-hint">After saving, connect this approach to the techniques it uses.</p></fieldset>`;
  }
  function renderEditor(shard = {}) {
    const item=metadata(shard),currentRole=role(shard),prefix=`code-reference-${++sequence}`;
    return `<section class="code-editor" data-code-editor aria-label="Code reference"><div class="code-editor-heading"><h3>Code reference</h3><p>A reusable snippet, an algorithm, or a solved problem.</p></div>${field(prefix,'role','Code reference type',currentRole,{choices:roles})}<div data-code-visible="active"${currentRole?'':' hidden'}>${field(prefix,'purpose','Purpose or problem reminder',item.purpose,{multiline:true,rows:2,placeholder:'What this solves, in a sentence or two.'})}<div data-code-visible="reference"${currentRole==='problem'?' hidden':''}>${field(prefix,'code','C++ code',item.code,{multiline:true,code:true,rows:10})}${optionalFields(prefix,item)}</div><section class="code-approaches-editor" data-code-visible="problem"${currentRole==='problem'?'':' hidden'}><div class="code-approaches-heading"><h4>Solution approaches</h4><button type="button" class="secondary" data-code-action="add">＋ Add approach</button></div><p class="code-editor-hint">Keep alternatives together, with their own code and complexities.</p><div data-code-approaches>${objects(item.approaches).map(renderApproach).join('')}</div></section><details class="code-editor-options"><summary>Search aliases <span>optional</span></summary>${field(prefix,'aliases','Other names you might search for',item.aliases,{list:true,rows:2,hint:'One per line: count ones, population count, popcount…'})}</details></div></section>`;
  }
  function rootFor(container) {return container?.matches?.('[data-code-editor]')?container:container?.querySelector?.('[data-code-editor]');}
  function readFields(container,owner) {
    const result={};
    for(const control of container.querySelectorAll('[data-code-field]'))if(control.closest('[data-code-approach]')===owner){let value=string(control.value);if(control.dataset.codeField==='code'&&typeof control.dataset.codeOriginal==='string'){try{const original=JSON.parse(control.dataset.codeOriginal);if(typeof original==='string'&&original.replace(/\r\n?/g,'\n')===value.replace(/\r\n?/g,'\n'))value=original;}catch{}}result[control.dataset.codeField]=value;}
    for(const control of container.querySelectorAll('[data-code-list]'))if(control.closest('[data-code-approach]')===owner)result[control.dataset.codeList]=string(control.value).split(/\r?\n/).map(value=>value.trim()).filter(Boolean);
    return result;
  }
  function normalizedApproach(row) {
    if(!row.dataset.codeApproach)row.dataset.codeApproach=newId();
    return {id:row.dataset.codeApproach,title:'',summary:'',code:'',headers:[],timeComplexity:'',spaceComplexity:'',complexityNotes:'',assumptions:[],pitfalls:[],...readFields(row,row)};
  }
  function meaningfulApproach(item) {return Object.entries(item).some(([key,value])=>key!=='id'&&(Array.isArray(value)?value.length:typeof value==='string'&&value.trim()));}
  function validate(value) {
    if(!roles.some(([key])=>key===value.role))throw new Error('Choose a code reference type.');
    const text=(item,key,label,max)=>{if(string(item[key]).length>max)throw new Error(`${label} must be at most ${max.toLocaleString('en')} characters.`);};
    const lists=(item,label)=>{for(const key of listKeys){if(item[key].length>100)throw new Error(`${label} ${key} must contain at most 100 entries.`);const max=key==='headers'?240:2000;for(const entry of item[key])if(entry.length>max)throw new Error(`${label} ${key} entries must be at most ${max.toLocaleString('en')} characters.`);}};
    const common=(item,label)=>{text(item,'code',label+' code',100000);text(item,'timeComplexity',label+' time complexity',500);text(item,'spaceComplexity',label+' space complexity',500);text(item,'complexityNotes',label+' complexity notes',5000);lists(item,label);};
    text(value,'purpose','Purpose',10000);common(value,'Code reference');
    if(value.aliases.length>200)throw new Error('Search aliases must contain at most 200 entries.');
    for(const alias of value.aliases)if(alias.length>240)throw new Error('Search aliases must be at most 240 characters each.');
    value.approaches=value.approaches.filter(meaningfulApproach);
    if(value.approaches.length>100)throw new Error('A solved problem can contain at most 100 approaches.');
    const seen=new Set();
    value.approaches.forEach((item,index)=>{const label=`Approach ${index+1}`;if(!item.title.trim())throw new Error(`${label} needs a name.`);text(item,'title',label+' name',240);text(item,'summary',label+' idea',10000);common(item,label);if(seen.has(item.id))throw new Error('Each solution approach needs its own identifier.');seen.add(item.id);});
    return value;
  }
  function readEditor(container,options = {}) {
    const root=rootFor(container);if(!root)return {codeSolution:empty()};
    const value={...empty(),...readFields(root,null),approaches:[...root.querySelectorAll('[data-code-approach]')].map(normalizedApproach)};
    return {codeSolution:options.validate===false?value:validate(value)};
  }
  function syncVisibility(root,value) {
    for(const section of root.querySelectorAll('[data-code-visible]'))section.hidden=section.dataset.codeVisible==='active'?!value.role:section.dataset.codeVisible==='problem'?value.role!=='problem':value.role==='problem';
    const rows=[...root.querySelectorAll('[data-code-approach]')];
    rows.forEach((row,index)=>{const up=row.querySelector('[data-code-action="up"]'),down=row.querySelector('[data-code-action="down"]');if(up)up.disabled=index===0;if(down)down.disabled=index===rows.length-1;});
  }
  function bindEditor(container,onChange = ()=>{}) {
    const root=rootFor(container);if(!root||root.dataset.codeBound)return;root.dataset.codeBound='true';
    const changed=()=>{const result=readEditor(root,{validate:false});syncVisibility(root,result.codeSolution);onChange(result);};
    root.addEventListener('input',changed);root.addEventListener('change',changed);
    root.addEventListener('click',event=>{
      const button=event.target.closest('[data-code-action]');if(!button||!root.contains(button))return;event.preventDefault();event.stopPropagation();
      const action=button.dataset.codeAction,row=button.closest('[data-code-approach]');let focus;
      if(action==='add'){const target=root.querySelector('[data-code-approaches]');if(!target)return;target.insertAdjacentHTML('beforeend',renderApproach());focus=target.lastElementChild.querySelector('input');}
      else if(action==='remove'&&row){focus=row.previousElementSibling?.querySelector('input')||root.querySelector('[data-code-action="add"]');row.remove();}
      else if(action==='up'&&row?.previousElementSibling){row.parentElement.insertBefore(row,row.previousElementSibling);focus=row.querySelector('[data-code-action="up"]');}
      else if(action==='down'&&row?.nextElementSibling){row.parentElement.insertBefore(row.nextElementSibling,row);focus=row.querySelector('[data-code-action="down"]');}
      changed();focus?.focus();
    });
    syncVisibility(root,readEditor(root,{validate:false}).codeSolution);
  }
  function markdown(value,context) {const source=string(value);if(!source)return '';try{if(typeof context.renderMarkdown==='function')return context.renderMarkdown(source);}catch{}return `<p>${esc(source).replace(/\n/g,'<br>')}</p>`;}
  function code(value,context) {const source=string(value);if(!source)return '';try{if(typeof context.renderCode==='function')return context.renderCode(source);}catch{}return `<div class="code-block"><div class="code-toolbar"><span>C++</span><button type="button" class="text-button" data-action="copy-code">Copy</button></div><pre><code>${esc(source)}</code></pre></div>`;}
  function facts(values,label,kind) {const items=strings(values);return items.length?`<div class="code-reference-facts${kind?` code-reference-${kind}`:''}"><h5>${label}</h5><ul>${items.map(value=>`<li>${esc(value)}</li>`).join('')}</ul></div>`:'';}
  function costs(item) {const time=string(item.timeComplexity),space=string(item.spaceComplexity);return `${time||space?`<dl class="code-reference-costs">${time?`<div><dt>Time</dt><dd>${esc(time)}</dd></div>`:''}${space?`<div><dt>Extra space</dt><dd>${esc(space)}</dd></div>`:''}</dl>`:''}${item.complexityNotes?`<p class="code-complexity-note">${esc(string(item.complexityNotes))}</p>`:''}`;}
  function caveats(item) {return `${strings(item.headers).length?`<p class="code-required-headers"><span>Headers</span> ${strings(item.headers).map(value=>`<code>${esc(value)}</code>`).join(' ')}</p>`:''}<div class="code-caveats">${facts(item.assumptions,'Assumptions')}${facts(item.pitfalls,'Pitfalls','pitfalls')}</div>`;}
  function renderDetail(shard = {},context = {}) {
    const item=metadata(shard),currentRole=role(shard);if(!currentRole)return '';
    const approaches=objects(item.approaches),hasCode=!!string(item.code)||(currentRole==='problem'&&approaches.some(item=>string(item.code)));
    const key=hasCode?'<div class="syntax-key code-reference-key" aria-label="C++ syntax colors"><span class="syn-keyword">Keywords</span><span class="syn-type">Types</span><span class="syn-function">Functions</span><span class="syn-number">Numbers</span><span class="syn-string">Literals</span><span class="syn-comment">Comments</span></div>':'';
    const approachMarkup=currentRole==='problem'?`<div class="code-solution-approaches">${approaches.map((approach,index)=>{let connections='';try{if(typeof context.renderApproachConnections==='function')connections=context.renderApproachConnections(approach)||'';}catch{}return `<article class="code-solution-approach" data-code-approach-id="${esc(string(approach.id))}"><header><span>Approach ${index+1}</span><h4>${esc(string(approach.title)||'Solution approach')}</h4></header>${string(approach.summary)?`<div class="markdown code-approach-summary">${markdown(approach.summary,context)}</div>`:''}${code(approach.code,context)}${costs(approach)}${caveats(approach)}${connections}</article>`;}).join('')}</div>`:'';
    return `<section class="code-reference-detail" aria-label="Code reference"><header class="code-reference-heading"><h3>Quick reference</h3><span class="code-role-badge">${esc(roles.find(([key])=>key===currentRole)[1])}</span></header>${item.purpose?`<div class="code-reference-purpose markdown">${markdown(item.purpose,context)}</div>`:''}${key}${code(item.code,context)}${costs(item)}${caveats(item)}${approachMarkup}${aliases(shard).length?`<details class="code-reference-aliases"><summary>Also find this as</summary><p>${aliases(shard).map(esc).join(' · ')}</p></details>`:''}</section>`;
  }
  function searchText(shard = {}) {const parts=[];const append=value=>{if(typeof value==='string')parts.push(value);else if(Array.isArray(value))value.forEach(append);};const item=metadata(shard);append(item.aliases);for(const key of [...textKeys,...listKeys])append(item[key]);for(const approach of objects(item.approaches)){append(approach.title);append(approach.summary);for(const key of ['code','timeComplexity','spaceComplexity','complexityNotes',...listKeys])append(approach[key]);}return parts.join(' ');}
  function searchRank(shard = {},query = '') {const normalized=string(query).trim().toLocaleLowerCase('en');if(!normalized)return 0;const title=string(shard.title).toLocaleLowerCase('en'),names=aliases(shard).map(value=>value.toLocaleLowerCase('en'));if(title===normalized)return 100;if(names.includes(normalized))return 95;if(title.startsWith(normalized))return 80;if(names.some(value=>value.startsWith(normalized)))return 75;if(title.includes(normalized))return 60;if(names.some(value=>value.includes(normalized)))return 55;const words=normalized.split(/\s+/);return words.every(word=>title.includes(word))?45:words.every(word=>names.some(value=>value.includes(word)))?40:0;}
  window.CodeSolutions=Object.freeze({roles,role,aliases,renderEditor,readEditor,bindEditor,renderDetail,searchText,searchRank});
})();
