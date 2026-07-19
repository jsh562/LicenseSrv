// T016 [US1] (FR-008, SC-010): nonce anti-replay + idempotent replay on POST /v1/validate. A retry with the
// SAME nonce for the SAME activation replays the ORIGINAL result at 200 (the SAME already-minted token, and
// the monotonic anchor is NOT advanced twice); a nonce reused to forge a DIFFERENT activation is rejected
// 409 nonce_replayed. Real Postgres via Testcontainers + the real E004 signer.
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { startHarness, type EnforcementHarness } from "./harness.js";

let h: EnforcementHarness;

beforeAll(async () => {
  h = await startHarness("nonce");
}, 240_000);

afterAll(async () => {
  await h?.stop();
});

describe("validate nonce anti-replay + idempotency (integration, real Postgres)", () => {
  it("US1: a same-nonce retry replays the ORIGINAL token (idempotent 200; anchor not advanced twice) (SC-010)", async () => {
    const lic = await h.issueLicense();
    const { activationId } = await h.activateMachine(lic.id, h.sigs("a1", "a2", "a3", "a4", "a5"));
    const n = h.nonce();

    const first = await h.validate(h.validateKey, { activationId, nonce: n });
    expect(first.statusCode).toBe(200);
    const firstBody = first.json() as { verdict: string; shortLivedToken: string; serverTime: string };
    expect(firstBody.verdict).toBe("valid");
    const anchorAfterFirst = await h.anchorOf(activationId);
    expect(anchorAfterFirst).not.toBeNull();

    const replay = await h.validate(h.validateKey, { activationId, nonce: n });
    expect(replay.statusCode).toBe(200);
    const replayBody = replay.json() as { verdict: string; shortLivedToken: string; serverTime: string };
    // The ORIGINAL result is replayed: the SAME token, no second mint.
    expect(replayBody.verdict).toBe("valid");
    expect(replayBody.shortLivedToken).toBe(firstBody.shortLivedToken);
    expect(replayBody.serverTime).toBe(firstBody.serverTime);
    // The monotonic anchor is NOT advanced a second time by an idempotent replay.
    expect(await h.anchorOf(activationId)).toBe(anchorAfterFirst);
  });

  it("US1: a nonce reused to forge a DIFFERENT activation → 409 nonce_replayed (SC-010)", async () => {
    const lic = await h.issueLicense(); // maxActivations 5 → two seats on one license
    const act1 = await h.activateMachine(lic.id, h.sigs("b1", "b2", "b3", "b4", "b5"));
    const act2 = await h.activateMachine(lic.id, h.sigs("c1", "c2", "c3", "c4", "c5"));
    const n = h.nonce();

    const first = await h.validate(h.validateKey, { activationId: act1.activationId, nonce: n });
    expect(first.statusCode).toBe(200);
    expect((first.json() as { verdict: string }).verdict).toBe("valid");

    const forge = await h.validate(h.validateKey, { activationId: act2.activationId, nonce: n });
    expect(forge.statusCode).toBe(409);
    expect((forge.json() as { code: string }).code).toBe("nonce_replayed");
    // The forged check-in never minted a token for act2 and never advanced its anchor.
    expect(await h.anchorOf(act2.activationId)).toBeNull();
  });
});
