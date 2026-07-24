// SC-023 / FR-026 [US1]: the server-held holder-key salt is ROTATABLE and a rotation leaves every LIVE lease
// intact. renew/release operate on the STORED lease row by id (they never re-derive the holder-key), so a
// pre-rotation live lease can still be renewed and released after the salt changes; only a NEW acquire derives
// its holder-key under the rotated salt, so the SAME holder reference resolves to a DIFFERENT holder-key and is
// treated as a new holder (no auto-migration across a rotation, INV-8). Exercised through the real acquire/
// renew/release services against real Postgres — the salt is rotated by reconfiguring the live lease config
// (`h.deps()` re-reads `LEASE_HOLDER_KEY_SALT` on every call), the harness-supported reconfiguration path.
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { acquireLease } from "../acquire.js";
import { deriveHolderKey, holderKeyToString } from "../holder-key.js";
import { releaseLease } from "../release.js";
import { renewLease } from "../renew.js";
import { startHarness, type LeaseHarness } from "./harness.js";

// Two distinctive, non-overlapping salts. S1 is provisioned at boot; the test rotates the live config to S2.
const SALT_S1 = "salt-rotation-canary-S1-1111";
const SALT_S2 = "salt-rotation-canary-S2-2222";

let h: LeaseHarness;

beforeAll(async () => {
  h = await startHarness("salt-rotation", { holderKeySalt: SALT_S1 });
}, 240_000);

afterAll(async () => {
  await h?.stop();
});

/** Rotate the SERVER-HELD holder-key salt: the live lease config reads `LEASE_HOLDER_KEY_SALT` on every deps(). */
function rotateSaltTo(salt: string): void {
  process.env.LEASE_HOLDER_KEY_SALT = salt;
}

describe("holder-key salt rotation (integration, real Postgres)", () => {
  it("SC-023: rotating the salt leaves a LIVE lease renewable + releasable by id, while a new acquire for the same holder derives a different holder-key under the new salt", async () => {
    // A shared, session-scoped concurrency license with room for BOTH the pre- and post-rotation holders.
    const lic = await h.issueFloating({ maxConcurrent: 3, scope: "session" });
    const holderReference = `stable-holder-${Date.now()}`; // the SAME reference across the rotation

    // --- Under S1: acquire the lease L1 for the holder reference. ---
    expect(h.deps().config.holderKeySalt).toBe(SALT_S1);
    const acq1 = await acquireLease(h.deps(), h.tenantA, {
      licenseId: lic.licenseId,
      holderReference,
      acquireToken: h.nonce(),
    });
    expect(acq1.created).toBe(true);
    const leaseId = acq1.grant.id;
    const holderKeyS1 = acq1.grant.holderKey;
    // The stored holder-key IS the S1 derivation (salt ‖ scope ‖ reference).
    expect(holderKeyS1).toBe(
      holderKeyToString(deriveHolderKey({ scope: "session", reference: holderReference }, SALT_S1)),
    );
    expect(await h.countLive(lic.licenseId)).toBe(1);

    // Still under S1: a re-acquire of the SAME reference replays the ORIGINAL lease (one live per holder-key) —
    // proving the reference maps to the SAME holder while the salt is unchanged, consuming NO second seat.
    const replay = await acquireLease(h.deps(), h.tenantA, {
      licenseId: lic.licenseId,
      holderReference,
      acquireToken: h.nonce(),
    });
    expect(replay.created).toBe(false);
    expect(replay.grant.id).toBe(leaseId);
    expect(replay.grant.holderKey).toBe(holderKeyS1);
    expect(await h.countLive(lic.licenseId)).toBe(1);

    const genBefore = (await h.leaseRow(leaseId))!.generation;

    // --- Rotate the server-held salt S1 -> S2 (a rare operational event). ---
    rotateSaltTo(SALT_S2);
    expect(h.deps().config.holderKeySalt).toBe(SALT_S2);

    // The pre-rotation LIVE lease is still RENEWABLE by its id — renew operates on the stored row and never
    // re-derives the holder-key, so the salt change does not disturb it (INV-8).
    const renewed = await renewLease(h.deps(), h.tenantA, leaseId);
    expect(renewed.grant.id).toBe(leaseId);
    expect(renewed.grant.holderKey).toBe(holderKeyS1); // unchanged: the stored digest, not re-derived under S2
    const afterRenew = (await h.leaseRow(leaseId))!;
    expect(afterRenew.status).toBe("live");
    expect(afterRenew.generation).toBe(genBefore + 1); // the fence advanced → the renew really touched the row
    expect(await h.countLive(lic.licenseId)).toBe(1); // still exactly one seat

    // A NEW acquire for the SAME holder reference under S2 derives a DIFFERENT holder-key, so it is a NEW holder
    // (not a replay of L1) and consumes a second seat.
    const acq2 = await acquireLease(h.deps(), h.tenantA, {
      licenseId: lic.licenseId,
      holderReference,
      acquireToken: h.nonce(),
    });
    expect(acq2.created).toBe(true);
    expect(acq2.grant.id).not.toBe(leaseId);
    const holderKeyS2 = acq2.grant.holderKey;
    expect(holderKeyS2).not.toBe(holderKeyS1); // rotated salt ⇒ a distinct holder-key for the same reference
    expect(holderKeyS2).toBe(
      holderKeyToString(deriveHolderKey({ scope: "session", reference: holderReference }, SALT_S2)),
    );
    expect(await h.countLive(lic.licenseId)).toBe(2); // both holders now hold a seat concurrently

    // The pre-rotation LIVE lease is still RELEASABLE by its id — release also operates on the stored row.
    const released = await releaseLease(h.deps(), h.tenantA, leaseId);
    expect(released.status).toBe("released");
    expect((await h.leaseRow(leaseId))!.status).toBe("released");

    // Only the post-rotation (S2) lease remains live — the rotation never disturbed accounting.
    expect(await h.countLive(lic.licenseId)).toBe(1);
    expect((await h.leaseRow(acq2.grant.id))!.status).toBe("live");
  });
});
