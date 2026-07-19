// T027 [US5] (FR-012; SC-005): offline-first is preserved — E013 is strictly ADDITIVE. An activation that
// NEVER calls validate/heartbeat keeps its online-anchor columns (`last_checkin_at`/`last_anchor_at`) NULL
// and its E009 `machine_bound_token` offline credential STILL verifies OFFLINE via the E001 core to that
// credential's own `exp`, UNCHANGED by E013. It is NOT treated as revoked-by-default. A separate online
// activation renewing does not touch the never-connected one. Real Postgres via Testcontainers + the E001
// WASM verifier.
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { startHarness, type EnforcementHarness } from "./harness.js";

let h: EnforcementHarness;

beforeAll(async () => {
  h = await startHarness("offline-first");
}, 240_000);

afterAll(async () => {
  await h?.stop();
});

describe("offline-first preserved (integration, real Postgres + E001 core)", () => {
  it("US5: a never-connected activation keeps its anchors NULL and its E009 credential verifies offline (SC-005)", async () => {
    const lic = await h.issueLicense();
    const fp = h.sigs("o1", "o2", "o3", "o4", "o5");
    const { activationId, machineBoundKey } = await h.activateMachine(lic.id, fp);

    // It NEVER calls validate/heartbeat. Its online-anchor columns stay NULL (not revoked-by-default).
    const row = await h.activationRow(activationId);
    expect(row).not.toBeNull();
    expect(row!.status).toBe("active");
    expect(row!.lastCheckinAt).toBeNull();
    expect(row!.lastAnchorAt).toBeNull();
    // E013 did not overwrite or shorten the E009 offline credential.
    expect(row!.machineBoundToken).toBe(machineBoundKey);

    // The E009 machine_bound_token still verifies OFFLINE via the E001 core, unchanged by E013 (SC-005).
    expect(await h.verifyOffline(machineBoundKey, fp)).toBe(0);
  });

  it("US5: another activation renewing online leaves a never-connected sibling untouched (additive)", async () => {
    const lic = await h.issueLicense(); // maxActivations 5 -> two seats on one license
    const offlineFp = h.sigs("q1", "q2", "q3", "q4", "q5");
    const offline = await h.activateMachine(lic.id, offlineFp);
    const onlineFp = h.sigs("t1", "t2", "t3", "t4", "t5");
    const online = await h.activateMachine(lic.id, onlineFp);

    // The online sibling validates + heartbeats (advances its own anchor).
    expect((await h.validate(h.validateKey, { activationId: online.activationId, nonce: h.nonce() })).statusCode).toBe(200);
    expect((await h.heartbeat(h.validateKey, { activationId: online.activationId, nonce: h.nonce() })).statusCode).toBe(200);
    expect(await h.anchorOf(online.activationId)).not.toBeNull();

    // The never-connected sibling is entirely unaffected: NULL anchors, credential intact + offline-verifiable.
    const row = await h.activationRow(offline.activationId);
    expect(row!.lastCheckinAt).toBeNull();
    expect(row!.lastAnchorAt).toBeNull();
    expect(row!.machineBoundToken).toBe(offline.machineBoundKey);
    expect(await h.verifyOffline(offline.machineBoundKey, offlineFp)).toBe(0);
  });
});
