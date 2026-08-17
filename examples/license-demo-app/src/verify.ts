// Offline license verification in the browser via the WASM verifier core (the SAME Rust code a real
// embedded customer app would use). No network call to check a signature.
import init, { Keyring, verify as wasmVerify, abiVersion } from "./wasm/licensesrv.js";

let ready: Promise<void> | null = null;
/** Load + instantiate the WASM module once (required before any call in a --target web build). */
export function ensureReady(): Promise<void> {
  if (!ready) ready = init().then(() => undefined);
  return ready;
}
export function coreAbi(): number {
  return abiVersion();
}

export interface Jwk {
  kid: string;
  x: string;
}

/** Decode an unpadded base64url string (JWKS `x`) to raw bytes — NOT via Node Buffer. */
function b64urlToBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Build a trusted Keyring from a product's public JWKS (each `x` is a 32-byte Ed25519 key). */
export function buildKeyring(keys: Jwk[]): Keyring {
  const kr = new Keyring();
  for (const k of keys) {
    const code = kr.add(k.kid, b64urlToBytes(k.x));
    if (code !== 0) throw new Error(`could not trust key ${k.kid} (reason ${code})`);
  }
  return kr;
}

export interface Outcome {
  code: number;
  reason: string;
  ok: boolean;
  pro: boolean;
  seats: number | undefined;
  nextAnchor: number | undefined;
}

/** Verify a LIC1 token offline against the keyring at the supplied clock. */
export function verifyToken(kr: Keyring, token: string, nowUnix: number): Outcome {
  const r = wasmVerify(kr, token, nowUnix, undefined, undefined);
  const ok = r.code === 0;
  return {
    code: r.code,
    reason: reasonText(r.code),
    ok,
    pro: ok && r.has("pro"),
    seats: r.limit("seats"),
    nextAnchor: r.nextAnchor,
  };
}

/** Corrupt a token by flipping one character inside the signature region → BadSignature on verify. */
export function tamper(token: string): string {
  const dot = token.indexOf(".");
  const body = token.slice(dot + 1);
  const i = body.length - 6;
  const c = body[i] === "A" ? "B" : "A";
  return token.slice(0, dot + 1) + body.slice(0, i) + c + body.slice(i + 1);
}

/** Human text for a verifier reason code (mirrors the core VerifyError order). */
export function reasonText(code: number): string {
  switch (code) {
    case 0: return "Valid";
    case 1: return "Malformed token";
    case 2: return "Unsupported version";
    case 3: return "Unknown signing key";
    case 4: return "Key outside its validity window";
    case 5: return "Bad signature (tampered)";
    case 6: return "License expired";
    case 7: return "Clock rolled back";
    case 8: return "Machine fingerprint mismatch";
    case 9: return "Machine fingerprint missing";
    default: return `Error ${code}`;
  }
}
