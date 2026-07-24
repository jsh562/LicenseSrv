// T033 [US5] (FR-016; SC-010/013): operator/admin force-release. POST /admin/leases/:leaseId/force-release
// reclaims a live lease's seat immediately (freeing it for a new acquire), is IDEMPOTENT (already-ended → 200),
// and is AUDITED. It is admin-plane, fail-closed: a VIEWER attempt is refused 403 and recorded as a security
// event (SC-010); a missing/mismatched double-submit CSRF token is refused 403 fail-closed and recorded as a
// security event (SC-013); an unknown or cross-tenant leaseId resolves to 404 not_found (FR-019). Uses the real
// Testcontainers + admin-session harness.
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { startHarness, type LeaseHarness } from "./harness.js";

let h: LeaseHarness;

beforeAll(async () => {
  h = await startHarness("force-release");
}, 240_000);

afterAll(async () => {
  await h?.stop();
});

async function acquireLive(licenseId: string): Promise<string> {
  const res = await h.acquire(h.leaseKey, { licenseId, holderReference: h.holderRef(), acquireToken: h.nonce() });
  if (res.statusCode !== 201) throw new Error(`acquire failed: ${res.statusCode} ${res.body}`);
  return (res.json() as { id: string }).id;
}

describe("lease force-release (integration, real Postgres + admin session)", () => {
  it("SC-010: an admin force-release frees the seat, is audited, and lets a new session acquire", async () => {
    const lic = await h.issueFloating({ maxConcurrent: 1 }); // a single-seat license
    const leaseId = await acquireLive(lic.licenseId);
    expect(await h.countLive(lic.licenseId)).toBe(1);

    const res = await h.admin("POST", `/admin/leases/${leaseId}/force-release`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ id: leaseId, status: "reclaimed" });
    expect((await h.leaseRow(leaseId))?.status).toBe("reclaimed");
    expect(await h.countLive(lic.licenseId)).toBe(0);

    // The freed seat is immediately available to a different session.
    const reacquired = await h.acquire(h.leaseKey, { licenseId: lic.licenseId, holderReference: h.holderRef(), acquireToken: h.nonce() });
    expect(reacquired.statusCode).toBe(201);

    // The force-release is recorded to the append-only audit log (operational, actor = the admin user).
    const audit = await h.auditRows("lease.force_released", leaseId);
    expect(audit).toHaveLength(1);
    expect(audit[0]!.after).toMatchObject({ licenseId: lic.licenseId, changed: true });
  });

  it("FR-016: force-release is idempotent — a second force-release (already ended) still returns 200", async () => {
    const lic = await h.issueFloating({ maxConcurrent: 2 });
    const leaseId = await acquireLive(lic.licenseId);
    expect((await h.admin("POST", `/admin/leases/${leaseId}/force-release`)).statusCode).toBe(200);
    const again = await h.admin("POST", `/admin/leases/${leaseId}/force-release`);
    expect(again.statusCode).toBe(200);
    expect(again.json()).toEqual({ id: leaseId, status: "reclaimed" });
  });

  it("SC-010: a VIEWER cannot force-release — 403 forbidden, recorded as a security event; the seat is untouched", async () => {
    const lic = await h.issueFloating({ maxConcurrent: 2 });
    const leaseId = await acquireLive(lic.licenseId);

    const res = await h.viewer("POST", `/admin/leases/${leaseId}/force-release`);
    expect(res.statusCode).toBe(403);
    expect((res.json() as { code: string }).code).toBe("forbidden");
    expect((await h.leaseRow(leaseId))?.status).toBe("live"); // the seat is unchanged

    const events = await h.securityEvents();
    expect(events.some((e) => e.action === "authz.denied" && (e.target ?? "").includes(`/admin/leases/${leaseId}/force-release`))).toBe(true);
  });

  it("SC-013: a missing/mismatched CSRF token is refused 403 fail-closed and recorded as a security event", async () => {
    const lic = await h.issueFloating({ maxConcurrent: 2 });
    const leaseId = await acquireLive(lic.licenseId);

    const res = await h.adminNoCsrf("POST", `/admin/leases/${leaseId}/force-release`);
    expect(res.statusCode).toBe(403);
    expect((res.json() as { code: string }).code).toBe("forbidden");
    expect((await h.leaseRow(leaseId))?.status).toBe("live"); // fail-closed — no effect

    const events = await h.securityEvents();
    expect(events.some((e) => e.action === "authz.denied" && (e.target ?? "").includes("(csrf)"))).toBe(true);
  });

  it("SC-012: an unknown or cross-tenant leaseId resolves to 404 not_found (FR-019)", async () => {
    const lic = await h.issueFloating({ maxConcurrent: 2 });
    const leaseId = await acquireLive(lic.licenseId);

    // Tenant B's admin cannot see tenant A's lease → 404 (never 403).
    const cross = await h.adminB("POST", `/admin/leases/${leaseId}/force-release`);
    expect(cross.statusCode).toBe(404);
    expect((cross.json() as { code: string }).code).toBe("not_found");
    expect((await h.leaseRow(leaseId))?.status).toBe("live"); // cross-tenant force-release frees nothing

    const unknown = await h.admin("POST", `/admin/leases/00000000-0000-4000-8000-000000000000/force-release`);
    expect(unknown.statusCode).toBe(404);
  });

  it("force-release requires authentication — an unauthenticated caller is 401", async () => {
    const lic = await h.issueFloating({ maxConcurrent: 2 });
    const leaseId = await acquireLive(lic.licenseId);
    expect((await h.unauth("POST", `/admin/leases/${leaseId}/force-release`)).statusCode).toBe(401);
  });
});
