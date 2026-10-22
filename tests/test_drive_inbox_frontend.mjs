import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

class Element {
  constructor() { this.children=[];this.listeners={};this.textContent='';this.disabled=false;this.open=false; }
  append(child) { this.children.push(child); }
  replaceChildren() { this.children=[]; }
  addEventListener(name, callback) { this.listeners[name]=callback; }
}
function fixture(options={}) {
  const dialog=new Element(),status=new Element(),path=new Element(),files=new Element();
  const buttons=[{dataset:{driveAction:'sync'}},{dataset:{driveAction:'check'}}];
  dialog.querySelectorAll=()=>buttons;
  const elements={'#ai-dialog':dialog,'#drive-inbox-status':status,'#drive-inbox-path':path,'#drive-inbox-files':files};
  const document={querySelector:selector=>elements[selector],createElement:()=>new Element()};
  let observed,reads=0,writes=0,refreshes=0,busy=false;
  const context=vm.createContext({window:{},document,MutationObserver:class {constructor(callback){observed=callback;}observe(){}}});
  vm.runInContext(fs.readFileSync(new URL('../static/drive-inbox.js',import.meta.url),'utf8'),context);
  const result={available:true,path:'/Drive/Inbox',counts:{files:1,imported:1,replayed:0,errors:0},files:[{name:'<script>.json',status:'imported',receipt:{added:{shards:2},skipped:{shards:1}},warnings:['A later deletion was preserved.']}]};
  context.window.DriveInbox.install({
    api:async endpoint=>{assert.equal(endpoint,'/api/drive-inbox');reads++;return options.read?.()??result;},
    writeRequest:async(endpoint,method,body)=>{assert.equal(endpoint,'/api/drive-inbox/sync');assert.equal(method,'POST');assert.equal(JSON.stringify(body),'{}');writes++;if(options.gate)await options.gate;return result;},
    withBusy:async task=>{assert.equal(busy,false);busy=true;try{return await task();}finally{busy=false;}},
    refreshAtlas:async manual=>{assert.equal(manual,true);assert.equal(busy,false);refreshes++;if(options.refreshError)throw Error('Refresh unavailable');return {skipped:!!options.skipped};}
  });
  return {dialog,status,path,files,buttons,get reads(){return reads;},get writes(){return writes;},get refreshes(){return refreshes;},
    open(){dialog.open=true;observed();},click(action){dialog.listeners.click({target:{closest:()=>buttons.find(button=>button.dataset.driveAction===action)}});}};
}
async function until(predicate) {
  for(let attempt=0;attempt<100;attempt++){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,1));}
  throw Error('Timed out waiting for inbox UI');
}

{
  const ui=fixture();ui.open();await until(()=>!ui.buttons[0].disabled);
  assert.equal(ui.reads,1);assert.equal(ui.writes,0);assert.equal(ui.refreshes,0);
  assert.match(ui.status.textContent,/1 JSON file found/);
  assert.equal(ui.path.textContent,'/Drive/Inbox');
}
{
  let release;const gate=new Promise(resolve=>{release=resolve;}),ui=fixture({gate});
  ui.click('sync');ui.click('sync');
  assert.equal(ui.writes,1);assert.ok(ui.buttons.every(button=>button.disabled));
  release();await until(()=>!ui.buttons[0].disabled);
  assert.equal(ui.refreshes,1);assert.match(ui.status.textContent,/1 batch imported/);
  assert.equal(ui.files.children[0].children[0].textContent,'<script>.json: Imported');
  assert.match(ui.files.children[0].children[1].textContent,/2 notes added, 1 reused/);
  assert.match(ui.files.children[0].children[2].textContent,/deletion was preserved/);
}
{
  const ui=fixture({refreshError:true});ui.click('sync');await until(()=>!ui.buttons[0].disabled);
  assert.equal(ui.writes,1);assert.match(ui.status.textContent,/1 batch imported/);
  assert.match(ui.status.textContent,/import results are saved/);
}
{
  const ui=fixture({read:()=>{throw Error('Folder unavailable');}});ui.open();await until(()=>!ui.buttons[0].disabled);
  assert.equal(ui.status.textContent,'Folder unavailable');assert.equal(ui.writes,0);
}
console.log('4 Drive inbox frontend behavior checks passed.');
