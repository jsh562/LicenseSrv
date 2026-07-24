// T039 [COMPLETES FR-019] (SC-012): the lease surface is tenant-isolated, fail-closed. A cross-tenant lease/
// license reference resolves to NOT FOUND on acquire (`license_not_found`), renew (`not_found`), the admin
// registry (404), and admin force-release (404) — never 403, never leaking existence. The sole carve-out is the
// idempotent runtime RELEASE: a cross-tenant leaseId returns 200 and, under forced RLS, touches NO row (frees
// nothing outside the tenant, not an enumeration oracle — FR-008/019). The forced-RLS guarantee is re-asserted
// directly: with the tenant GUC UNSET the `lease` table yields 0 rows despite data being present (SC-012). Uses
// the real Testcontainers harness (tenant A + tenant B keys / admin sessions).
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { startHarness, type LeaseHarness } from "./harness.js";

let h: LeaseHarness;

beforeAll(async () => {
  h = await startHarness("isolation");
}, 240_000);

afterAll(async () => {
  await h?.stop();
});

async function acquireLive(licenseId: string): Promise<string> {
  const res = await h.acquire(h.leaseKey, { licenseId, holderReference: h.holderRef(), acquireToken: h.nonce() });
  if (res.statusCode !== 201) throw new Error(`acquire failed: ${res.statusCode} ${res.body}`);
  return (res.json() as { id: string }).id;
}

describe("multi-tenant lease isolation — cross-tenant → 404 (release carve-out) + forced RLS (FR-019, SC-012)", () => {
  it("forced RLS: an UNSET tenant GUC yields 0 rows on the lease table (despite data present)", async () => {
    const lic = await h.issueFloating({ maxConcurrent: 3 });
    await acquireLive(lic.licenseId); // ensure a lease row exists

    const client = await h.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE licensesrv_app"); // the non-owner app role — RLS is FORCED
      // No `app.current_tenant` GUC is set → the tenant_isolation policy matches nothing.
      const r = await client.query("SELECT count(*)::int AS n FROM lease");
      expect((r.rows[0] as { n: number }).n).toBe(0);
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  });

  it("cross-tenant ACQUIRE against tenant A's license → 404 license_not_found (never 403)", async () => {
    const lic = await h.issueFloating({ maxConcurrent: 3 });
    const res = await h.acquire(h.leaseKeyB, { licenseId: lic.licenseId, holderReference: h.holderRef(), acquireToken: h.nonce() });
    expect(res.statusCode).toBe(404);
    expect((res.json() as { code: string }).code).toBe("license_not_found");
    expect(await h.countLive(lic.licenseId)).toBe(0);
  });

  it("cross-tenant RENEW of tenant A's lease → 404 not_found", async () => {
    const lic = await h.issueFloating({ maxConcurrent: 3 });
    const leaseId = await acquireLive(lic.licenseId);
    const res = await h.renew(h.leaseKeyB, leaseId);
    expect(res.statusCode).toBe(404);
    expect((res.json() as { code: string }).code).toBe("not_found");
    // Tenant A's lease is untouched.
    expect((await h.leaseRow(leaseId))?.status).toBe("live");
  });

  it("cross-tenant REGISTRY read of tenant A's license → 404 not_found", async () => {
    const lic = await h.issueFloating({ maxConcurrent: 3 });
    await acquireLive(lic.licenseId);
    const res = await h.adminB("GET", `/admin/licenses/${lic.licenseId}/leases`);
    expect(res.statusCode).toBe(404);
    expect((res.json() as { code: string }).code).toBe("not_found");
  });

  it("cross-tenant FORCE-RELEASE of tenant A's lease → 404 not_found; the seat is untouched", async () => {
    const lic = await h.issueFloating({ maxConcurrent: 3 });
    const leaseId = await acquireLive(lic.licenseId);
    const res = await h.adminB("POST", `/admin/leases/${leaseId}/force-release`);
    expect(res.statusCode).toBe(404);
    expect((res.json() as { code: string }).code).toBe("not_found");
    expect((await h.leaseRow(leaseId))?.status).toBe("live"); // cross-tenant force-release frees nothing
    expect(await h.countLive(lic.licenseId)).toBe(1);
  });

  it("the RELEASE carve-out: a cross-tenant leaseId returns 200 and touches NO row (frees nothing, no oracle)", async () => {
    const lic = await h.issueFloating({ maxConcurrent: 3 });
    const leaseId = await acquireLive(lic.licenseId);
    expect(await h.countLive(lic.licenseId)).toBe(1);

    // Tenant B releases tenant A's leaseId → idempotent 200 no-op (the documented FR-008/019 exception).
    const res = await h.release(h.leaseKeyB, leaseId);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ id: leaseId, status: "released" });

    // Under forced RLS the release matched no row: tenant A's lease is still LIVE and the count is unchanged.
    expect((await h.leaseRow(leaseId))?.status).toBe("live");
    expect(await h.countLive(lic.licenseId)).toBe(1);
  });
});
