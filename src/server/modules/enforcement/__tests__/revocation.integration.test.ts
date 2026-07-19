// T020 [US2] (FR-005; SC-002/004): revocation propagation within the renewal window. A connected client
// validates an active license and receives a renewing short-lived token; the admin then REVOKES the license
// (E008 lifecycle). The NEXT validate/heartbeat is a 200 `verdict:"revoked"` with NO new token — renewal is
// refused by ceasing to re-issue (AD-001). The PREVIOUSLY-issued short-lived token still verifies OFFLINE
// via the E001 core until its own `exp` (it is NOT force-killed), but it is never renewed, so access lapses
// within the bounded renewal window (staleness <= short-token TTL, SC-004). A refused beat advances no
// anchor. Real Postgres via Testcontainers + the real E004 signer + the E001 WASM verifier.
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { revokeLicense } from "../../issuance/lifecycle.js";
import { startHarness, type EnforcementHarness } from "./harness.js";

let h: EnforcementHarness;

beforeAll(async () => {
  h = await startHarness("revocation");
}, 240_000);

afterAll(async () => {
  await h?.stop();
});

interface Wire {
  verdict: string;
  shortLivedToken?: string;
  serverTime: string;
  expiresAt?: string;
  stalenessWindow: { seconds: number; tokenTtlSeconds: number };
}

describe("revocation propagation (integration, real Postgres + real signer)", () => {
  it("US2: revoke → next validate is 200 revoked with NO token; the outstanding token still verifies offline until exp (SC-002/004)", async () => {
    const lic = await h.issueLicense();
    const fp = h.sigs("r1", "r2", "r3", "r4", "r5");
    const { activationId } = await h.activateMachine(lic.id, fp);

    // A connected client validates while active → a renewing short-lived token that verifies offline.
    const first = await h.validate(h.validateKey, { activationId, nonce: h.nonce() });
    expect(first.statusCode).toBe(200);
    const firstBody = first.json() as Wire;
    expect(firstBody.verdict).toBe("valid");
    const outstandingToken = firstBody.shortLivedToken!;
    expect(await h.verifyOffline(outstandingToken, fp)).toBe(0);
    const anchorBefore = await h.anchorOf(activationId);
    expect(anchorBefore).not.toBeNull();

    // SC-004: the token's own lifetime is bounded by the renewal window (staleness <= TTL).
    const ttl = (new Date(firstBody.expiresAt!).getTime() - new Date(firstBody.serverTime).getTime()) / 1000;
    expect(ttl).toBeLessThanOrEqual(firstBody.stalenessWindow.tokenTtlSeconds);

    // The admin revokes the license (E008 lifecycle) — the terminal state.
    await revokeLicense(h.pool, h.tenantA, "test-admin", lic.id);

    // The NEXT validate is refused: 200 verdict:revoked, no new token (AD-001; renew-by-ceasing-to-reissue).
    const afterValidate = await h.validate(h.validateKey, { activationId, nonce: h.nonce() });
    expect(afterValidate.statusCode).toBe(200);
    const av = afterValidate.json() as Wire;
    expect(av.verdict).toBe("revoked");
    expect(av.shortLivedToken).toBeUndefined();

    // ...and so is a heartbeat: same refusal on the renewal path.
    const afterBeat = await h.heartbeat(h.validateKey, { activationId, nonce: h.nonce() });
    expect(afterBeat.statusCode).toBe(200);
    const ab = afterBeat.json() as Wire;
    expect(ab.verdict).toBe("revoked");
    expect(ab.shortLivedToken).toBeUndefined();

    // Bounded staleness: the previously-issued token is NOT force-revoked — it still verifies offline until
    // its exp; it simply is never renewed, so access lapses within the renewal window (SC-002/004).
    expect(await h.verifyOffline(outstandingToken, fp)).toBe(0);

    // A refused beat advances no anchor (the last successful anchor is unchanged).
    expect(await h.anchorOf(activationId)).toBe(anchorBefore);
  });

  it("US2: revocation is idempotent — repeated refused beats stay 200 revoked and never mint a token", async () => {
    const lic = await h.issueLicense();
    const fp = h.sigs("s1", "s2", "s3", "s4", "s5");
    const { activationId } = await h.activateMachine(lic.id, fp);
    await revokeLicense(h.pool, h.tenantA, "test-admin", lic.id);

    for (let i = 0; i < 3; i++) {
      const res = await h.heartbeat(h.validateKey, { activationId, nonce: h.nonce() });
      expect(res.statusCode).toBe(200);
      const body = res.json() as Wire;
      expect(body.verdict).toBe("revoked");
      expect(body.shortLivedToken).toBeUndefined();
    }
    // Never anchored: this activation only ever produced refused beats.
    expect(await h.anchorOf(activationId)).toBeNull();
  });
});
