// T021 [US2] IT (TDD) — watermark incremental rollup correctness + idempotent re-run (FR-010/012, AD-002,
// HINT-002). Against real Postgres: a batch of raw events across two hourly buckets rolls up to the correct
// per-bucket true signed net + event count (SUM/COUNT/UNIQUE_COUNT); a re-run over the SAME events RECOMPUTES
// (not increments) the identical aggregate with NO double-count (SC-004); and an incremental sweep past the
// watermark re-opens an already-rolled bucket to fold newly-arrived + late events (FR-012). The rollup is
// driven DETERMINISTICALLY via `rollupSweep` (the worker's sweep function), not the cadence timer.
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { withTenant } from "../../../db/client.js";
import { rollupSweep } from "../rollup-worker.js";
import { startHarness, type UsageHarness } from "./harness.js";

let h: UsageHarness;

beforeAll(async () => {
  h = await startHarness("rollup");
}, 240_000);

afterAll(async () => {
  await h?.stop();
});

/** Two fixed, recent, WHOLE distinct UTC hours inside the acceptance window (so events are never stale). */
const HOUR_MS = 3_600_000;
function recentHour(hoursAgo: number): Date {
  const h0 = Math.floor(Date.now() / HOUR_MS) * HOUR_MS;
  return new Date(h0 - hoursAgo * HOUR_MS);
}

function ev(licenseId: string, entitlementId: string, at: Date, quantity: number, eventId: string, dimensions?: Record<string, unknown>): Record<string, unknown> {
  return { licenseId, entitlementId, source: "node-1", eventId, eventTime: at.toISOString(), quantity, ...(dimensions ? { dimensions } : {}) };
}

interface RollupRowT {
  bucket: string;
  value: number;
  event_count: number;
  over_quota: boolean;
}

async function readRollups(entitlementId: string): Promise<RollupRowT[]> {
  return withTenant(h.pool, h.tenantA, async (q) => {
    const r = await q(
      `SELECT to_char(bucket AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:00:00"Z"') AS bucket,
              value::float8 AS value, event_count::int AS event_count, over_quota
         FROM usage_rollup WHERE entitlement_id = $1 ORDER BY bucket`,
      [entitlementId],
    );
    return r.rows as RollupRowT[];
  });
}

describe("watermark rollup — correctness across buckets (US2, T021)", () => {
  it("rolls a SUM meter into the correct per-bucket true signed net + event count", async () => {
    const ent = await h.createMeteredEntitlement({ aggregation: "sum" });
    const h1 = recentHour(2);
    const h2 = recentHour(1);
    await h.ingest(h.usageKey, {
      events: [
        ev(h.chainA.licenseId, ent, h1, 100, h.eventId()),
        ev(h.chainA.licenseId, ent, h1, 200, h.eventId()),
        ev(h.chainA.licenseId, ent, h2, 50, h.eventId()),
      ],
    });

    await rollupSweep(h.pool, { since: new Date(0), bucketSeconds: 3600 });

    const rows = await readRollups(ent);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ bucket: h1.toISOString().replace(/\.\d{3}Z$/, "Z"), value: 300, event_count: 2 });
    expect(rows[1]).toMatchObject({ bucket: h2.toISOString().replace(/\.\d{3}Z$/, "Z"), value: 50, event_count: 1 });
  });

  it("rolls a COUNT meter as the signed sum of integer quantities (a -1 reversal decrements the net)", async () => {
    const ent = await h.createMeteredEntitlement({ aggregation: "count" });
    const hr = recentHour(3);
    await h.ingest(h.usageKey, {
      events: [
        ev(h.chainA.licenseId, ent, hr, 1, h.eventId()),
        ev(h.chainA.licenseId, ent, hr, 1, h.eventId()),
        ev(h.chainA.licenseId, ent, hr, 1, h.eventId()),
        ev(h.chainA.licenseId, ent, hr, -1, h.eventId()),
      ],
    });
    await rollupSweep(h.pool, { since: new Date(0), bucketSeconds: 3600 });
    const rows = await readRollups(ent);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ value: 2, event_count: 4 }); // 1+1+1-1 = 2 net, 4 raw events folded
  });

  it("rolls a UNIQUE_COUNT meter as the number of distinct dimension values (duplicates fold to one)", async () => {
    const ent = await h.createMeteredEntitlement({ aggregation: "unique_count" });
    const hr = recentHour(2);
    await h.ingest(h.usageKey, {
      events: [
        ev(h.chainA.licenseId, ent, hr, 1, h.eventId(), { user: "u1" }),
        ev(h.chainA.licenseId, ent, hr, 1, h.eventId(), { user: "u2" }),
        ev(h.chainA.licenseId, ent, hr, 1, h.eventId(), { user: "u1" }), // duplicate distinct value
      ],
    });
    await rollupSweep(h.pool, { since: new Date(0), bucketSeconds: 3600 });
    const rows = await readRollups(ent);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ value: 2, event_count: 3 }); // u1, u2 distinct; 3 raw events
  });
});

describe("watermark rollup — idempotent re-run (recompute, not increment) (US2, T021)", () => {
  it("a re-run over the same events yields the IDENTICAL aggregate — no double-count (SC-004)", async () => {
    const ent = await h.createMeteredEntitlement({ aggregation: "sum" });
    const hr = recentHour(4);
    await h.ingest(h.usageKey, {
      events: [ev(h.chainA.licenseId, ent, hr, 100, h.eventId()), ev(h.chainA.licenseId, ent, hr, 100, h.eventId())],
    });

    await rollupSweep(h.pool, { since: new Date(0), bucketSeconds: 3600 });
    const first = await readRollups(ent);
    // Re-run from the epoch — the SAME raw is recomputed (not incremented), so the row is overwritten identically.
    await rollupSweep(h.pool, { since: new Date(0), bucketSeconds: 3600 });
    const second = await readRollups(ent);

    expect(first).toEqual([expect.objectContaining({ value: 200, event_count: 2 })]);
    expect(second).toEqual(first);
  });

  it("UNIQUE_COUNT stays exact across re-runs (the distinct set is monotonic, not double-inserted)", async () => {
    const ent = await h.createMeteredEntitlement({ aggregation: "unique_count" });
    const hr = recentHour(5);
    await h.ingest(h.usageKey, {
      events: [
        ev(h.chainA.licenseId, ent, hr, 1, h.eventId(), { sku: "a" }),
        ev(h.chainA.licenseId, ent, hr, 1, h.eventId(), { sku: "b" }),
      ],
    });
    await rollupSweep(h.pool, { since: new Date(0), bucketSeconds: 3600 });
    await rollupSweep(h.pool, { since: new Date(0), bucketSeconds: 3600 });
    const rows = await readRollups(ent);
    expect(rows).toEqual([expect.objectContaining({ value: 2 })]); // still 2, not 4
  });
});

describe("watermark rollup — incremental re-open of an already-rolled bucket (US2, T021)", () => {
  it("an incremental sweep past the watermark folds newly-arrived events into the SAME bucket (FR-012)", async () => {
    const ent = await h.createMeteredEntitlement({ aggregation: "sum" });
    const hr = recentHour(6);

    await h.ingest(h.usageKey, { events: [ev(h.chainA.licenseId, ent, hr, 100, h.eventId())] });
    const first = await rollupSweep(h.pool, { since: new Date(0), bucketSeconds: 3600 });
    expect(await readRollups(ent)).toEqual([expect.objectContaining({ value: 100, event_count: 1 })]);

    // A later event lands in the SAME (already-rolled) hour bucket; an incremental sweep past the watermark
    // re-opens + recomputes it from ALL retained raw → 300 net, 2 events (recompute-not-increment).
    await h.ingest(h.usageKey, { events: [ev(h.chainA.licenseId, ent, hr, 200, h.eventId())] });
    await rollupSweep(h.pool, { since: first.since, bucketSeconds: 3600 });
    expect(await readRollups(ent)).toEqual([expect.objectContaining({ value: 300, event_count: 2 })]);
  });

  it("derives the over-quota flag on the true net when a bucket crosses the allowance (FR-014)", async () => {
    const ent = await h.createMeteredEntitlement({ aggregation: "sum", allowance: 250 });
    const hr = recentHour(7);
    await h.ingest(h.usageKey, {
      events: [ev(h.chainA.licenseId, ent, hr, 200, h.eventId()), ev(h.chainA.licenseId, ent, hr, 100, h.eventId())],
    });
    await rollupSweep(h.pool, { since: new Date(0), bucketSeconds: 3600 });
    const rows = await readRollups(ent);
    expect(rows[0]).toMatchObject({ value: 300, over_quota: true }); // 300 > 250
  });
});
