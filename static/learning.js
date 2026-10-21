/* Optional explanations, ordered reasoning, and personal questions on shared concepts. */
(() => {
  'use strict';
  const esc = value => String(value ?? '').replace(/[&<>"']/g, character => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character]));
  const string = value => typeof value === 'string' ? value : '';
  const trim = value => string(value).trim();
  const objects = value => Array.isArray(value) ? value.filter(item=>item && typeof item==='object' && !Array.isArray(item)) : [];
  const strings = value => Array.isArray(value) ? value.filter(item=>typeof item==='string') : [];
  const verificationDefault = () => ({status:'unverified',note:'',sourceUrl:'',sourceLocation:'',checkedAt:''});
  const emptyMetadata = () => ({perspectives:[],walkthroughs:[],comparisons:[],learningLog:[],verification:verificationDefault()});
  const labels = {perspective:'Perspective',walkthrough:'Walkthrough',step:'Step',comparison:'Method comparison',alternative:'Alternative',log:'Question or misconception',history:'History entry'};
  const owners = {step:'walkthrough',alternative:'comparison',history:'log'};
  let sequence = 0;

  function safeUrl(value) {try {const url=new URL(string(value));return ['http:','https:'].includes(url.protocol)?url.href:'';}catch{return '';}}
  function sourceMarkup(item) {
    const url=safeUrl(item.sourceUrl),location=string(item.sourceLocation);
    return url||location?`<footer class="learning-source">${location?`<span>${esc(location)}</span>`:''}${url?`<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">View source ↗</a>`:''}</footer>`:'';
  }
  function renderList(values,label) {const items=strings(values);return items.length?`<div class="learning-facts"><h5>${label}</h5><ul>${items.map(value=>`<li>${esc(value)}</li>`).join('')}</ul></div>`:'';}
  function markdown(value,options) {const source=string(value);if(!source)return '';try{return typeof options.renderMarkdown==='function'?options.renderMarkdown(source):`<p>${esc(source).replace(/\n/g,'<br>')}</p>`;}catch{return `<p>${esc(source)}</p>`;}}
  function math(value,options) {const source=string(value);if(!source)return '';try{return typeof options.renderMath==='function'?options.renderMath(source,true):`<code>${esc(source)}</code>`;}catch{return `<code>${esc(source)}</code>`;}}
  function conceptLink(shard,options) {
    if(typeof options.renderConceptLink==='function'){
      try {const rendered=options.renderConceptLink(shard);if(typeof rendered==='string')return rendered;}catch{}
    }
    return `<button type="button" class="text-button learning-linked-concept" data-shard-id="${esc(shard.id)}">${esc(shard.title || 'Open linked concept')} ↗</button>`;
  }
  function section(title,items,render) {return items.length?`<details class="learning-detail-section"><summary>${title} <span>${items.length}</span></summary><div class="learning-detail-section-body">${items.map(render).join('')}</div></details>`:'';}

  function renderDetail(shard = {}, options = {}) {
    const perspectives=objects(shard.perspectives),walkthroughs=objects(shard.walkthroughs),comparisons=objects(shard.comparisons),log=objects(shard.learningLog),verification={...verificationDefault(),...(shard.verification&&typeof shard.verification==='object'&&!Array.isArray(shard.verification)?shard.verification:{})};
    const status=['unverified','source-checked','needs-correction'].includes(verification.status)?verification.status:'unverified';
    const statusLabel={'unverified':'Unverified','source-checked':'Source checked','needs-correction':'Needs correction'}[status];
    const verificationMarkup=`<div class="learning-verification" data-verification-status="${status}"><div><span>Content verification</span><strong>${statusLabel}</strong></div><small>Your understanding is tracked separately.</small>${verification.note||verification.sourceUrl||verification.sourceLocation||verification.checkedAt?`<details><summary>Verification details</summary>${verification.note?`<p>${esc(verification.note)}</p>`:''}${verification.checkedAt?`<p class="learning-checked-date">Checked ${esc(verification.checkedAt)}</p>`:''}${sourceMarkup(verification)}</details>`:''}</div>`;
    return `<section class="learning-detail" aria-label="Perspectives, reasoning, and learning log">${verificationMarkup}`+
      section('Perspectives',perspectives,item=>`<article class="learning-perspective"><header><h4>${esc(item.title)}</h4>${item.viewpoint?`<span class="learning-viewpoint">${esc(item.viewpoint)}</span>`:''}</header><div class="markdown">${markdown(item.content,options)}</div>${renderList(item.assumptions,'Assumptions')}${sourceMarkup(item)}</article>`)+
      section('Walkthroughs',walkthroughs,(item,index)=>{
        const steps=objects(item.steps);
        return `<details class="learning-walkthrough"${index===0?' open':''}><summary><span>${esc(item.title)}</span><small>${item.kind==='trace'?'Algorithm trace':'Derivation'} · ${steps.length} ${steps.length===1?'step':'steps'}</small></summary>${item.goal?`<div class="learning-goal markdown"><span class="learning-label">Goal</span>${markdown(item.goal,options)}</div>`:''}<div class="learning-player" data-learning-player data-current="0" data-show-all="false"><div class="learning-player-controls"><button type="button" class="secondary" data-learning-nav="previous" disabled aria-label="Previous step">← Previous</button><span class="learning-step-position" role="status">${steps.length?`Step 1 of ${steps.length}`:'No steps'}</span><button type="button" class="secondary" data-learning-nav="next"${steps.length<2?' disabled':''} aria-label="Next step">Next →</button><button type="button" class="text-button" data-learning-nav="all" aria-pressed="false">Show all steps</button></div><div class="learning-steps">${steps.map((step,stepIndex)=>`<article class="learning-step" data-learning-step${stepIndex?' hidden':''}><div class="learning-step-heading"><span>Step ${stepIndex+1}</span>${step.title?`<h5>${esc(step.title)}</h5>`:''}</div>${step.expression?`<div class="learning-expression">${math(step.expression,options)}</div>`:''}${step.explanation?`<div class="learning-step-explanation markdown">${markdown(step.explanation,options)}</div>`:''}${step.justification?`<div class="learning-justification markdown"><span class="learning-label">Why this step follows</span>${markdown(step.justification,options)}</div>`:''}</article>`).join('')}</div></div>${item.conclusion?`<div class="learning-conclusion markdown"><span class="learning-label">Conclusion</span>${markdown(item.conclusion,options)}</div>`:''}${sourceMarkup(item)}</details>`;
      })+
      section('Method comparisons',comparisons,item=>`<article class="learning-comparison"><h4>${esc(item.title)}</h4>${item.question?`<div class="learning-comparison-question markdown">${markdown(item.question,options)}</div>`:''}<div class="learning-comparison-grid" style="--learning-alternatives:${Math.min(3,Math.max(1,objects(item.alternatives).length))}">${objects(item.alternatives).map(alternative=>{let linked;try{linked=typeof options.resolveShard==='function'?options.resolveShard(string(alternative.shardId)):null;}catch{linked=null;}return `<article class="learning-alternative"><header><h5>${esc(alternative.name)}</h5>${linked&&string(linked.id)?conceptLink(linked,options):alternative.shardId?'<span class="learning-unavailable-link">Linked concept outside this atlas</span>':''}</header>${alternative.summary?`<div class="markdown">${markdown(alternative.summary,options)}</div>`:''}${renderList(alternative.assumptions,'Assumptions')}${renderList(alternative.strengths,'Strengths')}${renderList(alternative.limitations,'Limitations')}${alternative.cost?`<div class="learning-cost"><h5>Computational cost</h5><p>${esc(alternative.cost)}</p></div>`:''}</article>`;}).join('')}</div>${item.conclusion?`<div class="learning-conclusion markdown"><span class="learning-label">Conclusion</span>${markdown(item.conclusion,options)}</div>`:''}${sourceMarkup(item)}</article>`)+
      section('Questions &amp; misconceptions',log,item=>`<article class="learning-log-entry" data-log-status="${item.status==='resolved'?'resolved':'open'}"><header><span class="learning-log-kind">${item.kind==='misconception'?'Misconception':'Question'}</span><span class="learning-log-status">${item.status==='resolved'?'Resolved':'Open'}</span></header><h4>${esc(item.prompt)}</h4>${item.resolution?`<div class="learning-resolution markdown"><span class="learning-label">Resolution</span>${markdown(item.resolution,options)}</div>`:''}${objects(item.history).length?`<details class="learning-history"><summary>History <span>${objects(item.history).length}</span></summary><ol>${objects(item.history).map(entry=>`<li>${entry.date?`<time>${esc(entry.date)}</time>`:'<span class="learning-undated">Date not recorded</span>'}<p>${esc(entry.note)}</p></li>`).join('')}</ol></details>`:''}${sourceMarkup(item)}</article>`)+`</section>`;
  }

  function field(prefix,key,label,value,options = {}) {
    const id=`${prefix}-${key}`,attributes=`id="${id}" name="${id}" data-learning-${options.list?'list':'field'}="${key}"${options.required?' aria-required="true"':''}${options.placeholder?` placeholder="${esc(options.placeholder)}"`:''}`;
    let control;
    if(options.choices)control=`<select ${attributes}>${options.choices.map(([item,title])=>`<option value="${esc(item)}"${item===value?' selected':''}>${esc(title)}</option>`).join('')}</select>`;
    else if(options.multiline||options.list)control=`<textarea ${attributes} rows="${options.rows||3}"${options.max?` maxlength="${options.max}"`:''}>${esc(options.list?strings(value).join('\n'):string(value))}</textarea>`;
    else control=`<input ${attributes} type="text" value="${esc(value)}"${options.max?` maxlength="${options.max}"`:''}>`;
    return `<label class="field${options.wide?' learning-wide':''}" for="${id}">${label}${control}${options.hint?`<span class="field-hint">${options.hint}</span>`:''}</label>`;
  }
  function sources(prefix,item) {return `<details class="learning-editor-source"${item.sourceUrl||item.sourceLocation?' open':''}><summary>Source &amp; location</summary><div class="learning-editor-grid">${field(prefix,'sourceUrl','Source link',item.sourceUrl,{placeholder:'https://…',max:2048})}${field(prefix,'sourceLocation','Source location',item.sourceLocation,{placeholder:'Page, section, slide, or timestamp',max:240})}</div></details>`;}
  function rowControls(kind) {return `<div class="learning-row-controls"><button type="button" class="text-button" data-learning-action="up" aria-label="Move ${labels[kind].toLocaleLowerCase('en')} up">↑</button><button type="button" class="text-button" data-learning-action="down" aria-label="Move ${labels[kind].toLocaleLowerCase('en')} down">↓</button><button type="button" class="text-button" data-learning-action="remove" aria-label="Remove ${labels[kind].toLocaleLowerCase('en')}">Remove</button></div>`;}
  function row(kind,item,body) {return `<fieldset class="learning-editor-row" data-learning-row="${kind}"><legend>${labels[kind]}</legend>${rowControls(kind)}${body}</fieldset>`;}
  function rows(kind,values,options) {return `<div data-learning-rows="${kind}">${objects(values).map(value=>renderRow(kind,value,options)).join('')}</div>`;}
  function addButton(kind,title) {return `<button type="button" class="secondary" data-learning-action="add" data-learning-kind="${kind}">＋ ${title || labels[kind]}</button>`;}
  function linkedConcept(prefix,value,options) {
    const shards=objects(options.shards).filter(shard=>string(shard.id)).sort((a,b)=>string(a.title).localeCompare(string(b.title),'en'));
    const choices=[['','No linked concept'],...shards.map(shard=>[shard.id,shard.title||'Untitled concept'])];
    if(value&&!shards.some(shard=>shard.id===value))choices.push([value,'Linked concept outside this atlas']);
    return field(prefix,'shardId','Linked concept',value,{choices});
  }
  function renderRow(kind,item = {},options = {}) {
    const prefix=`learning-${kind}-${++sequence}`;
    if(kind==='perspective')return row(kind,item,`<div class="learning-editor-grid">${field(prefix,'title','Perspective title',item.title,{required:true,max:240})}${field(prefix,'viewpoint','Viewpoint',item.viewpoint,{placeholder:'Geometric, algebraic, algorithmic, practical…',max:240})}${field(prefix,'content','Perspective explanation',item.content,{multiline:true,wide:true,required:true,max:30000,rows:5,hint:'Markdown, code, and math are supported.'})}${field(prefix,'assumptions','Perspective assumptions',item.assumptions,{list:true,wide:true,hint:'One assumption per line.'})}</div>${sources(prefix,item)}`);
    if(kind==='step')return row(kind,item,`${field(prefix,'title','Step title',item.title,{max:240})}${field(prefix,'expression','Expression',item.expression,{multiline:true,rows:2,max:5000,hint:'Optional TeX, without dollar delimiters. Keep one algebraic operation per step.'})}${field(prefix,'explanation','Step explanation',item.explanation,{multiline:true,max:10000,hint:'Explain the operation or the algorithm state change.'})}${field(prefix,'justification','Why this step follows',item.justification,{multiline:true,max:5000,hint:'Name the substitution, assumption, theorem, or invariant used.'})}`);
    if(kind==='walkthrough')return row(kind,item,`<div class="learning-editor-grid">${field(prefix,'title','Walkthrough title',item.title,{required:true,max:240})}${field(prefix,'kind','Walkthrough kind',item.kind||'derivation',{choices:[['derivation','Derivation'],['trace','Algorithm trace']]})}${field(prefix,'goal','Walkthrough goal',item.goal,{multiline:true,wide:true,max:5000})}</div><div class="learning-nested-heading"><h4>Ordered steps</h4>${addButton('step','Step')}</div>${rows('step',Array.isArray(item.steps)?item.steps:[{}],options)}${field(prefix,'conclusion','Walkthrough conclusion',item.conclusion,{multiline:true,max:5000})}${sources(prefix,item)}`);
    if(kind==='alternative')return row(kind,item,`<div class="learning-editor-grid">${field(prefix,'name','Alternative name',item.name,{required:true,max:240})}${linkedConcept(prefix,item.shardId||'',options)}${field(prefix,'summary','Alternative summary',item.summary,{multiline:true,wide:true,max:5000})}${field(prefix,'assumptions','Alternative assumptions',item.assumptions,{list:true,wide:true,hint:'One assumption per line.'})}${field(prefix,'strengths','Strengths',item.strengths,{list:true,hint:'One strength per line.'})}${field(prefix,'limitations','Limitations',item.limitations,{list:true,hint:'One limitation per line.'})}${field(prefix,'cost','Computational cost',item.cost,{multiline:true,wide:true,max:2000})}</div>`);
    if(kind==='comparison')return row(kind,item,`${field(prefix,'title','Comparison title',item.title,{required:true,max:240})}${field(prefix,'question','Comparison question',item.question,{multiline:true,max:5000,hint:'What decision or distinction does this comparison explain?'})}<div class="learning-nested-heading"><h4>Alternatives</h4>${addButton('alternative','Alternative')}</div>${rows('alternative',Array.isArray(item.alternatives)?item.alternatives:[{},{}],options)}${field(prefix,'conclusion','Comparison conclusion',item.conclusion,{multiline:true,max:5000})}${sources(prefix,item)}`);
    if(kind==='history')return row(kind,item,`<div class="learning-editor-grid">${field(prefix,'date','History date',item.date,{max:10,placeholder:'YYYY, YYYY-MM, or YYYY-MM-DD'})}${field(prefix,'note','History note',item.note,{multiline:true,required:true,max:5000})}</div>`);
    if(kind==='log')return row(kind,item,`<div class="learning-editor-grid">${field(prefix,'kind','Log kind',item.kind||'question',{choices:[['question','Question'],['misconception','Misconception']]})}${field(prefix,'status','Question status',item.status||'open',{choices:[['open','Open'],['resolved','Resolved']]})}${field(prefix,'prompt','Question or original misconception',item.prompt,{multiline:true,wide:true,required:true,max:5000})}${field(prefix,'resolution','Resolution',item.resolution,{multiline:true,wide:true,max:10000,hint:'Required when marked Resolved. Preserve what changed your understanding.'})}</div><div class="learning-nested-heading"><h4>Dated history</h4>${addButton('history','History entry')}</div>${rows('history',item.history,options)}${sources(prefix,item)}`);
    return '';
  }
  function editorSection(kind,title,description,values,options) {return `<details class="learning-editor-section"${objects(values).length?' open':''}><summary>${title} <span data-learning-count="${kind}">${objects(values).length}</span></summary><div class="learning-editor-section-body"><div class="learning-section-description"><p>${description}</p>${addButton(kind)}</div>${rows(kind,values,options)}</div></details>`;}
  function renderEditor(shard = {},options = {}) {
    const prefix=`learning-verification-${++sequence}`,verification={...verificationDefault(),...(shard.verification&&typeof shard.verification==='object'&&!Array.isArray(shard.verification)?shard.verification:{})};
    const hasContent=[shard.perspectives,shard.walkthroughs,shard.comparisons,shard.learningLog].some(values=>objects(values).length)||verification.status!=='unverified'||verification.note||verification.sourceUrl||verification.sourceLocation||verification.checkedAt;
    return `<section class="learning-editor" data-learning-editor><details class="learning-editor-panel"${hasContent?' open':''}><summary>Learning &amp; explanation<span>Optional perspectives, reasoning, and questions</span></summary><div class="learning-editor-body">`+
      editorSection('perspective','Perspectives','Explain the same concept from different viewpoints.',shard.perspectives,options)+
      editorSection('walkthrough','Walkthroughs','Keep derivations and algorithm traces in a deliberate order.',shard.walkthroughs,options)+
      editorSection('comparison','Method comparisons','Compare methods and their assumptions within this concept.',shard.comparisons,options)+
      editorSection('log','Questions &amp; misconceptions','Preserve an open question or an original misunderstanding and how it changed.',shard.learningLog,options)+
      `<details class="learning-editor-section"${verification.status!=='unverified'||verification.note||verification.sourceUrl||verification.sourceLocation||verification.checkedAt?' open':''}><summary>Content verification <span>Separate from understanding</span></summary><fieldset class="learning-verification-editor" data-learning-row="verification"><legend>Check the explanation against a source</legend><div class="learning-editor-grid">${field(prefix,'status','Verification status',verification.status,{choices:[['unverified','Unverified'],['source-checked','Source checked'],['needs-correction','Needs correction']]})}${field(prefix,'checkedAt','Checked date',verification.checkedAt,{max:10,placeholder:'YYYY, YYYY-MM, or YYYY-MM-DD'})}${field(prefix,'note','Verification note',verification.note,{multiline:true,wide:true,max:5000,hint:'For Source checked, explain what you checked and provide a source link or location.'})}${field(prefix,'sourceUrl','Verification source link',verification.sourceUrl,{max:2048,placeholder:'https://…'})}${field(prefix,'sourceLocation','Verification source location',verification.sourceLocation,{max:240,placeholder:'Page, section, slide, or timestamp'})}</div></fieldset></details></div></details></section>`;
  }

  function rootFor(container) {return container?.matches?.('[data-learning-editor]')?container:container?.querySelector?.('[data-learning-editor]');}
  function ownedFields(row,selector) {return [...row.querySelectorAll(selector)].filter(input=>input.closest('[data-learning-row]')===row);}
  function readRow(row) {
    if(!row)return {};
    const value=Object.fromEntries(ownedFields(row,'[data-learning-field]').map(input=>[input.dataset.learningField,string(input.value)]));
    for(const input of ownedFields(row,'[data-learning-list]'))value[input.dataset.learningList]=string(input.value).split('\n').map(line=>line.trim()).filter(Boolean);
    const kind=row.dataset.learningRow;
    if(kind==='walkthrough')value.steps=readRows(row,'step');
    if(kind==='comparison')value.alternatives=readRows(row,'alternative');
    if(kind==='log')value.history=readRows(row,'history');
    return value;
  }
  function readRows(container,kind) {return [...container.querySelectorAll(`[data-learning-row="${kind}"]`)].map(readRow);}
  function meaningful(value,ignored=new Set(['kind','status'])) {
    if(Array.isArray(value))return value.some(item=>meaningful(item,ignored));
    if(value&&typeof value==='object')return Object.entries(value).some(([key,item])=>!ignored.has(key)&&meaningful(item,ignored));
    return typeof value==='string'?!!value.trim():false;
  }
  function validDate(value) {
    if(!value)return true;
    if(!/^\d{4}(?:-\d{2}(?:-\d{2})?)?$/.test(value))return false;
    const [year,month,day]=value.split('-').map(Number);if(year<1)return false;if(month===undefined)return true;if(month<1||month>12)return false;if(day===undefined)return true;
    const leap=year%4===0&&(year%100!==0||year%400===0);return day>=1&&day<=[31,leap?29:28,31,30,31,30,31,31,30,31,30,31][month-1];
  }
  function validateMetadata(result) {
    const bound=(value,label,max,required=false)=>{if(typeof value!=='string')throw new Error(`${label} must be text.`);if(required&&!value.trim())throw new Error(`${label} is required.`);if(value.length>max)throw new Error(`${label} must be at most ${max.toLocaleString('en')} characters.`);};
    const maximum=(items,label,max,min=0)=>{if(items.length>max||items.length<min)throw new Error(`${label} must contain ${min?`${min} to ${max}`:`at most ${max}`} entries.`);};
    const source=(item,label)=>{bound(item.sourceUrl,label+' source link',2048);bound(item.sourceLocation,label+' source location',240);if(item.sourceUrl&&!safeUrl(item.sourceUrl))throw new Error(`${label}: use an http or https source link.`);};
    const lines=(items,label,max=30)=>{maximum(items,label,max);for(const value of items)bound(value,label+' entry',2000,true);};
    const date=(value,label)=>{bound(value,label,10);if(!validDate(value))throw new Error(`${label} must be a valid YYYY, YYYY-MM, or YYYY-MM-DD date.`);};
    for(const key of ['perspectives','walkthroughs','comparisons','learningLog'])result[key]=result[key].filter(item=>meaningful(item));
    maximum(result.perspectives,'Perspectives',20);maximum(result.walkthroughs,'Walkthroughs',20);maximum(result.comparisons,'Method comparisons',20);maximum(result.learningLog,'Questions and misconceptions',100);
    result.perspectives.forEach((item,index)=>{const label=`Perspective ${index+1}`;bound(item.title,label+' title',240,true);bound(item.viewpoint,label+' viewpoint',240);bound(item.content,label+' explanation',30000,true);lines(item.assumptions,label+' assumptions',20);source(item,label);});
    result.walkthroughs.forEach((item,index)=>{const label=`Walkthrough ${index+1}`;bound(item.title,label+' title',240,true);if(!['derivation','trace'].includes(item.kind))throw new Error(label+': choose Derivation or Algorithm trace.');bound(item.goal,label+' goal',5000);bound(item.conclusion,label+' conclusion',5000);source(item,label);item.steps=item.steps.filter(step=>meaningful(step));maximum(item.steps,label+' steps',100,1);item.steps.forEach((step,stepIndex)=>{const name=`${label}, step ${stepIndex+1}`;bound(step.title,name+' title',240);bound(step.expression,name+' expression',5000);bound(step.explanation,name+' explanation',10000);bound(step.justification,name+' justification',5000);if(!step.expression.trim()&&!step.explanation.trim())throw new Error(name+' needs an expression or explanation.');});});
    result.comparisons.forEach((item,index)=>{const label=`Comparison ${index+1}`;bound(item.title,label+' title',240,true);bound(item.question,label+' question',5000);bound(item.conclusion,label+' conclusion',5000);source(item,label);item.alternatives=item.alternatives.filter(alternative=>meaningful(alternative));maximum(item.alternatives,label+' alternatives',10,2);item.alternatives.forEach((alternative,alternativeIndex)=>{const name=`${label}, alternative ${alternativeIndex+1}`;bound(alternative.name,name+' name',240,true);bound(alternative.shardId,name+' linked concept',120);if(alternative.shardId&&!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$/.test(alternative.shardId))throw new Error(name+' has an invalid linked concept.');bound(alternative.summary,name+' summary',5000);bound(alternative.cost,name+' computational cost',2000);for(const key of ['assumptions','strengths','limitations'])lines(alternative[key],name+' '+key);});});
    result.learningLog.forEach((item,index)=>{const label=`Learning log entry ${index+1}`;if(!['question','misconception'].includes(item.kind))throw new Error(label+': choose Question or Misconception.');if(!['open','resolved'].includes(item.status))throw new Error(label+': choose Open or Resolved.');bound(item.prompt,label+' question or misconception',5000,true);bound(item.resolution,label+' resolution',10000,item.status==='resolved');source(item,label);item.history=item.history.filter(entry=>meaningful(entry));maximum(item.history,label+' history',100);item.history.forEach((entry,historyIndex)=>{const name=`${label}, history ${historyIndex+1}`;date(entry.date,name+' date');bound(entry.note,name+' note',5000,true);});});
    const verification=result.verification;if(!['unverified','source-checked','needs-correction'].includes(verification.status))throw new Error('Choose a valid verification status.');bound(verification.note,'Verification note',5000,verification.status==='source-checked');source(verification,'Verification');date(verification.checkedAt,'Checked date');if(verification.status==='source-checked'&&!verification.sourceUrl.trim()&&!verification.sourceLocation.trim())throw new Error('Source checked needs a source link or source location.');
    return result;
  }
  function readEditor(container,options = {}) {
    const root=rootFor(container);if(!root)return emptyMetadata();
    const result={perspectives:readRows(root,'perspective'),walkthroughs:readRows(root,'walkthrough'),comparisons:readRows(root,'comparison'),learningLog:readRows(root,'log'),verification:{...verificationDefault(),...readRow(root.querySelector('[data-learning-row="verification"]'))}};
    return options.validate===false?result:validateMetadata(result);
  }
  function bindEditor(container,onChange = ()=>{},options = {}) {
    const root=rootFor(container);if(!root||root.dataset.learningBound)return;root.dataset.learningBound='true';
    const changed=()=>{const value=readEditor(root,{validate:false}),counts={perspective:value.perspectives.length,walkthrough:value.walkthroughs.length,comparison:value.comparisons.length,log:value.learningLog.length};for(const counter of root.querySelectorAll('[data-learning-count]'))counter.textContent=String(counts[counter.dataset.learningCount]||0);onChange(value);};root.addEventListener('input',changed);root.addEventListener('change',changed);
    root.addEventListener('click',event=>{
      const button=event.target.closest('[data-learning-action]');if(!button||!root.contains(button))return;event.preventDefault();event.stopPropagation();
      const action=button.dataset.learningAction,row=button.closest('[data-learning-row]');let focus;
      if(action==='add'){
        const kind=button.dataset.learningKind,owner=owners[kind]?button.closest(`[data-learning-row="${owners[kind]}"]`):root;
        const target=owner?.querySelector(`[data-learning-rows="${kind}"]`);if(!target)return;
        target.insertAdjacentHTML('beforeend',renderRow(kind,{},options));focus=target.lastElementChild.querySelector('input,textarea,select');
      }else if(action==='remove'&&row){focus=row.previousElementSibling?.querySelector('input,textarea,select')||row.parentElement.parentElement.querySelector('[data-learning-action="add"]');row.remove();}
      else if(action==='up'&&row?.previousElementSibling){row.parentElement.insertBefore(row,row.previousElementSibling);focus=row.querySelector('[data-learning-action="up"]');}
      else if(action==='down'&&row?.nextElementSibling){row.parentElement.insertBefore(row.nextElementSibling,row);focus=row.querySelector('[data-learning-action="down"]');}
      changed();focus?.focus();
    });
  }
  function updatePlayer(player,index,showAll) {
    const steps=[...player.querySelectorAll('[data-learning-step]')],current=Math.max(0,Math.min(steps.length-1,index));player.dataset.current=String(current);player.dataset.showAll=String(showAll);
    steps.forEach((step,stepIndex)=>{step.hidden=!showAll&&stepIndex!==current;});
    const previous=player.querySelector('[data-learning-nav="previous"]'),next=player.querySelector('[data-learning-nav="next"]'),all=player.querySelector('[data-learning-nav="all"]'),status=player.querySelector('.learning-step-position');
    if(previous)previous.disabled=showAll||current<=0;if(next)next.disabled=showAll||current>=steps.length-1;if(all){all.textContent=showAll?'One step at a time':'Show all steps';all.setAttribute('aria-pressed',String(showAll));}if(status)status.textContent=showAll?`All ${steps.length} steps`:steps.length?`Step ${current+1} of ${steps.length}`:'No steps';
  }
  const detailBindings=new WeakSet();
  function bindDetail(container) {
    if(!container?.addEventListener||detailBindings.has(container))return;detailBindings.add(container);
    container.addEventListener('click',event=>{const button=event.target.closest('[data-learning-nav]');if(!button)return;const player=button.closest('[data-learning-player]');if(!player)return;event.preventDefault();event.stopPropagation();const index=Number(player.dataset.current)||0,all=player.dataset.showAll==='true',action=button.dataset.learningNav;updatePlayer(player,index+(action==='next'?1:action==='previous'?-1:0),action==='all'?!all:all);});
  }
  function searchText(shard = {}) {
    const parts=[],append=value=>{if(typeof value==='string')parts.push(value);else if(Array.isArray(value))value.forEach(append);else if(value&&typeof value==='object')Object.values(value).forEach(append);};
    for(const key of ['perspectives','walkthroughs','comparisons','learningLog','verification'])append(shard[key]);return parts.join(' ');
  }
  window.LearningAtlas=Object.freeze({renderEditor,readEditor,bindEditor,renderDetail,searchText,bindDetail});
})();
