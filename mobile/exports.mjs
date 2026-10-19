// Portable exports use only standard JavaScript so they also work offline on iOS.
const encoder = new TextEncoder();
const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) value = crcTable[(value ^ byte) & 255] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function safeId(value, fallback) {
  const bytes = encoder.encode(String(value ?? '') || fallback);
  return Array.from(bytes, (byte, index) => {
    const character = String.fromCharCode(byte);
    return /[A-Za-z0-9_.-]/.test(character) && !(index === 0 && character === '.')
      ? character : '~' + byte.toString(16).toUpperCase().padStart(2, '0');
  }).join('');
}

function titleSlug(title) {
  return String(title ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'shard';
}

function uniquePath(path, used) {
  let result = path;
  for (let suffix = 2; used.has(result); suffix++) {
    const extension = path.endsWith('.md') ? '.md' : '';
    result = path.slice(0, path.length - extension.length) + '-' + suffix + extension;
  }
  used.add(result);
  return result;
}

function base64Bytes(data) {
  if (typeof data !== 'string') throw new TypeError('A complete archive must include every asset’s base64 data.');
  const text = data.replace(/\s/g, '');
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(text)) {
    throw new TypeError('An archive asset contains invalid base64 data.');
  }
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const padding = text.endsWith('==') ? 2 : text.endsWith('=') ? 1 : 0;
  const output = new Uint8Array(text.length / 4 * 3 - padding);
  let position = 0;
  for (let offset = 0; offset < text.length; offset += 4) {
    const group = (alphabet.indexOf(text[offset]) << 18) | (alphabet.indexOf(text[offset + 1]) << 12)
      | ((text[offset + 2] === '=' ? 0 : alphabet.indexOf(text[offset + 2])) << 6)
      | (text[offset + 3] === '=' ? 0 : alphabet.indexOf(text[offset + 3]));
    for (const shift of [16, 8, 0]) if (position < output.length) output[position++] = (group >>> shift) & 255;
  }
  return output;
}

// Only rewrite image destinations in prose. In particular, C++ examples and
// inline literals containing /assets/ must remain byte-for-byte unchanged.
function portableContent(content, assetPaths) {
  let fence = null;
  let inlineTicks = 0;
  return String(content ?? '').replace(/[^\r\n]+|\r\n|[\r\n]/g, line => {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (fence) {
      if (marker && marker[1][0] === fence.character && marker[1].length >= fence.length && !marker[2].trim()) fence = null;
      return line;
    }
    if (marker) {
      fence = { character: marker[1][0], length: marker[1].length };
      return line;
    }
    if (/^(?: {4}|\t)/.test(line)) return line;
    return line.replace(/`+|!\[(?:\\.|[^\]\\])*\]\(\/assets\/([^\s)]+)\)/g, (whole, assetId, offset) => {
      let slashes = 0;
      for (let index = offset - 1; index >= 0 && line[index] === '\\'; index--) slashes++;
      if (slashes % 2) return whole;
      if (whole[0] === '`') {
        if (!inlineTicks) inlineTicks = whole.length;
        else if (inlineTicks === whole.length) inlineTicks = 0;
        return whole;
      }
      const path = assetPaths.get(assetId);
      return !inlineTicks && path ? whole.replace('/assets/' + assetId, '../' + path) : whole;
    });
  });
}

function markdown(shard, archive, assetPaths, notePaths) {
  const title = String(shard.title ?? 'Untitled shard').replace(/[\r\n]/g, ' ');
  const lines = ['# ' + title, ''];
  for (const [key, label] of [
    ['id', 'ID'], ['kind', 'Kind'], ['status', 'Status'], ['createdAt', 'Created'],
    ['updatedAt', 'Updated'], ['languageVersion', 'Language version'], ['eventDate', 'Event date'],
    ['evidenceStatus', 'Evidence status'], ['publicationDate', 'Published'], ['verifiedDate', 'Verified'],
  ]) if (shard[key] !== undefined && shard[key] !== '') lines.push(label + ': ' + String(shard[key]));
  if (Array.isArray(shard.tags) && shard.tags.length) lines.push('Tags: ' + shard.tags.join(', '));
  lines.push('', '## Explanation', '', portableContent(shard.content, assetPaths));
  const sources = Array.isArray(shard.sources) ? [...shard.sources] : [];
  if (shard.sourceUrl && !sources.some(source => source.url === shard.sourceUrl)) sources.unshift({ url: shard.sourceUrl, title: 'Primary source' });
  if (sources.length) {
    lines.push('', '## Sources', '');
    for (const source of sources) {
      lines.push('- ' + (source.title || 'Source') + (source.url ? ': ' + source.url : ''));
      if (source.publishedDate) lines.push('  Published: ' + source.publishedDate);
      if (source.accessedDate) lines.push('  Accessed: ' + source.accessedDate);
      if (source.note) lines.push('  ' + source.note);
    }
  }
  const relationships = (archive.links || []).filter(link => link.fromId === shard.id || link.toId === shard.id);
  if (relationships.length) {
    const shards = new Map((archive.shards || []).map(note => [note.id, note]));
    const endpoint = id => {
      const title = String(shards.get(id)?.title || id).replace(/[\[\]\r\n]/g, ' ');
      const path = notePaths.get(id);
      return (path ? '[' + title + '](' + path.slice('notes/'.length) + ')' : title) + ' (' + id + ')';
    };
    lines.push('', '## Relationships', '');
    for (const link of relationships) {
      lines.push('- ' + endpoint(link.fromId) + ' → ' + String(link.type || 'related_to').replace(/_/g, ' ') + ' → ' + endpoint(link.toId));
      if (link.note) lines.push('  ' + link.note);
    }
  }
  return lines.join('\n') + '\n';
}

function storedZip(files) {
  if (files.length > 0xffff) throw new RangeError('This export contains too many files for a standard ZIP.');
  const entries = files.map(file => {
    const name = encoder.encode(file.path);
    const data = typeof file.data === 'string' ? encoder.encode(file.data) : file.data;
    if (name.length > 0xffff || data.length > 0xffffffff) throw new RangeError('This export exceeds standard ZIP limits.');
    return { name, data, crc: crc32(data) };
  });
  const localSize = entries.reduce((size, entry) => size + 30 + entry.name.length + entry.data.length, 0);
  const centralSize = entries.reduce((size, entry) => size + 46 + entry.name.length, 0);
  if (localSize + centralSize + 22 > 0xffffffff) throw new RangeError('This export exceeds standard ZIP limits.');
  const output = new Uint8Array(localSize + centralSize + 22);
  const view = new DataView(output.buffer);
  const u16 = (offset, value) => view.setUint16(offset, value, true);
  const u32 = (offset, value) => view.setUint32(offset, value, true);
  let offset = 0;
  for (const entry of entries) {
    entry.offset = offset;
    u32(offset, 0x04034b50); u16(offset + 4, 20); u16(offset + 6, 0x0800);
    u16(offset + 10, 0); u16(offset + 12, 0x21); // DOS epoch: 1980-01-01.
    u32(offset + 14, entry.crc); u32(offset + 18, entry.data.length); u32(offset + 22, entry.data.length);
    u16(offset + 26, entry.name.length);
    output.set(entry.name, offset + 30); output.set(entry.data, offset + 30 + entry.name.length);
    offset += 30 + entry.name.length + entry.data.length;
  }
  const centralOffset = offset;
  for (const entry of entries) {
    u32(offset, 0x02014b50); u16(offset + 4, 20); u16(offset + 6, 20); u16(offset + 8, 0x0800);
    u16(offset + 12, 0); u16(offset + 14, 0x21);
    u32(offset + 16, entry.crc); u32(offset + 20, entry.data.length); u32(offset + 24, entry.data.length);
    u16(offset + 28, entry.name.length); u32(offset + 42, entry.offset);
    output.set(entry.name, offset + 46);
    offset += 46 + entry.name.length;
  }
  u32(offset, 0x06054b50); u16(offset + 8, entries.length); u16(offset + 10, entries.length);
  u32(offset + 12, centralSize); u32(offset + 16, centralOffset);
  return output;
}

/** Export a complete archive as a portable, uncompressed ZIP without mutating it. */
export function markdownZip(archive) {
  if (!archive || typeof archive !== 'object' || Array.isArray(archive)) throw new TypeError('An archive object is required.');
  const files = [
    { path: 'shard-atlas.json', data: JSON.stringify(archive, null, 2) + '\n' },
    { path: 'relationships.json', data: JSON.stringify(archive.links || [], null, 2) + '\n' },
  ];
  const used = new Set(files.map(file => file.path));
  const assetPaths = new Map();
  for (const [index, asset] of (archive.assets || []).entries()) {
    const path = uniquePath('assets/' + safeId(asset.id, 'asset-' + (index + 1)), used);
    if (!assetPaths.has(asset.id)) assetPaths.set(asset.id, path);
    files.push({ path, data: base64Bytes(asset.data) });
  }
  const notePaths = new Map();
  const notes = (archive.shards || []).map((shard, index) => {
    const path = uniquePath('notes/' + titleSlug(shard.title) + '--' + safeId(shard.id, 'shard-' + (index + 1)) + '.md', used);
    if (!notePaths.has(shard.id)) notePaths.set(shard.id, path);
    return { shard, path };
  });
  for (const { shard, path } of notes) files.push({ path, data: markdown(shard, archive, assetPaths, notePaths) });
  return storedZip(files);
}
