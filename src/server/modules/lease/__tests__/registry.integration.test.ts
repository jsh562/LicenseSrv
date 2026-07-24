// T032 [US5] (FR-015; SC-010/012): the operator lease registry. GET /admin/licenses/:licenseId/leases lists a
// license's LIVE and recently-ended leases (pseudonymous holderKey, scope, status, acquired/last-renewed/
// expires timestamps) plus a concurrency-used-vs-cap summary — deterministically ordered, bounded to 1000 with
// a `truncated` signal, NEVER exposing a signed lease handle or a raw holder reference (SC-015). A viewer (or
// higher) may read; an unauthenticated caller is 401; a cross-tenant / unknown licenseId resolves to 404 under
// RLS (FR-019). Uses the real Testcontainers + admin-session harness.
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { startHarness, type LeaseHarness } from "./harness.js";

let h: LeaseHarness;

beforeAll(async () => {
  h = await startHarness("registry");
}, 240_000);

afterAll(async () => {
  await h?.stop();
});

interface RegistryBody {
  concurrencyUsed: number;
  maxConcurrent: number;
  overageAllowance: number;
  scope: string;
  truncated: boolean;
  leases: Array<{
    id: string;
    holderKey: string;
    scope: string;
    status: string;
    acquiredAt: string;
    lastRenewedAt: string;
    expiresAt: string;
    leaseHandle?: unknown;
  }>;
}

async function acquireLive(licenseId: string): Promise<{ id: string; holderKey: string }> {
  const res = await h.acquire(h.leaseKey, { licenseId, holderReference: h.holderRef(), acquireToken: h.nonce() });
  if (res.statusCode !== 201) throw new Error(`acquire failed: ${res.statusCode} ${res.body}`);
  const b = res.json() as { id: string; holderKey: string };
  return { id: b.id, holderKey: b.holderKey };
}

describe("lease registry (integration, real Postgres + admin session)", () => {
  it("SC-010: lists live + recently-ended leases (pseudonymous, used-vs-cap, no handle), deterministic order", async () => {
    const lic = await h.issueFloating({ maxConcurrent: 5, overage: 0 });
    const first = await acquireLive(lic.licenseId);
    const second = await acquireLive(lic.licenseId);
    // A released (recently-ended) lease should also appear within the 24h display window.
    const released = await acquireLive(lic.licenseId);
    expect((await h.release(h.leaseKey, released.id)).statusCode).toBe(200);

    const res = await h.admin("GET", `/admin/licenses/${lic.licenseId}/leases`);
    expect(res.statusCode).toBe(200);
    const body = res.json() as RegistryBody;

    expect(body.concurrencyUsed).toBe(2); // the two LIVE leases (the released one freed its seat)
    expect(body.maxConcurrent).toBe(5);
    expect(body.overageAllowance).toBe(0);
    expect(body.scope).toBe("session");
    expect(body.truncated).toBe(false);

    const ids = body.leases.map((l) => l.id);
    expect(ids).toContain(first.id);
    expect(ids).toContain(second.id);
    expect(ids).toContain(released.id); // recently-ended, still shown

    const releasedRow = body.leases.find((l) => l.id === released.id)!;
    expect(releasedRow.status).toBe("released");
    const liveRow = body.leases.find((l) => l.id === first.id)!;
    expect(liveRow.status).toBe("live");
    expect(liveRow.holderKey).toBe(first.holderKey); // pseudonymous holder key, echoed
    expect(liveRow.scope).toBe("session");
    expect(typeof liveRow.acquiredAt).toBe("string");

    // Deterministic order: acquired_at DESC (ties by id DESC) — non-increasing timestamps.
    for (let i = 1; i < body.leases.length; i++) {
      expect(body.leases[i - 1]!.acquiredAt >= body.leases[i]!.acquiredAt).toBe(true);
    }

    // SC-015: NO signed lease handle or raw holder reference is present in the registry.
    for (const l of body.leases) {
      expect(l.leaseHandle).toBeUndefined();
    }
    expect(JSON.stringify(body)).not.toMatch(/LEASE1\.|instance-/);
  });

  it("FR-015: an optional ?status filter narrows the set", async () => {
    const lic = await h.issueFloating({ maxConcurrent: 5 });
    const live = await acquireLive(lic.licenseId);
    const gone = await acquireLive(lic.licenseId);
    await h.release(h.leaseKey, gone.id);

    const liveOnly = await h.admin("GET", `/admin/licenses/${lic.licenseId}/leases?status=live`);
    const liveBody = liveOnly.json() as RegistryBody;
    expect(liveBody.leases.every((l) => l.status === "live")).toBe(true);
    expect(liveBody.leases.map((l) => l.id)).toContain(live.id);
    expect(liveBody.leases.map((l) => l.id)).not.toContain(gone.id);

    const releasedOnly = await h.admin("GET", `/admin/licenses/${lic.licenseId}/leases?status=released`);
    const relBody = releasedOnly.json() as RegistryBody;
    expect(relBody.leases.map((l) => l.id)).toContain(gone.id);
    expect(relBody.leases.every((l) => l.status === "released")).toBe(true);
  });

  it("FR-015: the list is bounded to 1000 with a truncated signal (concurrencyUsed reflects the TRUE live total)", async () => {
    const lic = await h.issueFloating({ maxConcurrent: 5 });
    // 1001 recently-ended leases (within the 24h window) exceed the 1000 hard cap.
    await h.seedEndedLeases(lic.licenseId, 1001, `reg-trunc-${lic.licenseId}-`);

    const res = await h.admin("GET", `/admin/licenses/${lic.licenseId}/leases`);
    const body = res.json() as RegistryBody;
    expect(body.leases).toHaveLength(1000);
    expect(body.truncated).toBe(true);
    expect(body.concurrencyUsed).toBe(0); // all seeded rows are terminal — the live count is independent
  });

  it("SC-010: a viewer may read the registry; an unauthenticated caller is 401", async () => {
    const lic = await h.issueFloating({ maxConcurrent: 3 });
    await acquireLive(lic.licenseId);
    expect((await h.viewer("GET", `/admin/licenses/${lic.licenseId}/leases`)).statusCode).toBe(200);
    expect((await h.unauth("GET", `/admin/licenses/${lic.licenseId}/leases`)).statusCode).toBe(401);
  });

  it("SC-012: a cross-tenant or unknown licenseId resolves to 404 not_found (FR-019)", async () => {
    const lic = await h.issueFloating({ maxConcurrent: 3 });
    await acquireLive(lic.licenseId);
    // Tenant B's admin cannot see tenant A's license → 404 (never 403; not an enumeration oracle).
    const cross = await h.adminB("GET", `/admin/licenses/${lic.licenseId}/leases`);
    expect(cross.statusCode).toBe(404);
    expect((cross.json() as { code: string }).code).toBe("not_found");

    const unknown = await h.admin("GET", `/admin/licenses/00000000-0000-4000-8000-000000000000/leases`);
    expect(unknown.statusCode).toBe(404);
  });
});
