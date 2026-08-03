// QC GAP 3 — the licensed app's SELF-READ of its own bound license's usage aggregate on the runtime /v1
// plane (E016 FR-020, NEW-API "operator console + app"; SC-019). GET /v1/licenses/:licenseId/usage is
// authenticated by the runtime API key + `usage.ingest` scope, tenant-scoped via RLS, and FLOOR-AT-ZERO ONLY
// — the app never receives the raw signed net (that stays admin/E014-internal, FR-013/020). Against real
// Postgres via the shared usage harness it confirms:
//   - the app reads its OWN floored aggregate (value = max(0, net) per entitlement/window).
//   - a net-negative reversal floors to 0 on this plane — the raw signed net is NEVER exposed.
//   - a cross-tenant / unknown licenseId resolves to 404 (never 403, never a cross-tenant leak).
//   - the plane is fail-closed: no key → 401, a key lacking the scope → 403.
//   - a `raw=true` (or any unknown) query key is refused 400 (the raw net can't be requested here).
import { randomUUID } from "node:crypto";

import type { LightMyRequestResponse } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { rollupSweep } from "../rollup-worker.js";
import { startHarness, type UsageHarness } from "./harness.js";

let h: UsageHarness;

beforeAll(async () => {
  h = await startHarness("app-self-read");
}, 240_000);

afterAll(async () => {
  await h?.stop();
});

const HOUR_MS = 3_600_000;
function recentHour(hoursAgo: number): Date {
  const h0 = Math.floor(Date.now() / HOUR_MS) * HOUR_MS;
  return new Date(h0 - hoursAgo * HOUR_MS);
}
function ev(entitlementId: string, at: Date, quantity: number): Record<string, unknown> {
  return { licenseId: h.chainA.licenseId, entitlementId, source: "node-1", eventId: h.eventId(), eventTime: at.toISOString(), quantity };
}
function dayWindow(): { from: string; to: string } {
  return { from: new Date(Date.now() - 24 * HOUR_MS).toISOString(), to: new Date(Date.now() + HOUR_MS).toISOString() };
}

/** GET /v1/licenses/:licenseId/usage with an API key (or none) + query params. */
function appRead(apiKey: string | null, licenseId: string, query: Record<string, string> = {}): Promise<LightMyRequestResponse> {
  const p = new URLSearchParams(query).toString();
  const headers: Record<string, string> = {};
  if (apiKey) headers["x-api-key"] = apiKey;
  return h.app.inject({ method: "GET", url: `/v1/licenses/${licenseId}/usage${p ? `?${p}` : ""}`, headers });
}

describe("GET /v1/licenses/:id/usage — app self-read of its own floored aggregate (GAP 3, SC-019)", () => {
  it("returns the app's own per-entitlement floored aggregate", async () => {
    const ent = await h.createMeteredEntitlement({ aggregation: "sum", unit: "gb" });
    await h.ingest(h.usageKey, { events: [ev(ent, recentHour(2), 100), ev(ent, recentHour(1), 50)] });
    await rollupSweep(h.pool, { since: new Date(0), bucketSeconds: 3600 });

    const res = await appRead(h.usageKey, h.chainA.licenseId, { ...dayWindow(), entitlementId: ent });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { licenseId: string; raw: boolean; entitlements: unknown[] };
    expect(body.licenseId).toBe(h.chainA.licenseId);
    expect(body.raw).toBe(false); // the app plane is floored-only
    expect(body.entitlements).toEqual([
      { entitlementId: ent, aggregation: "sum", unit: "gb", value: 150, allowance: null, overQuota: false },
    ]);
  });

  it("floors a net-negative reversal to 0 — the raw signed net is NEVER exposed on this plane", async () => {
    const ent = await h.createMeteredEntitlement({ aggregation: "sum" });
    const hr = recentHour(4);
    // +100 then a signed-negative reversal of -300 → true net -200 in that bucket.
    await h.ingest(h.usageKey, { events: [ev(ent, hr, 100), ev(ent, hr, -300)] });
    await rollupSweep(h.pool, { since: new Date(0), bucketSeconds: 3600 });

    const res = await appRead(h.usageKey, h.chainA.licenseId, { ...dayWindow(), entitlementId: ent });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { raw: boolean; entitlements: { value: number }[] };
    expect(body.raw).toBe(false);
    expect(body.entitlements[0]!.value).toBe(0); // max(0, -200) — the true net -200 is never returned here
  });

  it("refuses a `raw=true` (or any unknown) query key with 400 — the raw net can't be requested here", async () => {
    const ent = await h.createMeteredEntitlement({ aggregation: "sum" });
    const res = await appRead(h.usageKey, h.chainA.licenseId, { ...dayWindow(), entitlementId: ent, raw: "true" });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { code: string }).code).toBe("validation_error");
  });
});

describe("GET /v1/licenses/:id/usage — tenant/license scoping + fail-closed (GAP 3)", () => {
  it("resolves a cross-tenant licenseId to 404 (never 403, never a cross-tenant leak)", async () => {
    const res = await appRead(h.usageKey, h.chainB.licenseId, dayWindow());
    expect(res.statusCode).toBe(404);
    expect((res.json() as { code: string }).code).toBe("not_found");
  });

  it("resolves an unknown licenseId to 404", async () => {
    const res = await appRead(h.usageKey, randomUUID(), dayWindow());
    expect(res.statusCode).toBe(404);
  });

  it("refuses a missing API key with 401 and a key lacking the usage.ingest scope with 403", async () => {
    const noKey = await appRead(null, h.chainA.licenseId, dayWindow());
    expect(noKey.statusCode).toBe(401);

    const noScope = await appRead(h.noScopeKey, h.chainA.licenseId, dayWindow());
    expect(noScope.statusCode).toBe(403);
    expect((noScope.json() as { code: string }).code).toBe("forbidden");
  });
});
