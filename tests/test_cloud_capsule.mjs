import test from 'node:test';
import assert from 'node:assert/strict';
import {IncrementalSha256, CloudCapsuleError, readCloudCapsule, prepareCloudSnapshot, registerAssetSource, assetDataHash} from '../hosting/lib/cloud-capsule.mjs';
import {CHUNK_BYTES, sha256} from '../sync/protocol.mjs';

const encoder = new TextEncoder();
const capsule = () => ({format:'shard-atlas-library',version:1,archive:{schemaVersion:1,
  shards:[{id:'note',title:'A current idea',content:'Before.\r\nAfter.',tags:[],codeSolution:{role:'snippet',code:'\treturn x; // exact\r\n'}}],
  links:[],reviews:[],boards:[],assets:[],revisions:[],trash:[]},contributionReceipts:[],unknownExtension:{preserve:'α → β'}});
function fixture() {
  const objects=new Map(),calls={gets:0,puts:0,maxPutBytes:0};
  const storage={async blob(hash){calls.gets++;const value=objects.get(hash);return value?{size:value.length,body:new Response(value).body}:null;},
    async blobInfo(hash){const value=objects.get(hash);return value?{size:value.length}:null;},
    async putBlob(hash,bytes){calls.puts++;calls.maxPutBytes=Math.max(calls.maxPutBytes,bytes.length);objects.set(hash,new Uint8Array(bytes));}};
  async function raw(bytes){
    if(typeof bytes==='string')bytes=encoder.encode(bytes);
    const chunks=[];for(let i=0;i<bytes.length;i+=CHUNK_BYTES){const part=bytes.slice(i,i+CHUNK_BYTES),hash=await sha256(part);objects.set(hash,part);chunks.push({sha256:hash,bytes:part.length});}
    return {protocolVersion:1,archiveVersion:1,format:'shard-atlas-library-json',bytes:bytes.length,sha256:await sha256(bytes),chunks};
  }
  function decode(manifest){return JSON.parse(Buffer.concat(manifest.chunks.map(chunk=>Buffer.from(objects.get(chunk.sha256)))).toString('utf8'));}
  return {objects,storage,calls,raw,decode};
}
const rejected = (action,code='cloud_library_invalid') => assert.rejects(action,error=>error instanceof CloudCapsuleError && error.code===code);

test('incremental SHA-256 matches platform digests across padding and update boundaries',async()=>{
  for(const size of [0,1,55,56,63,64,65,127,128,129,1024*1024+3]){
    const bytes=Uint8Array.from({length:size},(_,i)=>(i*53+17)%256),hash=new IncrementalSha256();
    for(let i=0;i<bytes.length;i+=71)hash.update(bytes.subarray(i,i+71));
    assert.equal(hash.hex(),await sha256(bytes));assert.equal(hash.hex(),await sha256(bytes),'digest is non-destructive');
    hash.update(Uint8Array.of(42));assert.equal(hash.hex(),await sha256(Uint8Array.from([...bytes,42])));
  }
});

test('media over 16 MiB remains searchable and rewritable with exact portable image bytes',async()=>{
  const f=fixture(),original=capsule(),raw=Buffer.alloc(7*1024*1024,29),image=raw.toString('base64');
  original.archive.assets=[{id:'one',name:'diagram.png',mimeType:'image/png',size:raw.length,data:image},
    {id:'two',name:'other.png',mimeType:'image/png',size:raw.length,data:image}];
  const first=await prepareCloudSnapshot(f.storage,original,'','first');
  assert.ok(first.manifest.bytes>16*1024*1024);assert.equal(first.chunks.length,0);assert.equal(f.calls.maxPutBytes,CHUNK_BYTES);
  const loaded=await readCloudCapsule(f.storage,first.manifest,{metadataBytes:32*1024});
  assert.deepEqual(loaded.archive.shards,original.archive.shards);assert.deepEqual(loaded.unknownExtension,original.unknownExtension);
  assert.deepEqual(loaded.archive.assets.map(a=>a.data),['','']);
  assert.equal(await assetDataHash(loaded.archive.assets[0]),await sha256(encoder.encode(image)));
  const commit={id:'revision',library_id:'owner',status:'accepted',created_at:'2026-10-28T12:00:00.000Z',manifest:JSON.stringify(first.manifest)};
  const env={DB:{prepare(sql){return {bind(){return {async first(){return sql.includes('library_heads')?{revision:'revision'}:commit;}};}};}},
    BUCKET:{get:key=>f.storage.blob(key.split('/').at(-1))}};
  const {readCloudLibrary}=await import('../hosting/lib/cloud-library-reader.mjs');
  const current=await readCloudLibrary(env);assert.equal(current.archive.shards[0].title,original.archive.shards[0].title);
  assert.equal('assets' in current.archive,false);
  const next={...loaded,archive:{...loaded.archive,shards:loaded.archive.shards.map(s=>({...s,title:'Edited remotely'}))}};
  const second=await prepareCloudSnapshot(f.storage,next,'revision','second'),decoded=f.decode(second.manifest);
  assert.deepEqual(decoded.archive.assets,original.archive.assets);assert.equal(decoded.archive.shards[0].title,'Edited remotely');
  assert.equal(decoded.archive.shards[0].codeSolution.code,original.archive.shards[0].codeSolution.code);
  assert.deepEqual(decoded.unknownExtension,original.unknownExtension);
});

test('JSON-escaped image strings and reordered keys retain exact decoded data and portable fields',async()=>{
  const f=fixture(),value=capsule();value.archive.assets=[{id:'escaped',data:'/w==',size:1}];
  const json=JSON.stringify(value).replace('"archive":','"arc\\u0068ive":').replace('"data":"/w=="','"data":"\\u002fw=="');
  const manifest=await f.raw(json),loaded=await readCloudCapsule(f.storage,manifest);
  assert.equal(await assetDataHash(loaded.archive.assets[0]),await sha256(encoder.encode('/w==')));
  const written=await prepareCloudSnapshot(f.storage,loaded,'','escaped');assert.deepEqual(f.decode(written.manifest),value);
});

test('staged raw media is independently verified, base64 streamed, and bound to its data hash',async()=>{
  const f=fixture(),value=capsule(),bytes=Uint8Array.from({length:100003},(_,i)=>(i*7)%256),asset={id:'staged',name:'staged.png',mimeType:'image/png',size:bytes.length,data:''};
  const read=()=>new ReadableStream({start(controller){for(let i=0;i<bytes.length;i+=997)controller.enqueue(bytes.slice(i,i+997));controller.close();}});
  registerAssetSource(value,asset,{kind:'r2-raw',bytes:bytes.length,sha256:await sha256(bytes),read});value.archive.assets.push(asset);
  const expected=Buffer.from(bytes).toString('base64');assert.equal(await assetDataHash(asset),await sha256(encoder.encode(expected)));
  const written=await prepareCloudSnapshot(f.storage,value,'','staged');assert.equal(f.decode(written.manifest).archive.assets[0].data,expected);
  bytes[1]^=1;await rejected(()=>prepareCloudSnapshot(f.storage,value,'','changed'));
});

test('writer verifies stored chunk bytes before reusing immutable objects',async()=>{
  const f=fixture(),value=capsule(),first=await prepareCloudSnapshot(f.storage,value,'','first');
  f.objects.get(first.manifest.chunks[0].sha256)[5]^=1;
  await rejected(()=>prepareCloudSnapshot(f.storage,value,'','second'));
});

test('bounded metadata, corrupt chunks, mismatched manifests and malformed JSON fail closed',async t=>{
  for(const name of ['metadata','chunk','manifest','trailing-comma','duplicate-key','invalid-base64','noncanonical-padding','wrong-size','invalid-utf8'])await t.test(name,async()=>{
    const f=fixture(),value=capsule();value.archive.assets=[{id:'one',data:'AA==',size:1}];let json=JSON.stringify(value);
    if(name==='trailing-comma')json=json.replace('"data":"AA=="','"data":"AA==",');
    if(name==='duplicate-key')json=json.replace('"data":"AA=="','"data":"AA==","data":"AA=="');
    if(name==='invalid-base64')json=json.replace('AA==','wrong-base64');
    if(name==='noncanonical-padding')json=json.replace('AA==','AB==');
    if(name==='wrong-size')json=json.replace('"size":1','"size":2');
    let bytes=encoder.encode(json);if(name==='invalid-utf8'){bytes=Uint8Array.from(bytes);bytes[json.indexOf('Before')]=255;}
    const manifest=await f.raw(bytes);
    if(name==='chunk')f.objects.get(manifest.chunks[0].sha256)[5]^=1;
    if(name==='manifest')manifest.sha256='a'.repeat(64);
    await rejected(()=>readCloudCapsule(f.storage,manifest,{metadataBytes:name==='metadata'?32:16384}),name==='metadata'?'cloud_snapshot_too_large':'cloud_library_invalid');
  });
});

test('image escape and base64 padding remain correct at the four-MiB chunk boundary',async()=>{
  const f=fixture(),value=capsule();value.archive.assets=[{id:'boundary',data:'AA==',size:1}];
  const seed=JSON.stringify(value),dataOffset=seed.indexOf('AA==');value.padding='x'.repeat(CHUNK_BYTES-dataOffset-16);
  let json=JSON.stringify(value); // Move padding before archive to place the data string across a chunk.
  json=JSON.stringify({padding:value.padding,...value});
  const desired=CHUNK_BYTES-2,current=json.indexOf('AA==');
  if(current<desired)value.padding+='x'.repeat(desired-current);else value.padding=value.padding.slice(0,value.padding.length-(current-desired));
  json=JSON.stringify({padding:value.padding,...value});assert.equal(json.indexOf('AA=='),desired);
  const loaded=await readCloudCapsule(f.storage,await f.raw(json));const written=await prepareCloudSnapshot(f.storage,loaded,'','boundary');
  assert.equal(f.decode(written.manifest).archive.assets[0].data,'AA==');
});
