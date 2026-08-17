// Decode a LIC1 token's claims in the browser — purely to SHOW which license is loaded. This does NOT
// verify anything (that's the WASM core's job); it just reads the public payload.
// Format (src/server/modules/signing/token.ts):
//   "LIC1." + base64url( [version:1] ‖ CBOR(payload) ‖ ed25519_sig[64] )
// payload = a CBOR map with text-string keys (v, lid, pid, pl, cid, iat, exp?, maxa, ent, kid, non, …).

export interface Claims {
  licenseId: string;
  productId: string;
  planId: string;
  customerId: string;
  issuedAt: number;
  expiresAt: number | null;
  maxActivations: number | null;
  keyId: string;
  entitlements: Record<string, boolean | number>;
}

function b64urlToBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// --- minimal CBOR reader (major types 0/1/2/3/4/5/7 — the subset LIC1 uses) ---
class Cbor {
  private p = 0;
  constructor(private readonly b: Uint8Array) {}
  private u8(): number {
    if (this.p >= this.b.length) throw new Error("cbor: eof");
    return this.b[this.p++]!;
  }
  private len(ai: number): number {
    if (ai < 24) return ai;
    if (ai === 24) return this.u8();
    if (ai === 25) return (this.u8() << 8) | this.u8();
    if (ai === 26) return this.u8() * 0x1000000 + (this.u8() << 16) + (this.u8() << 8) + this.u8();
    if (ai === 27) {
      let n = 0;
      for (let i = 0; i < 8; i++) n = n * 256 + this.u8();
      return n; // fits in a JS number for our timestamps/ids
    }
    throw new Error(`cbor: bad ai ${ai}`);
  }
  read(): unknown {
    const ib = this.u8();
    const major = ib >> 5;
    const ai = ib & 0x1f;
    switch (major) {
      case 0: return this.len(ai); // unsigned int
      case 1: return -1 - this.len(ai); // negative int
      case 2: { // byte string
        const n = this.len(ai);
        const out = this.b.slice(this.p, this.p + n);
        this.p += n;
        return out;
      }
      case 3: { // text string
        const n = this.len(ai);
        const s = new TextDecoder().decode(this.b.slice(this.p, this.p + n));
        this.p += n;
        return s;
      }
      case 4: { // array
        const n = this.len(ai);
        const arr: unknown[] = [];
        for (let i = 0; i < n; i++) arr.push(this.read());
        return arr;
      }
      case 5: { // map
        const n = this.len(ai);
        const m: Record<string, unknown> = {};
        for (let i = 0; i < n; i++) {
          const k = String(this.read());
          m[k] = this.read();
        }
        return m;
      }
      case 7:
        if (ai === 20) return false;
        if (ai === 21) return true;
        if (ai === 22) return null;
        throw new Error(`cbor: unsupported simple ${ai}`);
      default:
        throw new Error(`cbor: unsupported major ${major}`);
    }
  }
}

/** Decode a LIC1 token's claims for display. Returns null if it can't be parsed. */
export function decodeClaims(token: string): Claims | null {
  try {
    if (!token.startsWith("LIC1.")) return null;
    const bytes = b64urlToBytes(token.slice(5));
    if (bytes.length < 1 + 64) return null;
    // payload = between the 1-byte version and the trailing 64-byte signature
    const payload = bytes.slice(1, bytes.length - 64);
    const m = new Cbor(payload).read() as Record<string, unknown>;
    const num = (v: unknown): number | null => (typeof v === "number" ? v : null);
    return {
      licenseId: String(m["lid"] ?? ""),
      productId: String(m["pid"] ?? ""),
      planId: String(m["pl"] ?? ""),
      customerId: String(m["cid"] ?? ""),
      issuedAt: num(m["iat"]) ?? 0,
      expiresAt: num(m["exp"]),
      maxActivations: num(m["maxa"]),
      keyId: String(m["kid"] ?? ""),
      entitlements: (m["ent"] as Record<string, boolean | number>) ?? {},
    };
  } catch {
    return null;
  }
}
