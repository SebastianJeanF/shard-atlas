// Portable capsules keep their existing wire format. Image strings are streamed
// around a bounded metadata parse instead of decoding the entire library in RAM.
import {validateCapsule} from '../../sync/client.mjs';
import {ARCHIVE_VERSION, CHUNK_BYTES, MAX_ARCHIVE_BYTES, PROTOCOL_VERSION, sha256, validateManifest} from '../../sync/protocol.mjs';

export const MAX_CLOUD_METADATA_BYTES = 16 * 1024 * 1024;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024, MAX_IMAGE_DATA = Math.ceil(MAX_IMAGE_BYTES / 3) * 4;
const sources = new WeakMap(), encoder = new TextEncoder();
const HASH = /^[a-f0-9]{64}$/;
export class CloudCapsuleError extends Error {
  constructor(code = 'cloud_library_invalid', status = 422) {
    super(code === 'cloud_snapshot_too_large' ? 'The non-image library metadata exceeds the remote capacity.' : 'The cloud library could not be verified.');
    this.name = 'CloudCapsuleError'; this.code = code; this.status = status;
  }
}
const invalid = () => {throw new CloudCapsuleError();};
const tooLarge = () => {throw new CloudCapsuleError('cloud_snapshot_too_large', 413);};

// Incremental SHA-256 avoids retaining a complete portable snapshot for digest().
const K = new Uint32Array([0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2]);
const rotate = (x, n) => (x >>> n) | (x << (32 - n));
export class IncrementalSha256 {
  constructor() {this.state = new Uint32Array([0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19]); this.buffer = new Uint8Array(64); this.used = 0; this.bytes = 0; this.words = new Uint32Array(64);}
  block(data, offset) {
    const w = this.words;
    for (let i = 0; i < 16; i++) {const j = offset + i * 4; w[i] = (data[j] << 24) | (data[j+1] << 16) | (data[j+2] << 8) | data[j+3];}
    for (let i = 16; i < 64; i++) {const a = w[i-15], b = w[i-2]; w[i] = (w[i-16] + (rotate(a,7)^rotate(a,18)^(a>>>3)) + w[i-7] + (rotate(b,17)^rotate(b,19)^(b>>>10))) >>> 0;}
    let [a,b,c,d,e,f,g,h] = this.state;
    for (let i = 0; i < 64; i++) {const t1 = (h + (rotate(e,6)^rotate(e,11)^rotate(e,25)) + ((e&f)^(~e&g)) + K[i] + w[i]) >>> 0; const t2 = ((rotate(a,2)^rotate(a,13)^rotate(a,22)) + ((a&b)^(a&c)^(b&c))) >>> 0; h=g;g=f;f=e;e=(d+t1)>>>0;d=c;c=b;b=a;a=(t1+t2)>>>0;}
    const values = [a,b,c,d,e,f,g,h]; for (let i=0;i<8;i++) this.state[i] = (this.state[i]+values[i])>>>0;
  }
  update(data) {
    if (!(data instanceof Uint8Array)) invalid(); this.bytes += data.byteLength;
    let offset = 0;
    if (this.used) {const n=Math.min(64-this.used,data.length);this.buffer.set(data.subarray(0,n),this.used);this.used+=n;offset+=n;if(this.used===64){this.block(this.buffer,0);this.used=0;}}
    while (offset + 64 <= data.length) {this.block(data,offset);offset+=64;}
    if(offset<data.length){this.buffer.set(data.subarray(offset),0);this.used=data.length-offset;} return this;
  }
  hex() {
    const copy=new IncrementalSha256();copy.state.set(this.state);copy.buffer.set(this.buffer);copy.used=this.used;copy.bytes=this.bytes;
    const length=this.bytes,pad=new Uint8Array(this.used<56?64-this.used:128-this.used);pad[0]=128;const view=new DataView(pad.buffer);view.setUint32(pad.length-8,Math.floor(length/0x20000000));view.setUint32(pad.length-4,(length*8)>>>0);copy.update(pad);
    return Array.from(copy.state,n=>n.toString(16).padStart(8,'0')).join('');
  }
}

async function* bodyChunks(value) {
  try{
  value = await value;
  if (value?.body) value = value.body;
  if (value instanceof Uint8Array) {yield value; return;}
  if (value?.getReader) {
    const reader=value.getReader();try{while(true){const part=await reader.read();if(part.done)break;if(!(part.value instanceof Uint8Array))invalid();yield part.value;}}
    finally{await reader.cancel().catch(()=>{});reader.releaseLock();}return;
  }
  if (value?.[Symbol.asyncIterator]) {for await(const part of value){if(!(part instanceof Uint8Array))invalid();yield part;}return;}
  invalid();
  }catch(error){if(error instanceof CloudCapsuleError)throw error;throw new CloudCapsuleError('cloud_library_unavailable',503);}
}

async function verifiedChunk(storage, chunk) {
  let blob;
  try {blob=await storage.blob(chunk.sha256);} catch {throw new CloudCapsuleError('cloud_library_unavailable',503);}
  if (!blob || blob.size !== chunk.bytes) invalid();
  const bytes=new Uint8Array(chunk.bytes);let offset=0;
  try{for await(const part of bodyChunks(blob)){if(offset+part.length>bytes.length)invalid();bytes.set(part,offset);offset+=part.length;}}
  catch(error){if(error instanceof CloudCapsuleError)throw error;throw new CloudCapsuleError('cloud_library_unavailable',503);}
  if(offset!==bytes.length||await sha256(bytes)!==chunk.sha256)invalid();return bytes;
}

class Base64Scan {
  constructor(strict=true){this.strict=strict;this.hash=new IncrementalSha256();this.length=0;this.padding=0;this.last='';}
  append(text){
    if(!this.strict){this.length+=text.length;return;}
    if(!/^[A-Za-z0-9+/]*={0,2}$/.test(text)||this.padding&&text.length&&!/^=+$/.test(text))invalid();
    const padding=(text.match(/=+$/)||[''])[0].length;this.padding+=padding;if(this.padding>2)invalid();
    this.length+=text.length;if(this.length>MAX_IMAGE_DATA)tooLarge();this.last=(this.last+text).slice(-4);this.hash.update(encoder.encode(text));
  }
  finish(){
    if(!this.strict)return {dataSha256:null,dataLength:this.length,decodedBytes:null};
    if(this.length%4)invalid();
    try{if(this.last&&btoa(atob(this.last))!==this.last)invalid();}catch{invalid();}
    const decodedBytes=this.length/4*3-this.padding;if(decodedBytes>MAX_IMAGE_BYTES)tooLarge();
    return {dataSha256:this.hash.hex(),dataLength:this.length,decodedBytes};
  }
}

// This byte scanner strips only the exact archive.assets[index].data string.
// Everything else, including unknown fields and JSON escaping, goes to JSON.parse.
class MetadataScanner {
  constructor(limit,strictImages=true){this.limit=limit;this.strictImages=strictImages;this.parts=[];this.out=new Uint8Array(64*1024);this.used=0;this.size=0;this.stack=[];this.root=false;this.string=null;this.primitive=false;this.offset=0;this.images=[];this.utf8=new TextDecoder('utf-8',{fatal:true});}
  put(byte){if(++this.size>this.limit)tooLarge();this.out[this.used++]=byte;if(this.used===this.out.length){this.parts.push(this.out);this.out=new Uint8Array(64*1024);this.used=0;}}
  consume(){const frame=this.stack.at(-1);if(!frame){if(this.root)invalid();this.root=true;return [];}
    if(frame.type==='object'){if(frame.expect!=='value')invalid();frame.expect='comma';return [...frame.path,frame.key];}
    if(!['value','first'].includes(frame.expect))invalid();frame.expect='comma';return [...frame.path,frame.index++];}
  write(bytes){
    try{this.utf8.decode(bytes,{stream:true});}catch{invalid();}
    for(let i=0;i<bytes.length;i++,this.offset++){
      const byte=bytes[i],text=this.string;
      if(text?.image&&!text.escape){
        let end=i;while(end<bytes.length&&bytes[end]!==34&&bytes[end]!==92)end++;
        if(end>i){const part=bytes.subarray(i,end);if(part.some(b=>b<32))invalid();text.scan.append(new TextDecoder('ascii').decode(part));this.offset+=end-i;i=end;if(i===bytes.length)break;}
      }
      const b=bytes[i];
      if(this.string){
        const token=this.string;
        if(!token.image)this.put(b);
        if(token.key){token.raw.push(b);if(token.raw.length>this.limit)tooLarge();}
        if(token.image){
          if(token.escape){
            token.escaped.push(b);
            if(token.escaped.length===1&&b===117)token.escapeLength=5;
            if(token.escaped.length===(token.escapeLength||1)){
              let decoded;try{decoded=JSON.parse('"\\'+String.fromCharCode(...token.escaped)+'"');}catch{invalid();}
              token.scan.append(decoded);token.escape=false;token.escaped=[];token.escapeLength=0;
            }
            continue;
          }
          if(b===92){token.escape=true;token.escaped=[];continue;}
        }else if(token.escape){token.escape=false;continue;}
        if(b===92){token.escape=true;continue;}
        if(b===34){
          if(token.key){let key;try{key=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Uint8Array.from(token.raw)));}catch{invalid();}const frame=this.stack.at(-1);if(frame.keys.has(key))invalid();frame.keys.add(key);frame.key=key;frame.expect='colon';}
          if(token.image){this.put(34);const details=token.scan.finish();this.images.push({index:token.path[2],start:token.start,end:this.offset,...details});}
          this.string=null;
        }else if(b<32)invalid();
        continue;
      }
      if(this.primitive){if(![9,10,13,32,44,93,125].includes(b)){this.put(b);continue;}this.primitive=false;}
      this.put(b);
      if([9,10,13,32].includes(b))continue;
      const frame=this.stack.at(-1);
      if(b===34){const key=frame?.type==='object'&&['key','first'].includes(frame.expect);const path=key?null:this.consume();const image=path?.length===4&&path[0]==='archive'&&path[1]==='assets'&&Number.isInteger(path[2])&&path[3]==='data';this.string={key,path,image,raw:key?[34]:null,escape:false,...(image?{start:this.offset+1,scan:new Base64Scan(this.strictImages)}: {})};continue;}
      if(b===123||b===91){const path=this.consume();if(this.stack.length>=128)invalid();this.stack.push({type:b===123?'object':'array',path,expect:'first',key:null,index:0,keys:new Set()});continue;}
      if(b===125||b===93){if(!frame||frame.type!==(b===125?'object':'array')||!['first','comma'].includes(frame.expect))invalid();this.stack.pop();continue;}
      if(b===58){if(frame?.type!=='object'||frame.expect!=='colon')invalid();frame.expect='value';continue;}
      if(b===44){if(frame?.expect!=='comma')invalid();frame.expect=frame.type==='object'?'key':'value';continue;}
      this.consume();this.primitive=true;
    }
  }
  finish(){
    try{this.utf8.decode();}catch{invalid();}if(this.string||this.stack.length||!this.root)invalid();
    const bytes=new Uint8Array(this.size);let offset=0;for(const part of this.parts){bytes.set(part,offset);offset+=part.length;}bytes.set(this.out.subarray(0,this.used),offset);
    try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{invalid();}
  }
}

export async function readCloudCapsule(storage, manifest, options={}) {
  manifest=validateManifest(manifest);const strictImages=options.validateImages!==false,scanner=new MetadataScanner(options.metadataBytes??options.metadataLimit??MAX_CLOUD_METADATA_BYTES,strictImages),hash=new IncrementalSha256();
  for(const chunk of manifest.chunks){const bytes=await verifiedChunk(storage,chunk);hash.update(bytes);scanner.write(bytes);}
  if(hash.hex()!==manifest.sha256)invalid();
  const capsule=validateCapsule(scanner.finish()),assets=capsule.archive.assets;
  if(strictImages&&(assets.length>2048||assets.some(asset=>asset&&typeof asset==='object'&&Object.hasOwn(asset,'data')&&typeof asset.data!=='string')))invalid();
  let total=0;
  for(const image of scanner.images){const asset=assets[image.index];if(!asset||asset.data!==''||sources.has(asset))invalid();if(strictImages&&asset.size!==undefined&&asset.size!==image.decodedBytes)invalid();total+=image.decodedBytes||0;if(total>96*1024*1024)tooLarge();sources.set(asset,{kind:'snapshot-json',storage,manifest,...image});}
  return capsule;
}

export function registerAssetSource(...args){
  const [asset,source]=args.length===3?args.slice(1):args;
  if(!asset||typeof asset!=='object'||typeof source?.read!=='function'||!Number.isSafeInteger(source.bytes)||source.bytes<0||source.bytes>MAX_IMAGE_BYTES||!HASH.test(source.sha256||''))invalid();
  if(asset.data!==undefined&&asset.data!=='')invalid();asset.data='';sources.set(asset,{...source,encoding:'binary'});return asset;
}

async function* snapshotData(source,cache){
  let offset=0,total=0;
  for(const chunk of source.manifest.chunks){const end=offset+chunk.bytes;if(end>source.start&&offset<source.end){const bytes=cache.hash===chunk.sha256&&cache.storage===source.storage?cache.bytes:await verifiedChunk(source.storage,chunk);cache.hash=chunk.sha256;cache.storage=source.storage;cache.bytes=bytes;const part=bytes.subarray(Math.max(0,source.start-offset),Math.min(bytes.length,source.end-offset));total+=part.length;yield part;}offset=end;if(offset>=source.end)break;}
  if(total!==source.end-source.start)invalid();
}
function base64(bytes){let binary='';for(let i=0;i<bytes.length;i+=16384)binary+=String.fromCharCode(...bytes.subarray(i,i+16384));return btoa(binary);}
async function* binaryBase64(source){
  const rawHash=new IncrementalSha256();let total=0,tail=new Uint8Array();
  for await(const input of bodyChunks(Promise.resolve().then(()=>source.read()))){
    total+=input.length;if(total>source.bytes||total>MAX_IMAGE_BYTES)invalid();rawHash.update(input);
    for(let offset=0;offset<input.length;offset+=48*1024){const part=input.subarray(offset,offset+48*1024),joined=new Uint8Array(tail.length+part.length);joined.set(tail);joined.set(part,tail.length);const end=joined.length-joined.length%3;if(end)yield encoder.encode(base64(joined.subarray(0,end)));tail=joined.slice(end);}
  }
  if(total!==source.bytes||rawHash.hex()!==source.sha256)invalid();if(tail.length)yield encoder.encode(base64(tail));
}
function sourceFor(asset){return asset?.data===''?sources.get(asset):null;}
export function assetByteSize(asset){
  const source=sourceFor(asset);if(source)return source.kind==='snapshot-json'?source.decodedBytes:source.bytes;
  if(typeof asset?.data!=='string')return 0;
  const scan=new Base64Scan();for(let i=0;i<asset.data.length;i+=32768)scan.append(asset.data.slice(i,i+32768));return scan.finish().decodedBytes;
}
export async function assetDataHash(asset){
  const source=sourceFor(asset);if(source?.kind==='snapshot-json')return source.dataSha256;
  const hash=new IncrementalSha256();
  if(source){for await(const part of binaryBase64(source))hash.update(part);return hash.hex();}
  if(typeof asset?.data!=='string')invalid();for(let i=0;i<asset.data.length;i+=32768)hash.update(encoder.encode(asset.data.slice(i,i+32768)));return hash.hex();
}

function* stringBytes(value){for(let i=0;i<value.length;){let end=Math.min(value.length,i+16384);if(end<value.length&&/[\uD800-\uDBFF]/.test(value[end-1]))end++;yield encoder.encode(value.slice(i,end));i=end;}}
async function* jsonParts(value,path=[],depth=0,ancestors=new Set(),cache={}){
  if(depth>128)invalid();
  if(value===null||typeof value!=='object'){const text=JSON.stringify(value);if(text===undefined)invalid();for(const bytes of stringBytes(text))yield {bytes,media:false};return;}
  if(ancestors.has(value))invalid();ancestors.add(value);
  try{
    if(Array.isArray(value)){
      yield {bytes:encoder.encode('['),media:false};
      for(let i=0;i<value.length;i++){if(i)yield {bytes:encoder.encode(','),media:false};yield* jsonParts(value[i]===undefined?null:value[i],[...path,i],depth+1,ancestors,cache);}
      yield {bytes:encoder.encode(']'),media:false};return;
    }
    yield {bytes:encoder.encode('{'),media:false};let first=true;
    for(const key of Object.keys(value)){
      const item=value[key];if(item===undefined||typeof item==='function'||typeof item==='symbol')continue;
      if(!first)yield {bytes:encoder.encode(','),media:false};first=false;
      yield {bytes:encoder.encode(JSON.stringify(key)+':'),media:false};
      const image=path.length===3&&path[0]==='archive'&&path[1]==='assets'&&Number.isInteger(path[2])&&key==='data';
      if(image){
        if(typeof item!=='string')invalid();
        yield {bytes:encoder.encode('"'),media:false};const source=sourceFor(value);
        if(!cache.metadataOnly){
          if(source){for await(const bytes of source.kind==='snapshot-json'?snapshotData(source,cache):binaryBase64(source))yield {bytes,media:true};}
          else {if(typeof item!=='string')invalid();const scan=new Base64Scan();for(let i=0;i<item.length;i+=32768){const text=item.slice(i,i+32768);scan.append(text);yield {bytes:encoder.encode(text),media:true};}scan.finish();}
        }
        yield {bytes:encoder.encode('"'),media:false};
      }else yield* jsonParts(item,[...path,key],depth+1,ancestors,cache);
    }
    yield {bytes:encoder.encode('}'),media:false};
  }finally{ancestors.delete(value);}
}

export async function prepareCloudSnapshot(storage,capsule,baseRevision,mutationId){
  validateCapsule(capsule);if(typeof baseRevision!=='string'||typeof mutationId!=='string')invalid();
  if(capsule.archive.assets.length>2048)tooLarge();let imageBytes=0;
  for(const asset of capsule.archive.assets){const bytes=assetByteSize(asset);if(bytes===null)invalid();if(typeof asset?.data==='string'&&asset.size!==undefined&&asset.size!==bytes)invalid();imageBytes+=bytes;if(imageBytes>96*1024*1024)tooLarge();}
  // Reject a genuine metadata capacity failure before creating immutable blobs.
  // This walk omits media contents entirely, including source reads and hashing.
  let plannedMetadata=0;
  for await(const part of jsonParts(capsule,[],0,new Set(),{metadataOnly:true})){plannedMetadata+=part.bytes.length;if(plannedMetadata>MAX_CLOUD_METADATA_BYTES)tooLarge();}
  let buffer=new Uint8Array(CHUNK_BYTES),used=0,total=0,metadata=0;const chunks=[],hash=new IncrementalSha256();
  async function flush(){
    if(!used)return;const bytes=used===buffer.length?buffer:buffer.slice(0,used),digest=await sha256(bytes);
    try {const old=await storage.blobInfo(digest);if(!old)await storage.putBlob(digest,bytes);const stored=await storage.blobInfo(digest);if(!stored||stored.size!==bytes.length)throw Error();await verifiedChunk(storage,{sha256:digest,bytes:bytes.length});}
    catch(error){if(error instanceof CloudCapsuleError)throw error;throw new CloudCapsuleError('cloud_library_unavailable',503);}
    chunks.push({sha256:digest,bytes:bytes.length});buffer=new Uint8Array(CHUNK_BYTES);used=0;
  }
  for await(const part of jsonParts(capsule)){
    total+=part.bytes.length;if(total>MAX_ARCHIVE_BYTES)tooLarge();if(!part.media){metadata+=part.bytes.length;if(metadata>MAX_CLOUD_METADATA_BYTES)tooLarge();}hash.update(part.bytes);
    for(let offset=0;offset<part.bytes.length;){const n=Math.min(buffer.length-used,part.bytes.length-offset);buffer.set(part.bytes.subarray(offset,offset+n),used);used+=n;offset+=n;if(used===buffer.length)await flush();}
  }
  await flush();const manifest=validateManifest({protocolVersion:PROTOCOL_VERSION,archiveVersion:ARCHIVE_VERSION,format:'shard-atlas-library-json',sha256:hash.hex(),bytes:total,chunks});
  return {mutationId,baseRevision,manifest,chunks:[]};
}
export const prepareCloudCapsule=(storage,capsule,{baseRevision,mutationId})=>prepareCloudSnapshot(storage,capsule,baseRevision,mutationId);
