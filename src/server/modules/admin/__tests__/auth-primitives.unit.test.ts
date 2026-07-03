// T006/T008/T010 (FR-017/003/019): scrypt password hashing, session-token hashing, and the CSRF
// double-submit check — the pure, no-DB security primitives of the admin auth spine.
import { describe, expect, it } from "vitest";

import { csrfValid, issueCsrfToken } from "../csrf.js";
import { hashPassword, verifyPassword } from "../password.js";
import { generateToken, tokenHash } from "../session.js";

describe("scrypt password hashing (FR-017)", () => {
  it("verifies the correct password and rejects a wrong one", () => {
    const stored = hashPassword("correct horse battery staple");
    expect(verifyPassword("correct horse battery staple", stored)).toBe(true);
    expect(verifyPassword("wrong password", stored)).toBe(false);
  });

  it("never stores the plaintext and salts each hash uniquely", () => {
    const pw = "s3cret-pw";
    const a = hashPassword(pw);
    const b = hashPassword(pw);
    expect(a).not.toContain(pw); // plaintext never present
    expect(a.startsWith("scrypt$")).toBe(true);
    expect(a).not.toBe(b); // distinct random salts → distinct hashes
    expect(verifyPassword(pw, a)).toBe(true);
    expect(verifyPassword(pw, b)).toBe(true);
  });

  it("returns false on malformed stored hashes (no throw)", () => {
    expect(verifyPassword("x", "not-a-hash")).toBe(false);
    expect(verifyPassword("x", "scrypt$bad")).toBe(false);
    expect(verifyPassword("x", "")).toBe(false);
  });
});

describe("session token (FR-003)", () => {
  it("generates high-entropy url-safe tokens and a stable SHA-256 hash", () => {
    const t1 = generateToken();
    const t2 = generateToken();
    expect(t1).not.toBe(t2);
    expect(t1).toMatch(/^[A-Za-z0-9_-]+$/); // base64url, no padding
    expect(t1.length).toBeGreaterThanOrEqual(43); // 32 bytes → 43 url-safe chars
    expect(tokenHash(t1)).toBe(tokenHash(t1)); // deterministic
    expect(tokenHash(t1)).not.toBe(tokenHash(t2));
    expect(tokenHash(t1)).not.toBe(t1); // stored hash != raw token
  });
});

describe("CSRF double-submit (FR-019)", () => {
  it("accepts only matching cookie+header tokens", () => {
    const token = issueCsrfToken();
    expect(csrfValid(token, token)).toBe(true);
    expect(csrfValid(token, issueCsrfToken())).toBe(false); // mismatch
    expect(csrfValid(token, undefined)).toBe(false); // missing header
    expect(csrfValid(undefined, token)).toBe(false); // missing cookie
    expect(csrfValid(undefined, undefined)).toBe(false);
  });
});
