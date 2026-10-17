const $ = (selector, root = document) => root.querySelector(selector);
const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
const relations = {depends_on:'depends on', explains:'explains', contrasts_with:'contrasts with', example_of:'is an example of', related_to:'relates to',part_of:'is part of',supports:'supports',contradicts:'contradicts',supersedes:'supersedes',released_by:'was released by'};
const kinds = {concept:'Concept',fact:'Fact',example:'Example',mistake:'Learning moment',event:'Dated note',idea:'Idea'};
const coreRelations = ['depends_on','explains','contrasts_with','example_of','related_to','part_of'];
const statuses = {learning:'Learning',solid:'Confident',verify:'Needs verification'};
const timelineThemeKey = 'shard-atlas-timeline-theme';
function savedTimelineTheme(){try{return localStorage.getItem(timelineThemeKey)==='plain'?'plain':'spiral';}catch{return 'spiral';}}
const state = {data:{shards:[],links:[],boards:[]},view:'library',selectedId:null,tags:[],tagMode:'all',kind:'all',status:'all',sort:'updated',query:'',topicQuery:'',graphScope:'all',graphColor:'topic',graphGroup:'none',timelineMode:'releases',timelineContent:'both',timelineTheme:savedTimelineTheme(),timelineReleaseId:'cpp98',spiralCatalog:null,spiralCatalogError:null,boardId:null,boardSectionId:'',libraryLimit:120,releaseCategory:'all',releaseCatalog:null,releaseCatalogError:null};
const palette = ['#527444','#467b80','#946b3d','#86618e','#ad6b52','#6077a0','#768041','#96707a'];
Object.assign(state,{atlasMode:'topics',atlasTopic:null,atlasBridge:null,atlasSelectedId:null,atlasInspectId:null,atlasExpandedIds:[],atlasShowOrganizational:false,atlasRelation:'all',atlasLimit:12,atlasZoom:1,atlasFit:false});
const editorFields = ['title','content','kind','status','sourceUrl','languageVersion','eventDate','tags','evidenceStatus','eventType','publicationDate','verifiedDate','entityType','entities','inbox','sources','facts'];
const draftKinds = ['editor','connection'];
const drafts = {editor:null,connection:null};
const persistedDrafts = {editor:null,connection:null};
const draftTimers = {};
let editingId = null, linkingId = null, editingLinkId = null;
let toastTimer, confirmTask = null, busy = false, pendingWrites = 0;
let writeTail = Promise.resolve(), pendingClose = null, pendingFilePickerType = 'json';
let localDraftKey = 'shard-atlas-drafts', previewOpen = false;
let historyShardId = null, historyRecords = [], recoveryRecords = [], recoveryMode = null;
let editorOcr=null;
let aiInstructions = '', aiInstructionsLoading = null;
let atlasRefreshLoading = null;
let editingBoardId=null, editingSectionId=null, editingBoardItemId=null, importArchive=null, importPreview=null, boardDirty=false;
let graphTransform = {x:0,y:0,scale:1}, graphSize = {w:900,h:550};

function toast(message) {
  const el=$('#toast');el.textContent=message;el.hidden=false;
  clearTimeout(toastTimer);toastTimer=setTimeout(()=>{el.hidden=true;},4500);
}
async function api(path,method='GET',data) {
  const response=await fetch(path,{method,headers:data===undefined?{}:{'Content-Type':'application/json'},body:data===undefined?undefined:JSON.stringify(data)});
  let result;try{result=await response.json();}catch{throw new Error('The app could not read the response. Try opening it again.');}
  if(!response.ok)throw new Error(result.error||'The change could not be saved.');return result;
}
function writeRequest(path,method,data) {
  pendingWrites++;
  const request=writeTail.then(()=>api(path,method,data));
  writeTail=request.catch(()=>{});
  return request.finally(()=>{pendingWrites--;});
}
async function withBusy(task) {
  if(busy)throw new Error('Please wait for the current change to finish.');
  busy=true;document.body.dataset.saving='true';
  document.querySelectorAll('dialog[open] form').forEach(form=>{form.inert=true;});
  try{return await task();}finally{busy=false;delete document.body.dataset.saving;document.querySelectorAll('dialog form').forEach(form=>{form.inert=false;});}
}
async function mutate(path,method,data) {
  const result=await writeRequest(path,method,data);
  state.data=mergeBoardDrafts(result);$('#save-status').textContent='All changes saved.';render();return result;
}
let cachedShards=null,cachedLinks=null,shardIndex=new Map(),linkIndex=new Map();
function indexKnowledge(){if(cachedShards!==state.data.shards){cachedShards=state.data.shards;shardIndex=new Map(cachedShards.map(s=>[s.id,s]));}if(cachedLinks!==state.data.links){cachedLinks=state.data.links;linkIndex=new Map();for(const l of cachedLinks){for(const id of new Set([l.fromId,l.toId])){if(!linkIndex.has(id))linkIndex.set(id,[]);linkIndex.get(id).push(l);}}}}
const byId=id=>{indexKnowledge();return shardIndex.get(id);};
const linksFor=id=>{indexKnowledge();return linkIndex.get(id)||[];};
const formValues=form=>Object.fromEntries(new FormData(form));
const formSnapshot=form=>JSON.stringify(formValues(form));
const dateLabel=date=>{if(!date)return 'Unknown date';if(/^\d{4}$/.test(date))return date;if(/^\d{4}-\d{2}$/.test(date))return new Intl.DateTimeFormat(undefined,{month:'long',year:'numeric'}).format(new Date(date+'-15T12:00:00'));const d=new Date(date.length===10?date+'T12:00:00':date);return Number.isNaN(d.getTime())?'Unknown date':new Intl.DateTimeFormat(undefined,{month:'short',day:'numeric',year:'numeric'}).format(d);};
const dateTimeLabel=date=>date?new Intl.DateTimeFormat(undefined,{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}).format(new Date(date)):'Unknown date';
const excerpt=text=>String(text||'').replace(/```[\s\S]*?```/g,' [code example] ').replace(/!\[[^\]]*\]\([^)]*\)/g,' [image] ').replace(/^cppreference:[^\n]*(?:\n|$)/gmi,'').replace(/^#{1,6}\s+|^>\s+/gm,'').replace(/[*`]/g,'').replace(/\s+/g,' ').trim();
const allTags=()=>[...new Set(state.data.shards.flatMap(s=>s.tags))].sort((a,b)=>a.localeCompare(b));
const hasFilters=()=>!!(state.query||state.tags.length||state.kind!=='all'||state.status!=='all');
function clearFilters(){state.query='';state.topicQuery='';state.tags=[];state.kind='all';state.status='all';state.releaseCategory='all';$('#search').value='';}

function resolveWiki(target) {
  if(target.startsWith('id:'))return byId(target.slice(3));
  return state.data.shards.find(s=>s.title.toLocaleLowerCase()===target.trim().toLocaleLowerCase());
}
function mathMarkup(source,displayMode=false) {
  if(!window.katex)return '<code>'+esc(source)+'</code>';
  return window.katex.renderToString(source,{displayMode,throwOnError:false,trust:false,strict:'ignore',maxExpand:1000,maxSize:10,macros:{}});
}
function inlineMarkdown(text) {
  const protectedParts=[];
  const protect=html=>{protectedParts.push(html);return '\u0000'+(protectedParts.length-1)+'\u0000';};
  let output=String(text).replace(/\u0000/g,'');
  // Protect currency amounts before pairing math delimiters. Code and links stay intact.
  output=output.split(/(`[^`]+`|\[\[[^\]\n]+\]\]|!\[[^\]\n]*\]\([^)]*\)|\[[^\]\n]+\]\(https?:\/\/[^\s)]+\))/g).map((part,index)=>index%2?part:part.replace(/(?<![\\$])\$(?!\$)([+-]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(?:[KMBkmb])?)/g,(whole,amount,offset,full)=>{
    if(/[A-Za-z0-9_]/.test(full[offset+whole.length]||''))return whole;
    const tail=full.slice(offset+whole.length),closing=tail.search(/(?<!\\)\$(?!\$)/),body=closing<0?'':full.slice(offset+1,offset+whole.length+closing),words=body.match(/[A-Za-z]+/g)||[];
    const math=closing>=0&&!body.includes('\n')&&(/^\s*[+-]?\d+(?:\.\d+)?\s*$/.test(body)||/\\[A-Za-z]+|[_^]/.test(body)||(/^[\d\s.,()+\-*/^=<>\[\]{}_A-Za-z]+$/.test(body)&&words.every(word=>word.length===1)&&/[\dA-Za-z)]\s*[+*/^=<>\-]\s*[\dA-Za-z(]/.test(body)));
    return math?whole:protect(esc(whole));
  })).join('');
  output=output.replace(/`([^`]+)`|\[\[([^\]\n]+)\]\]|!\[([^\]\n]*)\]\((\/assets\/[A-Za-z0-9_.:-]+)\)|\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)|(?<!\\)\$(?!\$)([^$\n]+)(?<!\\)\$/g,(whole,code,wiki,alt,image,label,url,math)=>{
    if(code!==undefined)return protect('<code>'+esc(code)+'</code>');
    if(wiki!==undefined){const split=wiki.indexOf('|'),target=split<0?wiki:wiki.slice(0,split),alias=split<0?null:wiki.slice(split+1),s=resolveWiki(target);return protect(s?`<button type="button" class="wiki-link" data-shard-id="${esc(s.id)}">${esc(alias||s.title)}</button>`:`<span class="wiki-unresolved" title="No shard with this title yet">${esc(alias||target)}</span>`);}
    if(image!==undefined)return protect(`<figure class="note-image"><img src="${esc(image)}" alt="${esc(alt)}" loading="lazy">${alt?`<figcaption>${esc(alt)}</figcaption>`:''}</figure>`);
    if(url!==undefined)return protect(`<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(label)} ↗</a>`);
    return protect(mathMarkup(math));
  });
  output=esc(output).replace(/\*\*([^*]+)\*\*/g,'<strong>$1</strong>').replace(/(?<!\*)\*([^*]+)\*(?!\*)/g,'<em>$1</em>');
  return output.replace(/\u0000(\d+)\u0000/g,(_,i)=>protectedParts[Number(i)]||'');
}
function stabilizeWikiLinks(content) {
  return content.split(/(```[\s\S]*?```|`[^`]+`)/g).map((part,i)=>i%2?part:part.replace(/\[\[([^\]\n]+)\]\]/g,(whole,inner)=>{const split=inner.indexOf('|'),target=split<0?inner:inner.slice(0,split);if(target.startsWith('id:'))return whole;const shard=resolveWiki(target);return shard?`[[id:${shard.id}|${split<0?inner:inner.slice(split+1)}]]`:whole;})).join('');
}
function highlightCpp(code) {
  const types = new Set('void bool char char8_t char16_t char32_t wchar_t short int long signed unsigned float double size_t ptrdiff_t'.split(' '));
  const keywords = new Set('alignas alignof asm auto break case catch class concept const consteval constexpr constinit const_cast continue co_await co_return co_yield decltype default delete do dynamic_cast else enum explicit export extern false for friend goto if inline mutable namespace new noexcept nullptr operator private protected public register reinterpret_cast requires return sizeof static static_assert static_cast struct switch template this thread_local throw true try typedef typeid typename union using virtual volatile while and and_eq bitand bitor compl not not_eq or or_eq xor xor_eq'.split(' '));
  const stdTypes = new Set('vector string string_view unique_ptr shared_ptr weak_ptr array map unordered_map set optional variant span mutex lock_guard exception runtime_error ostream istream'.split(' '));
  const stdFunctions = new Set('move forward make_unique make_shared swap begin end size printf visit'.split(' '));
  const clean = code.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, ' ');
  const declaredTypes = new Set([...clean.matchAll(/\b(?:class|struct|union|enum\s+class|typename)\s+(\w+)|\busing\s+(\w+)\s*=/g)].map(m=>m[1]||m[2]));
  const declaredFunctions = new Set([...clean.matchAll(/\b(?:void|bool|int|double|float|auto)\s+(\w+)\s*\(/g)].map(m=>m[1]));
  const tokens = /\/\*[\s\S]*?\*\/|\/\/[^\n]*|(?:u8|u|U|L)?R"([^ ()\\\t\r\n]{0,16})\([\s\S]*?\)\1"\w*|(?:u8|u|U|L)?"(?:\\[\s\S]|[^"\\])*"\w*|(?:u8|u|U|L)?'(?:\\.|[^'\\])*'\w*|\b(?:0[xX][\da-fA-F']+(?:\.[\da-fA-F']*)?(?:[pP][+-]?\d+)?|0[bB][01']+|\d[\d']*(?:\.\d[\d']*)?(?:[eE][+-]?\d+)?)(?:[a-zA-Z_]\w*)?|[A-Za-z_]\w*|[^\w]/g;
  let result = '', match;
  while ((match=tokens.exec(code))) {
    const token = match[0], prefix = code.slice(Math.max(0,match.index-50),match.index);
    let cls = '';
    if (token.startsWith('//') || token.startsWith('/*')) cls='comment';
    else if (/^(?:u8|u|U|L)?(?:R"|"|')/.test(token)) cls='string';
    else if (/^\d/.test(token)) cls='number';
    else if (types.has(token) || declaredTypes.has(token) || (stdTypes.has(token) && /std\s*::\s*$/.test(prefix))) cls='type';
    else if (keywords.has(token) || (/^\s*#\s*$/.test(prefix.split('\n').at(-1)) && ['include','define','ifdef','ifndef','endif','if','else','elif','pragma'].includes(token))) cls='keyword';
    else if (declaredFunctions.has(token) || (stdFunctions.has(token) && /std\s*::\s*$/.test(prefix))) cls='function';
    result += cls ? `<span class="syn-${cls}">${esc(token)}</span>` : esc(token);
  }
  // Header names are literals only on recognized include lines.
  result = result.replace(/(<span class="syn-keyword">include<\/span>\s*)(&lt;[^\n]*?&gt;)/g,'$1<span class="syn-string">$2</span>');
  return result;
}


function markdown(text) {
  const provenance=String(text||'').match(/\n\nOriginal Lucid shape data:\n```json\n([\s\S]*?)\n```\s*$/);
  if(provenance){try{JSON.parse(provenance[1]);return markdown(String(text).slice(0,provenance.index))+`<details class="diagram-provenance"><summary>Original diagram data</summary><p class="muted">Exact source text, styles, and geometry retained from your Lucid diagram.</p><div class="code-block"><div class="code-toolbar"><span>Source JSON</span><button type="button" class="text-button" data-action="copy-code">Copy</button></div><pre><code>${esc(provenance[1])}</code></pre></div></details>`;}catch{}}
  const lines=String(text||'').replace(/\r\n/g,'\n').split('\n');let html='',paragraph=[],list=null,cppKey=false;
  const flush=()=>{if(paragraph.length){html+='<p>'+inlineMarkdown(paragraph.join(' '))+'</p>';paragraph=[];}if(list){html+='</'+list+'>';list=null;}};
  for(let i=0;i<lines.length;i++){
    const line=lines[i];
    if(line.startsWith('```')){
      flush();const lang=line.slice(3).trim().toLowerCase();const code=[];while(++i<lines.length&&!lines[i].startsWith('```'))code.push(lines[i]);const cpp=['cpp','c++','cxx','cc'].includes(lang);
      if(cpp&&!cppKey){html+='<div class="syntax-key" aria-label="C++ syntax colors"><span class="syn-keyword">Keywords</span><span class="syn-type">Types</span><span class="syn-function">Functions</span><span class="syn-number">Numbers</span><span class="syn-string">Literals</span><span class="syn-comment">Comments</span></div>';cppKey=true;}
      html+='<div class="code-block"><div class="code-toolbar"><span>'+esc(lang||'code')+'</span><button type="button" class="text-button" data-action="copy-code">Copy</button></div><pre><code>'+(cpp?highlightCpp(code.join('\n')):esc(code.join('\n')))+'</code></pre></div>';
    }else if(line.trim().startsWith('$$')){
      flush();let source=line.trim().slice(2);if(source.endsWith('$$'))source=source.slice(0,-2);else{const parts=[source];while(++i<lines.length){if(lines[i].trim().endsWith('$$')){parts.push(lines[i].trim().slice(0,-2));break;}parts.push(lines[i]);}source=parts.join('\n');}html+='<div class="math-display">'+mathMarkup(source,true)+'</div>';
    }else if(/^#{1,6}\s/.test(line)){flush();const match=line.match(/^(#{1,6})\s+(.*)/),n=Math.min(4,match[1].length+1);html+=`<h${n}>${inlineMarkdown(match[2])}</h${n}>`;
    }else if(/^\s*[-*]\s+/.test(line)||/^\s*\d+[.)]\s+/.test(line)){
      if(paragraph.length){html+='<p>'+inlineMarkdown(paragraph.join(' '))+'</p>';paragraph=[];}const type=/^\s*\d/.test(line)?'ol':'ul';if(list!==type){if(list)html+='</'+list+'>';html+='<'+type+'>';list=type;}html+='<li>'+inlineMarkdown(line.replace(/^\s*(?:[-*]|\d+[.)])\s+/,''))+'</li>';
    }else if(line.startsWith('> ')){flush();html+='<blockquote>'+inlineMarkdown(line.slice(2))+'</blockquote>';}
    else if(/^!\[[^\]]*\]\(\/assets\/[A-Za-z0-9_.:-]+\)\s*$/.test(line)){flush();html+=inlineMarkdown(line);}
    else if(!line.trim())flush();else{if(list){html+='</'+list+'>';list=null;}paragraph.push(line);}
  }
  flush();return html||'<p class="muted">This idea is waiting for your explanation.</p>';
}
function filteredShards() {
  const words=state.query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
  return state.data.shards.filter(s=>{
    const tagsMatch=!state.tags.length||(state.tagMode==='all'?state.tags.every(t=>s.tags.includes(t)):state.tags.some(t=>s.tags.includes(t)));
    if(!tagsMatch||(state.kind!=='all'&&s.kind!==state.kind)||(state.status!=='all'&&s.status!==state.status))return false;
    const connectedText=linksFor(s.id).map(l=>[relations[l.type],l.note,byId(l.fromId)?.title,byId(l.toId)?.title].join(' ')).join(' ');
    const haystack=[s.title,s.content,s.tags.join(' '),s.sourceUrl,s.languageVersion,(s.entities||[]).join(' '),JSON.stringify(s.facts||[]),JSON.stringify(s.sources||[]),connectedText].join(' ').toLocaleLowerCase();return words.every(w=>haystack.includes(w));
  }).sort((a,b)=>state.sort==='title'?a.title.localeCompare(b.title):state.sort==='created'?b.createdAt.localeCompare(a.createdAt):b.updatedAt.localeCompare(a.updatedAt));
}
function sidebarTopics(){
  const counts=new Map(),releaseMode=state.view==='timeline'&&state.timelineMode==='releases',labels=new Map();
  const countTopic=tag=>{const key=releaseMode?tag.toLocaleLowerCase():tag;if(!labels.has(key))labels.set(key,tag);counts.set(key,(counts.get(key)||0)+1);};
  for(const shard of state.data.shards)for(const tag of shard.tags)countTopic(tag);
  if(releaseMode)for(const release of state.releaseCatalog?.releases||[])for(const feature of release.features)for(const tag of feature.tags)countTopic(tag);
  return [...counts.entries()].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0])).map(([key,count])=>({tag:labels.get(key),count}));
}
function matchingSidebarTopics(topics=sidebarTopics()){
  const query=state.topicQuery.trim().toLocaleLowerCase();return topics.filter(({tag})=>tag.toLocaleLowerCase().includes(query));
}
function renderTopics(){
  const topics=sidebarTopics(),matches=matchingSidebarTopics(topics),query=state.topicQuery.trim(),releaseMode=state.view==='timeline'&&state.timelineMode==='releases';
  const input=$('#topic-search');if(input.value!==state.topicQuery)input.value=state.topicQuery;
  $('#clear-topic-search').hidden=!state.topicQuery;
  $('#topic-search-status').textContent=query?`${matches.length} of ${topics.length} topics match`:`${topics.length} topic${topics.length===1?'':'s'}`;
  const selected=$('#selected-topic-filters');selected.hidden=!state.tags.length;
  selected.innerHTML=state.tags.length?'<span class="sidebar-selected-label">Selected topics</span><div>'+state.tags.map(tag=>`<button class="tag" data-tag="${esc(tag)}" aria-label="${esc('Remove topic filter '+tag)}" title="Remove this topic filter">${esc(tag)} <span aria-hidden="true">×</span></button>`).join('')+'</div>':'';
  $('#topic-list').innerHTML=matches.map(({tag,count})=>{const active=releaseMode?releaseTagSelected(tag):state.tags.includes(tag);return `<button class="topic-item ${active?'active':''}" data-tag="${esc(tag)}" aria-pressed="${active}"${releaseMode?' title="Matching reference entries and personal notes"':''}><span class="topic-dot"></span><span>${esc(tag)}</span><small>${count}</small></button>`;}).join('')||(query?`<div class="topic-empty"><p>No topics match “${esc(query)}”.</p><p>Try another search. To add a new topic, type it in a shard’s Topics field and save.</p></div>`:'<p class="topic-empty">Topics appear as you add them to shards.</p>');
}
function clearTopicSearch(){state.topicQuery='';renderTopics();$('#topic-search').focus();}
function selectSearchedTopic(){
  const query=state.topicQuery.trim();if(!query)return;
  const matches=matchingSidebarTopics(),exact=matches.filter(({tag})=>tag.toLocaleLowerCase()===query.toLocaleLowerCase());
  const selected=exact.find(({tag})=>tag===query)||(exact.length===1?exact[0]:matches.length===1?matches[0]:null);
  if(selected)toggleTag(selected.tag);else if(matches.length)toast('Choose a topic from the matching list.');else toast('No matching topic. Add a new topic in a shard’s Topics field.');
}
function renderNav(){
  $('#library-count').textContent=state.data.shards.length;$('#view-label').textContent={library:'Library',graph:'Connections',timeline:'C++ timeline',atlas:'Topic map',boards:'Topic map'}[state.view];
  document.querySelectorAll('[data-view]').forEach(el=>el.classList.toggle('active',el.dataset.view===state.view));
  const releaseMode=state.view==='timeline'&&state.timelineMode==='releases';
  $('#search').placeholder=releaseMode?'Find a C++ feature or one of your notes…':'Find an idea, example, or connection…';$('#search').setAttribute('aria-label',releaseMode?'Search C++ features and notes':'Search shards');
  renderTopics();
  renderDraftShelf();
}
function pageHeading(eyebrow,title,description,action=''){return `<div class="page-heading"><div><span class="eyebrow">${eyebrow}</span><h1>${title}</h1><p>${description}</p></div><div class="heading-actions">${action}</div></div>`;}
function render(){renderNav();const views={library:renderLibrary,graph:renderGraphPage,timeline:renderTimeline,atlas:renderAtlas,boards:renderAtlas};$('#workspace').innerHTML=(views[state.view]||renderLibrary)();bindGraph();bindAtlas();}
function filterMarkup(){
  return `<div class="filter-row"><select id="kind-filter" aria-label="Filter by kind"><option value="all">All kinds</option>${Object.entries(kinds).map(([v,t])=>`<option value="${v}" ${state.kind===v?'selected':''}>${t}</option>`).join('')}</select><select id="status-filter" aria-label="Filter by understanding"><option value="all">Any understanding</option>${Object.entries(statuses).map(([v,t])=>`<option value="${v}" ${state.status===v?'selected':''}>${t}</option>`).join('')}</select><select id="sort-filter" aria-label="Sort shards"><option value="updated" ${state.sort==='updated'?'selected':''}>Recently edited</option><option value="created" ${state.sort==='created'?'selected':''}>Recently captured</option><option value="title" ${state.sort==='title'?'selected':''}>Title A–Z</option></select></div>${state.tags.length?`<div class="selected-topics"><label>Match<select id="tag-mode" aria-label="Match selected topics"><option value="all" ${state.tagMode==='all'?'selected':''}>all topics</option><option value="any" ${state.tagMode==='any'?'selected':''}>any topic</option></select></label><div>${state.tags.map(t=>`<button class="tag" data-tag="${esc(t)}" title="Remove this topic filter">${esc(t)} ×</button>`).join('')}</div></div>`:''}`;
}
function renderLibrary(){
  const shards=filteredShards();if(!shards.some(s=>s.id===state.selectedId))state.selectedId=shards[0]?.id||null;
  const connected=new Set(state.data.links.flatMap(l=>[l.fromId,l.toId])).size,selected=byId(state.selectedId);
  return pageHeading('COLLECT. CONNECT. UNDERSTAND.','Build your technical understanding.','Programming, computer science, and the ideas behind machine learning and AI. Start with your C++ knowledge and follow its connections.',`<button class="primary" data-action="new">＋ New shard</button>`)+
  `<div class="stats-row"><div class="stat-card"><span class="stat-value">${state.data.shards.length}</span><span class="stat-label">shards in your atlas</span></div><div class="stat-card"><span class="stat-value">${state.data.links.length}</span><span class="stat-label">meaningful connections</span></div><div class="stat-card"><span class="stat-value">${allTags().length}</span><span class="stat-label">topics to explore</span></div></div>`+
  `<div class="library-layout ${selected?'has-selection':''}"><section class="library-panel" aria-label="Shard library"><div class="panel-heading"><h2>${state.tags.length?'Selected topics':'All shards'} <small>${shards.length}</small></h2>${hasFilters()?'<button class="text-button" data-action="clear-filters">Clear</button>':''}</div>${filterMarkup()}<div class="shard-list">${shards.slice(0,state.libraryLimit).map(renderCard).join('')||`<div class="empty-state"><span>◇</span><h3>${hasFilters()?'No matching ideas':'Your atlas starts here'}</h3><p>${hasFilters()?'Try a different search or clear the filters.':'Capture something you learned, wondered about, or changed your mind about.'}</p><button class="secondary" data-action="${hasFilters()?'clear-filters':'new'}">${hasFilters()?'Clear filters':'Create your first shard'}</button></div>`}${shards.length>state.libraryLimit?`<button class="secondary full-width" data-action="more-shards">Show more · ${shards.length-state.libraryLimit} remaining</button>`:''}</div></section><article class="detail-panel"${selected?shardThemeAttributes(selected):''} aria-label="Selected shard">${selected?renderDetail(selected):'<div class="detail-empty"><span>◇</span><h2>Make room for an idea.</h2><p>Select a shard to explore its explanation and connections.</p></div>'}</article><aside class="context-panel" aria-label="Related ideas"><div class="context-heading"><span class="eyebrow">THE BIGGER PICTURE</span><h2>In good company.</h2><p>Every line has a reason.</p></div><div class="graph-surface">${selected?graphSvg(selected.id,false):'<div class="empty-state">Your connections will appear here.</div>'}</div><div class="graph-legend"><span class="status-dot"></span> Selected idea <span class="neighbor-dot"></span> Connected idea</div><p class="context-note">${selected?`Explore an idea by selecting a node. ${linksFor(selected.id).length} connection${linksFor(selected.id).length===1?'':'s'} around this shard.`:'Start with one idea. Connections can come later.'}</p><button class="secondary full-width" data-view="graph">Open connection map ↗</button><div class="mini-stat"><strong>${connected}</strong><span>shards woven into your atlas</span></div></aside></div>`;
}
function renderCard(s){return `<button class="shard-card ${s.id===state.selectedId?'active':''}"${shardThemeAttributes(s)} data-shard-id="${esc(s.id)}" aria-pressed="${s.id===state.selectedId}"><div class="card-top"><span class="kind-dot ${esc(s.kind)}"></span><span class="kind-label">${kinds[s.kind]||esc(s.kind)}</span><span class="card-connection">${linksFor(s.id).length?'⌘ '+linksFor(s.id).length:''}</span></div><h3 class="card-title">${esc(s.title)}</h3><p class="card-excerpt">${esc(excerpt(s.content).slice(0,110))}</p><div class="card-bottom">${s.tags.slice(0,2).map(t=>`<span class="tag">${esc(t)}</span>`).join('')}<span class="card-date">${dateLabel(s.updatedAt)}</span></div></button>`;}
function shardWorldReleaseIds(shard){const assigned=new Set(shardReleaseIds(shard));return spiralReleaseIds.filter(id=>assigned.has(id));}
function shardThemeAttributes(shard,ids=shardWorldReleaseIds(shard)){
  if(!ids.length)return '';
  const tint=ids.length===1?`linear-gradient(var(--${ids[0]}-soft),var(--${ids[0]}-soft))`:`linear-gradient(135deg,${ids.map(id=>`var(--${id}-soft)`).join(',')})`,seam=ids.length===1?`var(--${ids[0]}-seam)`:`linear-gradient(90deg,${ids.map(id=>`var(--${id}-accent)`).join(',')})`;
  return ` data-shard-worlds="${ids.join(' ')}"${ids.length===1?` data-spiral-release="${ids[0]}"`:''} style="--shard-tint:${tint};--shard-seam:${seam}"`;
}
function renderShardWorldBadges(shard){
  const badges=shardWorldReleaseIds(shard).map(id=>{
    const emblems=spiralEmblems(state.spiralCatalog?.releases?.[id]);if(!emblems.length)return '';
    const release=state.releaseCatalog?.releases?.find(release=>release.id===id),label=(release?.label||'C++'+id.slice(3))+((release?.status==='draft'||(!release&&id==='cpp26'))?' (draft)':''),description=label+': '+emblems.map(emblem=>emblem.name).join(', ');
    return `<button type="button" class="note-world-badge" data-spiral-release="${id}" data-action="open-release" data-id="${id}" aria-label="${esc('Open '+label+' timeline: '+emblems.map(emblem=>emblem.name).join(', '))}" title="${esc(description+' · Open release column')}"><span class="note-world-icons" data-world-count="${emblems.length}" aria-hidden="true">${emblems.map(emblem=>`<img src="${esc(emblem.src)}" alt="" width="40" height="40" loading="lazy">`).join('')}</span><span class="note-world-release" aria-hidden="true">${label}</span></button>`;
  }).join('');
  return badges?`<div class="note-world-badges" role="group" aria-label="Worlds associated with this shard">${badges}</div>`:'';
}
function renderShardHeading(shard){
  const heading=`<div class="note-meta"><span class="badge ${esc(shard.status)}">${statuses[shard.status]}</span><span>${esc(kinds[shard.kind])}</span></div><h2 class="note-title">${esc(shard.title)}</h2>`,badges=renderShardWorldBadges(shard);
  return badges?`<div class="note-heading-row"><div class="note-heading-text">${heading}</div>${badges}</div>`:heading;
}
function renderDetail(s){
  const connections=linksFor(s.id);
  return `<div class="note-header"><div class="note-heading" data-shard-id="${esc(s.id)}">${renderShardHeading(s)}</div><div class="note-actions"><button class="secondary" data-action="edit" data-id="${esc(s.id)}">Edit shard</button><button class="secondary" data-action="link" data-id="${esc(s.id)}">＋ Connect</button><button class="secondary" data-action="history" data-id="${esc(s.id)}">Saved versions</button><button class="icon-button" data-action="delete" data-id="${esc(s.id)}" aria-label="Move shard to trash" title="Move to trash">⌫</button></div><div class="note-tags">${s.tags.map(t=>`<button class="tag" data-tag="${esc(t)}">${esc(t)}</button>`).join('')}</div></div><div class="note-body markdown">${markdown(s.content)}</div>${renderSources(s)}<section class="connection-section"><div class="panel-heading"><h3>Connected ideas <small>${connections.length}</small></h3><button class="text-button" data-action="link" data-id="${esc(s.id)}">＋ Add</button></div><div class="connection-list">${connections.map(l=>{
    const out=l.fromId===s.id,other=byId(out?l.toId:l.fromId),inverse={depends_on:'is a dependency of',explains:'is explained by',contrasts_with:'contrasts with',example_of:'has an example in',related_to:'relates to',part_of:'contains',supports:'is supported by',contradicts:'contradicts',supersedes:'is superseded by',released_by:'released'};
    return `<div class="connection-card"><button class="connection-open" data-shard-id="${esc(other?.id)}"><span class="relation">This idea ${out?relations[l.type]:inverse[l.type]}</span><span class="connection-title">${esc(other?.title)} <span class="connection-arrow">↗</span></span>${l.note?`<span class="connection-note">${esc(l.note)}</span>`:''}</button><div class="connection-tools"><button class="icon-button" data-action="edit-link" data-id="${esc(l.id)}" aria-label="Edit relationship" title="Edit relationship">✎</button><button class="icon-button remove-connection" data-action="unlink" data-id="${esc(l.id)}" aria-label="Remove connection" title="Remove connection">×</button></div></div>`;
  }).join('')||'<p class="muted">An idea can stand on its own. Connect it when a relationship helps you understand.</p>'}</div></section><footer class="note-footer">${s.sourceUrl?`<a href="${esc(s.sourceUrl)}" target="_blank" rel="noopener noreferrer">View source ↗</a>`:'<span>No source added</span>'}${s.languageVersion?`<span>${esc(s.languageVersion)}</span>`:''}<span>Edited ${dateLabel(s.updatedAt)}</span></footer>`;
}
function graphCategory(shard,mode){return mode==='kind'?(kinds[shard.kind]||shard.kind):[...shard.tags].sort((a,b)=>a.localeCompare(b))[0]||'No topic';}
function graphColorMap(nodes){const categories=[...new Set(nodes.map(n=>graphCategory(n,state.graphColor)))].sort((a,b)=>a.localeCompare(b));return new Map(categories.map((c,i)=>[c,palette[i%palette.length]]));}
function graphNodes(centerId,full){
  if(!full||state.graphScope==='local'){const ids=new Set([centerId,...linksFor(centerId).flatMap(l=>[l.fromId,l.toId])]);const found=state.data.shards.filter(s=>ids.has(s.id));return full?found:[byId(centerId),...found.filter(s=>s.id!==centerId).sort((a,b)=>a.title.localeCompare(b.title)).slice(0,6)].filter(Boolean);}
  return filteredShards().slice(0,100);
}
function graphSvg(centerId,full){
  const selected=byId(centerId),nodes=graphNodes(centerId,full),visible=new Set(nodes.map(s=>s.id)),edges=state.data.links.filter(l=>visible.has(l.fromId)&&visible.has(l.toId)&&(full||l.fromId===centerId||l.toId===centerId));
  if(!nodes.length)return '<div class="empty-state"><span>◇</span><h3>No ideas in this view</h3><p>Add a shard or clear the filters to begin.</p></div>';
  const positions=new Map(),groups=[];let w=full?900:330,h=full?Math.max(550,Math.ceil(nodes.length/6)*125):320;
  if(!full){positions.set(centerId,{x:w/2,y:h/2});const others=nodes.filter(n=>n.id!==centerId);others.forEach((n,i)=>{const a=-Math.PI/2+i*Math.PI*2/others.length;positions.set(n.id,{x:w/2+94*Math.cos(a),y:h/2+100*Math.sin(a)});});}
  else if(state.graphGroup!=='none'){
    const categories=[...new Set(nodes.map(n=>graphCategory(n,state.graphGroup)))].sort((a,b)=>a.localeCompare(b));let y=50;
    for(const category of categories){const members=nodes.filter(n=>graphCategory(n,state.graphGroup)===category);groups.push({label:category,x:30,y});members.forEach((n,i)=>positions.set(n.id,{x:125+(i%4)*215,y:y+62+Math.floor(i/4)*120}));y+=Math.ceil(members.length/4)*120+60;}h=Math.max(550,y+20);
  }else{
    const columns=Math.max(1,Math.ceil(Math.sqrt(nodes.length*w/h))),rows=Math.ceil(nodes.length/columns),cx=w/2,cy=h/2;
    nodes.forEach((n,i)=>positions.set(n.id,{x:100+(i%columns)*(w-200)/Math.max(1,columns-1),y:50+Math.floor(i/columns)*(h-140)/Math.max(1,rows-1)}));
    if(nodes.length>1&&nodes.length<=60)for(let step=0;step<70;step++){
      const forces=new Map(nodes.map(n=>[n.id,{x:(cx-positions.get(n.id).x)*0.003,y:(cy-positions.get(n.id).y)*0.003}]));
      for(let i=0;i<nodes.length;i++)for(let j=i+1;j<nodes.length;j++){const a=positions.get(nodes[i].id),b=positions.get(nodes[j].id),dx=a.x-b.x,dy=a.y-b.y,dist=Math.max(12,Math.hypot(dx,dy)),f=Math.min(9,14000/(dist*dist));forces.get(nodes[i].id).x+=dx/dist*f;forces.get(nodes[i].id).y+=dy/dist*f;forces.get(nodes[j].id).x-=dx/dist*f;forces.get(nodes[j].id).y-=dy/dist*f;const ox=175-Math.abs(dx),oy=105-Math.abs(dy);if(ox>0&&oy>0){const horizontal=ox<oy,amount=(horizontal?ox:oy)*0.3,axis=horizontal?'x':'y',direction=Math.sign(horizontal?dx:dy)||1;forces.get(nodes[i].id)[axis]+=direction*amount;forces.get(nodes[j].id)[axis]-=direction*amount;}}
      for(const l of edges){const a=positions.get(l.fromId),b=positions.get(l.toId),dx=b.x-a.x,dy=b.y-a.y,d=Math.max(1,Math.hypot(dx,dy)),f=(d-240)*0.006;forces.get(l.fromId).x+=dx/d*f;forces.get(l.fromId).y+=dy/d*f;forces.get(l.toId).x-=dx/d*f;forces.get(l.toId).y-=dy/d*f;}
      for(const n of nodes){const p=positions.get(n.id),f=forces.get(n.id);p.x=Math.min(w-100,Math.max(100,p.x+f.x));p.y=Math.min(h-65,Math.max(65,p.y+f.y));}
    }
    if(nodes.length===1)positions.set(nodes[0].id,{x:cx,y:cy});
  }
  if(full)graphSize={w,h};const colors=graphColorMap(nodes);
  const nodeLabels=title=>{const words=title.split(/\s+/),lines=[];let line='';for(const word of words){if((line+' '+word).length>(full?22:18)&&line){lines.push(line);line=word;}else line+=(line?' ':'')+word;}if(line)lines.push(line);return lines.slice(0,3).map((l,i)=>`<tspan x="0" dy="${i?13:0}">${esc(l.length>25?l.slice(0,23)+'…':l)}</tspan>`).join('');};
  return `<svg class="knowledge-graph ${full?'interactive-graph':''}" viewBox="0 0 ${w} ${h}" ${full?`style="height:${Math.max(460,h*.7)}px"`:''} role="img" aria-label="${full?'Map of connected shards':'Connections around '+esc(selected?.title)}"><defs><marker id="graph-arrow" markerWidth="7" markerHeight="7" refX="6" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6" fill="none" stroke="currentColor"/></marker></defs><g class="graph-content">${groups.map(g=>`<text class="graph-group-label" x="${g.x}" y="${g.y}">${esc(g.label)}</text>`).join('')}`+
  edges.map(l=>{const a=positions.get(l.fromId),b=positions.get(l.toId),d=Math.max(1,Math.hypot(b.x-a.x,b.y-a.y)),dx=(b.x-a.x)/d,dy=(b.y-a.y)/d;return `<g class="graph-edge ${l.fromId===centerId||l.toId===centerId?'highlighted':''}"><title>${esc(byId(l.fromId)?.title)} ${relations[l.type]} ${esc(byId(l.toId)?.title)}${l.note?': '+esc(l.note):''}</title><line x1="${a.x+dx*15}" y1="${a.y+dy*15}" x2="${b.x-dx*19}" y2="${b.y-dy*19}" marker-end="url(#graph-arrow)"/>${!full||l.fromId===centerId||l.toId===centerId?`<text class="edge-label" x="${(a.x+b.x)/2}" y="${(a.y+b.y)/2-7}" text-anchor="middle">${relations[l.type]}</text>`:''}</g>`;}).join('')+
  nodes.map(n=>{const p=positions.get(n.id),color=full?colors.get(graphCategory(n,state.graphColor)):n.id===centerId?'#527444':'#9cb185';return `<g class="graph-node ${n.id===centerId?'selected':''}" transform="translate(${p.x},${p.y})" data-graph-id="${esc(n.id)}" tabindex="0" role="button" aria-label="Explore ${esc(n.title)}"><title>${esc(n.title)}</title><circle class="node-halo" r="21" style="fill:${color};opacity:.13"/><circle class="node-dot" r="${n.id===centerId?10:7}" style="fill:${color}"/><text class="node-label" y="29" text-anchor="middle">${nodeLabels(!full&&n.id===centerId?'This idea':n.title)}</text></g>`;}).join('')+'</g></svg>';
}
function renderGraphPage(){
  const selected=byId(state.selectedId)||state.data.shards[0];if(selected)state.selectedId=selected.id;
  const nodes=graphNodes(selected?.id,true),colors=graphColorMap(nodes);
  return pageHeading('FOLLOW THE THREAD.','Ideas belong together.','Explore the relationships behind your notes. Select a node to read it.',`<button class="primary" data-action="new">＋ New shard</button>`)+`<div class="graph-page"><div class="graph-controls"><div class="segmented-control"><button class="${state.graphScope==='all'?'active':''}" data-scope="all">All matching ideas</button><button class="${state.graphScope==='local'?'active':''}" data-scope="local" ${selected?'':'disabled'}>Around selected idea</button></div><label>Color<select id="graph-color"><option value="topic" ${state.graphColor==='topic'?'selected':''}>By topic</option><option value="kind" ${state.graphColor==='kind'?'selected':''}>By kind</option></select></label><label>Group<select id="graph-group"><option value="none" ${state.graphGroup==='none'?'selected':''}>By connections</option><option value="topic" ${state.graphGroup==='topic'?'selected':''}>By topic</option><option value="kind" ${state.graphGroup==='kind'?'selected':''}>By kind</option></select></label><div class="graph-toolbar"><button class="icon-button" data-action="zoom-out" aria-label="Zoom out">−</button><button class="icon-button" data-action="zoom-in" aria-label="Zoom in">＋</button><button class="secondary" data-action="reset-graph">Reset view</button></div></div><div class="graph-topic-filters">${filterMarkup()}</div><div class="full-graph">${graphSvg(selected?.id,true)}</div><div class="graph-category-legend">${[...colors.entries()].map(([label,color])=>`<span><i style="background:${color}"></i>${esc(label)}</span>`).join('')}<small>${state.graphColor==='topic'?'For multi-topic shards, color uses the first topic alphabetically.':''}</small></div><div class="graph-bottom"><span class="muted">Drag to move · Use ＋ / − to zoom · Arrows show relationship direction</span><span>${nodes.length} visible ideas${state.graphScope==='all'&&filteredShards().length>100?' · Showing the first 100 matches. Search or choose a topic to narrow the map.':''}</span></div></div>${selected?`<div class="graph-selection"><div><span class="eyebrow">SELECTED IDEA</span><h2>${esc(selected.title)}</h2><p>${esc(excerpt(selected.content).slice(0,170))}</p></div><button class="secondary" data-action="read-selected">Read shard →</button><button class="primary" data-action="link" data-id="${esc(selected.id)}">＋ Connect</button></div>`:''}`;
}
const atlasOrganizationalTopics = new Set(['c++','lucidchart','images','links','source material','tables','code examples']);
const atlasKey = value=>String(value||'').trim().toLocaleLowerCase('en');
const atlasCompare = (a,b)=>String(a).localeCompare(String(b),'en');
const atlasShardCompare = (a,b)=>atlasCompare(a.title,b.title)||atlasCompare(a.id,b.id);
function atlasColor(key){let hash=0;for(const ch of key)hash=(Math.imul(hash,31)+ch.charCodeAt(0))|0;return palette[(hash>>>0)%palette.length];}
function atlasModel(shards=filteredShards(),includeOrganizational=state.atlasShowOrganizational){
  const ordered=[...shards].sort(atlasShardCompare),records=new Map(),memberships=new Map();
  for(const shard of ordered){
    const keys=new Set();
    for(const tag of [...(shard.tags||[])].sort(atlasCompare)){
      const key=atlasKey(tag);if(!key||(!includeOrganizational&&atlasOrganizationalTopics.has(key))||keys.has(key))continue;
      keys.add(key);if(!records.has(key))records.set(key,{key,label:tag.trim(),shardIds:[],color:atlasColor(key)});
      records.get(key).shardIds.push(shard.id);
    }
    memberships.set(shard.id,[...keys].sort(atlasCompare));
  }
  const topics=[...records.values()].map(topic=>({...topic,count:topic.shardIds.length,shardIds:[...topic.shardIds].sort(atlasCompare)})).sort((a,b)=>b.count-a.count||atlasCompare(a.key,b.key));
  const pairs=new Map();
  for(const shard of ordered){const keys=memberships.get(shard.id);for(let i=0;i<keys.length;i++)for(let j=i+1;j<keys.length;j++){
    const pairKey=JSON.stringify([keys[i],keys[j]]);if(!pairs.has(pairKey))pairs.set(pairKey,{a:keys[i],b:keys[j],shardIds:[]});pairs.get(pairKey).shardIds.push(shard.id);
  }}
  const overlaps=[...pairs.values()].map(pair=>({...pair,count:pair.shardIds.length,shardIds:[...pair.shardIds].sort(atlasCompare)})).sort((a,b)=>b.count-a.count||atlasCompare(a.a,b.a)||atlasCompare(a.b,b.b));
  return {shards:ordered,topics,overlaps,memberships,unmappedShards:ordered.filter(s=>!memberships.get(s.id).length),bridgeShards:ordered.filter(s=>memberships.get(s.id).length>1)};
}
function atlasRelationshipModel(){
  const eligible=[...filteredShards()].sort(atlasShardCompare),byKey=new Map(eligible.map(s=>[s.id,s]));
  const centerId=byKey.has(state.atlasSelectedId)?state.atlasSelectedId:byKey.has(state.selectedId)?state.selectedId:eligible[0]?.id;
  const links=state.data.links.filter(link=>byKey.has(link.fromId)&&byKey.has(link.toId)&&(state.atlasRelation==='all'||link.type===state.atlasRelation)).slice().sort((a,b)=>atlasCompare(a.id,b.id));
  const adjacent=new Map(eligible.map(s=>[s.id,new Set()]));for(const link of links){adjacent.get(link.fromId).add(link.toId);adjacent.get(link.toId).add(link.fromId);}
  const expanded=new Set([centerId,...state.atlasExpandedIds]),visible=new Set(centerId?[centerId]:[]),queue=centerId?[centerId]:[],visited=new Set();
  while(queue.length){const id=queue.shift();if(visited.has(id)||!expanded.has(id))continue;visited.add(id);for(const other of [...(adjacent.get(id)||[])].sort(atlasCompare)){visible.add(other);if(expanded.has(other)&&!visited.has(other))queue.push(other);}}
  const hiddenByNode=new Map(),hidden=new Set();for(const id of visible){const others=[...(adjacent.get(id)||[])].filter(other=>!visible.has(other));hiddenByNode.set(id,others.length);for(const other of others)hidden.add(other);}
  return {nodes:eligible.filter(s=>visible.has(s.id)),edges:links.filter(l=>visible.has(l.fromId)&&visible.has(l.toId)),centerId,hiddenByNode,frontierCount:hidden.size};
}
function atlasTextLines(text,width=21,maxLines=3){const lines=[];let line='';for(const word of String(text).split(/\s+/)){if(line&&line.length+word.length+1>width){lines.push(line);line=word;}else line+=(line?' ':'')+word;}if(line)lines.push(line);return lines.slice(0,maxLines).map((value,i)=>esc(value.length>width+5?value.slice(0,width+3)+'…':value)+(i===maxLines-1&&lines.length>maxLines?'…':''));}
function atlasTopicSvg(model){
  const selected=model.topics.find(t=>t.key===state.atlasTopic),byKey=new Map(model.topics.map(t=>[t.key,t]));
  const neighbors=selected?model.overlaps.filter(p=>p.a===selected.key||p.b===selected.key).map(p=>byKey.get(p.a===selected.key?p.b:p.a)).filter(Boolean).slice(0,10):[];
  const topics=selected?[selected,...neighbors]:model.topics.slice(0,12),keys=new Set(topics.map(t=>t.key)),positions=new Map();
  const ring=selected?topics.slice(1):topics;ring.forEach((topic,i)=>{const angle=-Math.PI/2+i*2*Math.PI/Math.max(1,ring.length);positions.set(topic.key,{x:500+385*Math.cos(angle),y:340+240*Math.sin(angle),r:49});});
  if(selected)positions.set(selected.key,{x:500,y:340,r:66});
  const pairs=model.overlaps.filter(p=>keys.has(p.a)&&keys.has(p.b)&&(!selected||p.a===selected.key||p.b===selected.key)).slice(0,selected?10:18);
  return `<div class="atlas-surface"><svg class="atlas-topic-map" viewBox="0 0 1000 680" role="group" aria-label="Topic neighborhoods. Lines show shared shards, not recorded relationships." style="width:${state.atlasZoom*100}%;min-width:${state.atlasFit?0:600*state.atlasZoom}px"><g>${pairs.map(pair=>{const a=positions.get(pair.a),b=positions.get(pair.b);return `<line class="atlas-topic-link" x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" stroke-width="${Math.min(8,1+Math.sqrt(pair.count))}"><title>${esc(byKey.get(pair.a).label+' and '+byKey.get(pair.b).label+': '+pair.count+' shared shards')}</title></line>`;}).join('')}${topics.map(topic=>{const p=positions.get(topic.key),lines=atlasTextLines(topic.label,17,2);return `<g class="atlas-topic-node ${selected?.key===topic.key?'selected':''}" transform="translate(${p.x},${p.y})" style="--topic-color:${topic.color}" role="button" tabindex="0" data-atlas-action="atlas-topic" data-id="${esc(topic.key)}" aria-label="${esc('Explore topic '+topic.label+', '+topic.count+' shards')}" aria-pressed="${selected?.key===topic.key}"><title>${esc(topic.label)}: ${topic.count} shards</title><circle r="${p.r}"/><text text-anchor="middle" y="${lines.length>1?-12:-3}">${lines.map((line,i)=>`<tspan x="0" dy="${i?17:0}">${line}</tspan>`).join('')}<tspan class="atlas-node-meta" x="0" dy="21">${topic.count} shards</tspan></text></g>`;}).join('')}</g></svg></div><p class="atlas-notice">${selected?'Showing this topic and up to 10 overlapping neighborhoods.':'Showing up to 12 largest neighborhoods and their 18 strongest overlaps.'} Every topic is available below. Line thickness shows the number of shared shards.</p>`;
}
function atlasShardCard(shard,model){const topics=model.memberships.get(shard.id)||[];return `<article class="atlas-shard-card"${shardThemeAttributes(shard)}><div class="atlas-card-topline"><small>${esc(kinds[shard.kind]||'Shard')} · ${esc(statuses[shard.status]||shard.status)}</small><small>${topics.length>1?'Bridge · '+topics.length+' topics':''}</small></div><button class="atlas-shard-open" data-action="atlas-select" data-id="${esc(shard.id)}"><h3>${esc(shard.title)}</h3></button><p>${esc(excerpt(shard.content).slice(0,180))}</p><div class="atlas-memberships">${topics.map(key=>`<button data-action="atlas-topic" data-id="${esc(key)}">${esc(model.topics.find(t=>t.key===key)?.label||key)}</button>`).join('')||'<span>No visible topic</span>'}</div><div class="atlas-card-actions"><button class="secondary" data-action="atlas-select" data-id="${esc(shard.id)}">Explore connections</button><button class="text-button" data-shard-id="${esc(shard.id)}">Read shard ↗</button></div></article>`;}
function atlasTopicInspector(model){
  const labels=new Map(model.topics.map(t=>[t.key,t.label])),topic=model.topics.find(t=>t.key===state.atlasTopic);
  const pairs=topic?model.overlaps.filter(p=>p.a===topic.key||p.b===topic.key):model.overlaps;
  return `<aside class="atlas-inspector" aria-label="Topic overlaps"><section><span class="eyebrow">${topic?'CONNECTED NEIGHBORHOODS':'WHERE IDEAS MEET'}</span><h2>${esc(topic?topic.label:'Topics overlap.')}</h2><p>${topic?'Choose another neighborhood to see the shards they share.':'A bridge shard belongs to more than one topic. These overlaps come directly from your saved topics.'}</p><ul class="atlas-bridges">${pairs.slice(0,8).map(pair=>`<li><button data-action="atlas-overlap" data-id="${esc(pair.a)}" data-other="${esc(pair.b)}" aria-pressed="${state.atlasTopic===pair.a&&state.atlasBridge===pair.b}"><span>${esc(labels.get(pair.a))} ↔ ${esc(labels.get(pair.b))}</span><small>${pair.count} shared ${pair.count===1?'shard':'shards'}</small></button></li>`).join('')||'<li>No shared-topic shards in this view.</li>'}</ul></section><section><h3>Explore an idea</h3><p>Select any shard below to see its recorded connections. Shared-topic lines describe membership. They do not assert that one idea explains or depends on another.</p><p>Organizational tags such as C++ and LucidChart are hidden here by default. Your tags and notes remain unchanged.</p></section></aside>`;
}
function atlasRelationshipSvg(model){
  const byKey=new Map(model.nodes.map(n=>[n.id,n])),levels=new Map(model.centerId?[[model.centerId,0]]:[]),queue=model.centerId?[model.centerId]:[];
  while(queue.length){const id=queue.shift();for(const edge of model.edges){const other=edge.fromId===id?edge.toId:edge.toId===id?edge.fromId:null;if(other&&!levels.has(other)){levels.set(other,levels.get(id)+1);queue.push(other);}}}
  const groups=new Map();for(const node of model.nodes){const level=levels.get(node.id)||0;if(!groups.has(level))groups.set(level,[]);groups.get(level).push(node);}
  const width=Math.max(960,(Math.max(0,...groups.keys())+1)*320+60),height=Math.max(560,Math.max(0,...[...groups.values()].map(g=>g.length))*122+60),positions=new Map();
  for(const [level,nodes] of groups){nodes.sort(atlasShardCompare).forEach((n,i)=>positions.set(n.id,{x:40+level*320,y:(height-nodes.length*122)/2+i*122}));}
  const inspected=model.nodes.some(n=>n.id===state.atlasInspectId)?state.atlasInspectId:model.centerId;
  return `<div class="atlas-surface"><svg class="atlas-relationship-map" viewBox="0 0 ${width} ${height}" role="group" aria-label="Recorded shard relationships. Arrows follow the saved relationship direction." style="width:${state.atlasZoom*100}%;min-width:${state.atlasFit?0:Math.min(width,960)*state.atlasZoom}px"><defs><marker id="atlas-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8" fill="#7f9474"/></marker></defs>${model.edges.map(edge=>{const a=positions.get(edge.fromId),b=positions.get(edge.toId),forward=b.x>a.x,sx=a.x+(forward?230:0),tx=b.x+(forward?0:230),sy=a.y+44,ty=b.y+44,mid=(sx+tx)/2;const path=a.x===b.x?`M${a.x+230},${sy} C${a.x+290},${sy} ${b.x+290},${ty} ${b.x+230},${ty}`:`M${sx},${sy} C${mid},${sy} ${mid},${ty} ${tx},${ty}`;return `<g><title>${esc(byKey.get(edge.fromId).title+' '+(relations[edge.type]||edge.type)+' '+byKey.get(edge.toId).title+(edge.note?': '+edge.note:''))}</title><path class="atlas-relation-edge" d="${path}" marker-end="url(#atlas-arrow)"/><text class="atlas-edge-label" x="${a.x===b.x?a.x+275:mid}" y="${(sy+ty)/2-7}" text-anchor="middle">${esc(relations[edge.type]||edge.type)}</text></g>`;}).join('')}${model.nodes.map(node=>{const p=positions.get(node.id),count=model.hiddenByNode.get(node.id)||0,selected=inspected===node.id,expanded=node.id===model.centerId||state.atlasExpandedIds.includes(node.id),lines=atlasTextLines(node.title,28,3);return `<g class="atlas-relationship-node ${selected?'selected':''} ${expanded?'expanded':''}" transform="translate(${p.x},${p.y})" tabindex="0" role="button" aria-pressed="${selected}" data-atlas-action="atlas-inspect" data-id="${esc(node.id)}" aria-label="${esc('Inspect '+node.title+(count?', '+count+' more connections':''))}"><title>${esc(node.title)}</title><rect width="230" height="96" rx="10"/><text x="14" y="22">${lines.map((line,i)=>`<tspan x="14" dy="${i?17:0}">${line}</tspan>`).join('')}<tspan class="atlas-node-meta" x="14" y="83">${count?'＋ '+count+' more connections':expanded?'Connections expanded':'All connections visible'}</tspan></text></g>`;}).join('')}</svg></div>`;
}
function atlasRelationshipInspector(model,topicModel){
  const selected=model.nodes.find(n=>n.id===state.atlasInspectId)||model.nodes.find(n=>n.id===model.centerId);if(!selected)return '';
  const inverse={depends_on:'is a dependency of',explains:'is explained by',contrasts_with:'contrasts with',example_of:'has an example in',related_to:'relates to',part_of:'contains',supports:'is supported by',contradicts:'contradicts',supersedes:'is superseded by',released_by:'was released by'};
  const edges=model.edges.filter(l=>l.fromId===selected.id||l.toId===selected.id),hidden=model.hiddenByNode.get(selected.id)||0;
  return `<aside class="atlas-inspector" aria-label="Selected shard connections"><section class="atlas-focus-card"${shardThemeAttributes(selected)}><span class="eyebrow">${selected.id===model.centerId?'STARTING IDEA':'SELECTED IDEA'}</span><h2>${esc(selected.title)}</h2><p>${esc(excerpt(selected.content).slice(0,280))}</p><div class="atlas-memberships">${(topicModel.memberships.get(selected.id)||[]).map(key=>`<button data-action="atlas-topic" data-id="${esc(key)}">${esc(topicModel.topics.find(t=>t.key===key)?.label||key)}</button>`).join('')}</div><button class="secondary" data-shard-id="${esc(selected.id)}">Read shard ↗</button><button class="primary" data-action="atlas-expand" data-id="${esc(selected.id)}" ${hidden?'':'disabled'}>Expand connections${hidden?' · '+hidden:''}</button>${selected.id!==model.centerId?`<button class="text-button" data-action="atlas-focus" data-id="${esc(selected.id)}">Start from this shard</button>`:''}</section><section><h3>Recorded relationships</h3><ul class="atlas-neighbor-list">${edges.map(edge=>{const out=edge.fromId===selected.id,other=byId(out?edge.toId:edge.fromId);return `<li><span class="atlas-relation-label">This idea ${esc(out?(relations[edge.type]||edge.type):(inverse[edge.type]||edge.type))}</span><h4>${esc(other.title)}</h4>${edge.note?`<p>${esc(edge.note)}</p>`:''}<button class="text-button" data-action="atlas-inspect" data-id="${esc(other.id)}">Inspect connection →</button></li>`;}).join('')||'<li>No recorded relationships match this view.</li>'}</ul></section></aside>`;
}
function renderAtlas(){
  const model=atlasModel(),topics=new Map(model.topics.map(t=>[t.key,t])),topic=topics.get(state.atlasTopic),bridge=topic?topics.get(state.atlasBridge):null;
  const matching=model.shards.filter(s=>(!topic||model.memberships.get(s.id).includes(topic.key))&&(!bridge||model.memberships.get(s.id).includes(bridge.key))).sort((a,b)=>state.sort==='title'?atlasShardCompare(a,b):atlasCompare(b[state.sort==='created'?'createdAt':'updatedAt']||'',a[state.sort==='created'?'createdAt':'updatedAt']||'')||atlasShardCompare(a,b));
  const mode=state.atlasMode==='connections'?'connections':'topics';
  const controls=`<div class="atlas-controls"><div class="segmented-control atlas-mode-switch" aria-label="Map view"><button data-action="atlas-mode" data-id="topics" class="${mode==='topics'?'active':''}" aria-pressed="${mode==='topics'}">Topic neighborhoods</button><button data-action="atlas-mode" data-id="connections" class="${mode==='connections'?'active':''}" aria-pressed="${mode==='connections'}">Shard connections</button></div><label><input type="checkbox" id="atlas-organizational" ${state.atlasShowOrganizational?'checked':''}> Show organizational tags</label>${mode==='connections'?`<label>Relationship<select id="atlas-relation" aria-label="Filter map relationships"><option value="all">All relationships</option>${Object.entries(relations).filter(([key])=>state.data.links.some(l=>l.type===key)).map(([key,label])=>`<option value="${key}" ${state.atlasRelation===key?'selected':''}>${esc(label)}</option>`).join('')}</select></label>`:''}<button class="text-button" data-action="atlas-reset">Reset map</button></div>`;
  const heading=pageHeading('YOUR KNOWLEDGE, CONNECTED.','Follow the shape of an idea.','Explore topic neighborhoods and the shards that connect them. Everything is arranged from your saved knowledge.');
  const filters=`<div class="atlas-filters">${filterMarkup()}${hasFilters()?'<button class="text-button" data-action="clear-filters">Clear filters</button>':''}</div>`;
  const stats=`<div class="atlas-stats"><span><strong>${model.shards.length}</strong> matching shards</span><span><strong>${model.topics.length}</strong> topics</span><span><strong>${model.bridgeShards.length}</strong> bridge shards</span></div>`;
  if(!model.shards.length)return `<div class="atlas-page">${heading}${controls}${filters}<div class="atlas-empty"><h2>${state.data.shards.length?'No shards match these filters.':'Your topic map starts with a shard.'}</h2><p>${state.data.shards.length?'Try another search or clear the filters.':'Add a shard with topics. Its neighborhoods and saved connections will appear automatically.'}</p><button class="secondary" data-action="${state.data.shards.length?'clear-filters':'new'}">${state.data.shards.length?'Clear filters':'New shard'}</button></div></div>`;
  const toolbar=`<div class="atlas-map-toolbar"><span>${mode==='topics'?'Shared topics · no implied prerequisites':'Recorded relationships · arrows preserve direction'}</span><div><button class="icon-button" data-action="atlas-zoom-out" aria-label="Zoom out of map">−</button><button class="text-button" data-action="atlas-zoom-reset">Fit map</button><button class="icon-button" data-action="atlas-zoom-in" aria-label="Zoom into map">＋</button></div></div>`;
  const topicList=`<details aria-label="All topic neighborhoods"><summary>Browse all ${model.topics.length} topic neighborhoods</summary><div class="atlas-topic-list">${model.topics.map(t=>`<button class="atlas-topic-button ${topic?.key===t.key?'selected':''}" data-action="atlas-topic" data-id="${esc(t.key)}" style="--topic-color:${t.color}" aria-pressed="${topic?.key===t.key}"><span>${esc(t.label)}</span><small>${t.count}</small></button>`).join('')}</div></details>`;
  const cards=`<section aria-label="Shards in this neighborhood"><div class="atlas-topic-heading"><h2>${esc(topic?(bridge?topic.label+' ∩ '+bridge.label:topic.label):'Explore your shards')}</h2><small>${matching.length} shards</small>${topic?'<button class="text-button" data-action="atlas-all-topics">All neighborhoods</button>':''}</div><div class="atlas-topic-shards">${matching.slice(0,state.atlasLimit).map(s=>atlasShardCard(s,model)).join('')}</div>${matching.length>state.atlasLimit?`<button class="secondary full-width" data-action="atlas-more">Show more · ${matching.length-state.atlasLimit} remaining</button>`:''}</section>`;
  const unmapped=model.unmappedShards.length?`<details class="atlas-notice"><summary>${model.unmappedShards.length} shards without visible topic neighborhoods</summary><p>These shards have no topics, or only organizational tags. They are included in the shard list and remain searchable.</p><div class="atlas-memberships">${model.unmappedShards.map(s=>`<button data-action="atlas-select" data-id="${esc(s.id)}">${esc(s.title)}</button>`).join('')}</div></details>`:'';
  if(mode==='connections'){
    const graph=atlasRelationshipModel();return `<div class="atlas-page">${heading}${controls}${filters}${stats}<p class="atlas-notice">${graph.nodes.length} visible shards · ${graph.edges.length} recorded relationships · ${graph.frontierCount} more shards available to expand. Select a node, then expand its connections.</p><div class="atlas-layout"><div class="atlas-main">${toolbar}${atlasRelationshipSvg(graph)}<div class="atlas-legend"><span>Arrow: recorded relationship</span><span>Highlighted card: selected idea</span></div><details><summary>Choose another starting shard</summary>${cards}</details></div>${atlasRelationshipInspector(graph,model)}</div></div>`;
  }
  return `<div class="atlas-page">${heading}${controls}${filters}${stats}<div class="atlas-layout"><div class="atlas-main">${toolbar}${model.topics.length?atlasTopicSvg(model):'<div class="atlas-empty"><h2>No visible topic neighborhoods yet.</h2><p>Show organizational tags or add a subject topic to a shard. Your shards are listed below.</p></div>'}<div class="atlas-legend"><span>Circle: topic neighborhood</span><span>Line: shared shards</span><span>Bridge shard: belongs to multiple topics</span></div>${topicList}${unmapped}${cards}</div>${atlasTopicInspector(model)}</div></div>`;
}
function atlasAction(action,button){
  const id=button.dataset.id;
  if(action==='atlas-mode'){state.atlasMode=id==='connections'?'connections':'topics';state.atlasZoom=1;state.atlasFit=false;}
  else if(action==='atlas-topic'){state.atlasMode='topics';state.atlasTopic=atlasKey(id);state.atlasBridge=null;state.atlasLimit=12;}
  else if(action==='atlas-overlap'){state.atlasMode='topics';state.atlasTopic=atlasKey(id);state.atlasBridge=atlasKey(button.dataset.other);state.atlasLimit=12;}
  else if(action==='atlas-all-topics'){state.atlasTopic=null;state.atlasBridge=null;state.atlasLimit=12;}
  else if(action==='atlas-select'||action==='atlas-focus'){if(!filteredShards().some(s=>s.id===id))return true;state.atlasMode='connections';state.atlasSelectedId=id;state.atlasInspectId=id;state.atlasExpandedIds=[];state.atlasZoom=1;}
  else if(action==='atlas-inspect'){if(!atlasRelationshipModel().nodes.some(s=>s.id===id))return true;state.atlasInspectId=id;}
  else if(action==='atlas-expand'){if(!atlasRelationshipModel().nodes.some(s=>s.id===id))return true;state.atlasExpandedIds=[...new Set([...state.atlasExpandedIds,id])];}
  else if(action==='atlas-reset'){Object.assign(state,{atlasTopic:null,atlasBridge:null,atlasSelectedId:null,atlasInspectId:null,atlasExpandedIds:[],atlasRelation:'all',atlasLimit:12,atlasZoom:1,atlasFit:false});}
  else if(action==='atlas-more')state.atlasLimit+=12;
  else if(action==='atlas-zoom-in')state.atlasZoom=Math.min(2.5,state.atlasZoom*1.25);
  else if(action==='atlas-zoom-out')state.atlasZoom=Math.max(.75,state.atlasZoom/1.25);
  else if(action==='atlas-zoom-reset'){state.atlasZoom=1;state.atlasFit=true;}
  else return false;
  render();return true;
}
function bindAtlas(){
  document.querySelectorAll('[data-atlas-action]').forEach(node=>{
    node.addEventListener('click',()=>{if(!busy)atlasAction(node.dataset.atlasAction,node);});
    node.addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();event.stopPropagation();if(!busy)atlasAction(node.dataset.atlasAction,node);}});
  });
}
const releaseCategories = {language:'Language',library:'Library',change:'Changes & removals'};
function releaseTagSelected(tag) {return state.tags.some(selected=>selected.toLocaleLowerCase()===tag.toLocaleLowerCase());}
function matchesTimelineTopics(tags) {
  const available=new Set(tags.map(tag=>tag.toLocaleLowerCase()));
  return !state.tags.length||(state.tagMode==='all'?state.tags.every(tag=>available.has(tag.toLocaleLowerCase())):state.tags.some(tag=>available.has(tag.toLocaleLowerCase())));
}
function shardReleaseIds(shard) {
  const version=String(shard.languageVersion||'');
  return [...new Set([...version.matchAll(/C\+\+\s*(98|03|11|14|17|20|23|26)\b/gi)].filter(match=>!/(?:pre[-\s]*|before\s+|prior\s+to\s+)$/i.test(version.slice(0,match.index))).map(match=>'cpp'+match[1]))];
}
function filteredReleaseFeatures(release) {
  const words=state.query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
  return release.features.filter(feature=>(state.releaseCategory==='all'||feature.category===state.releaseCategory)&&matchesTimelineTopics(feature.tags)&&words.every(word=>[release.label,feature.title,feature.summary,feature.tags.join(' '),feature.category,...(Array.isArray(feature.cppreferenceLinks)?feature.cppreferenceLinks:[]).map(link=>link?.title||'')].join(' ').toLocaleLowerCase().includes(word)));
}
function filteredReleaseShards() {
  const words=state.query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
  return state.data.shards.filter(shard=>matchesTimelineTopics(shard.tags)&&words.every(word=>[shard.title,shard.content,shard.tags.join(' '),shard.languageVersion,shard.sourceUrl].join(' ').toLocaleLowerCase().includes(word)));
}
const spiralReleaseIds = ['cpp98','cpp03','cpp11','cpp14','cpp17','cpp20','cpp23','cpp26'];
let spiralCatalogLoading = null, releaseCatalogLoading = null, releaseNavigationToken = 0;
function spiralArt(world){const value=typeof world?.art==='string'?world.art:world?.art?.src;return /^\/spiral\/[a-z0-9_-]+\.svg$/i.test(value||'')?value:'';}
function spiralEmblems(world){return (Array.isArray(world?.emblems)?world.emblems:[]).filter(emblem=>emblem&&/^[a-z0-9-]+$/.test(emblem.id||'')&&typeof emblem.name==='string'&&/^\/spiral\/(?:emblems\/[a-z0-9-]+\.svg|local-emblems\/[a-z0-9-]+\.(?:png|gif|webp|jpe?g))$/.test(emblem.src||''));}
function renderSpiralEmblems(world,placement){
  const emblems=spiralEmblems(world);if(!emblems.length)return '';
  if(placement==='world')return `<div class="spiral-world-emblems" data-world-count="${emblems.length}" role="list" aria-label="Worlds in this release">${emblems.map(emblem=>`<div class="spiral-world-emblem" data-world="${esc(emblem.id)}" role="listitem"><img src="${esc(emblem.src)}" alt="" width="32" height="32" loading="lazy"><span>${esc(emblem.name)}</span></div>`).join('')}</div>`;
  return `<span class="spiral-${placement}-emblems" data-world-count="${emblems.length}" aria-hidden="true">${emblems.map(emblem=>`<img class="spiral-${placement}-emblem" src="${esc(emblem.src)}" alt="" width="44" height="44" loading="lazy">`).join('')}</span>`;
}
function spiralWorld(release){return state.timelineTheme==='spiral'?state.spiralCatalog?.releases?.[release.id]:null;}
function spiralText(value){return typeof value==='string'?value:value?.summary||'';}
function spiralSources(sources){return (Array.isArray(sources)?sources:[]).filter(source=>source&&/^https?:\/\//i.test(source.url||'')).map(source=>sourceAnchor(source.url,source.title||'Supporting source')).join('');}
function setTimelineTheme(theme){if(!['plain','spiral'].includes(theme))return;state.timelineTheme=theme;try{localStorage.setItem(timelineThemeKey,theme);}catch{}render();}
function renderTimelineAppearance(){
  const unavailable=state.timelineTheme==='spiral'&&!state.spiralCatalog;
  return `<div class="timeline-appearance"><div class="segmented-control" role="group" aria-label="Timeline appearance"><button type="button" data-action="timeline-theme" data-theme="spiral" aria-pressed="${state.timelineTheme==='spiral'}">Spiral worlds</button><button type="button" data-action="timeline-theme" data-theme="plain" aria-pressed="${state.timelineTheme==='plain'}">Plain timeline</button></div><span class="timeline-appearance-note" id="spiral-load-status" role="status">${unavailable?(state.spiralCatalogError?'World guide unavailable. The plain timeline is ready.':'Opening the world guide. The plain timeline is ready.'):'C++ years lead. Worlds are optional memory cues.'}</span>${unavailable&&state.spiralCatalogError?'<button type="button" class="text-button" data-action="reload-spiral">Try world guide again</button>':''}</div>`;
}
function renderReleaseNavigation(releases,noVersion,showShards){
  const themed=state.timelineTheme==='spiral'&&state.spiralCatalog;
  const selected=releases.some(release=>release.id===state.timelineReleaseId)?state.timelineReleaseId:releases[0]?.id;
  return `<nav class="release-jumps ${themed?'spiral-portals':''}" aria-label="${themed?'World portals, jump to a C++ release':'Jump to a C++ release'}">${releases.map(release=>{
    const world=spiralWorld(release),worldName=world?.worldNames?.join(' · ')||'';
    return world?`<button type="button" class="spiral-portal" id="portal-${esc(release.id)}" data-action="jump-release" data-id="${esc(release.id)}" data-portal-release="${esc(release.id)}" data-spiral-release="${esc(release.id)}" aria-controls="release-${esc(release.id)}" aria-current="${selected===release.id?'step':'false'}" aria-label="Jump to ${esc(release.label)}${release.status==='draft'?', working draft':''}: ${esc(worldName)}">${renderSpiralEmblems(world,'portal')||`<span class="spiral-portal-art" aria-hidden="true"><img src="${esc(spiralArt(world))}" alt="" loading="lazy"></span>`}<span class="spiral-portal-label"><strong>${esc(release.label)}${release.status==='draft'?' · draft':''}</strong><span>${esc(worldName)}</span></span></button>`:`<button class="secondary" data-action="jump-release" data-id="${esc(release.id)}">${esc(release.label)}${release.status==='draft'?' · draft':''}</button>`;
  }).join('')}${showShards&&noVersion.length?`<button class="secondary release-unassigned-jump" data-action="jump-release" data-id="unassigned">No release assigned <span>${noVersion.length}</span></button>`:''}</nav>`;
}
function renderSpiralWorld(release){
  const world=spiralWorld(release);if(!world)return '';
  const names=world.worldNames.join(' · '),art=spiralArt(world),association=spiralText(world.association),history=spiralText(world.history);
  const emblems=spiralEmblems(world),emblemCredits=[...new Set(emblems.map(emblem=>emblem.credit).filter(Boolean))];
  return `<div class="spiral-world"><figure class="spiral-banner"><img src="${esc(art)}" alt="${esc(world.artAlt||world.art?.alt||'An original landscape inspired by '+names)}" width="1600" height="560" loading="lazy"><figcaption>${renderSpiralEmblems(world,'world')||`<strong>${esc(names)}</strong>`}<span>${esc(world.caption||'')}</span></figcaption></figure><details class="spiral-world-info"><summary>Why this world?</summary><div><p>${esc(association)}</p>${world.association?.why?`<p>${esc(world.association.why)}</p>`:''}<p class="spiral-limit">${esc(world.association?.limits||'A learning analogy, not a link between the two release histories.')}</p>${history?`<h3>Wizard101 history</h3><p>${esc(history)}</p>`:''}<div class="release-sources">${spiralSources(world.sourceLinks||world.sources||world.history?.sources)}</div>${world.artCredit||world.art?.credit?`<p class="spiral-art-credit">Banner: ${esc(world.artCredit||world.art.credit)}${world.artLicense||world.art?.license?' · '+esc(world.artLicense||world.art.license):''}</p>`:''}${emblemCredits.map(credit=>`<p class="spiral-art-credit">Emblems: ${esc(credit)}</p>`).join('')}${emblems.some(emblem=>emblem.sourceUrl)?`<div class="release-sources">${spiralSources(emblems.filter(emblem=>emblem.sourceUrl).map(emblem=>({url:emblem.sourceUrl,title:emblem.name+' emblem source'})))}</div>`:''}</div></details></div>`;
}
function filteredSpiralExamples(release){
  const words=state.query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean),world=spiralWorld(release);
  return (world?.examples||[]).filter(example=>{const tags=Array.isArray(example.tags)?example.tags:[];return (state.releaseCategory==='all'||(example.category||'language')===state.releaseCategory)&&matchesTimelineTopics(tags)&&words.every(word=>[release.label,example.title,example.summary,example.explanation,example.code,tags.join(' ')].join(' ').toLocaleLowerCase().includes(word));});
}
function renderSpiralExamples(release){
  const examples=filteredSpiralExamples(release);if(!examples.length)return '';
  return `<details class="spiral-examples"><summary>Spellbook examples <span>${examples.length}</span></summary><p class="spiral-reference-note">Curated learning examples, separate from your shards.</p>${examples.map(example=>`<article class="spiral-example"><h4>${esc(example.title)}</h4><span class="spiral-standard">${esc(example.languageVersion||example.standard||release.label)}</span><p>${esc(example.summary||'')}</p>${example.code?`<div class="markdown">${markdown('```cpp\n'+example.code+'\n```')}</div>`:''}${example.explanation?`<p>${esc(example.explanation)}</p>`:''}${example.limits?`<p class="spiral-limit">${esc(example.limits)}</p>`:''}<div class="release-sources">${spiralSources(example.sourceLinks||example.sources)}</div></article>`).join('')}</details>`;
}
function renderSpiralTrail(){
  if(state.timelineTheme!=='spiral'||!state.spiralCatalog||state.timelineContent==='shards')return '';
  const trail=state.spiralCatalog.trail;if(!trail?.steps?.length)return '';
  const releases=new Map((state.releaseCatalog?.releases||[]).map(release=>[release.id,release]));
  return `<details class="spiral-trail"><summary><span>Cross-release trail</span> ${esc(trail.title||'Follow constexpr')}</summary><div class="spiral-trail-body"><p>${esc(trail.summary||'')}</p><ol>${trail.steps.filter(step=>releases.has(step.releaseId)).map(step=>{const release=releases.get(step.releaseId);return `<li><button type="button" class="spiral-trail-jump" data-spiral-release="${esc(step.releaseId)}" data-action="jump-release" data-id="${esc(step.releaseId)}">${renderSpiralEmblems(spiralWorld(release),'trail')}<span>${esc(release.label)}${release.status==='draft'?' · draft':''} →</span></button><h3>${esc(step.title)}</h3><p>${esc(step.summary||'')}</p>${step.code?`<details class="spiral-trail-code"><summary>Read the example</summary><div class="markdown">${markdown('```cpp\n'+step.code+'\n```')}</div></details>`:''}${step.limits?`<p class="spiral-limit">${esc(step.limits)}</p>`:''}<div class="release-sources">${spiralSources(step.sourceLinks||step.sources)}</div></li>`;}).join('')}</ol><p class="spiral-reference-note">This guide follows the releases without changing your search or topic filters.</p></div></details>`;
}
async function loadSpiralCatalog(){
  if(spiralCatalogLoading)return spiralCatalogLoading;
  state.spiralCatalogError=null;
  spiralCatalogLoading=(async()=>{
    try{
      const result=await api('/spiral-timeline.json');
      if(result.schemaVersion!==1||!result.releases||spiralReleaseIds.some(id=>{const world=result.releases[id];return !world||!Array.isArray(world.worldNames)||!world.worldNames.length||world.worldNames.some(name=>typeof name!=='string')||!spiralArt(world)||!Array.isArray(world.examples||[])||(world.examples||[]).some(example=>typeof example.title!=='string'||typeof example.code!=='string');}))throw new Error('Invalid world guide.');
      if(result.trail&&(!Array.isArray(result.trail.steps)||result.trail.steps.some(step=>!spiralReleaseIds.includes(step.releaseId))))throw new Error('Invalid learning trail.');
      state.spiralCatalog=result;
    }catch(error){state.spiralCatalog=null;state.spiralCatalogError=error.message;}
    if(state.view==='timeline')render();
    else if(state.view==='library'){const heading=$('.note-heading'),selected=byId(state.selectedId);if(heading&&selected&&heading.dataset.shardId===selected.id)heading.innerHTML=renderShardHeading(selected);}
  })();
  try{return await spiralCatalogLoading;}finally{spiralCatalogLoading=null;}
}
function handlePortalKey(event){
  const portal=event.target.closest?.('[data-portal-release]');if(!portal||event.altKey||event.ctrlKey||event.metaKey)return false;
  const ids=(state.releaseCatalog?.releases||[]).map(release=>release.id),index=ids.indexOf(portal.dataset.portalRelease);if(index<0)return false;
  const next=event.key==='Home'?0:event.key==='End'?ids.length-1:['ArrowRight','ArrowDown'].includes(event.key)?(index+1)%ids.length:['ArrowLeft','ArrowUp'].includes(event.key)?(index+ids.length-1)%ids.length:-1;
  if(next<0)return false;event.preventDefault();$('#portal-'+ids[next])?.focus();return true;
}
function renderTimeline() {return renderReleaseTimeline();}
function releaseSourceLinks(ids) {
  const sources=new Map((state.releaseCatalog?.sources||[]).map(source=>[source.id,source]));
  return [...new Set(ids||[])].map(id=>sources.get(id)).filter(source=>source&&/^https?:\/\//i.test(source.url)).map(source=>`<a href="${esc(source.url)}" target="_blank" rel="noopener noreferrer">${esc(source.title)} ↗</a>`).join('');
}
function renderReleaseFeature(feature) {
  const reading=(Array.isArray(feature.cppreferenceLinks)?feature.cppreferenceLinks:[]).filter(link=>link&&typeof link.title==='string'&&/^https:\/\/en\.cppreference\.com\/(?:w\/)?(?:cpp|c)\//.test(link.url||'')).map(link=>sourceAnchor(link.url,link.title)).join('');
  return `<details class="release-feature"><summary><span class="release-feature-category">${esc(releaseCategories[feature.category]||feature.category)}</span><span class="release-feature-title">${esc(feature.title)}</span><span class="release-expand" aria-hidden="true">＋</span></summary><div class="release-feature-body"><p>${esc(feature.summary)}</p><div class="release-tags">${feature.tags.map(tag=>`<button class="tag ${releaseTagSelected(tag)?'active':''}" data-tag="${esc(tag)}" aria-pressed="${releaseTagSelected(tag)}">${esc(tag)}</button>`).join('')}</div><div class="release-sources">${reading}${releaseSourceLinks(feature.sourceIds)}</div></div></details>`;
}
function renderReleaseNote(shard,releaseId) {
  const theme=state.timelineTheme==='spiral'?shardThemeAttributes(shard,spiralReleaseIds.includes(releaseId)?[releaseId]:shardWorldReleaseIds(shard)):'';
  return `<button class="release-note"${theme} data-shard-id="${esc(shard.id)}"><span class="release-note-kind">${esc(kinds[shard.kind]||shard.kind)} · ${esc(statuses[shard.status]||shard.status)}</span><strong>${esc(shard.title)}</strong><span>${esc(excerpt(shard.content).slice(0,115))}</span></button>`;
}
function releaseFilterMarkup() {
  return `<div class="release-filters"><label class="timeline-content-filter">Show<select id="timeline-content" aria-label="Timeline content">${Object.entries({both:'My shards & reference',shards:'My shards',reference:'Release reference'}).map(([value,label])=>`<option value="${value}" ${state.timelineContent===value?'selected':''}>${esc(label)}</option>`).join('')}</select></label>${state.timelineContent!=='shards'?`<label>Feature type<select id="release-category" aria-label="Filter C++ feature category"><option value="all">All features</option>${Object.entries(releaseCategories).map(([value,label])=>`<option value="${value}" ${state.releaseCategory===value?'selected':''}>${esc(label)}</option>`).join('')}</select></label>`:''}<label>Match topics<select id="tag-mode" aria-label="Match selected topics"><option value="all" ${state.tagMode==='all'?'selected':''}>All selected topics</option><option value="any" ${state.tagMode==='any'?'selected':''}>Any selected topic</option></select></label><span class="release-filter-hint">Search above or choose topics in the sidebar.</span>${state.query||state.tags.length||state.releaseCategory!=='all'?'<button class="text-button" data-action="clear-filters">Clear filters</button>':''}${state.tags.length?`<div class="release-selected-tags">${state.tags.map(tag=>`<button class="tag active" data-tag="${esc(tag)}" title="Remove this topic filter">${esc(tag)} ×</button>`).join('')}</div>`:''}</div>`;
}
function renderReleaseTimeline() {
  const heading=pageHeading('THE EVOLUTION OF C++.','From one release to the next.','See your shards alongside language and library features. Scroll horizontally or jump to a release.');
  if(!state.releaseCatalog){const shards=filteredReleaseShards();return heading+renderTimelineAppearance()+releaseFilterMarkup()+`<div class="release-load-state"><h2>${state.releaseCatalogError?'The release reference could not open.':'Opening the C++ release reference…'}</h2><p>${state.releaseCatalogError?(state.timelineContent==='reference'?'Choose My shards to read your notes, or try loading the bundled reference again.':'Your shards are still available below. Try loading the bundled reference again to see their release placement.'):'Your own knowledge stays separate from this reference catalog.'}</p>${state.releaseCatalogError?'<button class="secondary" data-action="reload-releases">Try again</button>':''}</div>${state.timelineContent!=='reference'?`<section class="release-unversioned"><h2>Your shards</h2><div class="release-unversioned-notes">${shards.map(renderReleaseNote).join('')||'<p>No shards match your search and topics.</p>'}</div></section>`:''}`;}
  const catalog=state.releaseCatalog,shards=filteredReleaseShards(),releases=catalog.releases,knownIds=new Set(releases.map(release=>release.id));
  const showShards=state.timelineContent!=='reference',showReference=state.timelineContent!=='shards';
  const noVersion=shards.filter(shard=>!shardReleaseIds(shard).some(id=>knownIds.has(id))),count=releases.reduce((sum,release)=>sum+filteredReleaseFeatures(release).length,0),total=releases.reduce((sum,release)=>sum+release.features.length,0);
  const coverage=typeof catalog.coverage==='string'?catalog.coverage:catalog.coverage?.summary||catalog.coverage?.note||catalog.coverage?.description||'';
  return heading+renderTimelineAppearance()+releaseFilterMarkup()+`<div class="release-overview"><span>${showShards?`<strong>${shards.length}</strong> matching shard${shards.length===1?'':'s'} · ${shards.length-noVersion.length} placed by release · ${noVersion.length} no release assigned`:''}${showShards&&showReference?' · ':''}${showReference?`<strong>${count}</strong> of ${total} reference entries`:''}</span><span>${showShards?'Open a shard to read or edit it.':'Reference features are separate from your understanding status.'}</span></div>${renderReleaseNavigation(releases,noVersion,showShards)}${renderSpiralTrail()}<div class="release-track" id="release-track" tabindex="0" role="region" aria-label="C++ releases, scroll horizontally">${releases.map(release=>{
    const features=filteredReleaseFeatures(release),notes=shards.filter(shard=>shardReleaseIds(shard).includes(release.id));
    return `<section class="release-column ${release.status==='draft'?'is-draft':''} ${spiralWorld(release)?'spiral-release':''}" id="release-${esc(release.id)}" ${spiralWorld(release)?`data-spiral-release="${esc(release.id)}"`: ''} tabindex="-1" aria-label="${esc(release.label)}"><header class="release-heading"><div><span>${esc(release.year)}${release.status==='draft'?' · Working draft':''}</span><h2>${esc(release.label)}</h2></div><small>${showShards?`${notes.length} shard${notes.length===1?'':'s'}`:''}${showShards&&showReference?' · ':''}${showReference?`${features.length} / ${release.features.length} entries`:''}</small><p>${esc(release.summary)}</p></header>${renderSpiralWorld(release)}<div class="release-column-body">${showShards?`<section class="release-own-notes" aria-label="Your shards for ${esc(release.label)}"><h3>Your shards <span>${notes.length}</span></h3>${notes.map(note=>renderReleaseNote(note,release.id)).join('')||'<p class="release-empty-shards">No matching shards for this release.</p>'}</section>`:''}${showReference?renderSpiralExamples(release):''}${showReference?`<div class="release-reference-heading"><h3>Release reference</h3><span>Language · library · changes</span></div>${features.map(renderReleaseFeature).join('')||'<p class="release-no-match">No reference entries match these filters.</p>'}<div class="release-version-sources">${releaseSourceLinks(release.sourceIds)}</div>`:''}</div></section>`;
  }).join('')}${showShards&&noVersion.length?`<section class="release-column release-unassigned" id="release-unassigned" aria-label="No release assigned"><header class="release-heading"><div><span>YOUR COLLECTION</span><h2>No release assigned</h2></div><small>${noVersion.length} shard${noVersion.length===1?'':'s'}</small><p>Set Version or scope in a shard’s Source &amp; context to place it by release, such as C++17.</p></header><div class="release-column-body"><section class="release-own-notes" aria-label="Your shards without a release"><h3>Your shards <span>${noVersion.length}</span></h3>${noVersion.map(renderReleaseNote).join('')}</section></div></section>`:''}</div><details class="release-coverage"><summary>Reference coverage &amp; sources${catalog.updatedAt?' · updated '+esc(String(catalog.updatedAt).slice(0,10)):''}</summary><p>${esc(coverage)}</p><p>The entries describe additions and changes in each release. Later releases also retain earlier features unless removed. C++26 is labeled as a draft. Its contents can change. Your shards use the version or scope you assigned.</p><div class="release-sources">${releaseSourceLinks((catalog.sources||[]).filter(source=>!source.id.startsWith('paper-')).map(source=>source.id))}</div></details>`;
}
async function loadReleaseCatalog() {
  if(releaseCatalogLoading)return releaseCatalogLoading;
  state.releaseCatalogError=null;
  releaseCatalogLoading=(async()=>{
    try {
      const result=await api('/cpp-releases.json');
      if(result.schemaVersion!==1||!Array.isArray(result.releases)||result.releases.some(release=>!/^cpp(?:98|03|11|14|17|20|23|26)$/.test(release.id)||!Array.isArray(release.features)||release.features.some(feature=>!Array.isArray(feature.tags))))throw new Error('Invalid release reference.');
      state.releaseCatalog=result;
    }catch(error){state.releaseCatalogError=error.message;}
    if(state.view==='timeline')render();
  })();
  try{return await releaseCatalogLoading;}finally{releaseCatalogLoading=null;}
}
function jumpToRelease(id,reveal=false){
  const track=$('#release-track'),column=$('#release-'+id);if(!track||!column)return;
  state.timelineReleaseId=id;
  const behavior=window.matchMedia?.('(prefers-reduced-motion: reduce)').matches?'auto':'smooth';
  track.scrollTo({left:column.offsetLeft,behavior});
  document.querySelectorAll('[data-portal-release]').forEach(portal=>portal.setAttribute('aria-current',portal.dataset.portalRelease===id?'step':'false'));
  if(reveal)track.scrollIntoView?.({block:'start',behavior});
  column.focus({preventScroll:true});
}
async function openReleaseColumn(id){
  if(!spiralReleaseIds.includes(id))return;
  state.timelineMode='releases';state.timelineReleaseId=id;changeView('timeline');
  const navigation=releaseNavigationToken;
  if(!state.releaseCatalog)await loadReleaseCatalog();
  if(state.view==='timeline'&&navigation===releaseNavigationToken&&state.timelineReleaseId===id)jumpToRelease(id,true);
}

function bindGraph(){
  const svg=$('.interactive-graph');if(!svg)return;graphTransform={x:0,y:0,scale:1};let drag=null;
  svg.addEventListener('pointerdown',event=>{if(event.target.closest('[data-graph-id]'))return;drag={x:event.clientX,y:event.clientY,px:graphTransform.x,py:graphTransform.y};svg.setPointerCapture(event.pointerId);});
  svg.addEventListener('pointermove',event=>{if(!drag)return;const rect=svg.getBoundingClientRect();graphTransform.x=drag.px+(event.clientX-drag.x)*graphSize.w/rect.width;graphTransform.y=drag.py+(event.clientY-drag.y)*graphSize.h/rect.height;updateGraphTransform();});
  svg.addEventListener('pointerup',()=>{drag=null;});svg.addEventListener('pointercancel',()=>{drag=null;});
}
function updateGraphTransform(){const group=$('.interactive-graph .graph-content');if(group)group.setAttribute('transform',`translate(${graphTransform.x},${graphTransform.y}) translate(${graphSize.w/2},${graphSize.h/2}) scale(${graphTransform.scale}) translate(${-graphSize.w/2},${-graphSize.h/2})`);}
function usePersonalTopicNames(){const tags=allTags();state.tags=[...new Set(state.tags.map(tag=>tags.find(personal=>personal.toLocaleLowerCase()===tag.toLocaleLowerCase())||tag))];}
function changeView(view){if(view==='boards')view='atlas';if(!['library','graph','timeline','atlas'].includes(view))return;releaseNavigationToken++;if(state.view==='timeline'&&state.timelineMode==='releases'&&view!=='timeline')usePersonalTopicNames();state.view=view;document.body.classList.remove('sidebar-open');render();}
function selectShard(id){if(!byId(id))return;state.selectedId=id;if(state.view!=='graph'){state.view='library';if(!filteredShards().some(s=>s.id===id))clearFilters();}render();}
function toggleTag(tag){const releaseMode=state.view==='timeline'&&state.timelineMode==='releases',matches=t=>releaseMode?t.toLocaleLowerCase()===tag.toLocaleLowerCase():t===tag;state.tags=state.tags.some(matches)?state.tags.filter(t=>!matches(t)):[...state.tags,tag];render();}

function draftForm(kind){return $(kind==='editor'?'#editor-form':'#link-form');}
function dirtyKind(kind){const form=draftForm(kind);return $(kind==='editor'?'#editor-dialog':'#link-dialog').open&&form.dataset.baseline!==formSnapshot(form);}
const editorDirty=()=>dirtyKind('editor');
const linkDirty=()=>dirtyKind('connection');
function writeLocalDrafts(){try{localStorage.setItem(localDraftKey,JSON.stringify(drafts));}catch{toast('Draft recovery storage is full. Save your note before closing.');}}
function snapshotDraft(kind){const form=draftForm(kind);return {editingId:kind==='editor'?editingId:null,linkingId:kind==='connection'?linkingId:null,editingLinkId:kind==='connection'?editingLinkId:null,values:formValues(form),baseline:form.dataset.baseline,updatedAt:new Date().toISOString()};}
function renderDraftShelf(){
  const entries=draftKinds.filter(kind=>drafts[kind]),shelf=$('#draft-shelf');shelf.hidden=!entries.length&&!boardRecovery.size;
  shelf.innerHTML=entries.map(kind=>`<div class="draft-notice"><span>Unfinished ${kind==='editor'?'shard':'connection'}${kind==='editor'&&drafts[kind].values.title?': '+esc(drafts[kind].values.title):''}</span><button class="text-button" data-action="restore-draft" data-id="${kind}">Restore draft</button><button class="text-button" data-action="discard-draft" data-id="${kind}">Discard</button></div>`).join('')+[...boardRecovery.values()].map(board=>`<div class="draft-notice"><span>Unfinished canvas arrangement: ${esc(board.title)}</span>${state.data.boards?.some(b=>b.id===board.id)?`<button class="text-button" data-action="restore-board-draft" data-id="${esc(board.id)}">Restore arrangement</button>`:'<small>Original canvas unavailable; recover it from a snapshot.</small>'}<button class="text-button" data-action="discard-board-draft" data-id="${esc(board.id)}">Discard</button></div>`).join('');
}
function draftStatus(kind,message){const el=$(kind==='editor'?'#editor-draft-status':'#link-draft-status');if(el)el.textContent=message;}
async function persistDraft(kind){
  clearTimeout(draftTimers[kind]);if(!dirtyKind(kind))return true;
  const draft=snapshotDraft(kind);drafts[kind]=draft;writeLocalDrafts();renderDraftShelf();draftStatus(kind,'Saving a recoverable draft…');
  try{await writeRequest('/api/drafts/'+kind,'PUT',{draft});persistedDrafts[kind]=JSON.stringify(draft.values);if(dirtyKind(kind)&&formSnapshot(draftForm(kind))===persistedDrafts[kind])draftStatus(kind,'Draft saved on this Mac.');return true;}
  catch(error){draftStatus(kind,'Draft kept in this window. Save your note before quitting.');toast('Draft recovery could not be saved: '+error.message);return false;}
}
function scheduleDraft(kind){
  clearTimeout(draftTimers[kind]);if(dirtyKind(kind)){drafts[kind]=snapshotDraft(kind);writeLocalDrafts();draftStatus(kind,'Changes kept as a draft…');draftTimers[kind]=setTimeout(()=>persistDraft(kind),450);}else{draftStatus(kind,'No unsaved changes.');if(drafts[kind])deleteDraft(kind).catch(error=>toast('The earlier draft could not be cleared: '+error.message));}
}
async function deleteDraft(kind){clearTimeout(draftTimers[kind]);const previous=drafts[kind];await writeRequest('/api/drafts/'+kind,'DELETE',{});if(drafts[kind]===previous)drafts[kind]=null;persistedDrafts[kind]=null;writeLocalDrafts();renderDraftShelf();}
function openEditor(id=null,recovered=null){
  if(!recovered&&drafts.editor){toast('Restore or discard your unfinished shard first.');renderDraftShelf();return;}
  editingId=recovered?.editingId??id;if(editingId&&!byId(editingId))editingId=null;
  const s=byId(editingId),form=$('#editor-form');form.reset();editorOcr=null;previewOpen=false;$('#editor-preview').hidden=true;$('#preview-toggle').textContent='Show preview';$('#wiki-suggestions').hidden=true;
  $('#editor-heading').textContent=s?'Refine this idea':'A new shard';$('#editor-eyebrow').textContent=s?'KEEP YOUR THINKING CURRENT':'CAPTURE AN IDEA';
  const selectedKind=recovered?.values.kind||s?.kind||'concept';form.elements.kind.innerHTML=Object.entries(kinds).filter(([key])=>key!=='event'||selectedKind==='event').map(([key,label])=>`<option value="${key}" ${key===selectedKind?'selected':''}>${label}</option>`).join('');
  for(const key of editorFields){if(recovered&&key in recovered.values)form.elements[key].value=recovered.values[key];else if(s)form.elements[key].value=['tags','entities'].includes(key)?(s[key]||[]).join(', '):['sources','facts'].includes(key)?JSON.stringify(s[key]||[]):key==='inbox'?String(!!s.inbox):(s[key]||'');}
  renderStructuredEditor('sources');renderImageRecognition();form.dataset.baseline=recovered?.baseline||formSnapshot(form);$('#editor-error').hidden=true;$('#editor-dialog').showModal();draftStatus('editor',recovered?'Recovered draft. Save when ready.':'One idea is enough. You can refine it later.');setTimeout(()=>$('#shard-title').focus(),0);
}
function renderLinkTargets(query='',selectedId=null){
  const select=$('#link-target'),previous=selectedId||select.value,words=query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
  const candidates=state.data.shards.filter(s=>s.id!==linkingId&&words.every(w=>(s.title+' '+s.tags.join(' ')).toLocaleLowerCase().includes(w))).sort((a,b)=>a.title.localeCompare(b.title));
  select.innerHTML=candidates.map(s=>`<option value="${esc(s.id)}" ${s.id===previous?'selected':''}>${esc(s.title)}</option>`).join('');if(!candidates.length)select.innerHTML='<option value="">No matching ideas</option>';
}
function openLink(id,linkId=null,recovered=null){
  if(!recovered&&drafts.connection){toast('Restore or discard your unfinished connection first.');renderDraftShelf();return;}
  const link=state.data.links.find(l=>l.id===linkId);linkingId=recovered?.linkingId||link?.fromId||id;editingLinkId=recovered?.editingLinkId||linkId;
  const s=byId(linkingId);if(!s){toast('The original shard is unavailable. You can discard the saved connection draft.');return;}
  if(state.data.shards.length<2){toast('Add another shard first, then connect your ideas.');return;}
  if(editingLinkId&&!state.data.links.some(l=>l.id===editingLinkId))editingLinkId=null;
  const form=$('#link-form');form.reset();$('#link-search').value='';$('#link-origin').textContent=s.title;$('#link-heading').textContent=editingLinkId?'Refine this relationship':'How do these ideas relate?';$('#save-link').textContent=editingLinkId?'Save relationship':'Connect ideas';
  const values=recovered?.values||link,choices=[...coreRelations];if(values?.type&&relations[values.type]&&!choices.includes(values.type))choices.push(values.type);form.elements.type.innerHTML=choices.map(key=>`<option value="${key}">${esc(relations[key].replace(/^./,letter=>letter.toUpperCase()))}</option>`).join('');renderLinkTargets('',values?.toId);for(const key of ['type','toId','note'])if(values&&key in values)form.elements[key].value=values[key];
  form.dataset.baseline=recovered?.baseline||formSnapshot(form);$('#link-error').hidden=true;$('#link-dialog').showModal();draftStatus('connection',recovered?'Recovered draft. Save when ready.':'Changes are kept as a recoverable draft.');
}
function restoreDraft(kind){const draft=drafts[kind];if(!draft)return;if(document.querySelector('dialog[open]')){toast('Close the current dialog first.');return;}if(kind==='editor')openEditor(null,draft);else openLink(null,null,draft);}
function extraFormDirty(){return ['board','board-item','section'].some(name=>$('#'+name+'-dialog').open&&$('#'+name+'-form').dataset.baseline!==formSnapshot($('#'+name+'-form')));}
function closeDialog(id){
  if(busy){toast('Saving your change…');return;}
  if(['board-dialog','board-item-dialog','section-dialog'].includes(id)){const form=$('#'+id.replace('-dialog','-form'));if(form.dataset.baseline!==formSnapshot(form)){confirmAction('Discard these unfinished changes?','The last saved canvas arrangement stays intact. You can continue editing by cancelling.','Discard changes',()=>{$('#'+id).close();},true);return;}}
  const kind=id==='editor-dialog'?'editor':id==='link-dialog'?'connection':null;
  if(kind&&dirtyKind(kind)){pendingClose={id,kind};$('#draft-close-dialog').showModal();return;}
  $('#'+id).close();if(kind){clearTimeout(draftTimers[kind]);renderDraftShelf();}
}
function confirmAction(title,message,label,task,danger=false){$('#confirm-title').textContent=title;$('#confirm-message').textContent=message;$('#confirm-action').textContent=label;$('#confirm-action').className=danger?'danger':'primary';confirmTask=task;$('#confirm-dialog').showModal();}
function confirmDelete(s){if(!s)return;confirmAction('Move this shard to trash?',`“${s.title}” will leave your atlas. You can recover the shard and its available connections from Recently deleted. A database backup is also made.`, 'Move to trash',async()=>{await mutate('/api/shards/'+encodeURIComponent(s.id),'DELETE');toast('Shard moved to trash.');},true);}
function openTagRename(){const tags=allTags();if(!tags.length){toast('Add a topic to a shard first.');return;}$('#tag-form').reset();$('#rename-from').innerHTML=tags.map(t=>`<option value="${esc(t)}">${esc(t)}</option>`).join('');if(state.tags.length)$('#rename-from').value=state.tags[0];$('#tag-error').hidden=true;$('#tag-dialog').showModal();}
async function showHistory(id){
  historyShardId=id;$('#history-title').textContent=byId(id)?.title||'Saved versions';$('#history-content').innerHTML='<p class="muted">Opening saved versions…</p>';$('#history-dialog').showModal();
  try{const result=await api('/api/shards/'+encodeURIComponent(id)+'/revisions');historyRecords=result.revisions||[];$('#history-content').innerHTML=historyRecords.length?historyRecords.map(r=>`<details class="revision-card"><summary><span>${dateTimeLabel(r.createdAt)}<small>${esc(r.reason||'Saved version')} · ${esc(r.snapshot?.title)}</small></span><span class="revision-expand">Preview</span></summary><div class="revision-body"><div class="markdown">${markdown(r.snapshot?.content)}</div><div class="revision-meta">${(r.snapshot?.tags||[]).map(t=>`<span class="tag">${esc(t)}</span>`).join('')}<span>${esc(statuses[r.snapshot?.status]||'')}</span></div><button class="secondary" data-action="restore-revision" data-id="${esc(r.id)}">Restore this version</button></div></details>`).join(''):'<div class="empty-state"><h3>No earlier versions yet</h3><p>A saved version is kept whenever you change this shard.</p></div>';}catch(error){$('#history-content').innerHTML='<p class="form-error">'+esc(error.message)+'</p>';}
}
async function showRecovery(mode){
  recoveryMode=mode;$('#settings-dialog').close();$('#recovery-title').textContent=mode==='trash'?'Recently deleted':'Saved snapshots';$('#recovery-content').innerHTML='<p class="muted">Opening your saved items…</p>';if(!$('#recovery-dialog').open)$('#recovery-dialog').showModal();
  try{const result=await api(mode==='trash'?'/api/trash':'/api/backups');recoveryRecords=result[mode==='trash'?'trash':'backups']||[];
    $('#recovery-content').innerHTML=(mode==='backups'?'<p class="dialog-intro">Restoring a snapshot replaces the current atlas. A fresh snapshot of the current atlas is made first, so you have a way back.</p>':'')+(recoveryRecords.length?recoveryRecords.map(item=>mode==='trash'?`<div class="recovery-card"><div><h3>${esc(item.shard?.title)}</h3><p>Deleted ${dateTimeLabel(item.deletedAt)} · ${(item.links||[]).length} saved connections</p><p>${esc(excerpt(item.shard?.content).slice(0,130))}</p></div><button class="secondary" data-action="restore-trash" data-id="${esc(item.id)}">Restore shard</button></div>`:`<div class="recovery-card"><div><h3>${esc(item.filename)}</h3><p>${dateTimeLabel(item.createdAt)} · ${Math.ceil(item.size/1024)} KB${Number.isFinite(item.shardCount)?' · '+item.shardCount+' shards':''}</p>${item.valid===false?`<p class="form-error">${esc(item.error||'This snapshot cannot be restored.')}</p>`:''}</div><button class="secondary" data-action="restore-backup" data-id="${esc(item.filename)}" ${item.valid===false?'disabled':''}>Restore snapshot</button></div>`).join(''):`<div class="empty-state"><h3>${mode==='trash'?'Nothing in the trash':'No saved snapshots yet'}</h3><p>${mode==='trash'?'Deleted shards will appear here.':'Use Back up now to save the current atlas.'}</p></div>`);
  }catch(error){$('#recovery-content').innerHTML='<p class="form-error">'+esc(error.message)+'</p>';}
}
function showWikiSuggestions(){
  const field=$('#shard-content'),before=field.value.slice(0,field.selectionStart),match=before.match(/\[\[([^\]\n]{0,100})$/),box=$('#wiki-suggestions');
  if(!match||match[1].startsWith('id:')){box.hidden=true;return;}
  const query=match[1].toLocaleLowerCase(),found=state.data.shards.filter(s=>s.id!==editingId&&s.title.toLocaleLowerCase().includes(query)).slice(0,6);box.hidden=!found.length;box.innerHTML='<span class="eyebrow">LINK TO AN EXISTING SHARD</span>'+found.map(s=>`<button type="button" class="wiki-suggestion" data-action="insert-wiki" data-id="${esc(s.id)}">${esc(s.title)}<small>${esc(s.tags.slice(0,2).join(' · '))}</small></button>`).join('');
}
function insertWiki(id){const s=byId(id),field=$('#shard-content');if(!s)return;const before=field.value.slice(0,field.selectionStart),match=before.match(/\[\[([^\]\n]{0,100})$/);if(!match)return;let end=field.selectionEnd;if(field.value.slice(end,end+2)===']]')end+=2;field.setRangeText(`[[id:${s.id}|${s.title.replace(/\]/g,'')}]]`,match.index,end,'end');$('#wiki-suggestions').hidden=true;field.focus();scheduleDraft('editor');refreshPreview();}
function refreshPreview(){updateImageRecognitionButton();if(previewOpen)$('#editor-preview').innerHTML=markdown($('#shard-content').value);}
async function loadAiInstructions(){
  if(aiInstructions)return aiInstructions;if(aiInstructionsLoading)return aiInstructionsLoading;
  $('#ai-instructions-status').textContent='Opening instructions…';
  aiInstructionsLoading=(async()=>{const response=await fetch('/ai-instructions.md',{cache:'no-store'});if(!response.ok)throw new Error('The instructions could not be opened. Close this window and try again.');const text=await response.text();if(!text.trim())throw new Error('The instructions are empty. Reopen Shard Atlas and try again.');aiInstructions=text;$('#ai-instructions-text').value=text;$('#ai-instructions-status').textContent='Ready to copy. Your atlas stays on this Mac.';return text;})();
  try{return await aiInstructionsLoading;}catch(error){$('#ai-instructions-status').textContent=error.message;throw error;}finally{aiInstructionsLoading=null;}
}
async function openAiHelp(){
  if($('#help-dialog').open)$('#help-dialog').close();document.body.classList.remove('sidebar-open');if(!$('#ai-dialog').open)$('#ai-dialog').showModal();
  try{await loadAiInstructions();}catch{}
}
async function selectAiInstructions(){await loadAiInstructions();$('#ai-instructions-panel').open=true;$('#ai-instructions-text').focus();$('#ai-instructions-text').select();}
async function copyAiInstructions(){
  const button=$('#copy-ai-instructions');button.disabled=true;
  try{const text=await loadAiInstructions(),native=window.webkit?.messageHandlers?.nativeClipboard;try{if(native)native.postMessage({text});else await navigator.clipboard.writeText(text);$('#ai-instructions-status').textContent='Instructions copied. Paste them into your other chat.';toast('AI instructions copied.');}catch{await selectAiInstructions();$('#ai-instructions-status').textContent='Automatic copying is unavailable. The instructions are selected below; press ⌘ C or Ctrl C to copy them.';}}
  finally{button.disabled=false;}
}
function imageIdsInEditor(){return [...$('#shard-content').value.matchAll(/!\[[^\]]*\]\(\/assets\/([A-Za-z0-9_.:-]+)\)/g)].map(m=>m[1]);}
function updateImageRecognitionButton(){$('#recognize-image').hidden=!imageIdsInEditor().length;}
function renderImageRecognition(){const pane=$('#image-recognition');updateImageRecognitionButton();pane.hidden=!editorOcr;if(!editorOcr)return;pane.innerHTML=editorOcr.loading?'<p class="muted">Reading text from your image on this Mac…</p>':editorOcr.text?`<div class="recognition-heading"><h3>Text recognized from your image</h3><span>Review before using</span></div><p class="field-hint">Your original image and explanation are preserved. Check code, symbols, and layout before adding this text.</p><label class="field">Recognized text<textarea id="recognized-text" rows="7">${esc(editorOcr.text)}</textarea></label><div class="recognition-actions"><button type="button" class="secondary" data-action="append-recognized-text">Append edited text to note</button><button type="button" class="text-button" data-action="dismiss-recognition">Dismiss</button></div>`:`<p class="muted">${esc(editorOcr.message||'No readable text was found. The original image is retained.')}</p>`;}
async function recognizeImage(id){editorOcr={loading:true};renderImageRecognition();try{const result=await api('/api/assets/'+encodeURIComponent(id)+'/text','POST',{});if(!result.available){editorOcr={message:'Text recognition is unavailable on this device. The original image is retained; you can add its text manually.'};}else if(!result.text?.trim()){editorOcr={message:'No readable text was found. The original image is retained.'};}else{editorOcr={text:result.text,method:result.method};}renderImageRecognition();}catch(error){editorOcr={message:'The image was saved, but text recognition could not finish: '+error.message};renderImageRecognition();}}
function insertContent(text){const field=$('#shard-content');field.setRangeText(text,field.selectionStart,field.selectionEnd,'end');field.focus();scheduleDraft('editor');refreshPreview();}
async function uploadImage(file){
  if(!file)return;if(!['image/png','image/jpeg','image/gif','image/webp'].includes(file.type))throw new Error('Choose a PNG, JPEG, GIF, or WebP image.');if(file.size>8*1024*1024)throw new Error('Choose an image smaller than 8 MB.');
  await withBusy(async()=>{
    const data=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]);reader.onerror=()=>reject(new Error('This image could not be read.'));reader.readAsDataURL(file);});
    const result=await writeRequest('/api/assets','POST',{name:file.name||'Pasted image',mimeType:file.type,data});if(!/^\/assets\/[A-Za-z0-9_.:-]+$/.test(result.url))throw new Error('The image address is invalid.');insertContent('\n\n!['+(file.name||'Pasted image').replace(/[\[\]\n]/g,'')+']('+result.url+')\n');await recognizeImage(result.id||result.url.split('/').at(-1));
  });$('#shard-content').focus();toast('Image added to your explanation.');
}
async function runAction(action,button){
  if(action.startsWith('atlas-')&&atlasAction(action,button))return;
  const id=button?.dataset.id;
  if(await legacyBoardAction(action,button))return;
  if(action==='new')openEditor();else if(action==='edit')openEditor(id);else if(action==='link')openLink(id);else if(action==='edit-link')openLink(null,id);else if(action==='delete')confirmDelete(byId(id));
  else if(action==='unlink')confirmAction('Remove this connection?','The two shards stay in your atlas. Their relationship and explanation will be removed.','Remove connection',async()=>{await mutate('/api/links/'+encodeURIComponent(id),'DELETE');toast('Connection removed.');},true);
  else if(action==='reload-releases'){await loadReleaseCatalog();if(state.view==='timeline')jumpToRelease(state.timelineReleaseId,true);}
  else if(action==='reload-spiral'){await loadSpiralCatalog();}
  else if(action==='timeline-theme')setTimelineTheme(button.dataset.theme);
  else if(action==='use-ai')await openAiHelp();else if(action==='copy-ai-instructions')await copyAiInstructions();else if(action==='select-ai-instructions')await selectAiInstructions();
  else if(action==='refresh-ai-notes'){const refreshButton=$('#refresh-ai-notes');refreshButton.disabled=true;$('#ai-refresh-status').textContent='Checking your notes…';try{const result=await refreshAtlas(true);$('#ai-refresh-status').textContent=result.skipped?'Finish editing, then try again.':result.changed?'Your latest notes are now in the atlas.':'Your notes are up to date.';}catch(error){$('#ai-refresh-status').textContent=error.message;}finally{refreshButton.disabled=false;}}
  else if(action==='jump-release')jumpToRelease(id);
  else if(action==='open-release')await openReleaseColumn(id);
  else if(action==='clear-topic-search')clearTopicSearch();else if(action==='clear-filters'){clearFilters();render();}else if(action==='settings')$('#settings-dialog').showModal();else if(action==='help')$('#help-dialog').showModal();else if(action==='read-selected'){state.view='library';selectShard(state.selectedId);}
  else if(action==='zoom-in'||action==='zoom-out'){graphTransform.scale=Math.max(.4,Math.min(3,graphTransform.scale*(action==='zoom-in'?1.2:1/1.2)));updateGraphTransform();}else if(action==='reset-graph'){graphTransform={x:0,y:0,scale:1};updateGraphTransform();}
  else if(action==='backup')await withBusy(async()=>{const result=await writeRequest('/api/backup','POST',{});toast('Backup saved: '+result.filename);});
  else if(action==='import'||action==='import-ai'){if(action==='import-ai')$('#ai-dialog').close();pendingFilePickerType='json';$('#import-file').click();}else if(action==='upload-image'){pendingFilePickerType='image';$('#image-file').click();}
  else if(action==='toggle-preview'){previewOpen=!previewOpen;$('#editor-preview').hidden=!previewOpen;$('#preview-toggle').textContent=previewOpen?'Hide preview':'Show preview';refreshPreview();}
  else if(action==='insert-wiki')insertWiki(id);else if(action==='rename-tag')openTagRename();else if(action==='history')await showHistory(id);else if(action==='trash'||action==='backups')await showRecovery(action);
  else if(action==='restore-revision'){const revision=historyRecords.find(r=>r.id===id);if(!revision)return;confirmAction('Restore this saved version?',`Your current explanation is saved in history before restoring the version from ${dateTimeLabel(revision.createdAt)}.`,'Restore version',async()=>{await mutate('/api/shards/'+encodeURIComponent(historyShardId)+'/restore','POST',{revisionId:id});$('#history-dialog').close();toast('Saved version restored.');});}
  else if(action==='restore-trash')await withBusy(async()=>{await mutate('/api/trash/'+encodeURIComponent(id)+'/restore','POST',{});await showRecovery('trash');toast('Shard restored to your atlas.');});
  else if(action==='restore-backup')confirmAction('Restore this atlas snapshot?',`The current atlas will be replaced with “${id}”. A snapshot of the current atlas is saved first.`,'Restore snapshot',async()=>{await mutate('/api/backups/restore','POST',{filename:id});clearFilters();$('#recovery-dialog').close();await loadDrafts();render();toast('Atlas snapshot restored.');});
  else if(action==='restore-draft')restoreDraft(id);
  else if(action==='discard-draft')confirmAction('Discard this unfinished draft?','Your saved notes and connections stay intact. Only the unfinished changes are removed.','Discard draft',async()=>{await deleteDraft(id);toast('Draft discarded.');},true);
  else if(action==='close-keep'||action==='close-discard'){
    if(!pendingClose)return;const closing=pendingClose;
    await withBusy(async()=>{if(action==='close-keep'){if(!await persistDraft(closing.kind))throw new Error('Keep editing until the draft can be saved, or choose Discard draft.');}else await deleteDraft(closing.kind);$('#draft-close-dialog').close();$('#'+closing.id).close();pendingClose=null;renderDraftShelf();});
  }else if(action==='copy-code'){const code=button.closest('.code-block').querySelector('code').textContent,native=window.webkit?.messageHandlers?.nativeClipboard;if(native)native.postMessage({text:code});else await navigator.clipboard.writeText(code);toast('Code copied.');}
}

const safeUrl=url=>/^https?:\/\//i.test(String(url||''))?String(url):'';
const sourceAnchor=(url,label='Source')=>safeUrl(url)?`<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(label)} ↗</a>`:'<span class="muted">Source not recorded</span>';
function renderSources(s){
  const sources=s.sources||[];
  if(!sources.length)return '';
  return `<section class="note-sources"><h3>Supporting sources</h3><div class="source-list">${sources.map((source,i)=>`<div class="source-record"><span class="source-number">${i+1}</span><div>${sourceAnchor(source.url,source.title||'Supporting source')}${source.publishedDate||source.accessedDate?`<small>${source.publishedDate?'Published '+dateLabel(source.publishedDate):''}${source.publishedDate&&source.accessedDate?' · ':''}${source.accessedDate?'Saved '+dateLabel(source.accessedDate):''}</small>`:''}${source.note?`<p>${esc(source.note)}</p>`:''}</div></div>`).join('')}</div></section>`;
}
function readStructured(kind){try{const value=JSON.parse($('#editor-form').elements[kind].value||'[]');return Array.isArray(value)?value:[];}catch{return [];}}
function renderStructuredEditor(kind){
  const fields=[['url','Source URL'],['title','Source title'],['publishedDate','Published date'],['accessedDate','Saved date'],['note','How does this source help?']];
  $('#source-editor').innerHTML=readStructured(kind).map((row,index)=>`<div class="structured-row" data-structured-row="${index}"><div class="structured-row-heading"><span>Source ${index+1}</span><button type="button" class="icon-button" data-action="remove-${kind}" data-index="${index}" aria-label="Remove source ${index+1}">×</button></div><div class="structured-fields">${fields.map(([key,label])=>`<label class="field">${label}<input data-structured="${kind}" data-row="${index}" data-key="${key}" value="${esc(row[key]||'')}" ${['url','sourceUrl'].includes(key)?'type="url"':'type="text"'} placeholder="${key.toLowerCase().includes('date')||key==='asOf'?'YYYY, YYYY-MM, or YYYY-MM-DD':''}"></label>`).join('')}</div></div>`).join('');
}
function syncStructuredEditor(kind){const rows=readStructured(kind);document.querySelectorAll(`[data-structured="${kind}"]`).forEach(el=>{if(rows[Number(el.dataset.row)])rows[Number(el.dataset.row)][el.dataset.key]=el.value;});$('#editor-form').elements[kind].value=JSON.stringify(rows);}
async function previewImport(data,name='Archive'){const preview=await api('/api/import/preview','POST',{data});importArchive=data;importPreview=preview;$('#settings-dialog').close();$('#import-preview-title').textContent=name;$('#confirm-import').disabled=preview.valid===false;const stats=preview.added||preview.counts||{};$('#import-preview-content').innerHTML=`<p class="dialog-intro">Review the content before it enters your atlas. Existing IDs are preserved; conflicting content is reported.</p><div class="import-counts">${Object.entries(stats).map(([key,value])=>`<div><strong>${esc(value)}</strong><span>${esc(key)}</span></div>`).join('')}</div>${preview.skipped?`<p class="muted">Skipped: ${esc(Object.entries(preview.skipped).map(([k,v])=>v+' '+k).join(', '))}</p>`:''}${['missing','duplicates','conflicts','warnings'].map(key=>(preview[key]||[]).length?`<details class="import-issues" open><summary>${esc(key)} · ${preview[key].length}</summary><ul>${preview[key].map(item=>`<li>${esc(typeof item==='string'?item:JSON.stringify(item))}</li>`).join('')}</ul></details>`:'').join('')}${preview.coverage?`<details class="import-coverage"><summary>Source coverage</summary><pre>${esc(typeof preview.coverage==='string'?preview.coverage:JSON.stringify(preview.coverage,null,2))}</pre></details>`:''}`;$('#import-preview-dialog').showModal();}
function renderUndoSummary(summary){if(!summary)return '';const removed=summary.removed||{},skipped=summary.skipped||[];return `<div class="import-undo-summary"><p><strong>Removed:</strong> ${esc(Object.entries(removed).map(([kind,count])=>count+' '+kind).join(', ')||'No records')}</p>${skipped.length?`<details open><summary>${skipped.length} records preserved</summary><ul>${skipped.map(item=>`<li><strong>${esc(item.kind)} · ${esc(byId(item.id)?.title||state.data.boards?.find(b=>b.id===item.id)?.title||item.id)}</strong><span>${esc(item.reason||'Retained to preserve your knowledge')}</span></li>`).join('')}</ul></details>`:'<p>No imported records needed to be preserved.</p>'}</div>`;}
async function showImports(){const result=await api('/api/imports');recoveryMode='imports';recoveryRecords=result.imports||[];$('#settings-dialog').close();$('#recovery-title').textContent='Import history';$('#recovery-content').innerHTML=recoveryRecords.map(receipt=>`<article class="import-receipt"><div><h3>${esc(receipt.title||receipt.sourceTitle||'Imported archive')}</h3><small>${dateTimeLabel(receipt.createdAt)} · ${esc(receipt.id)}</small></div><p>${esc(Object.entries(receipt.added||receipt.summary?.added||{}).map(([kind,count])=>count+' '+kind).join(', '))}</p>${receipt.undoneAt?'<span class="muted">Import undone</span>'+renderUndoSummary(receipt.undoSummary):`<button class="secondary" data-action="undo-import" data-id="${esc(receipt.id)}">Undo import</button>`}</article>`).join('')||'<p class="dialog-intro">Your future imports will appear here, with a receipt and an undo option.</p>';$('#recovery-dialog').showModal();}
const currentBoard=()=>state.data.boards?.find(b=>b.id===state.boardId)||state.data.boards?.[0]||null;
const numeric=(value,fallback=0)=>Number.isFinite(Number(value))?Number(value):fallback;
const boardViewport=board=>{board.viewport=board.viewport||{x:0,y:0,zoom:1};board.viewport.x=numeric(board.viewport.x);board.viewport.y=numeric(board.viewport.y);board.viewport.zoom=Math.max(.005,Math.min(10,numeric(board.viewport.zoom,1)));return board.viewport;};
function boardBounds(board,onlyMatches=false){const sections=board.sections||[],items=(board.items||[]).filter(item=>byId(item.shardId)&&(!onlyMatches||boardMatches(byId(item.shardId)))),all=[...sections.map(s=>({...s,height:s.collapsed?70:s.height})),...items.filter(item=>!sections.find(s=>s.id===item.sectionId)?.collapsed)];if(!all.length)return {x:0,y:0,width:900,height:600};const x=Math.min(...all.map(i=>numeric(i.x))),y=Math.min(...all.map(i=>numeric(i.y))),right=Math.max(...all.map(i=>numeric(i.x)+numeric(i.width,260))),bottom=Math.max(...all.map(i=>numeric(i.y)+numeric(i.height,190)));return {x:x-50,y:y-50,width:Math.max(300,right-x+100),height:Math.max(200,bottom-y+100)};}
function boardMatches(s){const words=state.query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean),text=[s.title,s.content,s.tags.join(' ')].join(' ').toLocaleLowerCase();return words.every(w=>text.includes(w))&&(!state.tags.length||state.tags.some(t=>s.tags.includes(t)));}
function boardMinimap(board){const bounds=boardBounds(board),sections=board.sections||[],vp=boardViewport(board);return `<svg id="board-minimap" viewBox="${bounds.x} ${bounds.y} ${bounds.width} ${bounds.height}" role="img" aria-label="Canvas overview, click to navigate">${sections.map(s=>`<rect x="${s.x}" y="${s.y}" width="${s.width}" height="${s.collapsed?70:s.height}" fill="#dfe9dc" stroke="#a8b7a1" stroke-width="${bounds.width/400}"/>`).join('')}${(board.items||[]).filter(i=>!sections.find(s=>s.id===i.sectionId)?.collapsed).map(i=>`<rect x="${i.x}" y="${i.y}" width="${i.width||260}" height="${i.height||190}" fill="${byId(i.shardId)&&boardMatches(byId(i.shardId))?'#60826a':'#c2c4bb'}"/>`).join('')}<rect id="minimap-viewport" x="${-vp.x/vp.zoom}" y="${-vp.y/vp.zoom}" width="900" height="600" fill="none" stroke="#ad7855" stroke-width="${Math.max(2,bounds.width/200)}"/></svg>`;}
function renderBoards(){
  const boards=state.data.boards||[],board=currentBoard();if(board)state.boardId=board.id;
  const heading=pageHeading('ARRANGE THE BIGGER PICTURE.','Connect your technical knowledge.','Arrange C++ facts and examples on an infinite canvas. Your cards share the same notes and relationships as your library.',`<button class="primary" data-action="new-board">＋ New canvas</button>`);
  if(!board)return heading+'<div class="empty-state board-empty"><span>▦</span><h2>Create a technical canvas.</h2><p>Map ownership and lifetimes, connect language features, or work through an algorithm. Add existing notes and group them into sections.</p><button class="secondary" data-action="new-board">Create a canvas</button></div>';
  const vp=boardViewport(board),sections=board.sections||[],headerIds=new Set(sections.map(section=>section.shardId).filter(Boolean)),missing=[...new Map([...(board.items||[]).filter(item=>!byId(item.shardId)),...sections.filter(section=>section.shardId&&!byId(section.shardId))].map(item=>[item.shardId,item])).values()],items=(board.items||[]).filter(item=>byId(item.shardId)&&!headerIds.has(item.shardId)),visible=items.filter(i=>!sections.find(s=>s.id===i.sectionId)?.collapsed),positions=new Map(visible.map(i=>[i.shardId,i]));for(const section of sections)if(section.shardId&&byId(section.shardId))positions.set(section.shardId,{x:section.x,y:section.y,width:section.width,height:70});const edges=state.data.links.filter(l=>positions.has(l.fromId)&&positions.has(l.toId));
  const bounds=boardBounds(board);return heading+`<div class="board-topline"><label class="board-picker">Canvas<select id="board-select" aria-label="Choose a saved canvas">${boards.map(b=>`<option value="${esc(b.id)}" ${b.id===board.id?'selected':''}>${esc(b.title)}</option>`).join('')}</select></label><span class="board-description">${esc(board.description||'A visual arrangement of your knowledge.')}</span><button class="icon-button" data-action="edit-board" aria-label="Edit canvas title and description">✎</button><button class="icon-button" data-action="delete-board" aria-label="Delete canvas">⌫</button></div>${missing.length?`<div class="board-missing-notes"><div><strong>${missing.length} saved canvas reference${missing.length===1?'':'s'} reference unavailable notes.</strong><p>Their positions remain saved. Restore the notes from Recently deleted or a snapshot to show them again.</p></div><button class="secondary" data-action="trash">Recently deleted</button></div>`:''}<div class="board-navigation"><label class="board-section-picker">Go to section<select id="board-section-jump" aria-label="Go to a canvas section"><option value="">Choose a section…</option>${[...sections].sort((a,b)=>a.y-b.y||a.x-b.x).map(section=>`<option value="${esc(section.id)}" ${state.boardSectionId===section.id?'selected':''}>${esc(section.title)}</option>`).join('')}</select></label><label class="board-search-label">Find on this canvas<input id="board-search" type="search" value="${esc(state.query)}" placeholder="Search notes or topics on this canvas" aria-label="Search notes on this canvas"></label><div class="board-result-jump"><span id="board-search-count">${items.filter(i=>boardMatches(byId(i.shardId))).length} of ${items.length} notes</span><button class="secondary" data-action="find-board-match" id="board-go-result" ${!state.query&&!state.tags.length?'disabled':''}>Go to first result →</button></div></div><div class="board-toolbar"><div><button class="secondary" data-action="add-board-item">＋ Add note</button><button class="secondary" data-action="add-section">＋ Section</button></div><div class="board-zoom-tools"><button class="icon-button" data-action="board-zoom-out" aria-label="Zoom out of canvas">−</button><span id="board-zoom-label">${Math.round(vp.zoom*100)}%</span><button class="icon-button" data-action="board-zoom-in" aria-label="Zoom into canvas">＋</button><button class="secondary" data-action="fit-board">Fit canvas</button></div></div><section id="board-surface" class="board-surface" tabindex="0" aria-label="${esc(board.title)} canvas. Drag cards or the background. Use zoom controls."><div id="board-world" class="board-world" style="transform:translate(${vp.x}px,${vp.y}px) scale(${vp.zoom})">${sections.map(section=>`<section class="board-section ${section.collapsed?'collapsed':''}" data-board-section="${esc(section.id)}" style="left:${section.x}px;top:${section.y}px;width:${section.width}px;height:${section.collapsed?70:section.height}px"><div class="board-section-heading"><span class="section-drag-handle" data-board-section-drag="${esc(section.id)}" tabindex="0" role="button" aria-label="Move section ${esc(section.title)}">⠿</span><div class="section-heading-content">${section.shardId&&byId(section.shardId)?`<button class="section-note-open" data-shard-id="${esc(section.shardId)}" aria-label="Read heading note ${esc(section.title)}"><strong>${esc(section.title)}</strong></button>`:`<strong>${esc(section.title)}</strong>`}<small>${items.filter(i=>i.sectionId===section.id).length} notes</small></div><button class="icon-button" data-action="edit-section" data-id="${esc(section.id)}" aria-label="Edit section">✎</button><button class="icon-button" data-action="toggle-section" data-id="${esc(section.id)}" aria-label="${section.collapsed?'Expand':'Collapse'} section">${section.collapsed?'＋':'−'}</button></div></section>`).join('')}<svg class="board-connections" width="${Math.max(bounds.width+Math.max(0,bounds.x),1200)}" height="${Math.max(bounds.height+Math.max(0,bounds.y),800)}" style="overflow:visible" aria-label="Typed connections on this canvas"><defs><marker id="board-arrow" markerWidth="7" markerHeight="7" refX="6" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6" fill="none" stroke="#7b9179"/></marker></defs>${edges.map(l=>{const a=positions.get(l.fromId),b=positions.get(l.toId),ax=a.x+(a.width||260)/2,ay=a.y+(a.height||190)/2,bx=b.x+(b.width||260)/2,by=b.y+(b.height||190)/2;return `<g><title>${esc(byId(l.fromId)?.title+' '+relations[l.type]+' '+byId(l.toId)?.title)}</title><line x1="${ax}" y1="${ay}" x2="${bx}" y2="${by}" marker-end="url(#board-arrow)"/>${edges.length<250?`<text x="${(ax+bx)/2}" y="${(ay+by)/2-8}" text-anchor="middle">${esc(relations[l.type])}</text>`:''}</g>`;}).join('')}</svg>${visible.map(item=>{const s=byId(item.shardId),image=s.content.match(/!\[[^\]]*\]\((\/assets\/[A-Za-z0-9_.:-]+)\)/)?.[1];return `<article class="board-card ${boardMatches(s)?'matches':'dimmed'}" data-board-card="${esc(item.shardId)}" style="left:${item.x}px;top:${item.y}px;width:${item.width||260}px;height:${item.height||190}px"><div class="board-card-heading"><span class="card-drag-handle" data-board-drag="${esc(item.shardId)}" tabindex="0" role="button" aria-label="Move ${esc(s.title)}">⠿ ${esc(kinds[s.kind]||'Note')}</span><button class="icon-button" data-action="edit-board-item" data-id="${esc(item.shardId)}" aria-label="Change card size or section">⋯</button></div><button class="board-card-open" data-shard-id="${esc(s.id)}"><h3>${esc(s.title)}</h3>${image?`<img src="${esc(image)}" alt="Image in ${esc(s.title)}" loading="lazy">`:`<p>${esc(excerpt(s.content).slice(0,280))}</p>`}<div>${s.tags.slice(0,3).map(t=>`<span class="tag">${esc(t)}</span>`).join('')}</div></button><span class="board-resize-handle" data-board-resize="${esc(item.shardId)}" role="button" tabindex="0" aria-label="Resize card ${esc(s.title)}">⌟</span></article>`;}).join('')}</div><div class="board-minimap">${boardMinimap(board)}<small>Click overview to navigate</small></div>${!items.length?'<div class="board-canvas-empty"><h2>Put an idea on the map.</h2><p>Add a note, then drag it into place.</p><button class="primary" data-action="add-board-item">＋ Add note</button></div>':''}</section><div class="board-bottom"><span>Drag background to pan · Drag card headers to arrange · Scroll to zoom · Arrow keys move focused cards</span><span>${visible.length} visible / ${items.length+missing.length} saved cards${missing.length?' · '+missing.length+' missing notes':''}${state.query?' · '+items.filter(i=>boardMatches(byId(i.shardId))).length+' search matches':''}</span></div>${board.sourceUrl?`<p class="board-source">${sourceAnchor(board.sourceUrl,'Original diagram')}</p>`:''}`;
}
const boardSaves=new Map(),boardRecovery=new Map();let boardDragActive=false;
function boardSnapshot(board){return JSON.stringify([board.title,board.description,board.sourceUrl,board.items,board.sections,board.viewport]);}
function updateBoardDirty(){boardDirty=boardDragActive||[...boardSaves.values()].some(record=>record.dirty);}
function writeBoardDrafts(){const pending=new Map(boardRecovery);for(const [id,record] of boardSaves)if(record.dirty)pending.set(id,record.board);try{localStorage.setItem(localDraftKey+':boards',JSON.stringify(Object.fromEntries(pending)));localStorage.removeItem?.(localDraftKey+':board');}catch{toast('Canvas draft storage is full. Keep the app open until the arrangement saves.');}}
function mergeBoardDrafts(data){if(!Array.isArray(data.boards))return data;for(const [id,record] of boardSaves){if(!record.dirty)continue;const index=data.boards.findIndex(board=>board.id===id);if(index>=0)data.boards[index]=record.board;}return data;}
function loadBoardRecovery(){try{const saved=JSON.parse(localStorage.getItem(localDraftKey+':boards')||'{}'),legacy=JSON.parse(localStorage.getItem(localDraftKey+':board')||'null');if(legacy?.id)saved[legacy.id]=legacy;for(const [id,board] of Object.entries(saved)){if(!board||board.id!==id||!Array.isArray(board.items)||!Array.isArray(board.sections))continue;const original=state.data.boards?.find(b=>b.id===id);if(!original||boardSnapshot(original)!==boardSnapshot(board))boardRecovery.set(id,board);}writeBoardDrafts();}catch{}}
function markBoardChanged(board){const index=state.data.boards?.findIndex(b=>b.id===board.id);if(index>=0)state.data.boards[index]=board;const record=boardSaves.get(board.id)||{version:0,timer:null,dirty:false,board};record.board=board;record.version++;record.dirty=true;clearTimeout(record.timer);record.timer=setTimeout(()=>saveBoard(record.board),220);boardSaves.set(board.id,record);updateBoardDirty();$('#save-status').textContent='Saving canvas…';writeBoardDrafts();}
async function saveBoard(board){const record=boardSaves.get(board.id)||{version:0,timer:null,dirty:true,board};boardSaves.set(board.id,record);clearTimeout(record.timer);record.timer=null;record.dirty=true;updateBoardDirty();const version=record.version,snapshot=JSON.parse(JSON.stringify(record.board)),visible=currentBoard();try{const result=await writeRequest('/api/boards/'+encodeURIComponent(board.id),'PUT',snapshot),saved=result.boards.find(b=>b.id===board.id);if(saved){Object.assign(record.board,{createdAt:saved.createdAt,updatedAt:saved.updatedAt});result.boards[result.boards.findIndex(b=>b.id===board.id)]=record.board;}if(boardSaves.get(board.id)===record&&version===record.version){record.dirty=false;boardSaves.delete(board.id);boardRecovery.delete(board.id);}if(visible&&visible.id!==board.id&&!boardSaves.get(visible.id)?.dirty){const index=result.boards.findIndex(b=>b.id===visible.id);if(index>=0)result.boards[index]=visible;}state.data=mergeBoardDrafts(result);updateBoardDirty();writeBoardDrafts();renderDraftShelf();$('#save-status').textContent=boardDirty?'Saving canvas…':'Canvas arrangement saved.';return true;}catch(error){record.dirty=true;updateBoardDirty();writeBoardDrafts();toast('Canvas changes are retained for recovery: '+error.message);$('#save-status').textContent='Canvas needs to be saved.';return false;}}
function updateBoardTransform(){const board=currentBoard(),world=$('#board-world'),surface=$('#board-surface');if(!board||!world)return;const vp=boardViewport(board);world.style.transform=`translate(${vp.x}px,${vp.y}px) scale(${vp.zoom})`;$('#board-zoom-label').textContent=Math.round(vp.zoom*100)+'%';const rect=$('#minimap-viewport');if(rect&&surface){rect.setAttribute('x',-vp.x/vp.zoom);rect.setAttribute('y',-vp.y/vp.zoom);rect.setAttribute('width',surface.clientWidth/vp.zoom);rect.setAttribute('height',surface.clientHeight/vp.zoom);}}
function sectionBoardBounds(board,section){const cards=(board.items||[]).filter(item=>item.sectionId===section.id&&byId(item.shardId)),shapes=[section,...cards],x=Math.min(...shapes.map(item=>numeric(item.x))),y=Math.min(...shapes.map(item=>numeric(item.y))),right=Math.max(...shapes.map(item=>numeric(item.x)+numeric(item.width,260))),bottom=Math.max(...shapes.map(item=>numeric(item.y)+numeric(item.height,190)));return {x,y,width:Math.max(1,right-x),height:Math.max(1,bottom-y)};}
function jumpToBoardSection(id){const board=currentBoard(),surface=$('#board-surface'),section=board?.sections.find(item=>item.id===id);if(!board||!surface||!section)return;section.collapsed=false;const bounds=sectionBoardBounds(board,section),width=surface.clientWidth||900,height=surface.clientHeight||600,vp=boardViewport(board),fit=Math.min(1.2,(width-64)/bounds.width,(height-64)/bounds.height);vp.zoom=Math.max(.25,fit);vp.x=bounds.width*vp.zoom<=width-64?(width-bounds.width*vp.zoom)/2-bounds.x*vp.zoom:32-section.x*vp.zoom;vp.y=bounds.height*vp.zoom<=height-64?(height-bounds.height*vp.zoom)/2-bounds.y*vp.zoom:32-section.y*vp.zoom;state.boardSectionId=id;markBoardChanged(board);render();}
function jumpToBoardItem(item){const board=currentBoard(),surface=$('#board-surface');if(!board||!surface||!item)return;const section=board.sections.find(s=>s.id===item.sectionId);if(section)section.collapsed=false;const width=surface.clientWidth||900,height=surface.clientHeight||600,vp=boardViewport(board),cardWidth=numeric(item.width,260),cardHeight=numeric(item.height,190);vp.zoom=Math.max(.25,Math.min(1.2,(width-80)/cardWidth,(height-100)/cardHeight));vp.x=cardWidth*vp.zoom<=width-80?(width-cardWidth*vp.zoom)/2-item.x*vp.zoom:40-item.x*vp.zoom;vp.y=cardHeight*vp.zoom<=height-100?(height-cardHeight*vp.zoom)/2-item.y*vp.zoom:45-item.y*vp.zoom;markBoardChanged(board);render();}
function updateBoardSearchMatches(){const board=currentBoard();if(!board)return;const known=(board.items||[]).filter(item=>byId(item.shardId)),matches=known.filter(item=>boardMatches(byId(item.shardId)));document.querySelectorAll('[data-board-card]').forEach(card=>{const shard=byId(card.dataset.boardCard),matched=!!shard&&boardMatches(shard);card.classList.toggle('matches',matched);card.classList.toggle('dimmed',!matched);});$('#board-search-count').textContent=matches.length+' of '+known.length+' notes';$('#board-go-result').disabled=(!state.query&&!state.tags.length)||!matches.length;}
function fitBoard(){const board=currentBoard(),surface=$('#board-surface');if(!board||!surface)return;const bounds=boardBounds(board,!!state.query),vp=boardViewport(board),w=surface.clientWidth||900,h=surface.clientHeight||600;vp.zoom=Math.max(.005,Math.min(1.5,(w-80)/bounds.width,(h-80)/bounds.height));vp.x=(w-bounds.width*vp.zoom)/2-bounds.x*vp.zoom;vp.y=(h-bounds.height*vp.zoom)/2-bounds.y*vp.zoom;updateBoardTransform();markBoardChanged(board);}
function zoomBoard(factor,clientX=null,clientY=null){const board=currentBoard(),surface=$('#board-surface');if(!board||!surface)return;const vp=boardViewport(board),rect=surface.getBoundingClientRect(),x=clientX===null?rect.width/2:clientX-rect.left,y=clientY===null?rect.height/2:clientY-rect.top,next=Math.max(.005,Math.min(10,vp.zoom*factor));vp.x=x-(x-vp.x)*next/vp.zoom;vp.y=y-(y-vp.y)*next/vp.zoom;vp.zoom=next;updateBoardTransform();markBoardChanged(board);}
function bindBoard(){const surface=$('#board-surface');if(!surface)return;const board=currentBoard();let drag=null;updateBoardTransform();$('#board-search')?.addEventListener('input',event=>{state.query=event.target.value;$('#search').value=state.query;updateBoardSearchMatches();});$('#board-search')?.addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();const item=board.items.find(item=>byId(item.shardId)&&boardMatches(byId(item.shardId)));if(item)jumpToBoardItem(item);else toast('No matching note on this canvas.');}});$('#board-section-jump')?.addEventListener('change',event=>{if(event.target.value)jumpToBoardSection(event.target.value);});
  surface.addEventListener('pointerdown',event=>{if(busy||event.button!==0)return;const card=event.target.closest('[data-board-drag]'),section=event.target.closest('[data-board-section-drag]'),resize=event.target.closest('[data-board-resize]');if(!card&&!section&&!resize&&event.target.closest('button,a,.board-minimap,.board-card,.board-section-heading'))return;const vp=boardViewport(board),item=card||resize?board.items.find(i=>i.shardId===(card||resize).dataset[card?'boardDrag':'boardResize']):section?board.sections.find(s=>s.id===section.dataset.boardSectionDrag):null;drag={type:resize?'resize':card?'card':section?'section':'pan',startX:event.clientX,startY:event.clientY,x:item?item.x:vp.x,y:item?item.y:vp.y,width:item?.width||260,height:item?.height||190,item,zoom:vp.zoom,moved:false,children:section?board.items.filter(i=>i.sectionId===item.id).map(i=>({item:i,x:i.x,y:i.y})):[]};boardDragActive=true;surface.setPointerCapture(event.pointerId);event.preventDefault();});
  surface.addEventListener('pointermove',event=>{if(!drag)return;const dx=(event.clientX-drag.startX)/(drag.type==='pan'?1:drag.zoom),dy=(event.clientY-drag.startY)/(drag.type==='pan'?1:drag.zoom);if(Math.abs(dx)+Math.abs(dy)<2)return;drag.moved=true;if(drag.type==='pan'){const vp=boardViewport(board);vp.x=drag.x+dx;vp.y=drag.y+dy;updateBoardTransform();}else if(drag.type==='resize'){drag.item.width=Math.max(120,drag.width+dx);drag.item.height=Math.max(90,drag.height+dy);const card=$(`[data-board-card="${drag.item.shardId}"]`);if(card){card.style.width=drag.item.width+'px';card.style.height=drag.item.height+'px';}}else{drag.item.x=Math.round(drag.x+dx);drag.item.y=Math.round(drag.y+dy);const el=$(drag.type==='card'?`[data-board-card="${drag.item.shardId}"]`:`[data-board-section="${drag.item.id}"]`);if(el){el.style.left=drag.item.x+'px';el.style.top=drag.item.y+'px';}for(const c of drag.children){c.item.x=Math.round(c.x+dx);c.item.y=Math.round(c.y+dy);const card=$(`[data-board-card="${c.item.shardId}"]`);if(card){card.style.left=c.item.x+'px';card.style.top=c.item.y+'px';}}}boardDirty=true;});
  const finish=()=>{boardDragActive=false;if(drag?.moved){markBoardChanged(board);if(drag.type!=='pan')render();}drag=null;updateBoardDirty();};surface.addEventListener('pointerup',finish);surface.addEventListener('pointercancel',finish);
  surface.addEventListener('wheel',event=>{event.preventDefault();if(event.ctrlKey||event.metaKey||Math.abs(event.deltaY)>Math.abs(event.deltaX)){zoomBoard(Math.exp(-event.deltaY*.002),event.clientX,event.clientY);}else{const vp=boardViewport(board);vp.x-=event.deltaX;vp.y-=event.deltaY;updateBoardTransform();markBoardChanged(board);}},{passive:false});
  surface.addEventListener('keydown',event=>{const key=event.key;if(!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(key))return;const target=event.target.closest('[data-board-drag],[data-board-section-drag],[data-board-resize]');if(!target)return;event.preventDefault();const dx=(key==='ArrowRight'?1:key==='ArrowLeft'?-1:0)*(event.shiftKey?50:10),dy=(key==='ArrowDown'?1:key==='ArrowUp'?-1:0)*(event.shiftKey?50:10);if(target.dataset.boardSectionDrag){const section=board.sections.find(s=>s.id===target.dataset.boardSectionDrag);section.x+=dx;section.y+=dy;for(const item of board.items.filter(i=>i.sectionId===section.id)){item.x+=dx;item.y+=dy;}}else{const item=board.items.find(i=>i.shardId===(target.dataset.boardDrag||target.dataset.boardResize));if(target.dataset.boardResize){item.width=Math.max(120,item.width+dx);item.height=Math.max(90,item.height+dy);}else{item.x+=dx;item.y+=dy;}}const attr=target.dataset.boardSectionDrag?'board-section-drag':target.dataset.boardResize?'board-resize':'board-drag',value=target.dataset.boardSectionDrag||target.dataset.boardResize||target.dataset.boardDrag;markBoardChanged(board);render();$(`[data-${attr}="${value}"]`)?.focus();});
  $('#board-minimap')?.addEventListener('click',event=>{const svg=event.currentTarget,rect=svg.getBoundingClientRect(),bounds=boardBounds(board),scale=Math.min(rect.width/bounds.width,rect.height/bounds.height),offsetX=(rect.width-bounds.width*scale)/2,offsetY=(rect.height-bounds.height*scale)/2,x=bounds.x+(event.clientX-rect.left-offsetX)/scale,y=bounds.y+(event.clientY-rect.top-offsetY)/scale,vp=boardViewport(board);vp.x=surface.clientWidth/2-x*vp.zoom;vp.y=surface.clientHeight/2-y*vp.zoom;updateBoardTransform();markBoardChanged(board);});
}
function openBoardEditor(id=null){const board=state.data.boards?.find(b=>b.id===id),form=$('#board-form');editingBoardId=board?.id||null;form.reset();for(const key of ['title','description','sourceUrl'])form.elements[key].value=board?.[key]||'';$('#board-form-heading').textContent=board?'Edit canvas':'Create a canvas';form.dataset.baseline=formSnapshot(form);$('#board-dialog').showModal();}
function boardItemOptions(query='',selectedId=null){const board=currentBoard();if(!board)return;const items=new Set((board.items||[]).map(i=>i.shardId)),words=query.toLowerCase().split(/\s+/).filter(Boolean),candidates=state.data.shards.filter(s=>(s.id===selectedId||!items.has(s.id))&&words.every(w=>[s.title,...s.tags].join(' ').toLowerCase().includes(w))).sort((a,b)=>a.title.localeCompare(b.title));$('#board-item-shard').innerHTML=candidates.map(s=>`<option value="${esc(s.id)}" ${s.id===selectedId?'selected':''}>${esc(s.title)}</option>`).join('')||'<option value="">No matching unused notes</option>';}
function openBoardItem(id=null){const board=currentBoard();if(!board)return;const item=board.items.find(i=>i.shardId===id),form=$('#board-item-form');editingBoardItemId=item?.shardId||null;form.reset();$('#board-item-search').value='';boardItemOptions('',id);$('#board-item-shard').disabled=!!item;$('#remove-board-item').hidden=!item;$('#board-item-heading').textContent=item?'Card size & section':'Add an idea to this canvas';$('#board-item-section').innerHTML='<option value="">No section</option>'+(board.sections||[]).map(s=>`<option value="${esc(s.id)}" ${s.id===item?.sectionId?'selected':''}>${esc(s.title)}</option>`).join('');form.elements.width.value=item?.width||260;form.elements.height.value=item?.height||190;form.dataset.baseline=formSnapshot(form);$('#board-item-dialog').showModal();}
function openSection(id=null){const board=currentBoard();if(!board)return;const section=board.sections.find(s=>s.id===id),form=$('#section-form');editingSectionId=section?.id||null;form.reset();for(const key of ['title','width','height'])if(section)form.elements[key].value=section[key];$('#section-heading').textContent=section?'Edit section':'Create a section';$('#remove-section').hidden=!section;form.dataset.baseline=formSnapshot(form);$('#section-dialog').showModal();}
$('#board-form').addEventListener('submit',async event=>{event.preventDefault();if(busy)return;const values=formValues(event.target),old=currentBoard();try{await withBusy(async()=>{const ids=new Set((state.data.boards||[]).map(b=>b.id)),data=editingBoardId?{...state.data.boards.find(b=>b.id===editingBoardId),...values}:{...values,items:[],sections:[],viewport:{x:40,y:40,zoom:1}},result=await writeRequest('/api/boards'+(editingBoardId?'/'+encodeURIComponent(editingBoardId):''),editingBoardId?'PUT':'POST',data);state.data=mergeBoardDrafts(result);state.boardId=editingBoardId||(result.boards||[]).find(b=>!ids.has(b.id))?.id||old?.id;state.view='boards';$('#board-dialog').close();render();toast('Canvas saved.');});}catch(error){toast(error.message);}});
$('#board-item-search').addEventListener('input',event=>boardItemOptions(event.target.value,editingBoardItemId));
for(const id of ['board-dialog','board-item-dialog','section-dialog'])$('#'+id).addEventListener('cancel',event=>{event.preventDefault();closeDialog(id);});
$('#board-item-form').addEventListener('submit',async event=>{event.preventDefault();if(busy)return;const board=currentBoard(),values=formValues(event.target),id=editingBoardItemId||values.shardId;if(!board||!byId(id))return;const section=board.sections.find(s=>s.id===values.sectionId),vp=boardViewport(board),existing=board.items.find(i=>i.shardId===id),item={shardId:id,x:section?section.x+25:-vp.x/vp.zoom+60,y:section?section.y+80:-vp.y/vp.zoom+70,...existing,width:Number(values.width),height:Number(values.height),sectionId:values.sectionId};if(existing)Object.assign(existing,item);else board.items.push(item);if(section)section.collapsed=false;editingBoardItemId=id;markBoardChanged(board);await withBusy(async()=>{if(!await saveBoard(board))return;$('#board-item-dialog').close();render();toast('Card arrangement saved.');});});
$('#section-form').addEventListener('submit',async event=>{event.preventDefault();if(busy)return;const board=currentBoard(),values=formValues(event.target);if(!board)return;const vp=boardViewport(board),existing=board.sections.find(s=>s.id===editingSectionId),section={id:editingSectionId||'section-'+Date.now().toString(36),x:-vp.x/vp.zoom+35,y:-vp.y/vp.zoom+35,collapsed:false,...existing,...values,width:Number(values.width),height:Number(values.height)};if(existing)Object.assign(existing,section);else board.sections.push(section);editingSectionId=section.id;markBoardChanged(board);await withBusy(async()=>{if(!await saveBoard(board))return;$('#section-dialog').close();render();toast('Section saved.');});});

async function legacyBoardAction(action,button){const id=button?.dataset.id,board=currentBoard();
  if(action==='restore-board-draft'){const saved=boardRecovery.get(id);if(saved&&state.data.boards?.some(b=>b.id===id))confirmAction('Restore this unfinished arrangement?','This replaces the current arrangement with the retained board draft. Its original board ID and notes are preserved.','Restore arrangement',async()=>{const recovered=JSON.parse(JSON.stringify(saved));state.boardId=id;state.view='boards';markBoardChanged(recovered);if(await saveBoard(recovered)){boardRecovery.delete(id);writeBoardDrafts();render();toast('Canvas arrangement recovered.');}});}
  else if(action==='discard-board-draft'){boardRecovery.delete(id);writeBoardDrafts();renderDraftShelf();}
  else if(action==='recognize-image'){const id=imageIdsInEditor().at(-1);if(id)await withBusy(()=>recognizeImage(id));}
  else if(action==='append-recognized-text'){const text=$('#recognized-text')?.value.trim();if(text){const field=$('#shard-content');field.selectionStart=field.selectionEnd=field.value.length;insertContent('\n\n## Text extracted from image\n\n'+text+'\n');editorOcr=null;renderImageRecognition();toast('Recognized text appended. Your image and explanation are preserved.');}}
  else if(action==='dismiss-recognition'){editorOcr=null;renderImageRecognition();}
  else if(action==='more-shards'){state.libraryLimit+=120;render();}
  else if(action==='add-source'){const kind='sources',rows=readStructured(kind);rows.push({url:'',title:'',publishedDate:'',accessedDate:'',note:''});$('#editor-form').elements[kind].value=JSON.stringify(rows);renderStructuredEditor(kind);scheduleDraft('editor');}
  else if(action==='remove-sources'){const kind=action.slice(7),rows=readStructured(kind);rows.splice(Number(button.dataset.index),1);$('#editor-form').elements[kind].value=JSON.stringify(rows);renderStructuredEditor(kind);scheduleDraft('editor');}
  else if(action==='new-board')openBoardEditor();
  else if(action==='edit-board')openBoardEditor(board?.id);
  else if(action==='delete-board'&&board)confirmAction('Delete this canvas?',`The arrangement “${board.title}” will be removed. Its notes stay in your library.`,'Delete canvas',async()=>{clearTimeout(boardSaves.get(board.id)?.timer);boardSaves.delete(board.id);boardRecovery.delete(board.id);writeBoardDrafts();await mutate('/api/boards/'+encodeURIComponent(board.id),'DELETE');updateBoardDirty();state.boardId=null;render();toast('Canvas removed. Its notes are preserved.');},true);
  else if(action==='add-board-item')openBoardItem();
  else if(action==='edit-board-item')openBoardItem(id);
  else if(action==='remove-board-item'&&board&&editingBoardItemId){board.items=board.items.filter(i=>i.shardId!==editingBoardItemId);markBoardChanged(board);if(!await saveBoard(board))return true;$('#board-item-dialog').close();render();toast('Card removed from the canvas. Its note is preserved.');}
  else if(action==='add-section')openSection();
  else if(action==='edit-section')openSection(id);
  else if(action==='remove-section'&&board&&editingSectionId){board.sections=board.sections.filter(s=>s.id!==editingSectionId);for(const item of board.items)if(item.sectionId===editingSectionId)item.sectionId='';markBoardChanged(board);if(!await saveBoard(board))return true;$('#section-dialog').close();render();toast('Section removed. Its cards are preserved.');}
  else if(action==='toggle-section'&&board){const section=board.sections.find(s=>s.id===id);if(section){section.collapsed=!section.collapsed;markBoardChanged(board);render();}}
  else if(action==='board-zoom-in')zoomBoard(1.2);
  else if(action==='board-zoom-out')zoomBoard(1/1.2);
  else if(action==='fit-board')fitBoard();
  else if(action==='find-board-match'&&board){const item=board.items.find(i=>byId(i.shardId)&&boardMatches(byId(i.shardId)));if(item)jumpToBoardItem(item);else toast('No matching note on this canvas.');}
  else if(action==='import-history')await showImports();
  else if(action==='confirm-import'){if(!importArchive||importPreview?.valid===false)return true;await withBusy(async()=>{const result=await writeRequest('/api/import','POST',{data:importArchive});state.data=mergeBoardDrafts(result);importArchive=null;$('#import-preview-dialog').close();state.view='library';render();toast(`Imported ${result.importSummary?.added?.shards||0} notes. Saved canvas data remains in your archive. A receipt is available in Backup & export.`);});}
  else if(action==='undo-import')confirmAction('Undo this import?','Unchanged records added by this import will be removed. Edited records and existing knowledge are preserved. A backup is saved first.','Undo import',async()=>{const result=await mutate('/api/imports/'+encodeURIComponent(id)+'/undo','POST',{});await showImports();toast(`Import undone.${result.undoSummary?.skipped?.length?' '+result.undoSummary.skipped.length+' records were preserved. See their reasons in import history.':''}`);},true);
  else return false;return true;
}


document.addEventListener('click',async event=>{
  if(busy)return;const node=event.target.closest('[data-graph-id]'),button=event.target.closest('button,a');if(node){selectShard(node.dataset.graphId);return;}if(!button)return;
  try{if(button.dataset.close){closeDialog(button.dataset.close);return;}if(button.dataset.view){changeView(button.dataset.view);return;}if(button.dataset.shardId){selectShard(button.dataset.shardId);return;}if(button.dataset.tag){toggleTag(button.dataset.tag);return;}if(button.dataset.scope){state.graphScope=button.dataset.scope;render();return;}if(button.dataset.action)await runAction(button.dataset.action,button);}catch(error){toast(error.message);}
});
document.addEventListener('keydown',event=>{
  if(busy){if(event.metaKey||event.ctrlKey)event.preventDefault();return;}if(handlePortalKey(event))return;const node=event.target.closest?.('[data-graph-id]');if(node&&(event.key==='Enter'||event.key===' ')){event.preventDefault();selectShard(node.dataset.graphId);return;}if(!(event.metaKey||event.ctrlKey))return;
  if(event.key.toLowerCase()==='k'){event.preventDefault();if(!document.querySelector('dialog[open]')){$('#search').focus();$('#search').select();}}
  else if(event.key.toLowerCase()==='n'){event.preventDefault();if(!document.querySelector('dialog[open]'))openEditor();}else if(event.key==='Enter'&&$('#editor-dialog').open){event.preventDefault();$('#editor-form').requestSubmit();}
});
$('#mobile-menu').addEventListener('click',()=>document.body.classList.toggle('sidebar-open'));
let searchTimer;$('#search').addEventListener('input',event=>{state.query=event.target.value;clearTimeout(searchTimer);searchTimer=setTimeout(render,100);});
$('#topic-search').addEventListener('input',event=>{state.topicQuery=event.target.value;renderTopics();});
$('#topic-search').addEventListener('keydown',event=>{if(event.isComposing)return;if(event.key==='Escape'){event.preventDefault();event.stopPropagation();clearTopicSearch();}else if(event.key==='Enter'){event.preventDefault();event.stopPropagation();if(!busy)selectSearchedTopic();}});
document.addEventListener('change',event=>{
  if(event.target.id==='atlas-organizational'){state.atlasShowOrganizational=event.target.checked;state.atlasLimit=12;render();return;}
  if(event.target.id==='atlas-relation'){state.atlasRelation=event.target.value;state.atlasInspectId=null;render();return;}
  if(event.target.dataset?.structured){syncStructuredEditor(event.target.dataset.structured);scheduleDraft('editor');}
  const filters={'board-select':'boardId','kind-filter':'kind','status-filter':'status','sort-filter':'sort','tag-mode':'tagMode','graph-color':'graphColor','graph-group':'graphGroup','release-category':'releaseCategory','timeline-content':'timelineContent'};if(filters[event.target.id]){state[filters[event.target.id]]=event.target.value;render();}
});
for(const kind of draftKinds){const form=draftForm(kind);form.addEventListener('input',event=>{if(event.target.dataset?.structured)syncStructuredEditor(event.target.dataset.structured);scheduleDraft(kind);if(kind==='editor'){refreshPreview();showWikiSuggestions();}});form.addEventListener('change',()=>scheduleDraft(kind));$(kind==='editor'?'#editor-dialog':'#link-dialog').addEventListener('cancel',event=>{event.preventDefault();closeDialog(kind==='editor'?'editor-dialog':'link-dialog');});}
$('#link-search').addEventListener('input',event=>{renderLinkTargets(event.target.value);scheduleDraft('connection');});
$('#shard-content').addEventListener('paste',async event=>{const image=[...(event.clipboardData?.items||[])].find(item=>item.kind==='file'&&item.type.startsWith('image/'));if(!image)return;event.preventDefault();if(busy)return;try{await uploadImage(image.getAsFile());}catch(error){toast(error.message);}});
$('#image-file').addEventListener('change',async event=>{try{await uploadImage(event.target.files[0]);}catch(error){toast(error.message);}finally{event.target.value='';}});
window.addEventListener('beforeunload',event=>{if(editorDirty()||linkDirty()||extraFormDirty()||boardDirty||busy||pendingWrites){for(const kind of draftKinds)if(dirtyKind(kind)){drafts[kind]=snapshotDraft(kind);writeLocalDrafts();}event.preventDefault();event.returnValue='';}});
window.shardAtlasDesktop={status:()=>({dirty:editorDirty()||linkDirty()||extraFormDirty()||boardDirty,saving:busy||pendingWrites>0,draftSaved:!extraFormDirty()&&!boardDirty&&draftKinds.every(kind=>!dirtyKind(kind)||persistedDrafts[kind]===formSnapshot(draftForm(kind)))}),filePickerType:()=>pendingFilePickerType,command:name=>{if(busy){toast('Saving your change…');return;}if(document.querySelector('dialog[open]')){toast('Finish or close the current dialog first.');return;}if(name==='search'){$('#search').focus();$('#search').select();}else if(name==='new')openEditor();else if(['library','graph','timeline','atlas','boards'].includes(name))changeView(name);else if(name==='settings')$('#settings-dialog').showModal();}};
async function clearSavedDraft(kind){
  drafts[kind]=snapshotDraft(kind);writeLocalDrafts();
  try{await deleteDraft(kind);return true;}catch(error){
    try{await writeRequest('/api/drafts/'+kind,'PUT',{draft:drafts[kind]});persistedDrafts[kind]=JSON.stringify(drafts[kind].values);}catch{}
    renderDraftShelf();return false;
  }
}
$('#editor-form').addEventListener('submit',async event=>{
  event.preventDefault();if(busy)return;const form=event.target,values=formValues(form),original=byId(editingId),wasNew=!editingId;values.tags=original&&values.tags===original.tags.join(', ')?original.tags:[...new Set(values.tags.split(',').map(t=>t.trim()).filter(Boolean))];values.entities=original&&values.entities===(original.entities||[]).join(', ')?original.entities:[...new Set(values.entities.split(',').map(v=>v.trim()).filter(Boolean))];values.inbox=values.inbox==='true';try{values.sources=JSON.parse(values.sources||'[]');values.facts=JSON.parse(values.facts||'[]');}catch{toast('A source or fact could not be read. Reopen the editor.');return;}values.content=stabilizeWikiLinks(values.content);$('#editor-error').hidden=true;
  try{await withBusy(async()=>{
    clearTimeout(draftTimers.editor);const oldIds=new Set(state.data.shards.map(s=>s.id)),result=await writeRequest('/api/shards'+(editingId?'/'+encodeURIComponent(editingId):''),editingId?'PUT':'POST',{...original,...values});state.data=mergeBoardDrafts(result);editingId=editingId||result.shards.find(s=>!oldIds.has(s.id))?.id;state.selectedId=editingId;state.view='library';clearFilters();form.dataset.baseline=formSnapshot(form);const cleaned=await clearSavedDraft('editor');$('#editor-dialog').close();render();toast(cleaned?(wasNew?'A new idea, saved.':'Your explanation is up to date.'):'Your shard was saved. An older draft still needs to be discarded.');
  });}catch(error){$('#editor-error').textContent=error.message;$('#editor-error').hidden=false;}
});
$('#link-form').addEventListener('submit',async event=>{
  event.preventDefault();if(busy)return;const form=event.target,values=formValues(form),wasNew=!editingLinkId;values.fromId=linkingId;$('#link-error').hidden=true;
  try{await withBusy(async()=>{
    clearTimeout(draftTimers.connection);const oldIds=new Set(state.data.links.map(l=>l.id)),result=await mutate('/api/links'+(editingLinkId?'/'+encodeURIComponent(editingLinkId):''),editingLinkId?'PUT':'POST',values);editingLinkId=editingLinkId||result.links.find(l=>!oldIds.has(l.id))?.id;form.dataset.baseline=formSnapshot(form);const cleaned=await clearSavedDraft('connection');$('#link-dialog').close();toast(cleaned?(wasNew?'Ideas connected.':'Relationship updated.'):'Your relationship was saved. An older draft still needs to be discarded.');
  });}catch(error){$('#link-error').textContent=error.message;$('#link-error').hidden=false;}
});
$('#tag-form').addEventListener('submit',async event=>{
  event.preventDefault();if(busy)return;const values=formValues(event.target);$('#tag-error').hidden=true;
  try{await withBusy(async()=>{await mutate('/api/tags/rename','PUT',values);state.tags=[...new Set(state.tags.map(t=>t===values.from?values.to.trim():t))];$('#tag-dialog').close();render();toast('Topic renamed across your atlas.');});}catch(error){$('#tag-error').textContent=error.message;$('#tag-error').hidden=false;}
});
$('#confirm-action').addEventListener('click',async()=>{if(busy||!confirmTask)return;try{await withBusy(async()=>{await confirmTask();$('#confirm-dialog').close();confirmTask=null;});}catch(error){toast(error.message);}});
$('#import-file').addEventListener('change',async event=>{
  const file=event.target.files[0];if(!file||busy)return;
  try{if(file.size>256*1024*1024)throw new Error('Choose an archive no larger than 256 MB.');const data=JSON.parse(await file.text());await previewImport(data,file.name);}catch(error){toast(error instanceof SyntaxError?'This file is not valid JSON. Your atlas has not changed.':error.message);}finally{event.target.value='';}
});
async function loadDrafts(){
  let local={};try{local=JSON.parse(localStorage.getItem(localDraftKey)||'{}');}catch{}
  try{const result=await api('/api/drafts');for(const kind of draftKinds){const remote=result.drafts?.[kind]||null,candidate=local[kind];drafts[kind]=candidate?.values&&(!remote||candidate.updatedAt>remote.updatedAt)?candidate:remote;persistedDrafts[kind]=remote?JSON.stringify(remote.values):null;}}catch{for(const kind of draftKinds)drafts[kind]=local[kind]?.values?local[kind]:null;}
  writeLocalDrafts();renderDraftShelf();
}
function canRefreshAtlas(manual=false){const dialog=document.querySelector('dialog[open]');return document.visibilityState!=='hidden'&&!busy&&!pendingWrites&&!editorDirty()&&!linkDirty()&&!extraFormDirty()&&!boardDirty&&!boardDragActive&&(!dialog||(manual&&dialog.id==='ai-dialog'));}
async function refreshAtlas(manual=false){
  if(!canRefreshAtlas(manual))return {changed:false,skipped:true};if(atlasRefreshLoading)return atlasRefreshLoading;
  const baseline=JSON.stringify([state.data.shards,state.data.links,state.data.boards]);
  atlasRefreshLoading=(async()=>{const data=await api('/api/state');if(!canRefreshAtlas(manual)||JSON.stringify([state.data.shards,state.data.links,state.data.boards])!==baseline)return {changed:false,skipped:true};const changed=JSON.stringify([data.shards,data.links,data.boards])!==baseline;if(changed){state.data=mergeBoardDrafts(data);if(!byId(state.selectedId))state.selectedId=filteredShards()[0]?.id||data.shards[0]?.id||null;render();$('#save-status').textContent='Latest notes are ready.';}return {changed,skipped:false};})();
  try{return await atlasRefreshLoading;}catch(error){if(manual)throw error;return {changed:false,failed:true};}finally{atlasRefreshLoading=null;}
}
function scheduleAtlasRefresh(){setTimeout(async()=>{await refreshAtlas();scheduleAtlasRefresh();},15000);}
window.addEventListener('focus',()=>{void refreshAtlas();});
document.addEventListener('visibilitychange',()=>{if(document.visibilityState!=='hidden')void refreshAtlas();});
async function initialize(){
  try{const results=await Promise.allSettled([api('/api/state'),api('/api/health')]);if(results[0].status==='rejected')throw results[0].reason;state.data=results[0].value;state.selectedId=byId('cpp-raii')?.id||state.data.shards[0]?.id;
    if(results[1].status==='fulfilled'){const health=results[1].value;localDraftKey='shard-atlas-drafts:'+String(health.dbPath||'default');$('#settings-path').textContent='Notes: '+(health.dbPath||'stored locally')+'\nBackups: '+(health.backupDirectory||'project backups folder');if(health.lastBackupError){$('#save-status').textContent='Notes saved. Backup needs attention.';toast('Your notes are saved, but the daily backup needs attention: '+health.lastBackupError);}}
    loadBoardRecovery();render();await loadDrafts();
  }catch(error){$('#workspace').innerHTML='<div class="error-state"><h1>Your atlas could not open.</h1><p>'+esc(error.message)+'</p><button class="primary" id="retry-open">Try again</button></div>';$('#retry-open').addEventListener('click',initialize);}
}
initialize();
loadReleaseCatalog();
loadSpiralCatalog();
scheduleAtlasRefresh();
