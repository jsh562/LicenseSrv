// T024 [US3] (FR-004/007): every beat RE-CHECKS current authorization, and the grace window prevents a
// false lockout. A deactivated activation or an expired license -> heartbeat refused with the SPECIFIC
// verdict (200, no token; FR-004). Grace (FR-007) is CLIENT-side, so the server realizes it as the token's
// `renewAfter` (when to renew) sitting strictly BEFORE `expiresAt` (the hard fail-closed limit): a client
// that renews at `renewAfter` still has runway before `exp`, so a transient outage of a few beats is
// absorbed without lapsing. Real Postgres via Testcontainers + the real E004 signer.
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { deactivate } from "../../activation/deactivate.js";
import { startHarness, type EnforcementHarness } from "./harness.js";

let h: EnforcementHarness;

beforeAll(async () => {
  h = await startHarness("heartbeat-recheck");
}, 240_000);

afterAll(async () => {
  await h?.stop();
});

interface Wire {
  verdict: string;
  shortLivedToken?: string;
  serverTime: string;
  renewAfter?: string;
  expiresAt?: string;
}

describe("heartbeat re-check + grace window (integration, real Postgres + real signer)", () => {
  it("US3: a deactivated activation -> heartbeat refused verdict:deactivated, no token (FR-004)", async () => {
    const lic = await h.issueLicense();
    const fp = h.sigs("k1", "k2", "k3", "k4", "k5");
    const { activationId } = await h.activateMachine(lic.id, fp);
    await deactivate(h.pool, h.tenantA, "test-admin", activationId);

    const res = await h.heartbeat(h.validateKey, { activationId, nonce: h.nonce() });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Wire;
    expect(body.verdict).toBe("deactivated");
    expect(body.shortLivedToken).toBeUndefined();
    // A refused beat never anchors.
    expect(await h.anchorOf(activationId)).toBeNull();
  });

  it("US3: an expired license -> heartbeat refused verdict:expired, no token (FR-004)", async () => {
    const lic = await h.issueLicense();
    const fp = h.sigs("m1", "m2", "m3", "m4", "m5");
    const { activationId } = await h.activateMachine(lic.id, fp);
    await h.setLicenseExpiry(lic.id, Math.floor(Date.now() / 1000) - 60);

    const res = await h.heartbeat(h.validateKey, { activationId, nonce: h.nonce() });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Wire;
    expect(body.verdict).toBe("expired");
    expect(body.shortLivedToken).toBeUndefined();
  });

  it("US3: a valid beat discloses renewAfter strictly before expiresAt — the grace runway (FR-007)", async () => {
    const lic = await h.issueLicense();
    const fp = h.sigs("g1", "g2", "g3", "g4", "g5");
    const { activationId } = await h.activateMachine(lic.id, fp);

    const res = await h.heartbeat(h.validateKey, { activationId, nonce: h.nonce() });
    const body = res.json() as Wire;
    expect(body.verdict).toBe("valid");

    const t0 = new Date(body.serverTime).getTime();
    const renewAfter = new Date(body.renewAfter!).getTime();
    const expiresAt = new Date(body.expiresAt!).getTime();
    // The client is told to renew BEFORE the hard limit, leaving runway (the grace) for missed beats.
    expect(renewAfter).toBeGreaterThan(t0);
    expect(renewAfter).toBeLessThan(expiresAt);
    // The runway between the recommended renewal and the fail-closed exp is what absorbs a transient outage.
    expect(expiresAt - renewAfter).toBeGreaterThan(0);
  });
});
