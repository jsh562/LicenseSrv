// T017 [US1] (FR-014/023; SC-011/016): idempotency/anti-replay + concurrency scope. A replayed acquireToken
// returns the ORIGINAL lease at 200 with no second seat (FR-014/SC-011); a re-acquire from a holder that
// already holds a live lease is idempotent (one live lease per (license, holderKey), FR-023); under `machine`
// scope two instances on one machine (same fingerprint) SHARE a single seat, while under `session` scope two
// distinct holders consume two (SC-016). Real Postgres + the real E004 signer.
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { startHarness, type LeaseHarness } from "./harness.js";

let h: LeaseHarness;

beforeAll(async () => {
  h = await startHarness("idempotency-scope");
}, 240_000);

afterAll(async () => {
  await h?.stop();
});

describe("lease idempotency + scope (integration, real Postgres + real signer)", () => {
  it("SC-011: a replayed acquireToken returns the original lease (200, no Location, no second seat)", async () => {
    const lic = await h.issueFloating({ maxConcurrent: 5 });
    const holderReference = h.holderRef();
    const acquireToken = h.nonce();

    const first = await h.acquire(h.leaseKey, { licenseId: lic.licenseId, holderReference, acquireToken });
    expect(first.statusCode).toBe(201);
    const firstId = (first.json() as { id: string }).id;

    const replay = await h.acquire(h.leaseKey, { licenseId: lic.licenseId, holderReference, acquireToken });
    expect(replay.statusCode).toBe(200);
    expect(replay.headers.location).toBeUndefined();
    expect((replay.json() as { id: string }).id).toBe(firstId);
    expect(await h.countLive(lic.licenseId)).toBe(1);
  });

  it("FR-023: a re-acquire from the same holder (new token) re-uses the live lease, no second seat", async () => {
    const lic = await h.issueFloating({ maxConcurrent: 5 });
    const holderReference = h.holderRef();

    const first = await h.acquire(h.leaseKey, { licenseId: lic.licenseId, holderReference, acquireToken: h.nonce() });
    expect(first.statusCode).toBe(201);
    const firstId = (first.json() as { id: string }).id;

    const reacquire = await h.acquire(h.leaseKey, { licenseId: lic.licenseId, holderReference, acquireToken: h.nonce() });
    expect(reacquire.statusCode).toBe(200);
    expect((reacquire.json() as { id: string }).id).toBe(firstId);
    expect(await h.countLive(lic.licenseId)).toBe(1);
  });

  it("SC-016: under `machine` scope two instances on one machine SHARE a single seat", async () => {
    const lic = await h.issueFloating({ maxConcurrent: 5, scope: "machine" });
    const signals = ["m-sig-1-abcdefghijklmnop", "m-sig-2-abcdefghijklmnop"];

    const inst1 = await h.acquire(h.leaseKey, { licenseId: lic.licenseId, holderReference: h.holderRef(), acquireToken: h.nonce(), fingerprint: { signals } });
    expect(inst1.statusCode).toBe(201);
    expect((inst1.json() as { scope: string }).scope).toBe("machine");

    // A DIFFERENT instance (distinct holderReference + token) on the SAME machine (same fingerprint) re-uses
    // the seat — the holderKey is derived from the fingerprint, so it is the SAME holder.
    const inst2 = await h.acquire(h.leaseKey, {
      licenseId: lic.licenseId,
      holderReference: h.holderRef(),
      acquireToken: h.nonce(),
      fingerprint: { signals: [...signals].reverse() }, // order-independent
    });
    expect(inst2.statusCode).toBe(200);
    expect((inst2.json() as { id: string }).id).toBe((inst1.json() as { id: string }).id);
    expect(await h.countLive(lic.licenseId)).toBe(1);
  });

  it("SC-016: under `session` scope two distinct holders consume two seats", async () => {
    const lic = await h.issueFloating({ maxConcurrent: 5, scope: "session" });
    const a = await h.acquire(h.leaseKey, { licenseId: lic.licenseId, holderReference: h.holderRef(), acquireToken: h.nonce() });
    const b = await h.acquire(h.leaseKey, { licenseId: lic.licenseId, holderReference: h.holderRef(), acquireToken: h.nonce() });
    expect(a.statusCode).toBe(201);
    expect(b.statusCode).toBe(201);
    expect((a.json() as { id: string }).id).not.toBe((b.json() as { id: string }).id);
    expect(await h.countLive(lic.licenseId)).toBe(2);
  });

  it("FR-023: a missing fingerprint under `machine` scope → 400 validation_error (field: fingerprint)", async () => {
    const lic = await h.issueFloating({ maxConcurrent: 5, scope: "machine" });
    const res = await h.acquire(h.leaseKey, { licenseId: lic.licenseId, holderReference: h.holderRef(), acquireToken: h.nonce() });
    expect(res.statusCode).toBe(400);
    expect(res.json() as { code: string; details: { field: string } }).toMatchObject({ code: "validation_error", details: { field: "fingerprint" } });
  });
});
