// T023 [US3] (FR-002/017; SC-003): heartbeat renews a valid binding and reflects CURRENT entitlements. A
// beat before expiry mints a FRESH short-lived token and advances the monotonic last-seen anchor (FR-014).
// Critically for FR-017, the renewed token bakes in the CURRENT effective entitlements (E007) re-read this
// beat — NOT the license's issue-time snapshot — so a plan/entitlement change PROPAGATES on the next
// renewal, verified OFFLINE via the E001 core (which reads the entitlement claims back). Real Postgres via
// Testcontainers + the real E004 signer + the E001 WASM verifier.
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createEntitlement } from "../../catalog/entitlements.js";
import { createPlan } from "../../catalog/plans.js";
import { setPlanEntitlementValue } from "../../catalog/values.js";
import { startHarness, type EnforcementHarness } from "./harness.js";

let h: EnforcementHarness;

beforeAll(async () => {
  h = await startHarness("heartbeat");
}, 240_000);

afterAll(async () => {
  await h?.stop();
});

interface Wire {
  verdict: string;
  shortLivedToken?: string;
  serverTime: string;
}
const slug = (p: string): string => `${p}-${randomUUID().split("-")[0]}`;

describe("heartbeat renewal (integration, real Postgres + real signer + E001 core)", () => {
  it("US3: a heartbeat before expiry mints a FRESH token and advances the monotonic anchor (FR-014)", async () => {
    const lic = await h.issueLicense();
    const fp = h.sigs("h1", "h2", "h3", "h4", "h5");
    const { activationId } = await h.activateMachine(lic.id, fp);
    expect(await h.anchorOf(activationId)).toBeNull(); // never-connected until the first beat

    const first = await h.heartbeat(h.validateKey, { activationId, nonce: h.nonce() });
    expect(first.statusCode).toBe(200);
    const firstBody = first.json() as Wire;
    expect(firstBody.verdict).toBe("valid");
    expect(await h.verifyOffline(firstBody.shortLivedToken!, fp)).toBe(0);
    const anchor1 = await h.anchorOf(activationId);
    expect(anchor1).not.toBeNull(); // advanced from NULL on the first successful beat

    // A later beat mints a FRESH token and advances the anchor further (monotonic; >1s ensures a new second).
    await new Promise((r) => setTimeout(r, 1_100));
    const second = await h.heartbeat(h.validateKey, { activationId, nonce: h.nonce() });
    const secondBody = second.json() as Wire;
    expect(secondBody.verdict).toBe("valid");
    expect(secondBody.shortLivedToken).not.toBe(firstBody.shortLivedToken); // a fresh mint, not a replay
    expect(await h.verifyOffline(secondBody.shortLivedToken!, fp)).toBe(0);
    const anchor2 = await h.anchorOf(activationId);
    expect(anchor2!).toBeGreaterThan(anchor1!); // the last-seen anchor advanced
  });

  it("US3: the renewed token reflects a CURRENT entitlement change, not the issue-time snapshot (FR-017)", async () => {
    // A dedicated plan issued with NO entitlements, so the license snapshot cannot be the source of truth.
    const plan = await createPlan(h.pool, h.tenantA, "test", h.productId, { key: slug("plan"), name: "Ent Plan", maxActivations: 5 });
    const lic = await h.issueLicense(plan.id);
    const fp = h.sigs("f1", "f2", "f3", "f4", "f5");
    const { activationId } = await h.activateMachine(lic.id, fp);

    // Attach an integer-limit entitlement to the plan AFTER issue, then beat: the renewed token must carry
    // the CURRENT effective value (10), even though the license was snapshotted without it.
    const seatsKey = slug("seats");
    const ent = await createEntitlement(h.pool, h.tenantA, "test", { key: seatsKey, name: "Seats", type: "integer_limit" });
    await setPlanEntitlementValue(h.pool, h.tenantA, "test", plan.id, ent.id, 10);

    const beat1 = await h.heartbeat(h.validateKey, { activationId, nonce: h.nonce() });
    const b1 = beat1.json() as Wire;
    expect(b1.verdict).toBe("valid");
    const v1 = await h.verifyEntitlements(b1.shortLivedToken!, fp, { int: [seatsKey] });
    expect(v1.code).toBe(0);
    expect(v1.int[seatsKey]).toBe(10);

    // Change the effective entitlement value; the NEXT renewal reflects it (propagation on renewal, FR-017).
    await setPlanEntitlementValue(h.pool, h.tenantA, "test", plan.id, ent.id, 20);
    const beat2 = await h.heartbeat(h.validateKey, { activationId, nonce: h.nonce() });
    const b2 = beat2.json() as Wire;
    expect(b2.verdict).toBe("valid");
    const v2 = await h.verifyEntitlements(b2.shortLivedToken!, fp, { int: [seatsKey] });
    expect(v2.code).toBe(0);
    expect(v2.int[seatsKey]).toBe(20);
  });
});
