// Key custody (TR-011, TR-012, AD-002, AD-005). The keystore master key is split into n custodian
// shares via Shamir k-of-n over GF(256); at boot, k shares reconstruct it in memory only. Private
// keys are envelope-encrypted (AES-256-GCM) under that master key, so a DB dump alone is useless.
// Fail-closed: below k shares the signer never unlocks. Shamir SSS is a standard secret-sharing
// scheme (not signing crypto) and is unit-tested for split/recombine round-trip.
import crypto from "node:crypto";

// --- GF(256) arithmetic (AES field, poly 0x11b), via exp/log tables (generator 0x03) ---
const EXP = new Uint8Array(256);
const LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    // multiply x by the generator 3 in GF(256)
    let a = x;
    let b = 3;
    let p = 0;
    for (let bit = 0; bit < 8; bit++) {
      if (b & 1) p ^= a;
      const hi = a & 0x80;
      a = (a << 1) & 0xff;
      if (hi) a ^= 0x1b;
      b >>= 1;
    }
    x = p;
  }
})();
function gmul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return EXP[(LOG[a]! + LOG[b]!) % 255]!;
}
function gdiv(a: number, b: number): number {
  if (b === 0) throw new Error("gf div by zero");
  if (a === 0) return 0;
  return EXP[(LOG[a]! - LOG[b]! + 255) % 255]!;
}

/** Split `secret` into `n` Shamir shares, any `k` of which reconstruct it. Each share = `x ‖ y…`. */
export function shamirSplit(secret: Buffer, n: number, k: number): Buffer[] {
  if (k < 2 || k > n || n > 255) throw new Error("shamir: require 2 <= k <= n <= 255");
  const shares = Array.from({ length: n }, (_, i) => ({ x: i + 1, y: Buffer.alloc(secret.length) }));
  for (let byte = 0; byte < secret.length; byte++) {
    const coeffs = Buffer.concat([Buffer.from([secret[byte]!]), crypto.randomBytes(k - 1)]);
    for (const s of shares) {
      let y = 0;
      for (let p = coeffs.length - 1; p >= 0; p--) y = gmul(y, s.x) ^ coeffs[p]!; // Horner
      s.y[byte] = y;
    }
  }
  return shares.map((s) => Buffer.concat([Buffer.from([s.x]), s.y]));
}

/** Reconstruct the secret from any `k` distinct Shamir shares (Lagrange interpolation at x=0). */
export function shamirCombine(shares: Buffer[]): Buffer {
  if (shares.length < 2) throw new Error("shamir: need at least the threshold of shares");
  const len = shares[0]!.length - 1;
  const xs = shares.map((s) => s[0]!);
  if (new Set(xs).size !== xs.length) throw new Error("shamir: duplicate share indices");
  const out = Buffer.alloc(len);
  for (let byte = 0; byte < len; byte++) {
    let acc = 0;
    for (let i = 0; i < shares.length; i++) {
      const xi = xs[i]!;
      const yi = shares[i]![1 + byte]!;
      let num = 1;
      let den = 1;
      for (let j = 0; j < shares.length; j++) {
        if (i === j) continue;
        const xj = xs[j]!;
        num = gmul(num, xj); // (0 - xj) == xj in GF(256)
        den = gmul(den, xi ^ xj); // (xi - xj) == xi ^ xj
      }
      acc ^= gmul(yi, gdiv(num, den));
    }
    out[byte] = acc;
  }
  return out;
}

/** The custody scheme identifier stored alongside each wrapped key (data-model `custody_scheme`). */
export const KEYSTORE_SCHEME = "keystore-aes256gcm-v1";

/** Envelope-encrypt `plaintext` under the 32-byte master key: `iv(12) ‖ ciphertext ‖ tag(16)`. */
export function wrapKey(masterKey: Buffer, plaintext: Buffer): Buffer {
  if (masterKey.length !== 32) throw new Error("master key must be 32 bytes");
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", masterKey, iv);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([iv, ct, cipher.getAuthTag()]);
}

/** Reverse of {@link wrapKey}. Throws on a bad tag (tamper) — callers treat any throw as fatal. */
export function unwrapKey(masterKey: Buffer, blob: Buffer): Buffer {
  if (masterKey.length !== 32) throw new Error("master key must be 32 bytes");
  if (blob.length < 12 + 16) throw new Error("wrapped blob too short");
  const iv = blob.subarray(0, 12);
  const tag = blob.subarray(blob.length - 16);
  const ct = blob.subarray(12, blob.length - 16);
  const decipher = crypto.createDecipheriv("aes-256-gcm", masterKey, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

/**
 * Holds the unlocked keystore master key in memory (TR-012). Locked until `unlock` reconstructs the
 * master key from at least the threshold of custodian shares; below threshold it stays locked and
 * the signer fails closed. `zeroize` wipes the key on shutdown.
 */
export class Custody {
  #masterKey: Buffer | null = null;

  /** Reconstruct and hold the master key from `shares` (needs ≥ k). Throws (stays locked) on failure. */
  unlock(shares: Buffer[]): void {
    const master = shamirCombine(shares);
    if (master.length !== 32) throw new Error("reconstructed master key must be 32 bytes");
    this.#masterKey = master;
  }

  get unlocked(): boolean {
    return this.#masterKey !== null;
  }

  /** Wrap a private key for storage. Throws when locked (fail-closed). */
  wrap(privateKey: Buffer): Buffer {
    if (!this.#masterKey) throw new Error("custody locked");
    return wrapKey(this.#masterKey, privateKey);
  }

  /** Unwrap a stored private key for signing. Throws when locked (fail-closed). */
  unwrap(blob: Buffer): Buffer {
    if (!this.#masterKey) throw new Error("custody locked");
    return unwrapKey(this.#masterKey, blob);
  }

  /** Wipe the master key from memory (shutdown). */
  zeroize(): void {
    if (this.#masterKey) {
      this.#masterKey.fill(0);
      this.#masterKey = null;
    }
  }
}
