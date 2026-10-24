import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {IDBFactory} from 'fake-indexeddb';
import {BrowserStore} from '../web-dist/persistence.mjs';

// Exercise the actual paste, preview, discard and close guards against isolated
// browser storage. The complete source HTTP/UI save path is covered separately.
for(const variant of ['static','web-dist'])test(`${variant} pasted archives validate before saving and preserve exact code`,async t=>{
  const source=fs.readFileSync(new URL(`../${variant}/app.js`,import.meta.url),'utf8');
  const html=fs.readFileSync(new URL(`../${variant}/index.html`,import.meta.url),'utf8');
  assert.equal((html.match(/data-action="paste-import"/g)||[]).length,2);
  assert.match(html,/<label[^>]*for="archive-json">Archive JSON<textarea[^>]*id="archive-json"/);
  assert.match(html,/id="paste-import-error"[^>]*role="alert"/);
  const slice=(start,end)=>{const a=source.indexOf(start),b=source.indexOf(end,a+start.length);assert.ok(a>=0&&b>a);return source.slice(a,b);};
  const store=new BrowserStore(new IDBFactory());t.after(async()=>{(await store.ready).close();});
  const nodes=new Map(),listeners=new Map(),calls=[];
  const node=id=>{if(!nodes.has(id))nodes.set(id,{id,value:'',open:false,hidden:true,dataset:{},showModal(){this.open=true;},close(){this.open=false;},focus(){this.focused=true;}});return nodes.get(id);};
  const document={visibilityState:'visible',body:{dataset:{}},querySelector(selector){if(selector==='dialog[open]')return [...nodes.values()].find(value=>value.open&&value.id.endsWith('-dialog'))||null;return node(selector.slice(1));},querySelectorAll(){return [];}};
  const window={addEventListener(name,callback){listeners.set(name,callback);},ShardAtlasPlatform:{canRefreshDialog:()=>false}};
  const context=vm.createContext({window,document,Blob,Date,JSON,URL,console,localStorage:{getItem:()=>null},api:async(path,method,data)=>{calls.push({path,method});return (await store.request(path,method,data)).result;}});
  vm.runInContext([
    source.slice(0,source.indexOf('function toast(')),
    slice('async function withBusy(','async function mutate('),
    slice('function pasteImportDirty()','function confirmDelete('),
    slice('function openPasteImport()','function clearImportPreview('),
    slice('async function previewImport(','function openImportEditor('),
    slice('function hasUnsavedLibraryChanges()','async function refreshAtlas('),
    `function toast(message){window.lastToast=message;}
     function editorDirty(){return false;}
     function linkDirty(){return false;}
     function dirtyKind(){return false;}
     function formSnapshot(){return '';}
     const boardDragActive=false;
     function clearImportPreview(){importPreviewRequest++;importArchive=null;importPreview=null;importReviewChanged=false;}
     function importShards(){return Array.isArray(importArchive?.shards)?importArchive.shards:[];}
     function prepareImportImages(){}
     function renderImportReview(){$('#confirm-import').disabled=importPreview?.valid===false;}
     window.testPaste={openPasteImport,previewPastedImport,closeDialog,pasteImportDirty,canRefreshAtlas,get archive(){return importArchive;},get reviewChanged(){return importReviewChanged;},discard(){confirmTask();$('#confirm-dialog').close();},get drafts(){return drafts;}};`,
    source.split('\n').find(line=>line.startsWith("window.addEventListener('beforeunload'")),
    source.split('\n').find(line=>line.startsWith('window.shardAtlasDesktop='))
  ].join('\n'),context);
  const api=window.testPaste,input=node('archive-json'),snapshot=async()=>JSON.stringify((await store.atomic(db=>db,{readonly:true})).database);
  const initial=await snapshot();api.drafts.editor={values:{title:'Existing unfinished shard'},baseline:'original'};const draft=JSON.stringify(api.drafts);
  api.openPasteImport();assert.equal(node('paste-import-dialog').open,true);
  input.value='(()=>{globalThis.executed=true})()';await api.previewPastedImport();assert.match(node('paste-import-error').textContent,/not valid JSON/);assert.equal(context.executed,undefined);assert.equal(calls.length,0);
  input.value='x'.repeat(8*1024*1024+1);await api.previewPastedImport();assert.match(node('paste-import-error').textContent,/8 MB/);assert.equal(calls.length,0);
  input.value='😀'.repeat(2*1024*1024+1);await api.previewPastedImport();assert.match(node('paste-import-error').textContent,/8 MB/);assert.equal(calls.length,0,'The limit measures UTF-8 bytes as well as character count');
  input.value='{"schemaVersion":1}';assert.equal(api.canRefreshAtlas(true),false);assert.equal(window.shardAtlasDesktop.status().dirty,true);assert.equal(window.shardAtlasDesktop.status().draftSaved,false);
  const unload={preventDefault(){this.prevented=true;}};listeners.get('beforeunload')(unload);assert.equal(unload.prevented,true);
  api.closeDialog('paste-import-dialog');assert.equal(node('confirm-dialog').open,true);assert.equal(input.value,'{"schemaVersion":1}');api.closeDialog('confirm-dialog');assert.equal(node('paste-import-dialog').open,true);assert.ok(input.value);
  api.closeDialog('paste-import-dialog');api.discard();assert.equal(input.value,'');assert.equal(node('paste-import-dialog').open,false);assert.equal(await snapshot(),initial);assert.equal(calls.length,0);
  api.openPasteImport();input.value=JSON.stringify({schemaVersion:1,shards:[{id:'bad',title:123}]});await api.previewPastedImport();assert.equal(node('confirm-import').disabled,true);assert.equal(api.reviewChanged,true);assert.equal(await snapshot(),initial);api.closeDialog('import-preview-dialog');api.discard();
  const code='\n#include <vector>\r\nint f(int x) {\r\n\treturn x;  // [[id:literal]]\r\n}\r\n',variantCode='\nreturn 2;\r\n';
  const archive={schemaVersion:1,shards:[{id:'paste-isolated',title:'Pasted isolated fixture',kind:'concept',status:'learning',tags:['C++'],codeSolution:{role:'algorithm',code,approaches:[{id:'stable-variant',title:'Alternative',code:variantCode}]}}],links:[]};
  api.openPasteImport();input.value=JSON.stringify(archive);await api.previewPastedImport();assert.equal(node('paste-import-dialog').open,false);assert.equal(node('import-preview-dialog').open,true);assert.equal(node('confirm-import').disabled,false);assert.equal(input.value,'');assert.equal(await snapshot(),initial);assert.equal(api.archive.shards[0].codeSolution.code,code);assert.equal(api.canRefreshAtlas(true),false);assert.equal(window.shardAtlasDesktop.status().dirty,true);assert.equal(JSON.stringify(api.drafts),draft);
  assert.ok(calls.every(call=>call.path==='/api/import/preview'),'Paste and preview must use only the read-only validation route');
  await store.request('/api/import','POST',{data:api.archive});const saved=(await store.request('/api/state')).result.shards[0];assert.equal(saved.codeSolution.code,code);assert.equal(saved.codeSolution.approaches[0].code,variantCode);assert.equal(saved.codeSolution.approaches[0].id,'stable-variant');assert.equal(JSON.stringify(api.drafts),draft);
});
