// T022 [US2] (FR-008; SC-006): idempotent release. Releasing a live lease frees its seat IMMEDIATELY so a
// different session can acquire it at once; a repeat release on an already-released lease, an UNKNOWN lease,
// and a CROSS-TENANT lease all return a `200` no-op that frees nothing and never drives the live count below
// zero (the deliberate carve-out from the cross-tenant→404 rule, FR-008/019). Real Postgres + real E004 signer.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";

import { startHarness, type LeaseHarness } from "./harness.js";

let h: LeaseHarness;

beforeAll(async () => {
  h = await startHarness("release");
}, 240_000);

afterAll(async () => {
  await h?.stop();
});

describe("lease release (integration, real Postgres + real signer)", () => {
  it("SC-006: releasing a lease frees the seat so a different session can immediately acquire it", async () => {
    const lic = await h.issueFloating({ maxConcurrent: 1 });
    const a = await h.acquire(h.leaseKey, { licenseId: lic.licenseId, holderReference: h.holderRef(), acquireToken: h.nonce() });
    expect(a.statusCode).toBe(201);
    const leaseId = (a.json() as { id: string }).id;

    // At the cap: a different holder is refused.
    const blocked = await h.acquire(h.leaseKey, { licenseId: lic.licenseId, holderReference: h.holderRef(), acquireToken: h.nonce() });
    expect(blocked.statusCode).toBe(409);

    // Release frees the seat.
    const rel = await h.release(h.leaseKey, leaseId);
    expect(rel.statusCode).toBe(200);
    expect(rel.json()).toEqual({ id: leaseId, status: "released" });
    expect(await h.countLive(lic.licenseId)).toBe(0);

    // A different session can now acquire the freed seat.
    const b = await h.acquire(h.leaseKey, { licenseId: lic.licenseId, holderReference: h.holderRef(), acquireToken: h.nonce() });
    expect(b.statusCode).toBe(201);
    expect(await h.countLive(lic.licenseId)).toBe(1);
  });

  it("SC-006: a repeated release on an already-released lease → 200 no-op, count never below zero", async () => {
    const lic = await h.issueFloating({ maxConcurrent: 2 });
    const a = await h.acquire(h.leaseKey, { licenseId: lic.licenseId, holderReference: h.holderRef(), acquireToken: h.nonce() });
    const leaseId = (a.json() as { id: string }).id;

    expect((await h.release(h.leaseKey, leaseId)).statusCode).toBe(200);
    expect((await h.release(h.leaseKey, leaseId)).statusCode).toBe(200); // idempotent
    expect(await h.countLive(lic.licenseId)).toBe(0);
  });

  it("release of an UNKNOWN lease id → 200 idempotent no-op (no 404 on this route)", async () => {
    const res = await h.release(h.leaseKey, randomUUID());
    expect(res.statusCode).toBe(200);
    expect((res.json() as { status: string }).status).toBe("released");
  });

  it("FR-019: release of a CROSS-TENANT lease → 200 no-op that frees nothing outside the tenant", async () => {
    const lic = await h.issueFloating({ maxConcurrent: 2 });
    const a = await h.acquire(h.leaseKey, { licenseId: lic.licenseId, holderReference: h.holderRef(), acquireToken: h.nonce() });
    const leaseId = (a.json() as { id: string }).id;

    // Tenant B releases tenant A's lease id → 200, but under RLS it touches no row.
    const cross = await h.release(h.leaseKeyB, leaseId);
    expect(cross.statusCode).toBe(200);
    // Tenant A's seat is untouched.
    expect((await h.leaseRow(leaseId))?.status).toBe("live");
    expect(await h.countLive(lic.licenseId)).toBe(1);
  });
});
