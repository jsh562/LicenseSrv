// QC GAP 4 — the DEFINED UNIQUE_COUNT window semantics (E016 SC-005 + the Edge Case: a window UNIQUE_COUNT
// total is the SUM of each hourly bucket's distinct count — bucket-grain distinct, chosen so the total stays
// exact + reproducible AFTER raw-event pruning, when only the per-bucket distinct count survives, SC-020).
// This regression test LOCKS that behavior: the SAME distinct value reported in TWO different hourly buckets
// counts once PER bucket (window total = 1 + 1 = 2), while the same value twice within ONE bucket is a single
// distinct (bucket distinct = 1). Against real Postgres via the shared usage harness; rollup driven
// deterministically via `rollupSweep`.
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { rollupSweep } from "../rollup-worker.js";
import { startHarness, type UsageHarness } from "./harness.js";

let h: UsageHarness;

beforeAll(async () => {
  h = await startHarness("unique-window");
}, 240_000);

afterAll(async () => {
  await h?.stop();
});

const HOUR_MS = 3_600_000;
function recentHour(hoursAgo: number): Date {
  const h0 = Math.floor(Date.now() / HOUR_MS) * HOUR_MS;
  return new Date(h0 - hoursAgo * HOUR_MS);
}
/** A UNIQUE_COUNT event carrying its distinct dimension value. */
function evU(entitlementId: string, at: Date, user: string): Record<string, unknown> {
  return {
    licenseId: h.chainA.licenseId,
    entitlementId,
    source: "node-1",
    eventId: h.eventId(),
    eventTime: at.toISOString(),
    quantity: 1,
    dimensions: { user },
  };
}
function dayWindow(): { from: string; to: string } {
  return { from: new Date(Date.now() - 24 * HOUR_MS).toISOString(), to: new Date(Date.now() + HOUR_MS).toISOString() };
}

describe("UNIQUE_COUNT window total = SUM of per-hourly-bucket distinct counts (GAP 4, SC-005/SC-020)", () => {
  it("counts the SAME distinct value once PER hourly bucket (two hours => window total 2)", async () => {
    const ent = await h.createMeteredEntitlement({ aggregation: "unique_count", unit: "users" });
    const hrA = recentHour(3);
    const hrB = recentHour(2);

    // Bucket A: the SAME value "u1" reported TWICE within one hour → that bucket's distinct count is 1.
    await h.ingest(h.usageKey, { events: [evU(ent, hrA, "u1"), evU(ent, hrA, "u1")] });
    // Bucket B: the SAME value "u1" again, but in a DIFFERENT hour → its own bucket distinct count is 1.
    await h.ingest(h.usageKey, { events: [evU(ent, hrB, "u1")] });
    await rollupSweep(h.pool, { since: new Date(0), bucketSeconds: 3600 });

    const res = await h.getUsage(h.authViewer, h.chainA.licenseId, { ...dayWindow(), entitlementId: ent, bucket: "hour" });
    expect(res.statusCode).toBe(200);
    const agg = (res.json() as { entitlements: { aggregation: string; value: number; buckets: { value: number }[] }[] }).entitlements[0]!;

    // Window UNIQUE_COUNT = sum of the two buckets' distinct counts (1 + 1) = 2 — bucket-grain distinct, NOT a
    // single window-distinct set (which would be 1). A value recurring across different hours counts once PER hour.
    expect(agg.aggregation).toBe("unique_count");
    expect(agg.value).toBe(2);
    // Each hourly bucket's distinct count is exactly 1 (the same value twice within a bucket is a single distinct).
    expect(agg.buckets).toHaveLength(2);
    expect(agg.buckets.every((b) => b.value === 1)).toBe(true);
  });

  it("counts the same value twice within ONE bucket as a single distinct (bucket distinct = 1)", async () => {
    const ent = await h.createMeteredEntitlement({ aggregation: "unique_count", unit: "users" });
    const hr = recentHour(1);
    await h.ingest(h.usageKey, { events: [evU(ent, hr, "u9"), evU(ent, hr, "u9"), evU(ent, hr, "u9")] });
    await rollupSweep(h.pool, { since: new Date(0), bucketSeconds: 3600 });

    const res = await h.getUsage(h.authViewer, h.chainA.licenseId, { ...dayWindow(), entitlementId: ent });
    const agg = (res.json() as { entitlements: { value: number }[] }).entitlements[0]!;
    expect(agg.value).toBe(1); // one distinct value, regardless of repeat count within the bucket
  });
});
