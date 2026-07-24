// T015 [US1] (FR-004/005/006/022/025): the acquire path over real Postgres + the real E004 signer. A fresh
// acquire returns 201 with a server-set expiry + a tamper-evident signed handle (SC-001/018); an absent
// max_concurrent is refused fail-closed 403 no_concurrency_entitlement (SC-019); a suspended/revoked/expired
// license is refused 409 license_not_active (SC-004); a hard cap at capacity is refused 409
// seat_capacity_exhausted (SC-003); a signer fault while signed-handle mode is on fails closed 503 with NO
// seat consumed and no lease persisted (SC-021); the runtime plane is fail-closed on the `lease` scope
// (401/403, SC-020); and optional "activated-devices-only" gating refuses without a current activation (FR-025).
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { SignerError, type Signer } from "../../signing/signer.js";
import { acquireLease } from "../acquire.js";
import { LeaseError } from "../index.js";
import { startHarness, type LeaseHarness } from "./harness.js";

let h: LeaseHarness;

/** A signer that always faults — drives the fail-closed 503 signed-handle path. */
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
  h = await startHarness("acquire");
}, 240_000);

afterAll(async () => {
  await h?.stop();
});

describe("lease acquire (integration, real Postgres + real signer)", () => {
  it("SC-001/018: a fresh acquire returns 201 with a server expiry + a signed lease handle + Location", async () => {
    const lic = await h.issueFloating({ maxConcurrent: 5 });
    const res = await h.acquire(h.leaseKey, { licenseId: lic.licenseId, holderReference: h.holderRef(), acquireToken: h.nonce() });
    expect(res.statusCode).toBe(201);
    const body = res.json() as Record<string, unknown>;
    expect(body.status).toBe("live");
    expect(body.scope).toBe("session");
    expect(body.maxConcurrent).toBe(5);
    expect(body.concurrencyUsed).toBe(1);
    expect(typeof body.expiresAt).toBe("string");
    expect(new Date(body.expiresAt as string).getTime()).toBeGreaterThan(Date.now());
    expect(body.ttlSeconds).toBe(1800);
    expect(body.heartbeatIntervalSeconds).toBe(600);
    expect(typeof body.leaseHandle).toBe("string");
    expect((body.leaseHandle as string).startsWith("LEASE1.")).toBe(true);
    expect(typeof body.keyId).toBe("string");
    expect(res.headers.location).toBe(`/v1/leases/${body.id as string}`);
    expect(await h.countLive(lic.licenseId)).toBe(1);
  });

  it("SC-019: an acquire against a license with no max_concurrent → 403 no_concurrency_entitlement", async () => {
    const lic = await h.issueFloating({ maxConcurrent: null });
    const res = await h.acquire(h.leaseKey, { licenseId: lic.licenseId, holderReference: h.holderRef(), acquireToken: h.nonce() });
    expect(res.statusCode).toBe(403);
    expect((res.json() as { code: string }).code).toBe("no_concurrency_entitlement");
    expect(await h.countLive(lic.licenseId)).toBe(0);
  });

  it("SC-004: suspended / revoked / expired licenses are refused 409 license_not_active with the reason", async () => {
    const suspended = await h.issueFloating({ maxConcurrent: 3 });
    await h.setLicenseStatus(suspended.licenseId, "suspended");
    const r1 = await h.acquire(h.leaseKey, { licenseId: suspended.licenseId, holderReference: h.holderRef(), acquireToken: h.nonce() });
    expect(r1.statusCode).toBe(409);
    expect(r1.json() as { code: string; details: { status: string } }).toMatchObject({ code: "license_not_active", details: { status: "suspended" } });

    const revoked = await h.issueFloating({ maxConcurrent: 3 });
    await h.setLicenseStatus(revoked.licenseId, "revoked");
    const r2 = await h.acquire(h.leaseKey, { licenseId: revoked.licenseId, holderReference: h.holderRef(), acquireToken: h.nonce() });
    expect((r2.json() as { details: { status: string } }).details.status).toBe("revoked");

    const expired = await h.issueFloating({ maxConcurrent: 3 });
    await h.expireLicense(expired.licenseId, Math.floor(Date.now() / 1000) - 100);
    const r3 = await h.acquire(h.leaseKey, { licenseId: expired.licenseId, holderReference: h.holderRef(), acquireToken: h.nonce() });
    expect((r3.json() as { code: string; details: { status: string } })).toMatchObject({ code: "license_not_active", details: { status: "expired" } });
    expect(await h.countLive(expired.licenseId)).toBe(0);
  });

  it("SC-003: a hard cap at capacity refuses the next acquire 409 seat_capacity_exhausted, no partial lease", async () => {
    const lic = await h.issueFloating({ maxConcurrent: 2 });
    const a1 = await h.acquire(h.leaseKey, { licenseId: lic.licenseId, holderReference: h.holderRef(), acquireToken: h.nonce() });
    const a2 = await h.acquire(h.leaseKey, { licenseId: lic.licenseId, holderReference: h.holderRef(), acquireToken: h.nonce() });
    expect(a1.statusCode).toBe(201);
    expect(a2.statusCode).toBe(201);
    const a3 = await h.acquire(h.leaseKey, { licenseId: lic.licenseId, holderReference: h.holderRef(), acquireToken: h.nonce() });
    expect(a3.statusCode).toBe(409);
    expect(a3.json() as { code: string; details: unknown }).toMatchObject({
      code: "seat_capacity_exhausted",
      details: { maxConcurrent: 2, concurrencyUsed: 2, overageAllowance: 0 },
    });
    expect(await h.countLive(lic.licenseId)).toBe(2);
  });

  it("SC-021: a signer fault while signed-handle mode is on → 503, NO seat consumed, no lease persisted", async () => {
    const lic = await h.issueFloating({ maxConcurrent: 3 });
    await expect(
      acquireLease(h.deps({ signer: throwingSigner }), h.tenantA, {
        licenseId: lic.licenseId,
        holderReference: h.holderRef(),
        acquireToken: h.nonce(),
      }),
    ).rejects.toMatchObject({ code: "signer_unavailable", status: 503 } as Partial<LeaseError>);
    expect(await h.countLive(lic.licenseId)).toBe(0);
  });

  it("SC-020: the runtime plane is fail-closed on the lease scope — 401 (no key) / 403 (wrong scope)", async () => {
    const lic = await h.issueFloating({ maxConcurrent: 3 });
    const body = { licenseId: lic.licenseId, holderReference: h.holderRef(), acquireToken: h.nonce() };
    const noKey = await h.acquire(null, body);
    expect(noKey.statusCode).toBe(401);
    const wrongScope = await h.acquire(h.noScopeKey, body);
    expect(wrongScope.statusCode).toBe(403);
    expect((wrongScope.json() as { code: string }).code).toBe("forbidden");
    expect(await h.countLive(lic.licenseId)).toBe(0);
  });

  it("acquire by an unknown / cross-tenant licenseId → 404 license_not_found", async () => {
    const lic = await h.issueFloating({ maxConcurrent: 3 });
    // Tenant B's key cannot see tenant A's license → resolves to not found (FR-019).
    const res = await h.acquire(h.leaseKeyB, { licenseId: lic.licenseId, holderReference: h.holderRef(), acquireToken: h.nonce() });
    expect(res.statusCode).toBe(404);
    expect((res.json() as { code: string }).code).toBe("license_not_found");
  });

  it("FR-025: activated-devices-only gating refuses without a current activation and admits with one", async () => {
    const lic = await h.issueFloating({ maxConcurrent: 3, requireActivation: true });
    // No activation resolves → 409 activation_required (fail-closed).
    await expect(
      acquireLease(h.deps({ activationRead: async () => null }), h.tenantA, {
        licenseId: lic.licenseId,
        holderReference: h.holderRef(),
        acquireToken: h.nonce(),
      }),
    ).rejects.toMatchObject({ code: "activation_required", status: 409 } as Partial<LeaseError>);

    // A valid current activation for this license (resolved by the default read) → admitted.
    const activationId = await h.createActivation(lic.licenseId);
    const result = await acquireLease(h.deps(), h.tenantA, {
      licenseId: lic.licenseId,
      holderReference: h.holderRef(),
      acquireToken: h.nonce(),
      activationReference: activationId,
    });
    expect(result.created).toBe(true);
    expect(result.grant.status).toBe("live");
  });
});
