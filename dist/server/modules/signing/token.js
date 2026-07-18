// LIC1 token construction (AD-001, TR-018). The Ed25519 primitive is `node:crypto`; the byte
// format is single-sourced by the Rust verifier-core — this encoder is a thin, conformance-gated
// mirror. A minimal CBOR encoder reproduces ciborium's struct encoding EXACTLY (verified
// byte-for-byte against the core's `issue`), so no CBOR library is needed. Every minted token is
// verified against the real core (E003 WASM) before it is returned (conformance oracle).
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
// The E003 WASM package wraps the one Rust verifier-core; used as the conformance oracle.
const core = require("../../../bindings/wasm/pkg/licensesrv.js");
const DOMAIN_TAG = Buffer.from("LICSRV-LICENSE-TOKEN-v1", "ascii");
const FORMAT_VERSION = 1;
// --- minimal CBOR (definite maps, minimal ints) — matches ciborium/serde exactly ---
function cborHead(major, n) {
    const mt = major << 5;
    if (n < 24)
        return Buffer.from([mt | n]);
    if (n < 0x100)
        return Buffer.from([mt | 24, n]);
    if (n < 0x10000)
        return Buffer.from([mt | 25, n >> 8, n & 0xff]);
    if (n < 0x100000000)
        return Buffer.from([mt | 26, (n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);
    const b = Buffer.alloc(9);
    b[0] = mt | 27;
    b.writeBigUInt64BE(BigInt(n), 1);
    return b;
}
const cborInt = (n) => (n >= 0 ? cborHead(0, n) : cborHead(1, -n - 1));
function cborText(s) {
    const b = Buffer.from(s, "utf8");
    return Buffer.concat([cborHead(3, b.length), b]);
}
const cborBool = (v) => Buffer.from([v ? 0xf5 : 0xf4]);
// entitlements is a BTreeMap in the core -> CBOR map with keys in sorted order.
function cborEntitlements(ent) {
    const keys = Object.keys(ent).sort();
    const parts = [cborHead(5, keys.length)];
    for (const k of keys) {
        parts.push(cborText(k));
        const v = ent[k];
        parts.push(typeof v === "boolean" ? cborBool(v) : cborInt(v));
    }
    return Buffer.concat(parts);
}
/** CBOR-encode `claims` in the core's struct field order, skipping null optionals. */
export function encodeClaims(c) {
    const fields = [];
    fields.push(["v", cborInt(c.tokenVersion)]);
    fields.push(["lid", cborText(c.licenseId)]);
    fields.push(["pid", cborText(c.productId)]);
    fields.push(["pl", cborText(c.planId)]);
    fields.push(["cid", cborText(c.customerId)]);
    fields.push(["iat", cborInt(c.issuedAt)]);
    if (c.expiresAt != null)
        fields.push(["exp", cborInt(c.expiresAt)]);
    fields.push(["maxa", cborInt(c.maxActivations)]);
    if (c.fingerprint != null) {
        const parts = [cborHead(4, c.fingerprint.length), ...c.fingerprint.map(cborText)];
        fields.push(["fp", Buffer.concat(parts)]);
    }
    if (c.fpMin != null)
        fields.push(["fpk", cborInt(c.fpMin)]);
    if (c.maxSkewSecs != null)
        fields.push(["sk", cborInt(c.maxSkewSecs)]);
    fields.push(["ent", cborEntitlements(c.entitlements)]);
    if (c.maxVersion != null)
        fields.push(["maxv", cborText(c.maxVersion)]);
    if (c.maintenanceUntil != null)
        fields.push(["mnt", cborInt(c.maintenanceUntil)]);
    fields.push(["kid", cborText(c.keyId)]);
    fields.push(["non", cborText(c.nonce)]);
    const parts = [cborHead(5, fields.length)];
    for (const [k, v] of fields) {
        parts.push(cborText(k));
        parts.push(v);
    }
    return Buffer.concat(parts);
}
/** The bytes the signer must sign: `DOMAIN_TAG ‖ [FORMAT_VERSION] ‖ CBOR(payload)`. */
export function buildSigningInput(claims) {
    const payload = encodeClaims(claims);
    const signingInput = Buffer.concat([DOMAIN_TAG, Buffer.from([FORMAT_VERSION]), payload]);
    return { payload, signingInput };
}
const base64url = (b) => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
/** Assemble the final `LIC1.` token from the payload and its 64-byte Ed25519 signature. */
export function assembleToken(payload, signature) {
    if (signature.length !== 64)
        throw new Error("ed25519 signature must be 64 bytes");
    const transport = Buffer.concat([Buffer.from([FORMAT_VERSION]), payload, signature]);
    return "LIC1." + base64url(transport);
}
/**
 * Conformance oracle (TR-018): verify a minted token against the REAL Rust verifier-core (via the
 * E003 WASM binding) at `nowUnix`. Returns true iff the core accepts it (code 0). This is the
 * single source of truth for the byte format — a token that fails here MUST NOT be returned. A
 * machine-bound token (E009) carries an `fp` claim, so the same fingerprint must be supplied here or
 * the core rejects it as `FingerprintMissing`; `fingerprint` is null for an ordinary license token.
 */
export function conformanceVerify(token, publicKey, keyId, nowUnix, fingerprint = null) {
    const kr = new core.Keyring();
    try {
        if (kr.add(keyId, publicKey) !== 0)
            return false;
        const r = core.verify(kr, token, nowUnix, null, fingerprint);
        try {
            return r.code === 0;
        }
        finally {
            r.free();
        }
    }
    finally {
        kr.free();
    }
}
