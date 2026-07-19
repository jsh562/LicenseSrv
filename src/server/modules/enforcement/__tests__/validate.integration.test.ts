// T015 [US1] (FR-001/002): POST /v1/validate for an active license + active activation → 200 verdict:"valid"
// + a short-lived token that VERIFIES OFFLINE against the product key via the E001 WASM core (the US1 proof,
// SC-001) — the same offline-verify path the activation suite uses. Asserts serverTime/renewAfter/expiresAt
// + stalenessWindow are present, and that resolving by machineBoundKey (not just activationId) works. Real
// Postgres via Testcontainers + the real E004 signer.
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { startHarness, type EnforcementHarness } from "./harness.js";

let h: EnforcementHarness;

beforeAll(async () => {
  h = await startHarness("validate");
}, 240_000);

afterAll(async () => {
  await h?.stop();
});

describe("online validate (integration, real Postgres + real signer)", () => {
  it("US1: validate valid → 200 verdict:valid + a token that verifies offline via the E001 core (SC-001)", async () => {
    const lic = await h.issueLicense();
    const fp = h.sigs("v1", "v2", "v3", "v4", "v5");
    const { activationId } = await h.activateMachine(lic.id, fp);

    const res = await h.validate(h.validateKey, { activationId, nonce: h.nonce() });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      verdict: string;
      shortLivedToken: string;
      serverTime: string;
      renewAfter: string;
      expiresAt: string;
      stalenessWindow: { seconds: number; tokenTtlSeconds: number; crlNextUpdateSeconds: number; offlineToleranceSeconds: number };
    };

    expect(body.verdict).toBe("valid");
    expect(body.shortLivedToken).toMatch(/^LIC1\./);
    // The short-TTL renewal token verifies OFFLINE against the product key with the SAME fingerprint (SC-001).
    expect(await h.verifyOffline(body.shortLivedToken, fp)).toBe(0);

    // Signed server time + renewal bounds + bounded-staleness disclosure are all present (FR-013/014).
    expect(typeof body.serverTime).toBe("string");
    expect(Number.isNaN(Date.parse(body.serverTime))).toBe(false);
    expect(new Date(body.renewAfter).getTime()).toBeGreaterThan(new Date(body.serverTime).getTime());
    expect(new Date(body.expiresAt).getTime()).toBeGreaterThan(new Date(body.renewAfter).getTime());
    expect(body.stalenessWindow.seconds).toBeGreaterThan(0);
    expect(body.stalenessWindow.seconds).toBe(
      Math.max(body.stalenessWindow.tokenTtlSeconds, body.stalenessWindow.crlNextUpdateSeconds) + body.stalenessWindow.offlineToleranceSeconds,
    );
  });

  it("US1: validate resolves the activation by machineBoundKey too (FR-001)", async () => {
    const lic = await h.issueLicense();
    const fp = h.sigs("w1", "w2", "w3", "w4", "w5");
    const { machineBoundKey } = await h.activateMachine(lic.id, fp);

    const res = await h.validate(h.validateKey, { machineBoundKey, nonce: h.nonce() });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { verdict: string; shortLivedToken: string };
    expect(body.verdict).toBe("valid");
    expect(await h.verifyOffline(body.shortLivedToken, fp)).toBe(0);
  });

  it("US1: the first successful validate advances the monotonic last-seen anchor (FR-014)", async () => {
    const lic = await h.issueLicense();
    const fp = h.sigs("x1", "x2", "x3", "x4", "x5");
    const { activationId } = await h.activateMachine(lic.id, fp);
    expect(await h.anchorOf(activationId)).toBeNull(); // never online yet

    const res = await h.validate(h.validateKey, { activationId, nonce: h.nonce() });
    expect(res.statusCode).toBe(200);
    expect(await h.anchorOf(activationId)).not.toBeNull(); // anchored on the first successful beat
  });
});
