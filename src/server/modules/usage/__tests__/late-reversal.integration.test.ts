// T032 [US4] IT (TDD) — late, out-of-order, and correction events (E016 FR-004/FR-012/FR-013; SC-007/SC-008).
// Against real Postgres + the async rollup driven deterministically via `rollupSweep`:
//   - SC-007: an event accrues to the hour of its CLIENT event_time (not receipt); a late/out-of-order event
//     dated to an EARLIER still-retained hour re-opens + updates that hour's bucket (the retention window is
//     the SINGLE acceptance bound, FR-012).
//   - a too-old event → per-event `stale_event`; a future-dated event beyond skew → `future_event` (FR-004) —
//     rejected inside the 200 batch summary, never failing the batch (AD-008).
//   - SC-008: a reference-free signed-negative REVERSAL decrements the stored TRUE net WITHOUT mutating or
//     deleting any prior event (append-only, FR-003/FR-013) — SUM/COUNT only.
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { withTenant } from "../../../db/client.js";
import { rollupSweep } from "../rollup-worker.js";
import { startHarness, type UsageHarness } from "./harness.js";

let h: UsageHarness;

beforeAll(async () => {
  h = await startHarness("late");
}, 240_000);

afterAll(async () => {
  await h?.stop();
});

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
function recentHour(hoursAgo: number): Date {
  const h0 = Math.floor(Date.now() / HOUR_MS) * HOUR_MS;
  return new Date(h0 - hoursAgo * HOUR_MS);
}
function ev(entitlementId: string, at: Date, quantity: number): Record<string, unknown> {
  return { licenseId: h.chainA.licenseId, entitlementId, source: "node-1", eventId: h.eventId(), eventTime: at.toISOString(), quantity };
}
function evId(entitlementId: string, at: Date, quantity: number, eventId: string): Record<string, unknown> {
  return { licenseId: h.chainA.licenseId, entitlementId, source: "node-1", eventId, eventTime: at.toISOString(), quantity };
}

interface Bucket { bucket: string; value: number; event_count: number }
async function readBuckets(entitlementId: string): Promise<Bucket[]> {
  return withTenant(h.pool, h.tenantA, async (q) => {
    const r = await q(
      `SELECT to_char(bucket AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:00:00"Z"') AS bucket,
              value::float8 AS value, event_count::int AS event_count
         FROM usage_rollup WHERE entitlement_id = $1 ORDER BY bucket`,
      [entitlementId],
    );
    return r.rows as Bucket[];
  });
}
async function rawQuantity(eventId: string): Promise<number> {
  return withTenant(h.pool, h.tenantA, async (q) => {
    const r = await q("SELECT quantity::float8 AS n FROM usage_event WHERE event_id = $1", [eventId]);
    return Number((r.rows[0] as { n: number }).n);
  });
}

describe("late / out-of-order accrual by client event_time (US4, T032, SC-007)", () => {
  it("accrues a late, out-of-order event to the hour of its client event_time, re-opening the right bucket", async () => {
    const ent = await h.createMeteredEntitlement({ aggregation: "sum" });
    const recent = recentHour(1);
    const earlier = recentHour(6); // an EARLIER hour, still comfortably inside the retention window

    // First a recent event; sweep → one bucket at the recent hour.
    await h.ingest(h.usageKey, { events: [ev(ent, recent, 100)] });
    const first = await rollupSweep(h.pool, { since: new Date(0), bucketSeconds: 3600 });
    expect(await readBuckets(ent)).toEqual([expect.objectContaining({ bucket: recent.toISOString().replace(/\.\d{3}Z$/, "Z"), value: 100 })]);

    // A LATER-arriving event dated to the EARLIER hour (out of order) — an incremental sweep past the watermark
    // folds it into that earlier hour's bucket (FR-012), leaving the recent bucket untouched.
    await h.ingest(h.usageKey, { events: [ev(ent, earlier, 40)] });
    await rollupSweep(h.pool, { since: first.since, bucketSeconds: 3600 });
    const buckets = await readBuckets(ent);
    expect(buckets).toEqual([
      expect.objectContaining({ bucket: earlier.toISOString().replace(/\.\d{3}Z$/, "Z"), value: 40 }),
      expect.objectContaining({ bucket: recent.toISOString().replace(/\.\d{3}Z$/, "Z"), value: 100 }),
    ]);
  });

  it("re-opens an already-rolled hour when a later event lands in it (recompute-not-increment)", async () => {
    const ent = await h.createMeteredEntitlement({ aggregation: "sum" });
    const hr = recentHour(3);
    await h.ingest(h.usageKey, { events: [ev(ent, hr, 100)] });
    const first = await rollupSweep(h.pool, { since: new Date(0), bucketSeconds: 3600 });
    await h.ingest(h.usageKey, { events: [ev(ent, hr, 200)] });
    await rollupSweep(h.pool, { since: first.since, bucketSeconds: 3600 });
    expect(await readBuckets(ent)).toEqual([expect.objectContaining({ value: 300, event_count: 2 })]);
  });
});

describe("skew bounds — too-old / future (US4, T032, FR-004)", () => {
  it("rejects a too-old event per-event with stale_event (retention window is the single acceptance bound)", async () => {
    const ent = await h.createMeteredEntitlement({ aggregation: "sum" });
    const tooOld = new Date(Date.now() - 40 * DAY_MS); // older than the ~35d retention window
    const res = await h.ingest(h.usageKey, { events: [ev(ent, tooOld, 10)] });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { accepted: number; rejected: { code: string }[] };
    expect(body.accepted).toBe(0);
    expect(body.rejected[0]!.code).toBe("stale_event");
    expect(await h.countEvents(h.chainA.licenseId, ent)).toBe(0);
  });

  it("rejects a future-dated event beyond the skew allowance per-event with future_event", async () => {
    const ent = await h.createMeteredEntitlement({ aggregation: "sum" });
    const future = new Date(Date.now() + HOUR_MS); // well beyond the default 5-minute future skew
    const res = await h.ingest(h.usageKey, { events: [ev(ent, future, 10)] });
    const body = res.json() as { accepted: number; rejected: { code: string }[] };
    expect(body.accepted).toBe(0);
    expect(body.rejected[0]!.code).toBe("future_event");
    expect(await h.countEvents(h.chainA.licenseId, ent)).toBe(0);
  });
});

describe("reference-free signed reversal (US4, T032, SC-008)", () => {
  it("decrements the stored true net without mutating or deleting any prior event (SUM)", async () => {
    const ent = await h.createMeteredEntitlement({ aggregation: "sum" });
    const hr = recentHour(2);
    const originalId = h.eventId();

    await h.ingest(h.usageKey, { events: [evId(ent, hr, 100, originalId)] });
    await rollupSweep(h.pool, { since: new Date(0), bucketSeconds: 3600 });
    expect(await readBuckets(ent)).toEqual([expect.objectContaining({ value: 100, event_count: 1 })]);

    // A standalone signed-negative reversal (no reference to the original event id) → net 70, two raw events.
    await h.ingest(h.usageKey, { events: [ev(ent, hr, -30)] });
    await rollupSweep(h.pool, { since: new Date(0), bucketSeconds: 3600 });
    expect(await readBuckets(ent)).toEqual([expect.objectContaining({ value: 70, event_count: 2 })]);

    // The prior event is UNCHANGED (append-only) — its quantity is still +100, both raw rows persist.
    expect(await rawQuantity(originalId)).toBe(100);
    expect(await h.countEvents(h.chainA.licenseId, ent)).toBe(2);
    expect(await h.sumQuantity(h.chainA.licenseId, ent)).toBe(70);
  });

  it("decrements a COUNT meter via a -1 reversal (removes one previously-counted event)", async () => {
    const ent = await h.createMeteredEntitlement({ aggregation: "count" });
    const hr = recentHour(4);
    await h.ingest(h.usageKey, { events: [ev(ent, hr, 1), ev(ent, hr, 1), ev(ent, hr, 1)] });
    await rollupSweep(h.pool, { since: new Date(0), bucketSeconds: 3600 });
    expect(await readBuckets(ent)).toEqual([expect.objectContaining({ value: 3, event_count: 3 })]);

    await h.ingest(h.usageKey, { events: [ev(ent, hr, -1)] });
    await rollupSweep(h.pool, { since: new Date(0), bucketSeconds: 3600 });
    expect(await readBuckets(ent)).toEqual([expect.objectContaining({ value: 2, event_count: 4 })]);
  });
});
