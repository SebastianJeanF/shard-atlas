import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {ingestRemoteImage, getImageUploadStatus, resolveStagedImages, validateImageUploadArguments, IMAGE_UPLOAD_LIMITS, ImageUploadError} from '../hosting/lib/image-uploads.mjs';
import {sha256} from '../sync/protocol.mjs';

const OWNER = 'synthetic-owner', STAMP = Date.parse('2026-10-28T12:00:00.000Z');
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jR7sAAAAASUVORK5CYII=';
const GIF = 'R0lGODdhAgADAIEAAChGWgAAAAAAAAAAACwAAAAAAgADAAAIBgABCBwYEAA7';
const WEBP = 'UklGRjIAAABXRUJQVlA4ICYAAACQAQCdASoCAAMAAUAmJQBOl0AAhgAA/vbmB4tikNzPiF3sYUAAAA==';
const JPEG = '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAADAAIBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAABv/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8ADv/Z';
const VARIANTS = [
  ['image/webp','UklGRh4AAABXRUJQVlA4TBEAAAAvAYAAEAdQlFJUq1qBiOh/AAA='],
  ['image/webp','UklGRlYAAABXRUJQVlA4WAoAAAAQAAAAAQAAAgAAQUxQSAcAAAAAWlpaWlpaAFZQOCAoAAAAsAEAnQEqAgADAAFAJiWYAnS6AARmgAD++kXL+4Mz6uxw82e462AAAA=='],
  ['image/webp','UklGRrQAAABXRUJQVlA4WAoAAAACAAAAAQAAAgAAQU5JTQYAAAAAAAAAAABBTk1GQAAAAAAAAAAAAAEAAAIAAGQAAAJWUDggKAAAAFABAJ0BKgIAAwABQCYlmAAEYYAA/vpFy//zt+IP1Bgl/4d7s86oQABBTk1GQAAAAAAAAAAAAAEAAAIAAGQAAABWUDggKAAAADQBAJ0BKgIAAwAAACYliAADcAD++TbP/8b/Vr5MlN/+1P3s/CfLAAA='],
  ['image/gif','R0lGODlhAgADAIEAABQoWgAAAAAAAAAAACH/C05FVFNDQVBFMi4wAwEAAAAh+QQACgAAACwAAAAAAgADAAAIBgABCBwYEAAh+QQBCgABACwAAAAAAgADAIFQKAoAAAAAAAAAAAAIBgABCBwYEAA7'],
  ['image/jpeg','/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wgALCAADAAIBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAABf/aAAgBAQAAAAEP/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABBQJ//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQAGPwJ//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPyF//9oACAEBAAAAEH//xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAE/EH//2Q=='],
];
const bytes = value => Uint8Array.from(Buffer.from(value, 'base64'));
function input(requestId = 'upload-one', file = {}) {return {requestId, file: {download_url: 'https://files.oaiusercontent.com/private/image?signature=synthetic', file_id: 'file_fixture', ...file}};}
function fixture(t) {
  const db = new DatabaseSync(':memory:'); db.exec(readFileSync(new URL('../sync/schema.sql', import.meta.url), 'utf8'));
  t.after(() => db.close());
  const objects = new Map(), calls = {fetch:0,puts:0}, controls = {body:bytes(PNG),response:null,putFailure:false,corruptWrite:false,fetchHook:null};
  const DB = {prepare(sql) {return {bind(...args) {return {async first() {return db.prepare(sql).get(...args) || null;},
    async all() {return {results:db.prepare(sql).all(...args)};},async run() {return {meta:db.prepare(sql).run(...args)};}};}};}};
  const BUCKET = {async head(key) {const value=objects.get(key);return value ? {size:value.length} : null;},
    async get(key) {const value=objects.get(key);return value ? {size:value.length,body:new Response(value).body} : null;},
    async put(key,value) {calls.puts++;if(controls.putFailure)throw new Error('PRIVATE_OBJECT_PROVIDER_ERROR');const data=new Uint8Array(value);if(controls.corruptWrite)data[data.length-1]^=1;objects.set(key,data);}};
  const env = {DB,BUCKET}, fetch = async (url, options) => {
    calls.fetch++; assert.equal(options.redirect,'manual'); assert.equal(options.credentials,undefined); assert.equal(options.referrerPolicy,undefined);
    assert.equal(options.headers,undefined,'never forward authentication to a file URL');
    if(controls.fetchHook)return controls.fetchHook(url,options);
    return controls.response || new Response(controls.body,{headers:{'content-type':'application/octet-stream'}});
  };
  const options = more => ({ownerId:OWNER,now:STAMP,fetch,...more});
  return {db,env,objects,calls,controls,options};
}
const fails = code => error => error instanceof ImageUploadError && error.code===code && !error.message.includes('PRIVATE_');

test('native file references stage exact bytes privately and resolve ordered image sources without a library commit',async t=>{
  const f=fixture(t), result=await ingestRemoteImage(f.env,input(),f.options());
  assert.equal(result.status,'verified');assert.equal(result.verified,true);assert.equal(result.mimeType,'image/png');assert.equal(result.size,bytes(PNG).length);
  assert.match(result.sha256,/^[a-f0-9]{64}$/);assert.equal(result.assetId,'image-'+result.sha256);assert.equal(result.replayed,false);
  assert.equal(f.objects.size,1);assert.deepEqual([...f.objects.values()][0],bytes(PNG));
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM library_heads').get().n,0);assert.equal(f.db.prepare('SELECT count(*) AS n FROM library_commits').get().n,0);
  const resolved=await resolveStagedImages(f.env,[{uploadId:result.uploadId},{uploadId:result.uploadId}],f.options());
  assert.equal(resolved.length,2);assert.equal(resolved[0],resolved[1]);assert.equal(resolved[0].asset.data,'');assert.equal(resolved[0].asset.id,result.assetId);
  assert.equal(resolved[0].source.sha256,result.sha256);assert.equal(resolved[0].source.kind,'r2-raw');assert.ok(f.objects.has(resolved[0].source.key));
  const status=await getImageUploadStatus(f.env,{uploadId:result.uploadId},f.options());assert.equal(status.verified,true);
  const stored=f.db.prepare('SELECT * FROM image_uploads').get();assert.ok(stored.file_id_hash);assert.ok(!JSON.stringify(stored).includes('signature='));
});

test('all existing raster formats are detected from bytes and declared MIME must agree',async t=>{
  const f=fixture(t);
  for(const [number,data,type]of[[0,bytes(PNG),'image/png'],[1,bytes(GIF),'image/gif'],[2,bytes(WEBP),'image/webp'],[3,bytes(JPEG),'image/jpeg']]){
    f.controls.body=data;
    const result=await ingestRemoteImage(f.env,input('format-'+number,{file_id:'file_'+number,mime_type:type}),f.options());assert.equal(result.mimeType,type);
  }
  f.controls.body=bytes(PNG);await assert.rejects(ingestRemoteImage(f.env,input('wrong-type',{mime_type:'image/jpeg'}),f.options()),fails('invalid_image'));
  for(const data of [new Uint8Array(),new TextEncoder().encode('<svg>not a raster</svg>'),Uint8Array.from([0xff,0xd8,0xff,0xd9])]){
    f.controls.body=data;await assert.rejects(ingestRemoteImage(f.env,input('bad-'+data.length),f.options()),fails('invalid_image'));
  }
});

test('animated GIF, progressive JPEG, and transparent, lossless and animated WebP retain their original bytes',async t=>{
  const f=fixture(t);
  for(const [index,[type,data]]of VARIANTS.entries()) {
    f.controls.body=bytes(data);
    const result=await ingestRemoteImage(f.env,input('variant-'+index,{mime_type:type}),f.options());
    const [{source}]=await resolveStagedImages(f.env,[{uploadId:result.uploadId}],f.options());
    assert.deepEqual(f.objects.get(source.key),bytes(data));
  }
});

test('container-only or truncated raster headers cannot masquerade as verified images',async t=>{
  const f=fixture(t), gifHeader=bytes(GIF).slice(0,25);
  gifHeader[gifHeader.length-1]=0x3b;
  const webpHeader=bytes(VARIANTS[1][1]).slice(0,30);new DataView(webpHeader.buffer).setUint32(4,22,true);
  const truncatedPng=bytes(PNG).slice(0,-12);
  const truncatedJpeg=bytes(JPEG).slice(0,bytes(JPEG).length-3);truncatedJpeg[truncatedJpeg.length-2]=0xff;truncatedJpeg[truncatedJpeg.length-1]=0xd9;
  for(const [index,data]of[gifHeader,webpHeader,truncatedPng,truncatedJpeg].entries()) {
    f.controls.body=data;await assert.rejects(ingestRemoteImage(f.env,input('truncated-'+index),f.options()),fails('invalid_image'));
  }
  assert.equal(f.objects.size,0);
});

test('verified retries survive expired download URLs, renewed staging retains identity, and changed requests fail',async t=>{
  const f=fixture(t), first=await ingestRemoteImage(f.env,input(),f.options());
  f.controls.fetchHook=()=>{throw new Error('Must not refetch a verified immutable file');};
  const replay=await ingestRemoteImage(f.env,input('upload-one',{download_url:'https://files.oaiusercontent.com/private/image?signature=renewed'}),f.options());
  assert.equal(replay.replayed,true);assert.equal(replay.uploadId,first.uploadId);assert.equal(f.calls.fetch,1);assert.equal(f.calls.puts,1);
  await assert.rejects(ingestRemoteImage(f.env,input('upload-one',{file_name:'Different.png'}),f.options()),fails('image_request_reused'));
  const late=f.options({now:STAMP+IMAGE_UPLOAD_LIMITS.ttlMs+1});
  assert.equal((await getImageUploadStatus(f.env,{uploadId:first.uploadId},late)).status,'expired');
  await assert.rejects(resolveStagedImages(f.env,[{uploadId:first.uploadId}],late),fails('image_upload_expired'));
  const renewed=await ingestRemoteImage(f.env,input(),late);assert.equal(renewed.uploadId,first.uploadId);assert.equal(renewed.verified,true);assert.ok(renewed.expiresAt>first.expiresAt);assert.equal(f.calls.fetch,1);
});

test('owner isolation and strict schemas reject cross-account or malformed upload references',async t=>{
  const f=fixture(t), result=await ingestRemoteImage(f.env,input(),f.options());
  for(const operation of [()=>getImageUploadStatus(f.env,{uploadId:result.uploadId},f.options({ownerId:'another-owner'})),()=>resolveStagedImages(f.env,[{uploadId:result.uploadId}],f.options({ownerId:'another-owner'}))])await assert.rejects(operation(),fails('image_upload_missing'));
  for(const value of [{...input(),extra:true},input(''),input('bad request'),input('x',{extra:true}),input('x',{file_id:''}),input('x',{mime_type:'image/svg+xml'}),input('x',{file_name:'bad\nname.png'})])assert.throws(()=>validateImageUploadArguments(value),ImageUploadError);
  await assert.rejects(getImageUploadStatus(f.env,{uploadId:result.uploadId,extra:true},f.options()),fails('invalid_image_upload'));
  await assert.rejects(resolveStagedImages(f.env,[{uploadId:'missing'}],f.options()),fails('invalid_image_upload'));
});

test('file handoff cannot fetch arbitrary origins, credentials, alternate ports or private redirect destinations',async t=>{
  const f=fixture(t);
  const urls=['http://files.oaiusercontent.com/a','https://files.oaiusercontent.com:444/a','https://user:secret@files.oaiusercontent.com/a','https://files.oaiusercontent.com.evil.example/a','https://127.0.0.1/a','https://169.254.169.254/latest','https://[::1]/a','https://example.test/a','https://files.oaiusercontent.com/a#fragment','file:///private/a.png','https://files.oaiusercontent.com./a'];
  for(const download_url of urls)await assert.rejects(ingestRemoteImage(f.env,input('source-'+urls.indexOf(download_url),{download_url}),f.options()),fails('image_source_not_allowed'));
  assert.equal(f.calls.fetch,0);assert.equal(f.db.prepare('SELECT count(*) AS n FROM image_uploads').get().n,0);
  f.controls.response=new Response('',{status:302,headers:{location:'http://127.0.0.1/private'}});
  await assert.rejects(ingestRemoteImage(f.env,input(),f.options()),error=>fails('image_source_not_allowed')(error)&&error.details.phase==='redirect'&&error.details.downloadStatus===302);assert.equal(f.objects.size,0);
  f.controls.response=null;const retried=await ingestRemoteImage(f.env,input(),f.options());assert.equal(retried.verified,true);
});

test('official redirects are followed manually up to three hops with one deadline and no forwarded credentials',async t=>{
  const f=fixture(t), seen=[], signals=[];
  f.controls.fetchHook=(url,options)=>{
    seen.push(url);signals.push(options.signal);
    if(seen.length===1)return new Response('',{status:301,headers:{location:'/step?token=PRIVATE_SIGNED_TOKEN'}});
    if(seen.length===2)return new Response('',{status:307,headers:{location:'https://region.oaiusercontent.com/file?token=PRIVATE_REGIONAL_TOKEN'}});
    if(seen.length===3)return new Response('',{status:308,headers:{location:'/final.png'}});
    return new Response(bytes(PNG));
  };
  const result=await ingestRemoteImage(f.env,input(),f.options());assert.equal(result.verified,true);assert.equal(seen.length,4);
  assert.ok(signals.every(signal=>signal===signals[0]));assert.match(seen[1],/^https:\/\/files\.oaiusercontent\.com\/step\?/);assert.equal(seen[3],'https://region.oaiusercontent.com/final.png');
  assert.doesNotMatch(JSON.stringify(result),/PRIVATE_|SIGNED|REGIONAL/);
});

test('redirect targets are checked at every hop and loops or missing locations stop with safe diagnostics',async t=>{
  const f=fixture(t);
  const targets=['https://example.test/private?token=PRIVATE_TOKEN','http://files.oaiusercontent.com/a','https://127.0.0.1/a','https://user:PRIVATE_SECRET@files.oaiusercontent.com/a','https://files.oaiusercontent.com:444/a','https://files.oaiusercontent.com.evil.test/a'];
  for(const [index,target]of targets.entries()){
    const before=f.calls.fetch;f.controls.fetchHook=()=>new Response('',{status:302,headers:{location:target}});
    await assert.rejects(ingestRemoteImage(f.env,input('redirect-bad-'+index),f.options()),error=>{
      assert.equal(error.code,'image_source_not_allowed');assert.deepEqual(error.details,{phase:'redirect',downloadStatus:302});assert.doesNotMatch(JSON.stringify(error),/PRIVATE_|https|127\.0\.0\.1/);return true;
    });assert.equal(f.calls.fetch,before+1);
  }
  f.controls.fetchHook=()=>new Response('',{status:303,headers:{location:'/loop?token=PRIVATE_LOOP'}});
  const before=f.calls.fetch;
  await assert.rejects(ingestRemoteImage(f.env,input('redirect-loop'),f.options()),error=>fails('image_download_failed')(error)&&error.details.phase==='redirect'&&error.details.downloadStatus===303);
  assert.equal(f.calls.fetch,before+4);assert.equal(f.objects.size,0);
  f.controls.fetchHook=()=>new Response('',{status:302});
  await assert.rejects(ingestRemoteImage(f.env,input('redirect-missing'),f.options()),error=>fails('image_download_failed')(error)&&error.details.phase==='redirect');
});

test('HTTP errors and fetch or body failures expose only fixed phases, status and allowlisted exception names',async t=>{
  const f=fixture(t);
  f.controls.fetchHook=()=>new Response('PRIVATE_PROVIDER_BODY',{status:403,headers:{'x-private-token':'PRIVATE_HEADER'}});
  await assert.rejects(ingestRemoteImage(f.env,input('http-error'),f.options()),error=>{assert.deepEqual(error.details,{phase:'response',downloadStatus:403});return fails('image_download_failed')(error);});
  for(const [index,name]of ['TypeError','PRIVATE_TOKEN_IN_NAME'].entries()) {
    f.controls.fetchHook=()=>{throw Object.assign(new Error('PRIVATE_EXCEPTION_MESSAGE'),{name});};
    await assert.rejects(ingestRemoteImage(f.env,input('fetch-error-'+index),f.options()),error=>{assert.deepEqual(error.details,{phase:'fetch',causeName:index===0?'TypeError':'Error'});assert.doesNotMatch(JSON.stringify(error),/PRIVATE_/);return fails('image_download_failed')(error);});
  }
  f.controls.fetchHook=()=>new Response(new ReadableStream({start(controller){controller.error(new Error('PRIVATE_STREAM_ERROR'));}}));
  await assert.rejects(ingestRemoteImage(f.env,input('read-error'),f.options()),error=>{assert.deepEqual(error.details,{phase:'read',downloadStatus:200,causeName:'Error'});return fails('image_download_failed')(error);});
});

test('the shared deadline bounds a pending redirect fetch and a stalled body read, and cancels body consumption',async t=>{
  const f=fixture(t);let timers=0;
  t.mock.method(AbortSignal,'timeout',milliseconds=>{assert.equal(milliseconds,30_000);timers++;const controller=new AbortController();setTimeout(()=>controller.abort(new DOMException('PRIVATE_TIMEOUT_MESSAGE','TimeoutError')),5);return controller.signal;});
  let hops=0;
  f.controls.fetchHook=()=>++hops===1?new Response('',{status:302,headers:{location:'/wait'}}):new Promise(()=>{});
  await assert.rejects(ingestRemoteImage(f.env,input('fetch-timeout'),f.options()),error=>{assert.deepEqual(error.details,{phase:'fetch',causeName:'TimeoutError'});return fails('image_download_failed')(error);});
  assert.equal(timers,1);assert.equal(hops,2);
  let cancelled=false;f.controls.fetchHook=()=>new Response(new ReadableStream({cancel(){cancelled=true;}}));
  await assert.rejects(ingestRemoteImage(f.env,input('read-timeout'),f.options()),error=>{assert.deepEqual(error.details,{phase:'read',downloadStatus:200,causeName:'TimeoutError'});return fails('image_download_failed')(error);});
  assert.equal(cancelled,true);assert.equal(f.objects.size,0);
});

test('fresh native file IDs replay only after original description and exact verified bytes agree',async t=>{
  const f=fixture(t), descriptor={file_name:'diagram.png',mime_type:'image/png'};
  const first=await ingestRemoteImage(f.env,input('fresh-native',descriptor),f.options());
  const replay=await ingestRemoteImage(f.env,input('fresh-native',{...descriptor,file_id:'file_new_handoff'}),f.options());
  assert.equal(replay.replayed,true);assert.equal(replay.uploadId,first.uploadId);assert.equal(replay.sha256,first.sha256);assert.equal(f.calls.fetch,2);assert.equal(f.calls.puts,1);
  for(const changed of [{file_name:'changed.png'},{mime_type:'application/octet-stream'}])await assert.rejects(ingestRemoteImage(f.env,input('fresh-native',{...descriptor,...changed,file_id:'file_changed_description'}),f.options()),fails('image_request_reused'));
  assert.equal(f.calls.fetch,2);
  const changed=bytes(PNG);changed[changed.length-15]^=1;f.controls.body=changed;
  await assert.rejects(ingestRemoteImage(f.env,input('fresh-native',{...descriptor,file_id:'file_changed_bytes'}),f.options()),fails('image_request_reused'));
  assert.equal((await getImageUploadStatus(f.env,{uploadId:first.uploadId},f.options())).verified,true);assert.equal(f.calls.puts,1);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM image_uploads').get().n,1);
});

test('failed handoffs accept fresh IDs with the same description, including legacy rows without accepted bytes',async t=>{
  const f=fixture(t), descriptor={file_name:'native.png',mime_type:'image/png'};
  f.controls.fetchHook=()=>{throw new TypeError('PRIVATE_FETCH_FAILURE');};
  await assert.rejects(ingestRemoteImage(f.env,input('fresh-after-failure',descriptor),f.options()),fails('image_download_failed'));
  const legacyHash=await sha256(new TextEncoder().encode(JSON.stringify(['file_fixture',descriptor.file_name,descriptor.mime_type])));
  f.db.prepare('UPDATE image_uploads SET file_id_hash = ?').run(legacyHash);
  f.controls.fetchHook=null;
  const result=await ingestRemoteImage(f.env,input('fresh-after-failure',{...descriptor,file_id:'file_retry_fresh'}),f.options());assert.equal(result.verified,true);
  assert.match(f.db.prepare('SELECT file_id_hash FROM image_uploads').get().file_id_hash,/^v2:[a-f0-9]{64}:[a-f0-9]{64}$/);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM image_uploads').get().n,1);assert.equal(f.calls.puts,1);
});

test('stream limits cancel oversize transfers before persistence and reject unsafe dimensions',async t=>{
  const f=fixture(t);let cancelled=false;
  f.controls.response=new Response(new ReadableStream({start(controller){controller.enqueue(new Uint8Array(IMAGE_UPLOAD_LIMITS.fileBytes));controller.enqueue(new Uint8Array(1));},cancel(){cancelled=true;}}));
  await assert.rejects(ingestRemoteImage(f.env,input('oversize-stream'),f.options()),fails('image_too_large'));assert.equal(cancelled,true);assert.equal(f.objects.size,0);
  f.controls.response=new Response('x',{headers:{'content-length':String(IMAGE_UPLOAD_LIMITS.fileBytes+1)}});
  await assert.rejects(ingestRemoteImage(f.env,input('oversize-header'),f.options()),fails('image_too_large'));
  f.controls.response=null;const huge=bytes(PNG);new DataView(huge.buffer).setUint32(16,20000);f.controls.body=huge;
  await assert.rejects(ingestRemoteImage(f.env,input('huge-dimensions'),f.options()),fails('invalid_image'));
  const hugeGif=bytes(GIF);hugeGif[6]=0xff;hugeGif[7]=0xff;f.controls.body=hugeGif;
  await assert.rejects(ingestRemoteImage(f.env,input('huge-gif'),f.options()),fails('invalid_image'));
  const hugeJpeg=bytes(JPEG), sof=hugeJpeg.findIndex((byte,index)=>byte===0xff&&hugeJpeg[index+1]===0xc0);
  hugeJpeg[sof+7]=0x7f;hugeJpeg[sof+8]=0xff;f.controls.body=hugeJpeg;
  await assert.rejects(ingestRemoteImage(f.env,input('huge-jpeg'),f.options()),fails('invalid_image'));
  const hugeWebp=bytes(VARIANTS[1][1]);hugeWebp[24]=0xff;hugeWebp[25]=0xff;hugeWebp[26]=0xff;f.controls.body=hugeWebp;
  await assert.rejects(ingestRemoteImage(f.env,input('huge-webp'),f.options()),fails('invalid_image'));
});

test('stored byte corruption refuses verification and retains quota accounting after provider failure',async t=>{
  const f=fixture(t);f.controls.corruptWrite=true;
  await assert.rejects(ingestRemoteImage(f.env,input(),f.options()),fails('image_upload_corrupt'));
  const row=f.db.prepare('SELECT * FROM image_uploads').get();assert.equal(row.status,'failed');assert.equal(row.bytes,bytes(PNG).length);assert.match(row.sha256,/^[a-f0-9]{64}$/);
  f.controls.corruptWrite=false;f.objects.clear();const verified=await ingestRemoteImage(f.env,input(),f.options());assert.equal(verified.verified,true);
  const [key,data]=[...f.objects][0];const corrupt=new Uint8Array(data);corrupt[30]^=1;f.objects.set(key,corrupt);
  await assert.rejects(getImageUploadStatus(f.env,{uploadId:verified.uploadId},f.options()),fails('image_upload_corrupt'));
  await assert.rejects(resolveStagedImages(f.env,[{uploadId:verified.uploadId}],f.options()),fails('image_upload_corrupt'));
});

test('failed downloads are retryable without sensitive exception text or published library changes',async t=>{
  const f=fixture(t);f.controls.fetchHook=()=>{throw new Error('PRIVATE_TOKEN_IN_DOWNLOAD_EXCEPTION');};
  await assert.rejects(ingestRemoteImage(f.env,input(),f.options()),fails('image_download_failed'));
  let row=f.db.prepare('SELECT * FROM image_uploads').get();assert.equal(row.status,'failed');assert.equal(row.bytes,0);
  const pending=await getImageUploadStatus(f.env,{uploadId:row.id},f.options());assert.equal(pending.status,'failed');assert.equal(pending.verified,false);assert.equal(pending.assetId,undefined);
  await assert.rejects(resolveStagedImages(f.env,[{uploadId:row.id}],f.options()),fails('image_upload_incomplete'));
  f.controls.fetchHook=null;const retry=await ingestRemoteImage(f.env,input(),f.options());assert.equal(retry.uploadId,row.id);assert.equal(retry.verified,true);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM library_commits').get().n,0);
});

test('active request and retained-byte quotas include expired blobs but count duplicate immutable hashes once',async t=>{
  const f=fixture(t), insert=f.db.prepare('INSERT INTO image_uploads VALUES(?,?,?,?,?,?,?,?,?,?,?)');
  const expired=new Date(STAMP-1).toISOString(), created=new Date(STAMP-1000).toISOString();
  for(let i=0;i<12;i++)insert.run('image-upload-'+String(i).padStart(64,'0'),OWNER,'quota-'+i,'hash',String(i).padStart(64,'0'),'image.png','image/png',IMAGE_UPLOAD_LIMITS.fileBytes,'verified',created,expired);
  await assert.rejects(ingestRemoteImage(f.env,input(),f.options()),fails('image_upload_quota'));assert.equal(f.calls.fetch,0);
  f.db.exec('DELETE FROM image_uploads');
  for(let i=0;i<64;i++)insert.run('image-upload-'+String(i).padStart(64,'0'),OWNER,'active-'+i,'hash','a'.repeat(64),'image.png','image/png',68,'verified',created,new Date(STAMP+10000).toISOString());
  await assert.rejects(ingestRemoteImage(f.env,input(),f.options()),fails('image_upload_quota'));assert.equal(f.calls.fetch,0);
  f.db.exec('DELETE FROM image_uploads');
  for(let i=0;i<12;i++)insert.run('image-upload-'+String(i).padStart(64,'0'),OWNER,'duplicate-'+i,'hash','a'.repeat(64),'image.png','image/png',IMAGE_UPLOAD_LIMITS.fileBytes,'verified',created,expired);
  assert.equal((await ingestRemoteImage(f.env,input(),f.options())).verified,true);
});

test('a killed worker reservation is reclaimed by a fresh attempt without stale completion overwriting it',async t=>{
  const f=fixture(t);let release;
  const gate=new Promise(resolve=>{release=resolve;});let started;
  const began=new Promise(resolve=>{started=resolve;});
  f.controls.fetchHook=async()=>{started();await gate;return new Response(bytes(PNG));};
  const first=ingestRemoteImage(f.env,input(),f.options());await began;
  await assert.rejects(ingestRemoteImage(f.env,input(),f.options()),fails('image_upload_busy'));
  f.controls.fetchHook=null;
  const recovered=await ingestRemoteImage(f.env,input(),f.options({now:STAMP+IMAGE_UPLOAD_LIMITS.leaseMs+1}));assert.equal(recovered.verified,true);
  release();await assert.rejects(first,fails('image_upload_busy'));
  assert.equal((await getImageUploadStatus(f.env,{uploadId:recovered.uploadId},f.options())).verified,true);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM image_uploads').get().n,1);assert.equal(f.objects.size,1);
});

test('per-binding memory slots refuse a third concurrent ingest before writes and always release after success or failure',async t=>{
  const f=fixture(t), other=fixture(t);let release, began, active=0;
  const gate=new Promise(resolve=>{release=resolve;}), started=new Promise(resolve=>{began=resolve;});
  f.controls.fetchHook=async()=>{if(++active===2)began();await gate;return new Response(bytes(PNG));};
  const first=ingestRemoteImage(f.env,input('slot-one'),f.options()), second=ingestRemoteImage(f.env,input('slot-two'),f.options());
  await started;
  await assert.rejects(ingestRemoteImage(f.env,input('slot-three'),f.options()),fails('image_upload_busy'));
  assert.equal(f.calls.fetch,2);assert.equal(f.db.prepare('SELECT count(*) AS n FROM image_uploads').get().n,2);
  assert.equal((await ingestRemoteImage(other.env,input('different-binding'),other.options())).verified,true,'unrelated bindings have their own slots');
  release();assert.deepEqual((await Promise.all([first,second])).map(result=>result.verified),[true,true]);
  f.controls.fetchHook=()=>{throw new Error('PRIVATE_SYNTHETIC_FAILURE');};
  for(const requestId of ['failure-one','failure-two','failure-three'])await assert.rejects(ingestRemoteImage(f.env,input(requestId),f.options()),fails('image_download_failed'));
  f.controls.fetchHook=null;
  assert.equal((await ingestRemoteImage(f.env,input('slot-three'),f.options())).verified,true);
});
