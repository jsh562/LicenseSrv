// Reference: verify a license fully offline in Node via the WASM package (US2, FR-009, FR-018).
// No network call, no cryptography in JS — the one Rust core does the work. Run:
//   node src/bindings/wasm/examples/node-verify.mjs
import { readFileSync } from 'node:fs';
import pkg from '../pkg/licensesrv.js';

const { Keyring, verify, abiVersion } = pkg;

// In a real app the token and trusted public key are shipped with / fetched out-of-band; here we
// load the deterministic test fixture produced by the Rust core.
const fixture = JSON.parse(readFileSync(new URL('../tests/fixture.json', import.meta.url)));

console.log('binding/core ABI version:', abiVersion());

const keyring = new Keyring();
const addCode = keyring.add(fixture.keyId, new Uint8Array(fixture.publicKey));
if (addCode !== 0) {
  throw new Error(`failed to trust key: reason ${addCode}`);
}

// Verify offline. `nowUnix` is supplied by the host (deterministic verification).
const result = verify(keyring, fixture.token, fixture.nowUnix);
console.log('reason code:', result.code);

if (result.code === 0 && result.has('pro')) {
  console.log('✓ PRO unlocked — seats limit:', result.limit('seats'));
  console.log('  persist next anchor:', result.nextAnchor);
} else {
  console.log('✗ license invalid — feature stays locked');
}
