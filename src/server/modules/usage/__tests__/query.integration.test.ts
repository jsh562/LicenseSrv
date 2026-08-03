// T022 [US2] IT (TDD) — the reproducible aggregate query surface GET /admin/licenses/:licenseId/usage
// (FR-011/013/019/020; SC-004/017/019). Against real Postgres + the console session/RBAC: an identical query
// over an unchanged window returns IDENTICAL totals (reproducible, SC-004); after a signed reversal drives the
// true net negative, a VIEWER sees the floor-at-zero display while an ADMIN `raw=true` sees the TRUE signed net
// (SC-017); a VIEWER requesting `raw=true` is refused 403 (the un-floored net is admin-bounded, SC-019); a
// cross-tenant / unknown licenseId resolves to 404 (never 403, FR-017); an over-span window is refused
// `window_too_large` BEFORE any aggregation. The async rollup is driven deterministically via `rollupSweep`.
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { rollupSweep } from "../rollup-worker.js";
import { startHarness, type UsageHarness } from "./harness.js";

let h: UsageHarness;

beforeAll(async () => {
  h = await startHarness("query");
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
/** A window that comfortably brackets the last day (span well under the default 2160h bound). */
function dayWindow(): { from: string; to: string } {
  return { from: new Date(Date.now() - 24 * HOUR_MS).toISOString(), to: new Date(Date.now() + HOUR_MS).toISOString() };
}

describe("GET /admin/licenses/:id/usage — reproducible aggregate (US2, T022)", () => {
  it("returns the correct per-entitlement total and is reproducible on re-query (SC-004)", async () => {
    const ent = await h.createMeteredEntitlement({ aggregation: "sum", unit: "gb" });
    await h.ingest(h.usageKey, { events: [ev(ent, recentHour(2), 100), ev(ent, recentHour(2), 200), ev(ent, recentHour(1), 50)] });
    await rollupSweep(h.pool, { since: new Date(0), bucketSeconds: 3600 });

    const w = dayWindow();
    const first = await h.getUsage(h.authViewer, h.chainA.licenseId, { ...w, entitlementId: ent });
    expect(first.statusCode).toBe(200);
    const body = first.json() as { licenseId: string; raw: boolean; entitlements: { entitlementId: string; aggregation: string; unit: string; value: number; allowance: number | null; overQuota: boolean }[] };
    expect(body.licenseId).toBe(h.chainA.licenseId);
    expect(body.entitlements).toEqual([
      { entitlementId: ent, aggregation: "sum", unit: "gb", value: 350, allowance: null, overQuota: false },
    ]);

    // Re-query the same unchanged window → byte-identical body (reproducible).
    const second = await h.getUsage(h.authViewer, h.chainA.licenseId, { ...w, entitlementId: ent });
    expect(second.json()).toEqual(body);
  });

  it("groups by day when a bucket granularity is requested (ordered by bucketStart)", async () => {
    const ent = await h.createMeteredEntitlement({ aggregation: "sum" });
    await h.ingest(h.usageKey, { events: [ev(ent, recentHour(3), 10), ev(ent, recentHour(2), 20)] });
    await rollupSweep(h.pool, { since: new Date(0), bucketSeconds: 3600 });

    const res = await h.getUsage(h.authViewer, h.chainA.licenseId, { ...dayWindow(), entitlementId: ent, bucket: "hour" });
    expect(res.statusCode).toBe(200);
    const agg = (res.json() as { entitlements: { value: number; buckets: { bucketStart: string; value: number }[] }[] }).entitlements[0]!;
    expect(agg.value).toBe(30);
    expect(agg.buckets).toHaveLength(2);
    expect(agg.buckets[0]!.bucketStart < agg.buckets[1]!.bucketStart).toBe(true); // ascending
  });
});

describe("GET /admin/licenses/:id/usage — floor-at-zero vs true signed net (US2, T022)", () => {
  it("floors a net-negative reversal for a viewer, but an admin raw=true sees the true signed net (SC-017)", async () => {
    const ent = await h.createMeteredEntitlement({ aggregation: "sum" });
    const hr = recentHour(4);
    // Accrue +100 then a signed-negative reversal of -300 → true net -200 in that hour bucket.
    await h.ingest(h.usageKey, { events: [ev(ent, hr, 100), ev(ent, hr, -300)] });
    await rollupSweep(h.pool, { since: new Date(0), bucketSeconds: 3600 });
    const w = dayWindow();

    const floored = await h.getUsage(h.authViewer, h.chainA.licenseId, { ...w, entitlementId: ent });
    expect((floored.json() as { raw: boolean; entitlements: { value: number }[] }).raw).toBe(false);
    expect((floored.json() as { entitlements: { value: number }[] }).entitlements[0]!.value).toBe(0); // max(0, -200)

    const rawNet = await h.getUsage(h.authAdmin, h.chainA.licenseId, { ...w, entitlementId: ent, raw: "true" });
    expect(rawNet.statusCode).toBe(200);
    const rawBody = rawNet.json() as { raw: boolean; entitlements: { value: number }[] };
    expect(rawBody.raw).toBe(true);
    expect(rawBody.entitlements[0]!.value).toBe(-200); // the true signed net, visible to admin/E014
  });

  it("refuses a VIEWER requesting raw=true with 403 (the un-floored net requires admin, SC-019)", async () => {
    const ent = await h.createMeteredEntitlement({ aggregation: "sum" });
    const res = await h.getUsage(h.authViewer, h.chainA.licenseId, { ...dayWindow(), entitlementId: ent, raw: "true" });
    expect(res.statusCode).toBe(403);
    expect((res.json() as { code: string }).code).toBe("forbidden");
  });

  it("flags overQuota against the true net when the window total crosses the allowance (FR-014)", async () => {
    const ent = await h.createMeteredEntitlement({ aggregation: "sum", allowance: 250 });
    await h.ingest(h.usageKey, { events: [ev(ent, recentHour(2), 200), ev(ent, recentHour(1), 100)] });
    await rollupSweep(h.pool, { since: new Date(0), bucketSeconds: 3600 });
    const res = await h.getUsage(h.authViewer, h.chainA.licenseId, { ...dayWindow(), entitlementId: ent });
    const agg = (res.json() as { entitlements: { value: number; allowance: number; overQuota: boolean }[] }).entitlements[0]!;
    expect(agg).toMatchObject({ value: 300, allowance: 250, overQuota: true });
  });
});

describe("GET /admin/licenses/:id/usage — tenant scoping + window bound (US2, T022)", () => {
  it("resolves a cross-tenant licenseId to 404 (never 403, FR-017/SC-012)", async () => {
    const res = await h.getUsage(h.authAdmin, h.chainB.licenseId, dayWindow());
    expect(res.statusCode).toBe(404);
    expect((res.json() as { code: string }).code).toBe("not_found");
  });

  it("resolves an unknown licenseId to 404", async () => {
    const res = await h.getUsage(h.authAdmin, randomUUID(), dayWindow());
    expect(res.statusCode).toBe(404);
  });

  it("refuses an over-span window with window_too_large BEFORE any aggregation", async () => {
    const res = await h.getUsage(h.authAdmin, h.chainA.licenseId, {
      from: new Date(Date.now() - 200 * 24 * HOUR_MS).toISOString(),
      to: new Date().toISOString(),
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { code: string; details: { maxHours: number } };
    expect(body.code).toBe("window_too_large");
    expect(body.details.maxHours).toBe(2160);
  });

  it("refuses an inverted window with validation_error", async () => {
    const res = await h.getUsage(h.authAdmin, h.chainA.licenseId, {
      from: new Date().toISOString(),
      to: new Date(Date.now() - HOUR_MS).toISOString(),
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { code: string }).code).toBe("validation_error");
  });
});
