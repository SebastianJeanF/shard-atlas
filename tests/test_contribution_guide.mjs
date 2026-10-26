import test from 'node:test';
import assert from 'node:assert/strict';
import {GuideReadError, getContributionInstructions, verifyContributionInstructions} from '../hosting/lib/contribution-guide.mjs';

const SECRET = 'a7'.repeat(32), env = {SHARD_ATLAS_GUIDE_RECEIPT_SECRET: SECRET};
const owner = {userId: 'site-owner', email: 'owner@example.test', origin: 'https://atlas.example.test'};
const guideText = '# Canonical contribution guide\r\n\r\nKeep exact code: `x++;`\r\n';
const now = 1_800_000_000_000;
const options = {guideText, now};
const args = value => ({instructionsVersion: value.version, instructionsReceipt: value.readReceipt});
function rejects(action, code) {
  return assert.rejects(action, error => {
    assert.ok(error instanceof GuideReadError);
    assert.equal(error.code, code);
    assert.ok(error.message.length < 400);
    assert.match(error.message, /No new save was attempted/);
    assert.doesNotMatch(error.message, /Nothing was saved/);
    assert.doesNotMatch(error.message, /owner@example|site-owner|a7a7a7|PRIVATE_SECRET|SELECT|bucket/);
    return true;
  });
}

// Build signed malformed test payloads independently of production internals.
async function signed(payload, {domain = 'shard-atlas:contribution-guide-read:v1\n', raw} = {}) {
  const key = await crypto.subtle.importKey('raw', Uint8Array.from(SECRET.match(/../g), pair => parseInt(pair, 16)), {name: 'HMAC', hash: 'SHA-256'}, false, ['sign']);
  const encoded = Buffer.from(raw || JSON.stringify(payload)).toString('base64url');
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(domain + encoded));
  return 'v1.' + encoded + '.' + Buffer.from(signature).toString('base64url');
}

function payload(receipt) {return JSON.parse(Buffer.from(receipt.split('.')[1], 'base64url').toString('utf8'));}

test('guide delivery is exact, bounded, versioned and owner-bound without storage or network access', async () => {
  const configuration = new Proxy(env, {get(target, key) {if (key !== 'SHARD_ATLAS_GUIDE_RECEIPT_SECRET') throw new Error('Unexpected storage access'); return target[key];}});
  const value = await getContributionInstructions(configuration, owner, options);
  assert.equal(value.content, guideText); assert.match(value.version, /^[a-f0-9]{64}$/);
  assert.equal(value.format, 'markdown'); assert.equal(value.expiresAt, new Date(now + 3_600_000).toISOString());
  assert.match(value.receiptNotice, /does not prove/); assert.doesNotMatch(JSON.stringify(value), new RegExp(SECRET));
  assert.equal(await verifyContributionInstructions(configuration, owner, args(value), options), value.version);
  assert.deepEqual(await getContributionInstructions(configuration, owner, options), value);
});

test('instructions and their verification cannot make external requests', async () => {
  const previous = globalThis.fetch;
  globalThis.fetch = () => {throw new Error('External requests are not permitted.');};
  try {
    const value = await getContributionInstructions(env, owner, options);
    assert.equal(await verifyContributionInstructions(env, owner, args(value), options), value.version);
  } finally {globalThis.fetch = previous;}
});

test('receipt version binds exact UTF-8 guide bytes and refuses a changed guide or client version', async () => {
  const value = await getContributionInstructions(env, owner, options);
  const changed = await getContributionInstructions(env, owner, {guideText: guideText.replaceAll('\r\n', '\n'), now});
  assert.notEqual(value.version, changed.version);
  await rejects(() => verifyContributionInstructions(env, owner, args(value), {guideText: guideText + '\nNew rule', now}), 'guide_changed');
  await rejects(() => verifyContributionInstructions(env, owner, {...args(value), instructionsVersion: 'b'.repeat(64)}, options), 'guide_changed');
});

test('owner identity and Site origin cannot be transferred to another user or deployment', async () => {
  const value = await getContributionInstructions(env, owner, options);
  for (const identity of [{...owner, userId: 'other-user'}, {...owner, email: 'other@example.test'}, {...owner, origin: 'https://other.example.test'}]) {
    await rejects(() => verifyContributionInstructions(env, identity, args(value), options), 'guide_read_required');
  }
  assert.equal(await verifyContributionInstructions(env, {...owner, userId: ' site-owner ', email: ' OWNER@EXAMPLE.TEST '}, args(value), options), value.version);
});

test('receipts expire at the boundary and future-issued receipts fail closed', async () => {
  const value = await getContributionInstructions(env, owner, options);
  assert.equal(await verifyContributionInstructions(env, owner, args(value), {guideText, now: now + 3_600_000 - 1}), value.version);
  await rejects(() => verifyContributionInstructions(env, owner, args(value), {guideText, now: now + 3_600_000}), 'guide_receipt_expired');
  await rejects(() => verifyContributionInstructions(env, owner, args(value), {guideText, now: now - 1}), 'guide_read_required');
  assert.equal(await verifyContributionInstructions(env, owner, args(value), {guideText, now: () => new Date(now)}), value.version);
});

test('missing or rotated dedicated secrets do not fall back to device credentials', async () => {
  const value = await getContributionInstructions(env, owner, options);
  for (const secret of [undefined, '', 'PRIVATE_SECRET', 'b'.repeat(63), 'z'.repeat(64), 1]) {
    const configuration = {SHARD_ATLAS_GUIDE_RECEIPT_SECRET: secret, SHARD_ATLAS_SERVICE_SECRET_SHA256: SECRET};
    await rejects(() => getContributionInstructions(configuration, owner, options), 'guide_receipt_unconfigured');
    await rejects(() => verifyContributionInstructions(configuration, owner, args(value), options), 'guide_receipt_unconfigured');
  }
  await rejects(() => verifyContributionInstructions({SHARD_ATLAS_GUIDE_RECEIPT_SECRET: 'bc'.repeat(32)}, owner, args(value), options), 'guide_read_required');
  await rejects(() => getContributionInstructions(new Proxy({}, {get() {throw new Error('PRIVATE_SECRET');}}), owner, options), 'guide_receipt_unconfigured');
});

test('tampered payload, signature, domain, prefixes and malformed base64url fail with bounded errors', async () => {
  const value = await getContributionInstructions(env, owner, options), parts = value.readReceipt.split('.');
  const edited = payload(value.readReceipt); edited.userId = 'other-user';
  for (const receipt of ['', 'v2.' + parts.slice(1).join('.'), value.readReceipt + '.extra', 'v1.%.%', 'v1.A.A',
    'v1.' + Buffer.from(JSON.stringify(edited)).toString('base64url') + '.' + parts[2],
    parts.slice(0, 2).join('.') + '.' + 'A'.repeat(43),
    'v1.' + parts[1] + '=.' + parts[2], 'x'.repeat(4097),
    await signed(payload(value.readReceipt), {domain: 'a-different-feature\n'})]) {
    await rejects(() => verifyContributionInstructions(env, owner, {...args(value), instructionsReceipt: receipt}, options), 'guide_read_required');
  }
});

test('even signed invalid payloads and invalid UTF-8 are rejected before their fields are trusted', async () => {
  const value = await getContributionInstructions(env, owner, options), original = payload(value.readReceipt);
  for (const change of [p => {p.extra = true;}, p => {delete p.version;}, p => {p.schemaVersion = 2;},
    p => {p.issuedAt = -1;}, p => {p.expiresAt++;}, p => {p.version = 'bad';}, p => {p.issuedAt = 'time';}]) {
    const changed = {...original}; change(changed);
    const readReceipt = await signed(changed);
    await rejects(() => verifyContributionInstructions(env, owner, {...args(value), instructionsReceipt: readReceipt}, options), 'guide_read_required');
  }
  for (const raw of [Buffer.from([0xff]), Buffer.from('not JSON'), Buffer.from('[]')]) {
    const readReceipt = await signed(null, {raw});
    await rejects(() => verifyContributionInstructions(env, owner, {...args(value), instructionsReceipt: readReceipt}, options), 'guide_read_required');
  }
});

test('guide configuration, identity, argument types and clocks fail closed without echoing supplied values', async () => {
  for (const text of [null, '', '   ', 'x'.repeat(256 * 1024 + 1), '🌳'.repeat(100000)]) {
    await rejects(() => getContributionInstructions(env, owner, {guideText: text, now}), 'instructions_unavailable');
  }
  await rejects(() => getContributionInstructions(env, owner, {now}), 'instructions_unavailable');
  for (const identity of [null, {}, {...owner, userId: ''}, {...owner, email: 'bad\nvalue'}, {...owner, origin: 'https://atlas.example.test/path'}, {...owner, origin: 'https://user:pass@atlas.example.test'}, {...owner, origin: 'null'}]) {
    await rejects(() => getContributionInstructions(env, identity, options), 'guide_read_required');
  }
  for (const argumentsValue of [null, {}, {instructionsVersion: 'private', instructionsReceipt: 'private'}, {instructionsVersion: 1}, {instructionsVersion: 'a'.repeat(64), instructionsReceipt: 1}]) {
    await rejects(() => verifyContributionInstructions(env, owner, argumentsValue, options), 'guide_read_required');
  }
  for (const clock of [NaN, Infinity, -1, 'now', () => {throw new Error('PRIVATE_SECRET');}]) {
    await rejects(() => getContributionInstructions(env, owner, {guideText, now: clock}), 'instructions_unavailable');
  }
});
