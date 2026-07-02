// T027 (US2, SC-002, FR-002/009): the WASM Node test. A valid token verifies offline and reads
// entitlements; tampered and expired tokens are each rejected with their OWN distinct reason code
// (asserted separately, not conflated). Uses Node's built-in test runner — no extra deps.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import pkg from '../pkg/licensesrv.js';

const { Keyring, verify, abiVersion } = pkg;

const fx = JSON.parse(readFileSync(new URL('./fixture.json', import.meta.url)));

// Frozen reason codes shared across every binding (mirror of the Rust reason map).
const OK = 0;
const BAD_SIGNATURE = 5;
const EXPIRED = 6;

function trustedKeyring() {
  const k = new Keyring();
  assert.equal(k.add(fx.keyId, new Uint8Array(fx.publicKey)), OK, 'key must be trusted');
  return k;
}

test('valid token verifies offline and exposes entitlements', () => {
  const r = verify(trustedKeyring(), fx.token, fx.nowUnix);
  assert.equal(r.code, OK);
  assert.equal(r.has('pro'), true, 'bool entitlement readable');
  assert.equal(r.limit('seats'), 5, 'int entitlement readable');
  assert.equal(r.has('absent'), false, 'absent entitlement fails closed');
  assert.ok(typeof r.nextAnchor === 'number', 'anchor exposed on success');
});

test('tampered token is rejected with BadSignature and unlocks nothing', () => {
  const r = verify(trustedKeyring(), fx.tampered, fx.nowUnix);
  assert.equal(r.code, BAD_SIGNATURE);
  assert.equal(r.has('pro'), false, 'feature stays locked');
});

test('expired token is rejected with Expired', () => {
  const r = verify(trustedKeyring(), fx.token, fx.expiredNow);
  assert.equal(r.code, EXPIRED);
});

test('tampered and expired yield two DISTINCT reason codes (SC-002)', () => {
  const tampered = verify(trustedKeyring(), fx.tampered, fx.nowUnix).code;
  const expired = verify(trustedKeyring(), fx.token, fx.expiredNow).code;
  assert.notEqual(tampered, expired, 'distinct failure categories must not be conflated');
  assert.equal(tampered, BAD_SIGNATURE);
  assert.equal(expired, EXPIRED);
});

test('abiVersion exposes a stable nonzero version contract', () => {
  assert.ok(abiVersion() > 0);
});
