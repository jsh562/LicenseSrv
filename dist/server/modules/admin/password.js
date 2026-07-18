// Human password hashing (FR-017, AD-002). Uses node:crypto scrypt — a slow, memory-hard KDF — with
// a per-password random salt, encoded self-describingly so the cost parameters travel with the hash.
// The plaintext password is never stored, logged, or returned; only this string is persisted.
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
// scrypt cost: N=16384, r=8, p=1 → ~16 MB, ~50-100 ms per hash (tunable via config later).
const N = 16384;
const R = 8;
const P = 1;
const KEYLEN = 32;
const MAXMEM = 64 * 1024 * 1024; // headroom over 128*N*r (16 MB)
/** Hash a password into a self-describing `scrypt$N$r$p$salt$hash` string (never the plaintext). */
export function hashPassword(password) {
    const salt = randomBytes(16);
    const derived = scryptSync(password, salt, KEYLEN, { N, r: R, p: P, maxmem: MAXMEM });
    return `scrypt$${N}$${R}$${P}$${salt.toString("base64")}$${derived.toString("base64")}`;
}
/** Timing-safe verify of `password` against a stored `scrypt$...` hash. Returns false on any malformed input. */
export function verifyPassword(password, stored) {
    const parts = stored.split("$");
    if (parts.length !== 6 || parts[0] !== "scrypt")
        return false;
    const n = Number(parts[1]);
    const r = Number(parts[2]);
    const p = Number(parts[3]);
    if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p))
        return false;
    const salt = Buffer.from(parts[4], "base64");
    const expected = Buffer.from(parts[5], "base64");
    let derived;
    try {
        derived = scryptSync(password, salt, expected.length, { N: n, r, p, maxmem: MAXMEM });
    }
    catch {
        return false;
    }
    return expected.length === derived.length && timingSafeEqual(expected, derived);
}
