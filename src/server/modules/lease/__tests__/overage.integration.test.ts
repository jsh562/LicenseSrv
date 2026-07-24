// T030 [US4] (FR-012/013; SC-009): overage handling — a HARD cap refuses at capacity while a SOFT cap admits a
// bounded temporary overage and METERS each over-base acquisition to the append-only audit log, then refuses
// beyond the allowance. Over real Postgres + the real E004 signer. The effective cap is
// `max_concurrent + concurrency_overage` (FR-012): under a hard cap (overage 0) it equals max_concurrent; a
// soft cap of allowance N admits N seats above the base cap, each flagged `overage: true` on the grant and
// metered to audit (action `lease.overage`) with the concurrency level REACHED — NO card data, NO raw hardware
// id, NO holder reference. A further acquire beyond the allowance is refused 409 seat_capacity_exhausted with
// the used-vs-cap details (distinguished from the base-cap refusal only by those details).
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { startHarness, type LeaseHarness } from "./harness.js";

let h: LeaseHarness;

beforeAll(async () => {
  h = await startHarness("overage");
}, 240_000);

afterAll(async () => {
  await h?.stop();
});

/** Acquire and require a 201 fresh seat; returns the grant body. */
async function acquireFresh(licenseId: string): Promise<Record<string, unknown>> {
  const res = await h.acquire(h.leaseKey, { licenseId, holderReference: h.holderRef(), acquireToken: h.nonce() });
  if (res.statusCode !== 201) throw new Error(`acquire failed: ${res.statusCode} ${res.body}`);
  return res.json() as Record<string, unknown>;
}

describe("lease overage (integration, real Postgres + real signer)", () => {
  it("SC-003/009: a HARD cap (overage 0) refuses at capacity 409 seat_capacity_exhausted, no partial lease", async () => {
    const lic = await h.issueFloating({ maxConcurrent: 2, overage: 0 });
    const a1 = await acquireFresh(lic.licenseId);
    const a2 = await acquireFresh(lic.licenseId);
    expect(a1.overage).toBe(false);
    expect(a2.overage).toBe(false);

    const a3 = await h.acquire(h.leaseKey, { licenseId: lic.licenseId, holderReference: h.holderRef(), acquireToken: h.nonce() });
    expect(a3.statusCode).toBe(409);
    expect(a3.json() as { code: string; details: unknown }).toMatchObject({
      code: "seat_capacity_exhausted",
      details: { maxConcurrent: 2, concurrencyUsed: 2, overageAllowance: 0 },
    });
    expect(await h.countLive(lic.licenseId)).toBe(2);
  });

  it("SC-009: a SOFT cap admits acquisitions within the overage allowance and METERS each to the audit log", async () => {
    // Base cap 2 + overage allowance 1 → effective cap 3.
    const lic = await h.issueFloating({ maxConcurrent: 2, overage: 1 });

    // The two base seats are within the base cap → not overage, not metered.
    const base1 = await acquireFresh(lic.licenseId);
    const base2 = await acquireFresh(lic.licenseId);
    expect(base1.overage).toBe(false);
    expect(base2.overage).toBe(false);
    expect(await h.auditRows("lease.overage", base1.id as string)).toHaveLength(0);
    expect(await h.auditRows("lease.overage", base2.id as string)).toHaveLength(0);

    // The 3rd seat is ABOVE the base cap but within the allowance → admitted, flagged overage, and METERED.
    const over = await acquireFresh(lic.licenseId);
    expect(over.overage).toBe(true);
    expect(over.concurrencyUsed).toBe(3);
    expect(await h.countLive(lic.licenseId)).toBe(3);

    const meter = await h.auditRows("lease.overage", over.id as string);
    expect(meter).toHaveLength(1);
    // The authoritative meter captures the concurrency level reached + the cap shape — and NOTHING sensitive.
    expect(meter[0]!.after).toEqual({ licenseId: lic.licenseId, concurrencyUsed: 3, maxConcurrent: 2, overageAllowance: 1 });
    const serialized = JSON.stringify(meter[0]!.after);
    expect(serialized).not.toMatch(/holderReference|holder_key|card|pan|cvv|signal/i);
  });

  it("SC-009: beyond the overage allowance a SOFT cap refuses 409 seat_capacity_exhausted (used-vs-cap details)", async () => {
    const lic = await h.issueFloating({ maxConcurrent: 2, overage: 1 });
    await acquireFresh(lic.licenseId); // base 1
    await acquireFresh(lic.licenseId); // base 2
    await acquireFresh(lic.licenseId); // overage 1 (effective cap 3 now full)

    const beyond = await h.acquire(h.leaseKey, { licenseId: lic.licenseId, holderReference: h.holderRef(), acquireToken: h.nonce() });
    expect(beyond.statusCode).toBe(409);
    // Same code as the hard-cap refusal; the exhausted SOFT cap is distinguished by details (overageAllowance>0,
    // concurrencyUsed = maxConcurrent + overageAllowance).
    expect(beyond.json() as { code: string; details: unknown }).toMatchObject({
      code: "seat_capacity_exhausted",
      details: { maxConcurrent: 2, concurrencyUsed: 3, overageAllowance: 1 },
    });
    expect(await h.countLive(lic.licenseId)).toBe(3);
  });
});
