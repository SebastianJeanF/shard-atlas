// Stateless proof that the current canonical guide was delivered to this owner.
// This is a freshness/sequence guard, not proof of reading or understanding.
const COMPILED_GUIDE = typeof __SHARD_ATLAS_CONTRIBUTION_GUIDE__ === 'string' ? __SHARD_ATLAS_CONTRIBUTION_GUIDE__ : null;
const DOMAIN = 'shard-atlas:contribution-guide-read:v1\n';
const TTL_MS = 60 * 60 * 1000;
const MAX_GUIDE_BYTES = 256 * 1024;
const MAX_RECEIPT_CHARS = 4096;
const HASH = /^[a-f0-9]{64}$/;
const encoder = new TextEncoder();
const messages = Object.freeze({
  instructions_unavailable: 'The current contribution guide is unavailable. No new save was attempted. When available, refresh the guide and retry the identical batch and request ID to check any earlier outcome.',
  guide_receipt_unconfigured: 'Direct contributions are not configured yet. No new save was attempted. Once configured, refresh the guide and retry the identical batch and request ID to check any earlier outcome.',
  guide_read_required: 'Call shard_atlas_get_instructions, read and apply its complete guide, then pass version and readReceipt as instructionsVersion and instructionsReceipt. No new save was attempted. Retry the identical batch and request ID to check any earlier outcome.',
  guide_changed: 'The contribution guide changed. Read the current guide again and review the unchanged batch. No new save was attempted. Retry the identical batch and request ID to check any earlier outcome.',
  guide_receipt_expired: 'The guide-read receipt expired. Read the current guide again. No new save was attempted. Retry the identical batch and request ID to check any earlier outcome.',
});

export class GuideReadError extends Error {
  constructor(code) {super(messages[code] || messages.guide_read_required); this.name = 'GuideReadError'; this.code = Object.hasOwn(messages, code) ? code : 'guide_read_required';}
}
const fail = code => {throw new GuideReadError(code);};
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function instant(now) {
  let value;
  try {value = typeof now === 'function' ? now() : now ?? Date.now();}
  catch {fail('instructions_unavailable');}
  if (value instanceof Date) value = value.getTime();
  if (!Number.isSafeInteger(value) || value < 0 || value > 8_640_000_000_000_000 - TTL_MS) fail('instructions_unavailable');
  return value;
}

function ownerIdentity(identity) {
  if (!object(identity) || typeof identity.userId !== 'string' || typeof identity.email !== 'string' || typeof identity.origin !== 'string') fail('guide_read_required');
  const userId = identity.userId.trim(), email = identity.email.trim().toLowerCase(), origin = identity.origin;
  if (!userId || userId.length > 256 || /[\s\x00-\x1f\x7f]/.test(userId)
      || !email || email.length > 320 || /[\s\x00-\x1f\x7f]/.test(email)
      || !origin || origin.length > 512) fail('guide_read_required');
  try {
    const url = new URL(origin);
    if (!['https:', 'http:'].includes(url.protocol) || url.origin !== origin || url.username || url.password) fail('guide_read_required');
  } catch {fail('guide_read_required');}
  return {userId, email, origin};
}

async function signingKey(env) {
  let secret;
  try {secret = env?.SHARD_ATLAS_GUIDE_RECEIPT_SECRET;}
  catch {fail('guide_receipt_unconfigured');}
  if (typeof secret !== 'string' || !/^[a-f0-9]{64}$/i.test(secret) || !globalThis.crypto?.subtle) fail('guide_receipt_unconfigured');
  const bytes = Uint8Array.from(secret.match(/../g), pair => parseInt(pair, 16));
  try {return await crypto.subtle.importKey('raw', bytes, {name: 'HMAC', hash: 'SHA-256'}, false, ['sign', 'verify']);}
  catch {fail('guide_receipt_unconfigured');}
}

async function guide(guideText) {
  const content = guideText === undefined ? COMPILED_GUIDE : guideText;
  if (typeof content !== 'string' || !content.trim() || content.length > MAX_GUIDE_BYTES) fail('instructions_unavailable');
  const bytes = encoder.encode(content);
  if (bytes.byteLength > MAX_GUIDE_BYTES || !globalThis.crypto?.subtle) fail('instructions_unavailable');
  let digest;
  try {digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));}
  catch {fail('instructions_unavailable');}
  return {content, version: Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('')};
}

function base64url(bytes) {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 1024) binary += String.fromCharCode(...bytes.subarray(offset, offset + 1024));
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function decodeBase64url(value, maximum) {
  if (typeof value !== 'string' || !value || value.length > maximum || !/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1) fail('guide_read_required');
  try {
    const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4));
    const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
    if (base64url(bytes) !== value) fail('guide_read_required');
    return bytes;
  } catch {fail('guide_read_required');}
}
const signedBytes = encodedPayload => encoder.encode(DOMAIN + encodedPayload);

export async function getContributionInstructions(env, identity, {guideText, now} = {}) {
  const owner = ownerIdentity(identity), issuedAt = instant(now), expires = issuedAt + TTL_MS;
  const key = await signingKey(env), current = await guide(guideText);
  const payload = {schemaVersion: 1, version: current.version, ...owner, issuedAt, expiresAt: expires};
  const encoded = base64url(encoder.encode(JSON.stringify(payload)));
  let signature;
  try {signature = new Uint8Array(await crypto.subtle.sign('HMAC', key, signedBytes(encoded)));}
  catch {fail('guide_receipt_unconfigured');}
  const readReceipt = 'v1.' + encoded + '.' + base64url(signature);
  if (readReceipt.length > MAX_RECEIPT_CHARS) fail('guide_read_required');
  return {...current, readReceipt, expiresAt: new Date(expires).toISOString(), format: 'markdown',
    receiptNotice: 'This receipt proves delivery of this guide version to the authenticated owner at this Site and expires after one hour. It does not prove that the guide was read, understood, or followed. Read and apply the full guide before preparing a contribution.'};
}

export async function verifyContributionInstructions(env, identity, args, {guideText, now} = {}) {
  if (!object(args) || typeof args.instructionsVersion !== 'string' || !HASH.test(args.instructionsVersion)
      || typeof args.instructionsReceipt !== 'string' || args.instructionsReceipt.length > MAX_RECEIPT_CHARS) fail('guide_read_required');
  const owner = ownerIdentity(identity), checkedAt = instant(now), key = await signingKey(env), current = await guide(guideText);
  const parts = args.instructionsReceipt.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') fail('guide_read_required');
  const payloadBytes = decodeBase64url(parts[1], MAX_RECEIPT_CHARS - 47), signature = decodeBase64url(parts[2], 43);
  if (signature.byteLength !== 32) fail('guide_read_required');
  let validSignature = false;
  try {validSignature = await crypto.subtle.verify('HMAC', key, signature, signedBytes(parts[1]));}
  catch {fail('guide_read_required');}
  if (!validSignature) fail('guide_read_required');
  let payload;
  try {payload = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(payloadBytes));}
  catch {fail('guide_read_required');}
  const fields = ['schemaVersion', 'version', 'userId', 'email', 'origin', 'issuedAt', 'expiresAt'];
  if (!object(payload) || Object.keys(payload).length !== fields.length || !fields.every(field => Object.hasOwn(payload, field))
      || payload.schemaVersion !== 1 || typeof payload.version !== 'string' || !HASH.test(payload.version)
      || payload.userId !== owner.userId || payload.email !== owner.email || payload.origin !== owner.origin
      || !Number.isSafeInteger(payload.issuedAt) || payload.issuedAt < 0 || !Number.isSafeInteger(payload.expiresAt)
      || payload.expiresAt - payload.issuedAt !== TTL_MS || payload.issuedAt > checkedAt) fail('guide_read_required');
  if (checkedAt >= payload.expiresAt) fail('guide_receipt_expired');
  if (args.instructionsVersion !== payload.version || payload.version !== current.version) fail('guide_changed');
  return current.version;
}
