import { createHash, createHmac, timingSafeEqual } from "node:crypto";
/**
 * Deterministic keyed hash for API-key lookup (TR-012). The raw key is never stored; only
 * this HMAC is persisted, so a DB read cannot recover the credential.
 */
export function hmacKey(rawKey, secret) {
    return createHmac("sha256", secret).update(rawKey).digest("hex");
}
/** Salted hash for lookup identifiers (e.g. email) — no plaintext retained (TR-012). */
export function saltedHash(value, salt) {
    return createHash("sha256").update(`${salt}:${value}`).digest("hex");
}
/** Constant-time comparison for hashes. */
export function hashEquals(a, b) {
    const ab = Buffer.from(a);
    const bb = Buffer.from(b);
    return ab.length === bb.length && timingSafeEqual(ab, bb);
}
