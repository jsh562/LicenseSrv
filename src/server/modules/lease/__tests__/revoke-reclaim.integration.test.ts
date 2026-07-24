// T027 [US3] (FR-024; SC-017/004): the CONFIGURABLE per-reason license-state → live-lease policy. On REVOCATION
// (default policy `reclaim`) the sweeper PROACTIVELY reclaims the license's live leases regardless of TTL, so
// seats free within the sweep interval (near-immediate, SC-017), attributed to the synthetic worker actor with
// reason `license_revoked` (FR-018); on SUSPENSION / EXPIRY the DEFAULT is `timer` (live leases KEEP their seat
// until TTL + grace, only new acquires are refused), but setting `lease_policy_on_suspend` / `lease_policy_on_
// expire` to `reclaim` proactively reclaims on that reason too (reasons `license_suspended` / `license_expired`)
// — the full FR-024 per-reason configurability. Renew RE-CHECKS live license state, so a renew against a
// now-revoked license is refused 409 lease_not_renewable (FR-024). A `timer` revoke policy is honored too. Real
// Postgres.
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { privileged } from "../../../db/client.js";
import { RECLAIM_ACTOR, reclaimSweep } from "../reclaim-worker.js";
import { startHarness, type LeaseHarness } from "./harness.js";

let h: LeaseHarness;

beforeAll(async () => {
  h = await startHarness("revoke-reclaim");
}, 240_000);

afterAll(async () => {
  await h?.stop();
});

async function acquireId(licenseId: string): Promise<string> {
  const res = await h.acquire(h.leaseKey, { licenseId, holderReference: h.holderRef(), acquireToken: h.nonce() });
  if (res.statusCode !== 201) throw new Error(`acquire failed: ${res.statusCode} ${res.body}`);
  return (res.json() as { id: string }).id;
}

const reclaimAudit = (leaseId: string): Promise<{ actor: string; after: { reason: string } } | null> =>
  privileged(h.pool, async (q) => {
    const r = await q("SELECT actor, after FROM audit_log WHERE action = 'lease.reclaimed' AND target = $1", [leaseId]);
    return r.rowCount ? (r.rows[0] as { actor: string; after: { reason: string } }) : null;
  });

describe("lease revoke-reclaim + per-reason policy (integration, real Postgres)", () => {
  it("SC-017: a REVOKED license's live leases are proactively reclaimed within a sweep (reason license_revoked)", async () => {
    const lic = await h.issueFloating({ maxConcurrent: 3, policyOnRevoke: "reclaim" });
    const leaseId = await acquireId(lic.licenseId); // a live, UNEXPIRED lease
    expect((await h.leaseRow(leaseId))?.status).toBe("live");

    await h.setLicenseStatus(lic.licenseId, "revoked");
    const swept = await reclaimSweep(h.pool);
    expect(swept.reclaimed).toBeGreaterThanOrEqual(1);
    expect((await h.leaseRow(leaseId))?.status).toBe("reclaimed"); // reclaimed despite not being past TTL
    expect(await h.countLive(lic.licenseId)).toBe(0);

    const audit = await reclaimAudit(leaseId);
    expect(audit?.actor).toBe(RECLAIM_ACTOR);
    expect(audit?.after.reason).toBe("license_revoked");
  });

  it("SC-017: a SUSPENDED license's live leases persist until TTL + grace (timer policy, not reclaimed)", async () => {
    const lic = await h.issueFloating({ maxConcurrent: 3, policyOnSuspend: "timer" });
    const leaseId = await acquireId(lic.licenseId);

    await h.setLicenseStatus(lic.licenseId, "suspended");
    await reclaimSweep(h.pool);
    expect((await h.leaseRow(leaseId))?.status).toBe("live"); // still holds its seat on the timer
    expect(await h.countLive(lic.licenseId)).toBe(1);
  });

  it("FR-024: a renew against a now-revoked license is refused 409 lease_not_renewable (license_revoked)", async () => {
    const lic = await h.issueFloating({ maxConcurrent: 3 });
    const leaseId = await acquireId(lic.licenseId);
    await h.setLicenseStatus(lic.licenseId, "revoked");

    const r = await h.renew(h.leaseKey, leaseId);
    expect(r.statusCode).toBe(409);
    expect(r.json() as { code: string; details: { reason: string } }).toMatchObject({
      code: "lease_not_renewable",
      details: { reason: "license_revoked" },
    });
  });

  it("FR-024: a revoke policy of `timer` does NOT proactively reclaim (per-reason configurable)", async () => {
    const lic = await h.issueFloating({ maxConcurrent: 3, policyOnRevoke: "timer" });
    const leaseId = await acquireId(lic.licenseId);

    await h.setLicenseStatus(lic.licenseId, "revoked");
    await reclaimSweep(h.pool);
    // Not past TTL + grace and the revoke policy is timer → the live lease is not swept.
    expect((await h.leaseRow(leaseId))?.status).toBe("live");
  });

  it("FR-024: a SUSPENDED license with lease_policy_on_suspend='reclaim' proactively reclaims its live leases (reason license_suspended)", async () => {
    const lic = await h.issueFloating({ maxConcurrent: 3, policyOnSuspend: "reclaim" });
    const leaseId = await acquireId(lic.licenseId); // a live, UNEXPIRED lease
    expect((await h.leaseRow(leaseId))?.status).toBe("live");

    await h.setLicenseStatus(lic.licenseId, "suspended");
    const swept = await reclaimSweep(h.pool);
    expect(swept.reclaimed).toBeGreaterThanOrEqual(1);
    expect((await h.leaseRow(leaseId))?.status).toBe("reclaimed"); // reclaimed despite not being past TTL
    expect(await h.countLive(lic.licenseId)).toBe(0);

    const audit = await reclaimAudit(leaseId);
    expect(audit?.actor).toBe(RECLAIM_ACTOR);
    expect(audit?.after.reason).toBe("license_suspended");
  });

  it("FR-024: an EXPIRED (past expires_at) license with lease_policy_on_expire='reclaim' proactively reclaims its live leases (reason license_expired)", async () => {
    const lic = await h.issueFloating({ maxConcurrent: 3, policyOnExpire: "reclaim" });
    const leaseId = await acquireId(lic.licenseId); // a live lease whose OWN expiry is well in the future
    expect((await h.leaseRow(leaseId))?.status).toBe("live");

    // The LICENSE (not the lease) crosses its expiry — the derived "expired" state; status stays active.
    await h.expireLicense(lic.licenseId, Math.floor(Date.now() / 1000) - 3_600);
    const swept = await reclaimSweep(h.pool);
    expect(swept.reclaimed).toBeGreaterThanOrEqual(1);
    expect((await h.leaseRow(leaseId))?.status).toBe("reclaimed"); // reclaimed on license expiry, not the lease TTL
    expect(await h.countLive(lic.licenseId)).toBe(0);

    const audit = await reclaimAudit(leaseId);
    expect(audit?.actor).toBe(RECLAIM_ACTOR);
    expect(audit?.after.reason).toBe("license_expired");
  });

  it("FR-024: the DEFAULT expire policy `timer` does NOT proactively reclaim an expired license's live leases (regression guard)", async () => {
    const lic = await h.issueFloating({ maxConcurrent: 3 }); // policyOnExpire defaults to `timer`
    const leaseId = await acquireId(lic.licenseId);

    await h.expireLicense(lic.licenseId, Math.floor(Date.now() / 1000) - 3_600);
    await reclaimSweep(h.pool);
    // The lease is not past its OWN TTL + grace and the expire policy is the default timer → not swept.
    expect((await h.leaseRow(leaseId))?.status).toBe("live");
    expect(await h.countLive(lic.licenseId)).toBe(1);
  });
});
