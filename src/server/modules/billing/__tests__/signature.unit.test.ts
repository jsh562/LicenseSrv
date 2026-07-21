// T009 (FR-002): webhook signature verification unit tests. HMAC-SHA256 over the RAW body + a Stripe-style
// `t=…,v1=…` header, constant-time compared against the current AND (during rotation) previous secret, with
// timestamp recency rejecting BOTH stale and future skew. Pure (no DB / no app).
import crypto from "node:crypto";

import { describe, expect, it } from "vitest";

import { parseSignatureHeader, verifySignature } from "../signature.js";

const SECRET = "whsec_current_9f8Xk2QpL0rNvT7bYc4mHs6Jd1WuA3eZoG5iRfB2xKQ";
const PREV = "whsec_previous_2xTt5RbQ9wPmK7vY0nZa8Lc3Jd6HsU1eIoG4fRB2yNw";
const TOLERANCE = 300;

/** Build a Stripe-style signature header for `body` at `ts`, signed with `secret`. */
function sign(secret: string, ts: number, body: Buffer): string {
  const mac = crypto.createHmac("sha256", secret).update(`${ts}.`).update(body).digest("hex");
  return `t=${ts},v1=${mac}`;
}

describe("verifySignature (FR-002)", () => {
  const body = Buffer.from(JSON.stringify({ id: "evt_1", type: "invoice.paid", created: 1_000 }));
  const now = 1_000;

  it("accepts a valid signature over the raw body (current secret)", () => {
    const r = verifySignature(body, sign(SECRET, now, body), SECRET, undefined, now, TOLERANCE);
    expect(r.ok).toBe(true);
    expect(r.usedPrevious).toBe(false);
    expect(r.timestamp).toBe(now);
  });

  it("rejects a tampered body as a mismatch (401 class)", () => {
    const header = sign(SECRET, now, body);
    const tampered = Buffer.from(JSON.stringify({ id: "evt_1", type: "invoice.paid", created: 9_999 }));
    const r = verifySignature(tampered, header, SECRET, undefined, now, TOLERANCE);
    expect(r).toMatchObject({ ok: false, reason: "mismatch" });
  });

  it("rejects a wrong secret as a mismatch", () => {
    const r = verifySignature(body, sign("whsec_attacker", now, body), SECRET, undefined, now, TOLERANCE);
    expect(r).toMatchObject({ ok: false, reason: "mismatch" });
  });

  it("rejects a missing header", () => {
    expect(verifySignature(body, undefined, SECRET, undefined, now, TOLERANCE)).toMatchObject({
      ok: false,
      reason: "missing",
    });
  });

  it("rejects a malformed header (no v1 / no t)", () => {
    expect(verifySignature(body, "t=1000", SECRET, undefined, now, TOLERANCE)).toMatchObject({
      ok: false,
      reason: "malformed",
    });
    expect(verifySignature(body, "v1=deadbeef", SECRET, undefined, now, TOLERANCE)).toMatchObject({
      ok: false,
      reason: "malformed",
    });
  });

  it("rejects a stale timestamp (older than tolerance) AFTER a valid signature match (400 class)", () => {
    const staleTs = now - (TOLERANCE + 1);
    const r = verifySignature(body, sign(SECRET, staleTs, body), SECRET, undefined, now, TOLERANCE);
    expect(r).toMatchObject({ ok: false, reason: "stale_timestamp", timestamp: staleTs });
  });

  it("rejects a future-skewed timestamp (beyond tolerance)", () => {
    const futureTs = now + (TOLERANCE + 1);
    const r = verifySignature(body, sign(SECRET, futureTs, body), SECRET, undefined, now, TOLERANCE);
    expect(r).toMatchObject({ ok: false, reason: "future_timestamp", timestamp: futureTs });
  });

  it("accepts a timestamp exactly at the tolerance edge", () => {
    const edge = now - TOLERANCE;
    expect(verifySignature(body, sign(SECRET, edge, body), SECRET, undefined, now, TOLERANCE).ok).toBe(true);
  });

  it("accepts a signature under the PREVIOUS secret during a rotation window (usedPrevious)", () => {
    const header = sign(PREV, now, body);
    const r = verifySignature(body, header, SECRET, PREV, now, TOLERANCE);
    expect(r.ok).toBe(true);
    expect(r.usedPrevious).toBe(true);
  });

  it("does NOT accept the previous secret when none is offered (window closed)", () => {
    const r = verifySignature(body, sign(PREV, now, body), SECRET, undefined, now, TOLERANCE);
    expect(r).toMatchObject({ ok: false, reason: "mismatch" });
  });

  it("accepts when any one of several v1 candidates matches", () => {
    const mac = crypto.createHmac("sha256", SECRET).update(`${now}.`).update(body).digest("hex");
    const header = `t=${now},v1=${"a".repeat(64)},v1=${mac}`; // first wrong (valid length), second correct
    expect(verifySignature(body, header, SECRET, undefined, now, TOLERANCE).ok).toBe(true);
  });

  it("treats a wrong-length hex candidate as a non-match without throwing", () => {
    const header = `t=${now},v1=abcd`; // too short to be a SHA-256 hex
    expect(verifySignature(body, header, SECRET, undefined, now, TOLERANCE)).toMatchObject({
      ok: false,
      reason: "mismatch",
    });
  });
});

describe("parseSignatureHeader", () => {
  it("parses t + all v1 candidates and ignores other parts", () => {
    const parsed = parseSignatureHeader("t=1700000000,v1=aa,v0=zz,v1=bb");
    expect(parsed).toEqual({ timestamp: 1_700_000_000, signatures: ["aa", "bb"] });
  });

  it("returns null without a numeric t or any v1", () => {
    expect(parseSignatureHeader("v1=aa")).toBeNull();
    expect(parseSignatureHeader("t=notanumber,v1=aa")).toBeNull();
    expect(parseSignatureHeader("t=1,v0=aa")).toBeNull();
  });
});
