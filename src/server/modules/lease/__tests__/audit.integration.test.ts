// T038 [COMPLETES FR-018] (SC-014): the append-only audit trail of the lease surface. Every runtime + admin
// OP writes an audit entry — acquire (`lease.acquired`), idempotent re-acquire (`lease.reacquired`), renew
// (`lease.renewed`), release (`lease.released`), and admin force-release (`lease.force_released`) — and every
// DENIAL is recorded too: no-entitlement / license-not-active / activation-required / seat-capacity-exhausted
// (as `lease.denied` targeting the reason code), lease-not-renewable (as `lease.renew_denied`), the transient
// signer-fault (503, no seat consumed — `lease.denied` targeting `signer_unavailable`), and a rate-limit breach
// (as the `lease.rate_limited` SECURITY event). A TIME-driven reclaim (sweeper) AND a revoke-reclaim each write
// a SYNTHETIC worker-actor entry (`lease-reclaim-worker`) + the affected lease/license id and NO client actor
// (mirroring E013/E014's synthetic-actor workers). Uses the real Testcontainers + real-signer harness; asserts
// against the append-only `audit_log`.
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { SignerError, type Signer } from "../../signing/signer.js";
import { RECLAIM_ACTOR, reclaimSweep } from "../reclaim-worker.js";
import { startHarness, type LeaseHarness } from "./harness.js";

let h: LeaseHarness;

/** The synthetic client actor every runtime op/denial is attributed to (distinct from the worker actor). */
const CLIENT_ACTOR = "lease-api";

/** A signer that always faults — drives the fail-closed 503 signer-fault denial through the ROUTE. */
const throwingSigner: Signer = {
  sign: async () => {
    throw new SignerError("unavailable", "signer down");
  },
  signDetached: async () => {
    throw new SignerError("unavailable", "signer down");
  },
  ready: () => false,
};

beforeAll(async () => {
  h = await startHarness("audit");
}, 240_000);

afterAll(async () => {
  await h?.stop();
});

async function acquireLive(licenseId: string, opts: { token?: string; holder?: string } = {}): Promise<string> {
  const res = await h.acquire(h.leaseKey, {
    licenseId,
    holderReference: opts.holder ?? h.holderRef(),
    acquireToken: opts.token ?? h.nonce(),
  });
  if (res.statusCode !== 201) throw new Error(`acquire failed: ${res.statusCode} ${res.body}`);
  return (res.json() as { id: string }).id;
}

describe("lease audit trail — every op + denial recorded; reclaim is synthetic-actor (FR-018, SC-014)", () => {
  it("acquire → an append-only `lease.acquired` entry (client actor + license id)", async () => {
    const lic = await h.issueFloating({ maxConcurrent: 3 });
    const leaseId = await acquireLive(lic.licenseId);
    const rows = await h.auditRows("lease.acquired", leaseId);
    expect(rows.length).toBe(1);
    expect(rows[0]!.actor).toBe(CLIENT_ACTOR);
    expect(rows[0]!.after).toMatchObject({ licenseId: lic.licenseId, created: true });
    expect(rows[0]!.securityEvent).toBe(false); // a routine op, not a security event
  });

  it("idempotent re-acquire (same token) → a `lease.reacquired` entry, no second seat", async () => {
    const lic = await h.issueFloating({ maxConcurrent: 3 });
    const token = h.nonce();
    const holder = h.holderRef();
    const leaseId = await acquireLive(lic.licenseId, { token, holder });
    const replay = await h.acquire(h.leaseKey, { licenseId: lic.licenseId, holderReference: holder, acquireToken: token });
    expect(replay.statusCode).toBe(200);
    const rows = await h.auditRows("lease.reacquired", leaseId);
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0]!.actor).toBe(CLIENT_ACTOR);
  });

  it("renew → a `lease.renewed` entry", async () => {
    const lic = await h.issueFloating({ maxConcurrent: 3 });
    const leaseId = await acquireLive(lic.licenseId);
    expect((await h.renew(h.leaseKey, leaseId)).statusCode).toBe(200);
    const rows = await h.auditRows("lease.renewed", leaseId);
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0]!.actor).toBe(CLIENT_ACTOR);
  });

  it("release → a `lease.released` entry (even the idempotent no-op is auditable)", async () => {
    const lic = await h.issueFloating({ maxConcurrent: 3 });
    const leaseId = await acquireLive(lic.licenseId);
    expect((await h.release(h.leaseKey, leaseId)).statusCode).toBe(200);
    const rows = await h.auditRows("lease.released", leaseId);
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0]!.actor).toBe(CLIENT_ACTOR);
  });

  it("admin force-release → a `lease.force_released` entry (the operator actor)", async () => {
    const lic = await h.issueFloating({ maxConcurrent: 2 });
    const leaseId = await acquireLive(lic.licenseId);
    expect((await h.admin("POST", `/admin/leases/${leaseId}/force-release`)).statusCode).toBe(200);
    const rows = await h.auditRows("lease.force_released", leaseId);
    expect(rows.length).toBe(1);
    expect(rows[0]!.actor).not.toBe(CLIENT_ACTOR); // attributed to the admin user, not the runtime actor
    expect(rows[0]!.after).toMatchObject({ licenseId: lic.licenseId, changed: true });
  });

  it("denial: no-entitlement (absent max_concurrent) → a `lease.denied` entry targeting the reason", async () => {
    const lic = await h.issueFloating({ maxConcurrent: null });
    const res = await h.acquire(h.leaseKey, { licenseId: lic.licenseId, holderReference: h.holderRef(), acquireToken: h.nonce() });
    expect(res.statusCode).toBe(403);
    const rows = await h.auditRows("lease.denied", "no_concurrency_entitlement");
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0]!.actor).toBe(CLIENT_ACTOR);
  });

  it("denial: license-not-active (suspended) → a `lease.denied` entry targeting the reason", async () => {
    const lic = await h.issueFloating({ maxConcurrent: 3 });
    await h.setLicenseStatus(lic.licenseId, "suspended");
    const res = await h.acquire(h.leaseKey, { licenseId: lic.licenseId, holderReference: h.holderRef(), acquireToken: h.nonce() });
    expect(res.statusCode).toBe(409);
    const rows = await h.auditRows("lease.denied", "license_not_active");
    expect(rows.length).toBeGreaterThanOrEqual(1);
  });

  it("denial: activation-required (gating on, no activation) → a `lease.denied` entry targeting the reason", async () => {
    const lic = await h.issueFloating({ maxConcurrent: 3, requireActivation: true });
    const res = await h.acquire(h.leaseKey, { licenseId: lic.licenseId, holderReference: h.holderRef(), acquireToken: h.nonce() });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { code: string }).code).toBe("activation_required");
    const rows = await h.auditRows("lease.denied", "activation_required");
    expect(rows.length).toBeGreaterThanOrEqual(1);
  });

  it("denial: seat-capacity-exhausted (hard cap) → a `lease.denied` entry targeting the reason", async () => {
    const lic = await h.issueFloating({ maxConcurrent: 1 });
    await acquireLive(lic.licenseId); // fill the single seat
    const res = await h.acquire(h.leaseKey, { licenseId: lic.licenseId, holderReference: h.holderRef(), acquireToken: h.nonce() });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { code: string }).code).toBe("seat_capacity_exhausted");
    const rows = await h.auditRows("lease.denied", "seat_capacity_exhausted");
    expect(rows.length).toBeGreaterThanOrEqual(1);
  });

  it("denial: lease-not-renewable (stale renew after reclaim) → a `lease.renew_denied` entry", async () => {
    const lic = await h.issueFloating({ maxConcurrent: 2 });
    const leaseId = await acquireLive(lic.licenseId);
    await h.expireLease(leaseId); // past TTL + grace
    await reclaimSweep(h.pool); // the sweeper reclaims it
    const res = await h.renew(h.leaseKey, leaseId);
    expect(res.statusCode).toBe(409);
    expect((res.json() as { code: string }).code).toBe("lease_not_renewable");
    const rows = await h.auditRows("lease.renew_denied", "lease_not_renewable");
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0]!.actor).toBe(CLIENT_ACTOR);
  });

  it("denial: a transient signer-fault (503, no seat consumed) → a `lease.denied` entry targeting `signer_unavailable`", async () => {
    const lic = await h.issueFloating({ maxConcurrent: 3 });
    // Swap the ROUTE's signer to a faulting one so the acquire path (signed-handle mode on) fails closed 503.
    const original = h.app.lease!.signer;
    h.app.lease!.signer = throwingSigner;
    let res;
    try {
      res = await h.acquire(h.leaseKey, { licenseId: lic.licenseId, holderReference: h.holderRef(), acquireToken: h.nonce() });
    } finally {
      h.app.lease!.signer = original;
    }
    expect(res.statusCode).toBe(503);
    expect((res.json() as { code: string }).code).toBe("signer_unavailable");
    expect(await h.countLive(lic.licenseId)).toBe(0); // no seat consumed
    const rows = await h.auditRows("lease.denied", "signer_unavailable");
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0]!.actor).toBe(CLIENT_ACTOR);
  });

  it("a TIME-driven reclaim (sweeper) writes a SYNTHETIC worker-actor entry + lease/license id, NO client actor", async () => {
    const lic = await h.issueFloating({ maxConcurrent: 2 });
    const leaseId = await acquireLive(lic.licenseId);
    await h.expireLease(leaseId); // past TTL + grace
    expect((await reclaimSweep(h.pool)).reclaimed).toBeGreaterThanOrEqual(1);

    const rows = await h.auditRows("lease.reclaimed", leaseId);
    expect(rows.length).toBe(1);
    expect(rows[0]!.actor).toBe(RECLAIM_ACTOR); // synthetic system/worker actor
    expect(rows[0]!.actor).not.toBe(CLIENT_ACTOR); // NOT a client/runtime actor
    expect(rows[0]!.after).toMatchObject({ licenseId: lic.licenseId, reason: "ttl_grace" });
  });

  it("a revoke-reclaim writes a SYNTHETIC worker-actor entry + lease/license id + reason `license_revoked`, NO client actor", async () => {
    const lic = await h.issueFloating({ maxConcurrent: 2, policyOnRevoke: "reclaim" });
    const leaseId = await acquireLive(lic.licenseId); // a live, UNEXPIRED lease
    await h.setLicenseStatus(lic.licenseId, "revoked");
    expect((await reclaimSweep(h.pool)).reclaimed).toBeGreaterThanOrEqual(1);

    const rows = await h.auditRows("lease.reclaimed", leaseId);
    expect(rows.length).toBe(1);
    expect(rows[0]!.actor).toBe(RECLAIM_ACTOR);
    expect(rows[0]!.actor).not.toBe(CLIENT_ACTOR);
    expect(rows[0]!.after).toMatchObject({ licenseId: lic.licenseId, reason: "license_revoked" });
  });
});

describe("lease rate-limit breach is audited as a security event (FR-017/018, SC-014)", () => {
  let hr: LeaseHarness;
  const RATE_MAX = 5;

  beforeAll(async () => {
    // A LOW per-API-key runtime ceiling so a modest burst trips the 429 shed path. The admin rate limit uses the
    // same ceiling but only covers the two LEASE admin routes (an encapsulated scope), so harness provisioning
    // (other-module admin routes) is unaffected.
    hr = await startHarness("audit-rate", { rateMax: RATE_MAX });
  }, 240_000);

  afterAll(async () => {
    await hr?.stop();
  });

  it("over-limit runtime lease calls → 429 rate_limited and each shed is a `lease.rate_limited` security event", async () => {
    const lic = await hr.issueFloating({ maxConcurrent: 50 });
    const statuses: number[] = [];
    for (let i = 0; i < RATE_MAX + 8; i++) {
      const res = await hr.acquire(hr.leaseKey, { licenseId: lic.licenseId, holderReference: hr.holderRef(), acquireToken: hr.nonce() });
      statuses.push(res.statusCode);
    }
    // The first RATE_MAX pass the ceiling (201); the surplus is shed 429.
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThanOrEqual(1);
    const shed = statuses.find((s) => s === 429);
    expect(shed).toBe(429);

    // The shed request(s) are audited as a security event (best-effort/async → poll).
    const audited = await waitForSecurityEvent(hr, (e) => e.action === "lease.rate_limited");
    expect(audited).toBe(true);
  });

  it("the ADMIN lease plane is ALSO rate-limited — over-limit registry reads → 429 rate_limited + Retry-After", async () => {
    // The admin lease scope carries a bounded per-source-IP ceiling (FR-017); session + RBAC + CSRF are the
    // primary control but the plane is rate-limited too. A burst of registry reads from one IP trips it.
    const lic = await hr.issueFloating({ maxConcurrent: 3 });
    const statuses: number[] = [];
    let over: Awaited<ReturnType<typeof hr.admin>> | undefined;
    for (let i = 0; i < RATE_MAX + 6; i++) {
      const res = await hr.admin("GET", `/admin/licenses/${lic.licenseId}/leases`);
      statuses.push(res.statusCode);
      if (res.statusCode === 429) over = res;
    }
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThanOrEqual(1);
    expect(over).toBeDefined();
    expect((over!.json() as { code: string }).code).toBe("rate_limited");
    expect(over!.headers["retry-after"]).toBeDefined(); // the standard backoff signal
  });
});

/** Poll the tenant-A security-event trail until `pred` matches or the timeout elapses (best-effort async audit). */
async function waitForSecurityEvent(
  harness: LeaseHarness,
  pred: (r: { actor: string; action: string; target: string | null }) => boolean,
  timeoutMs = 3000,
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const events = await harness.securityEvents();
    if (events.some(pred)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}
