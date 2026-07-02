// Helper for the cross-binding parity test (T028): verify the tokens handed on argv through the
// WASM binding and print their reason codes, so the Rust harness can compare them against the
// C-ABI codes for the *same* inputs. argv: <keyId> <hexPubkey> <nowUnix> <token> <tampered>
import pkg from '../pkg/licensesrv.js';

const { Keyring, verify } = pkg;
const [, , keyId, hexPk, now, token, tampered] = process.argv;

const publicKey = Uint8Array.from(hexPk.match(/../g).map((h) => parseInt(h, 16)));

function codeOf(tok) {
  const k = new Keyring();
  const added = k.add(keyId, publicKey);
  if (added !== 0) throw new Error(`add failed: ${added}`);
  return verify(k, tok, Number(now)).code;
}

console.log(`valid=${codeOf(token)} tampered=${codeOf(tampered)}`);
