// T021 [US2] (FR-006; SC-003): the refusal verdicts + reinstatement-resumes. A SUSPENDED license refuses
// renewal (200 verdict:"suspended", no token); REINSTATING it resumes renewal on the very next beat (200
// valid + a FRESH offline-verifiable token) — proving the verdict is re-evaluated each beat with NO sticky
// revoked/suspended state (FR-006). Also covers the other refusal verdicts: an expired license -> "expired"
// and a deactivated activation -> "deactivated". Real Postgres via Testcontainers + the real E004 signer.
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { deactivate } from "../../activation/deactivate.js";
import { reinstateLicense, suspendLicense } from "../../issuance/lifecycle.js";
import { startHarness, type EnforcementHarness } from "./harness.js";

let h: EnforcementHarness;

beforeAll(async () => {
  h = await startHarness("verdict-refusal");
}, 240_000);

afterAll(async () => {
  await h?.stop();
});

interface Wire {
  verdict: string;
  shortLivedToken?: string;
}

describe("refusal verdicts + reinstatement (integration, real Postgres + real signer)", () => {
  it("US2: suspend -> refused (no token); reinstate -> the next beat renews with a fresh token (FR-006)", async () => {
    const lic = await h.issueLicense();
    const fp = h.sigs("p1", "p2", "p3", "p4", "p5");
    const { activationId } = await h.activateMachine(lic.id, fp);

    // Healthy renewal first.
    const valid = await h.heartbeat(h.validateKey, { activationId, nonce: h.nonce() });
    expect((valid.json() as Wire).verdict).toBe("valid");

    // Suspend -> the next beat refuses renewal, no token (AD-001).
    await suspendLicense(h.pool, h.tenantA, "test-admin", lic.id);
    const suspended = await h.heartbeat(h.validateKey, { activationId, nonce: h.nonce() });
    expect(suspended.statusCode).toBe(200);
    const sBody = suspended.json() as Wire;
    expect(sBody.verdict).toBe("suspended");
    expect(sBody.shortLivedToken).toBeUndefined();

    // Reinstate -> renewal RESUMES on the very next beat (no sticky state; re-evaluated each beat, FR-006).
    await reinstateLicense(h.pool, h.tenantA, "test-admin", lic.id);
    const resumed = await h.heartbeat(h.validateKey, { activationId, nonce: h.nonce() });
    expect(resumed.statusCode).toBe(200);
    const rBody = resumed.json() as Wire;
    expect(rBody.verdict).toBe("valid");
    expect(rBody.shortLivedToken).toBeDefined();
    // The fresh token verifies offline against the product key (SC-003).
    expect(await h.verifyOffline(rBody.shortLivedToken!, fp)).toBe(0);
  });

  it("US2: an expired license -> verdict:expired, no token (SC-003)", async () => {
    const lic = await h.issueLicense();
    const fp = h.sigs("e1", "e2", "e3", "e4", "e5");
    const { activationId } = await h.activateMachine(lic.id, fp);

    // Force the license past its expiry, then beat.
    await h.setLicenseExpiry(lic.id, Math.floor(Date.now() / 1000) - 3600);
    const res = await h.heartbeat(h.validateKey, { activationId, nonce: h.nonce() });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Wire;
    expect(body.verdict).toBe("expired");
    expect(body.shortLivedToken).toBeUndefined();
  });

  it("US2: a deactivated activation on an active license -> verdict:deactivated, no token (SC-003)", async () => {
    const lic = await h.issueLicense();
    const fp = h.sigs("d1", "d2", "d3", "d4", "d5");
    const { activationId } = await h.activateMachine(lic.id, fp);

    await deactivate(h.pool, h.tenantA, "test-admin", activationId);
    const res = await h.validate(h.validateKey, { activationId, nonce: h.nonce() });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Wire;
    expect(body.verdict).toBe("deactivated");
    expect(body.shortLivedToken).toBeUndefined();
  });
});
