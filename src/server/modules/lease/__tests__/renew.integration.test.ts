// T021 [US2] (FR-007/011/022; SC-005/008/021): heartbeat renew. A renew extends the SERVER-computed expiry and
// bumps the generation while keeping EXACTLY one seat (repeated heartbeats never consume a second seat, SC-005);
// a stale/late renew after the lease was reclaimed/expired matches 0 rows → 409 lease_not_renewable (FR-011/
// SC-008); an unknown/cross-tenant lease → 404 not_found; and a signer fault while signed-handle mode is on
// leaves the lease and its seat UNCHANGED → 503 (SC-021). Real Postgres + the real E004 signer.
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { SignerError, type Signer } from "../../signing/signer.js";
import { reclaimSweep } from "../reclaim-worker.js";
import { renewLease } from "../renew.js";
import { startHarness, type LeaseHarness } from "./harness.js";

let h: LeaseHarness;

const throwingSigner: Signer = {
  sign: async () => {
    throw new SignerError("unavailable", "signer down");
  },
  signDetached: async () => {
    throw new SignerError("unavailable", "signer down");
  },
  ready: () => false,
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  h = await startHarness("renew");
}, 240_000);

afterAll(async () => {
  await h?.stop();
});

async function acquireOne(licenseId: string): Promise<{ id: string; expiresAt: string }> {
  const res = await h.acquire(h.leaseKey, { licenseId, holderReference: h.holderRef(), acquireToken: h.nonce() });
  if (res.statusCode !== 201) throw new Error(`acquire failed: ${res.statusCode} ${res.body}`);
  const body = res.json() as { id: string; expiresAt: string };
  return { id: body.id, expiresAt: body.expiresAt };
}

describe("lease renew (integration, real Postgres + real signer)", () => {
  it("SC-005: renew extends the expiry, bumps the generation, and keeps exactly one seat", async () => {
    const lic = await h.issueFloating({ maxConcurrent: 3 });
    const lease = await acquireOne(lic.licenseId);
    const before = await h.leaseRow(lease.id);
    expect(before?.generation).toBe(0);

    await sleep(60);
    const r = await h.renew(h.leaseKey, lease.id);
    expect(r.statusCode).toBe(200);
    const body = r.json() as { expiresAt: string; concurrencyUsed: number; overage: boolean; leaseHandle: string | null };
    expect(new Date(body.expiresAt).getTime()).toBeGreaterThan(new Date(lease.expiresAt).getTime());
    expect(body.concurrencyUsed).toBe(1);
    expect(body.overage).toBe(false);
    expect(typeof body.leaseHandle).toBe("string");

    const after = await h.leaseRow(lease.id);
    expect(after?.generation).toBe(1);
    expect(await h.countLive(lic.licenseId)).toBe(1);

    // A second heartbeat still keeps exactly one seat.
    await sleep(30);
    const r2 = await h.renew(h.leaseKey, lease.id);
    expect(r2.statusCode).toBe(200);
    expect((await h.leaseRow(lease.id))?.generation).toBe(2);
    expect(await h.countLive(lic.licenseId)).toBe(1);
  });

  it("SC-008: a stale renew after the lease was reclaimed → 409 lease_not_renewable (reason reclaimed)", async () => {
    const lic = await h.issueFloating({ maxConcurrent: 3 });
    const lease = await acquireOne(lic.licenseId);
    await h.expireLease(lease.id); // past TTL + grace
    await reclaimSweep(h.pool); // the sweeper reclaims it
    expect((await h.leaseRow(lease.id))?.status).toBe("reclaimed");

    const r = await h.renew(h.leaseKey, lease.id);
    expect(r.statusCode).toBe(409);
    expect(r.json() as { code: string; details: { reason: string } }).toMatchObject({ code: "lease_not_renewable", details: { reason: "reclaimed" } });
    // No seat was revived or double-counted.
    expect(await h.countLive(lic.licenseId)).toBe(0);
  });

  it("FR-011: a renew of a still-live but TTL+grace-LAPSED lease (not yet swept) → 409 lease_not_renewable (reason expired)", async () => {
    const lic = await h.issueFloating({ maxConcurrent: 3 });
    const lease = await acquireOne(lic.licenseId);
    // Lapse the lease past its expiry WITHOUT running the sweeper — the row is still `live` but expired, so the
    // fence-guarded UPDATE (`expires_at > now()`) matches 0 rows and the reason is diagnosed as `expired`.
    await h.expireLease(lease.id);
    expect((await h.leaseRow(lease.id))?.status).toBe("live");

    const r = await h.renew(h.leaseKey, lease.id);
    expect(r.statusCode).toBe(409);
    expect(r.json() as { code: string; details: { reason: string } }).toMatchObject({
      code: "lease_not_renewable",
      details: { reason: "expired" },
    });
    // A renew never revives an expired seat.
    expect(await h.countLive(lic.licenseId)).toBe(1); // still counted live until the sweeper reclaims it
  });

  it("renew of an unknown / cross-tenant lease → 404 not_found", async () => {
    const lic = await h.issueFloating({ maxConcurrent: 3 });
    const lease = await acquireOne(lic.licenseId);
    // Tenant B cannot see tenant A's lease → not found (FR-019).
    const crossTenant = await h.renew(h.leaseKeyB, lease.id);
    expect(crossTenant.statusCode).toBe(404);
    expect((crossTenant.json() as { code: string }).code).toBe("not_found");
  });

  it("SC-021: a signer fault on renew → 503, the lease and its seat UNCHANGED", async () => {
    const lic = await h.issueFloating({ maxConcurrent: 3 });
    const lease = await acquireOne(lic.licenseId);
    const before = await h.leaseRow(lease.id);

    await expect(renewLease(h.deps({ signer: throwingSigner }), h.tenantA, lease.id)).rejects.toMatchObject({
      code: "signer_unavailable",
      status: 503,
    });

    const after = await h.leaseRow(lease.id);
    expect(after?.status).toBe("live");
    expect(after?.generation).toBe(before?.generation); // the renew was rolled back
    expect(after?.expiresAt).toBe(before?.expiresAt);
    expect(await h.countLive(lic.licenseId)).toBe(1);
  });
});
