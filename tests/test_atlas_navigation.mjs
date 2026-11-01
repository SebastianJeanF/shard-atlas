import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const context=vm.createContext({URL,URLSearchParams});
vm.runInContext(readFileSync(new URL('../static/atlas-navigation.js',import.meta.url),'utf8'),context);
const nav=context.ShardAtlasNavigation;
const plain=value=>JSON.parse(JSON.stringify(value));
const site=nav.SITE;
const returnQuery='historyCollection=atlas-collection-123&historyRecord=history-logistic-1838';

test('web and native links retain exact foreign IDs and bounded History return identities',()=>{
  for(const id of ['cpp-raii','Math.sigmoid_v2:proof','constructor','A'.repeat(100)]){
    const expected={shardId:id,historyCollection:'atlas-collection-123',historyRecord:'history-logistic-1838'};
    assert.deepEqual(plain(nav.parse(`${site}/#shard=${encodeURIComponent(id)}&${returnQuery}`)),expected);
    assert.deepEqual(plain(nav.parse(`shardatlas://shard/${encodeURIComponent(id)}?${returnQuery}`)),expected);
    assert.deepEqual(plain(nav.parse(`${site}/${nav.fragment(expected)}`)),expected);
  }
  assert.equal(nav.parse(`${site}/#library`),null);
});

test('only exact QA schemes, safe parameters and paired return IDs are accepted',()=>{
  assert.equal(nav.parse('shardatlas-qa://shard/qa-id',{qa:true}).shardId,'qa-id');
  for(const value of [
    'shardatlas-qa://shard/id','shardatlas://other/id','shardatlas://shard/id/extra',
    'shardatlas://user:secret@shard/id','shardatlas://shard:80/id',
    'shardatlas://shard/id?callback=https://example.org','shardatlas://shard/id?historyRecord=event',
    'shardatlas://shard/id?historyCollection=collection','shardatlas://shard/id?historyCollection=collection&historyRecord=Upper',
    'shardatlas://shard/id?historyCollection=collection&historyRecord=event&historyRecord=another',
    'shardatlas://shard/id#fragment','shardatlas://shard/id%0A','shardatlas://shard/id%252Fother',
    'shardatlas://shard/id?historyCollection=collection%0A&historyRecord=event',
    `${site}/#shard=one&shard=two`,`${site}/#shard=${'a'.repeat(101)}`,
    'https://example.org/#shard=id','javascript:alert(1)'
  ])assert.throws(()=>nav.parse(value),undefined,value);
  assert.throws(()=>nav.parse('shardatlas://shard/id',{qa:true}));
  assert.throws(()=>nav.returnLinks({shardId:42}));
});

test('return URLs are generated from identities and keep production and QA apps separate',()=>{
  const route=nav.parse(`shardatlas://shard/id?${returnQuery}`);
  const links=nav.returnLinks(route);
  assert.equal(links.native,'historyatlas://event/history-logistic-1838?collection=atlas-collection-123');
  assert.equal(links.browser,'http://127.0.0.1:18766/?event=history-logistic-1838&atlas=atlas-collection-123');
  assert.match(nav.returnLinks(route,{qa:true}).native,/^historyatlas-qa:/);
  assert.equal(nav.returnLinks({shardId:'id'}),null);
});

test('startup and unsaved guards defer navigation while retaining the exact requested route',()=>{
  let ready=false,protectedEdit=true,selected='first';
  const messages=[],urls=[];
  const router=nav.createRouter({ready:()=>ready,canNavigate:()=>!protectedEdit,hasShard:id=>id==='target',
    selectShard:id=>{selected=id;},showMissing:()=>assert.fail('Target exists'),replaceUrl:url=>urls.push(url),message:value=>messages.push(value)});
  assert.equal(router.open(`shardatlas://shard/target?${returnQuery}`).accepted,true);
  assert.equal(selected,'first');assert.equal(router.current().status,'pending');
  ready=true;router.flush();router.flush();
  assert.equal(router.current().status,'deferred');assert.equal(messages.length,1);assert.equal(selected,'first');
  assert.equal(router.current().route.shardId,'target');assert.match(urls[0],/^#shard=target/);
  protectedEdit=false;router.flush();assert.equal(selected,'target');assert.equal(router.current().status,'opened');
  protectedEdit=true;router.flush();assert.equal(router.current().status,'opened');assert.equal(messages.length,1,'Opening a later editor must not requeue an already opened link');
});

test('missing targets never substitute the first shard and can resolve after a later refresh',()=>{
  const records=new Set(['first']),missing=[],selected=[];
  const router=nav.createRouter({hasShard:id=>records.has(id),selectShard:id=>selected.push(id),showMissing:id=>missing.push(id)});
  router.open(`shardatlas://shard/absent?${returnQuery}`);router.flush();
  assert.deepEqual(missing,['absent']);assert.deepEqual(selected,[]);assert.equal(router.current().route.shardId,'absent');
  assert.equal(router.current().status,'missing');
  records.add('absent');router.flush();assert.deepEqual(selected,['absent']);
  records.delete('absent');router.flush();assert.equal(router.current().status,'missing');
});
