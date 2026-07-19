// T039 [US6] (FR-014/015; SC-009): clock-tamper resistance on renewal. The server supplies SIGNED server
// time + a short `exp` + a MONOTONIC `last_anchor_at` floor; clock-tamper enforcement itself is CLIENT-side
// (HINT-005), so this suite verifies the three things the SERVER can actually enforce:
//   1. The signed `serverTime` returned to the client IS the authoritative anchor recorded server-side (the
//      token `iat` == the wire `serverTime` == `activation.last_anchor_at`).
//   2. The monotonic anchor floor NEVER regresses: a beat implying a client time/anchor BEFORE the stored
//      `last_anchor_at` (a rollback) does not pull the floor backwards (the guarded advanceAnchor blocks it),
//      yet renewal still succeeds — the server just refuses to lower the recorded anchor.
//   3. The per-plan offline-tolerance is surfaced in-band (`stalenessWindow.offlineToleranceSeconds`) and the
//      renew-before window (`renewAfter` strictly before `expiresAt`) drives the re-anchor gate — a client
//      running offline beyond tolerance must re-anchor (renew) to continue; the never-connected pure-offline
//      rollback exposure is BOUNDED by this window, not prevented (disclosed).
// Real Postgres via Testcontainers + the real E004 signer + the E001 WASM verifier.
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { withTenant } from "../../../db/client.js";
import { startHarness, type EnforcementHarness } from "./harness.js";

let h: EnforcementHarness;

beforeAll(async () => {
  h = await startHarness("clock-tamper");
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
  stalenessWindow: { seconds: number; offlineToleranceSeconds: number; tokenTtlSeconds: number };
}

const unix = (iso: string): number => Math.floor(new Date(iso).getTime() / 1000);

/** Force the activation's server-side anchor floor to an arbitrary instant (activation carries the E009 UPDATE grant). */
const forceAnchor = (activationId: string, whenUnix: number): Promise<void> =>
  withTenant(h.pool, h.tenantA, async (q) => {
    await q("UPDATE activation SET last_anchor_at = to_timestamp($2) WHERE id = $1", [activationId, whenUnix]);
  });

describe("clock-tamper resistance (integration, real Postgres + real signer)", () => {
  it("US6: the signed serverTime returned to the client IS the authoritative server-side anchor (FR-014)", async () => {
    const lic = await h.issueLicense();
    const fp = h.sigs("ct1", "ct2", "ct3", "ct4", "ct5");
    const { activationId } = await h.activateMachine(lic.id, fp);

    const res = await h.validate(h.validateKey, { activationId, nonce: h.nonce() });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Wire;
    expect(body.verdict).toBe("valid");
    // The token is a real, offline-verifiable public artifact carrying that signed server time.
    expect(await h.verifyOffline(body.shortLivedToken!, fp)).toBe(0);

    // The recorded floor equals EXACTLY the signed serverTime handed to the client (= the token `iat`).
    const anchor = await h.anchorOf(activationId);
    expect(anchor).toBe(unix(body.serverTime));
  });

  it("US6: a rollback (a beat implying a time/anchor BEFORE the floor) NEVER lowers the anchor (SC-009)", async () => {
    const lic = await h.issueLicense();
    const fp = h.sigs("rb1", "rb2", "rb3", "rb4", "rb5");
    const { activationId } = await h.activateMachine(lic.id, fp);

    // First real beat establishes the floor at the signed server time.
    const first = (await h.validate(h.validateKey, { activationId, nonce: h.nonce() })).json() as Wire;
    expect(first.verdict).toBe("valid");
    const floor0 = (await h.anchorOf(activationId))!;
    expect(floor0).toBe(unix(first.serverTime));

    // Simulate a HIGHER floor already recorded (as if a later signed anchor had been observed): push
    // last_anchor_at far into the future, so the next beat's REAL signed server time precedes the floor.
    const future = floor0 + 100_000;
    await forceAnchor(activationId, future);
    expect(await h.anchorOf(activationId)).toBe(future);

    // The next beat is still evaluated as valid and STILL renews (renewal is not clock-gated server-side),
    // but its signed serverTime is BEFORE the floor — the guarded advanceAnchor must NOT regress the floor.
    const beat = (await h.heartbeat(h.validateKey, { activationId, nonce: h.nonce() })).json() as Wire;
    expect(beat.verdict).toBe("valid");
    expect(beat.shortLivedToken).toBeDefined();
    expect(unix(beat.serverTime)).toBeLessThan(future); // this beat's signed time precedes the floor

    // The server never lowered the anchor: it is unchanged at the higher floor (monotonic non-decrease).
    const floor1 = (await h.anchorOf(activationId))!;
    expect(floor1).toBe(future);
    expect(floor1).toBeGreaterThanOrEqual(floor0);

    // A subsequent beat whose signed time is AT/AFTER the floor DOES advance it (the floor is a floor, not a cap).
    await forceAnchor(activationId, unix(beat.serverTime) - 5); // drop the floor just below the clock
    const advance = (await h.validate(h.validateKey, { activationId, nonce: h.nonce() })).json() as Wire;
    expect(advance.verdict).toBe("valid");
    expect(await h.anchorOf(activationId)).toBe(unix(advance.serverTime));
  });

  it("US6: the per-plan offline-tolerance + renew-before window are surfaced so a client must re-anchor (FR-015)", async () => {
    const lic = await h.issueLicense();
    const fp = h.sigs("ot1", "ot2", "ot3", "ot4", "ot5");
    const { activationId } = await h.activateMachine(lic.id, fp);

    const body = (await h.validate(h.validateKey, { activationId, nonce: h.nonce() })).json() as Wire;
    expect(body.verdict).toBe("valid");

    // The offline-tolerance window bounds how long a client may run without a fresh anchor before it MUST
    // re-anchor (renew) — disclosed in-band (FR-015).
    expect(body.stalenessWindow.offlineToleranceSeconds).toBeGreaterThan(0);

    // The renew-before gate: the client is told to renew (`renewAfter`) strictly before the hard, fail-closed
    // `expiresAt`. A client offline past `renewAfter` (and, at the limit, `exp`) can no longer renew and must
    // re-anchor — the offline runtime never extends beyond `exp`.
    expect(body.renewAfter).toBeDefined();
    expect(body.expiresAt).toBeDefined();
    expect(unix(body.renewAfter!)).toBeLessThan(unix(body.expiresAt!));
    // exp is bounded by the short-token TTL (offline runtime cannot exceed one renewal window).
    expect(unix(body.expiresAt!) - unix(body.serverTime)).toBeLessThanOrEqual(body.stalenessWindow.tokenTtlSeconds);
  });
});
