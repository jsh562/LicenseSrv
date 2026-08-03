// T036 [US6] IT (TDD) — bounded retention/prune + GDPR erase (E016 FR-015/FR-016; SC-010/SC-020/SC-013).
// Against real Postgres, driving the async rollup + the owner-role prune deterministically:
//   - SC-010: raw events + their idempotency keys older than the retention window are pruned while the durable
//     usage_rollup aggregate is UNCHANGED, and a re-report of a pruned key is a FRESH accrual (cannot resurrect
//     the pruned event).
//   - SC-020: a UNIQUE_COUNT meter's distinct count is FINAL in usage_rollup for a CLOSED bucket BEFORE its
//     usage_unique_value working rows are pruned, so it stays exact + reproducible after the raw is gone.
//   - SC-013: a tenant GDPR erasure removes that tenant's usage across all three usage tables.
// Raw events are inserted directly (owner-independent app INSERT) with an aged event_time/ingested_at to
// simulate a closed bucket — the ingest endpoint would reject a too-old event (the acceptance bound), which is
// exactly the retention boundary under test.
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { withTenant } from "../../../db/client.js";
import { eraseTenantUsage, retentionSweep } from "../retention-worker.js";
import { rollupSweep } from "../rollup-worker.js";
import { startHarness, type UsageHarness } from "./harness.js";

let h: UsageHarness;

beforeAll(async () => {
  h = await startHarness("retention");
}, 240_000);

afterAll(async () => {
  await h?.stop();
});

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
/** A whole UTC hour `days` in the past (well beyond the ~35d window → a CLOSED bucket once retention runs). */
function agedHour(days: number): Date {
  return new Date(Math.floor((Date.now() - days * DAY_MS) / HOUR_MS) * HOUR_MS);
}
function recentHour(hoursAgo: number): Date {
  return new Date(Math.floor(Date.now() / HOUR_MS) * HOUR_MS - hoursAgo * HOUR_MS);
}

/** Insert a raw usage_event directly (bypassing the ingest acceptance gate) with an explicit aged timestamp. */
async function insertRaw(
  entitlementId: string,
  at: Date,
  quantity: number,
  eventId: string,
  dimensions: Record<string, unknown> = {},
  source = "s1",
): Promise<void> {
  await withTenant(h.pool, h.tenantA, async (q) => {
    await q(
      `INSERT INTO usage_event
         (id, tenant_id, license_id, entitlement_id, source, event_id, event_time, quantity, dimensions, ingested_at)
       VALUES (gen_random_uuid(), current_setting('app.current_tenant')::uuid, $1, $2, $3, $4, $5, $6, $7::jsonb, $5)`,
      [h.chainA.licenseId, entitlementId, source, eventId, at, quantity, JSON.stringify(dimensions)],
    );
  });
}
async function rollupValue(entitlementId: string): Promise<number> {
  return withTenant(h.pool, h.tenantA, async (q) => {
    const r = await q("SELECT COALESCE(sum(value), 0)::float8 AS v FROM usage_rollup WHERE entitlement_id = $1", [entitlementId]);
    return Number((r.rows[0] as { v: number }).v);
  });
}
async function uniqueRowCount(entitlementId: string): Promise<number> {
  return withTenant(h.pool, h.tenantA, async (q) => {
    const r = await q("SELECT count(*)::int AS n FROM usage_unique_value WHERE entitlement_id = $1", [entitlementId]);
    return (r.rows[0] as { n: number }).n;
  });
}

describe("bounded retention prune (US6, T036, SC-010)", () => {
  it("prunes aged raw + keys, leaves the rollup intact, and treats a re-report of a pruned key as fresh", async () => {
    const ent = await h.createMeteredEntitlement({ aggregation: "sum" });
    const aged = agedHour(40); // older than the ~35d retention window
    const key = "pruned-key-1";
    await insertRaw(ent, aged, 100, key);

    // Roll the aged bucket into the durable aggregate.
    await rollupSweep(h.pool, { since: new Date(0), bucketSeconds: 3600 });
    expect(await h.countEvents(h.chainA.licenseId, ent)).toBe(1);
    expect(await rollupValue(ent)).toBe(100);

    // Prune: the aged raw + its idempotency key are removed; the durable rollup SURVIVES (INV-6).
    const swept = await retentionSweep(h.pool, { now: new Date() });
    expect(swept.events).toBeGreaterThanOrEqual(1);
    expect(await h.countEvents(h.chainA.licenseId, ent)).toBe(0);
    expect(await rollupValue(ent)).toBe(100);

    // The idempotency key was pruned → a re-report of the SAME (source, eventId) is a FRESH accrual, not a dup.
    const res = await h.ingest(h.usageKey, {
      events: [{ licenseId: h.chainA.licenseId, entitlementId: ent, source: "s1", eventId: key, eventTime: recentHour(1).toISOString(), quantity: 100 }],
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ accepted: 1, duplicate: 0 });
  });

  it("keeps UNIQUE_COUNT exact + reproducible after its working rows are pruned (SC-020)", async () => {
    const ent = await h.createMeteredEntitlement({ aggregation: "unique_count" });
    const aged = agedHour(41);
    await insertRaw(ent, aged, 1, randomUUID(), { sku: "a" });
    await insertRaw(ent, aged, 1, randomUUID(), { sku: "b" });
    await insertRaw(ent, aged, 1, randomUUID(), { sku: "a" }); // duplicate distinct value

    await rollupSweep(h.pool, { since: new Date(0), bucketSeconds: 3600 });
    expect(await rollupValue(ent)).toBe(2); // distinct a,b → 2, FINAL in the durable rollup
    expect(await uniqueRowCount(ent)).toBe(2);

    // Prune the CLOSED bucket: the raw + the distinct-set working rows go, the rollup count stays exact at 2.
    await retentionSweep(h.pool, { now: new Date() });
    expect(await h.countEvents(h.chainA.licenseId, ent)).toBe(0);
    expect(await uniqueRowCount(ent)).toBe(0); // working rows pruned (bounded to the open window)
    expect(await rollupValue(ent)).toBe(2); // still exact + reproducible post-prune
  });

  it("does NOT prune a still-open (recent) bucket — retention is bounded to closed buckets", async () => {
    const ent = await h.createMeteredEntitlement({ aggregation: "sum" });
    await insertRaw(ent, recentHour(1), 42, randomUUID());
    await rollupSweep(h.pool, { since: new Date(0), bucketSeconds: 3600 });
    await retentionSweep(h.pool, { now: new Date() });
    // The recent event is inside the acceptance window → its bucket is OPEN → it is NOT pruned.
    expect(await h.countEvents(h.chainA.licenseId, ent)).toBe(1);
  });
});

describe("tenant GDPR erasure across all three usage tables (US6, T036, SC-013)", () => {
  it("removes usage_event + usage_rollup + usage_unique_value for the tenant", async () => {
    const ent = await h.createMeteredEntitlement({ aggregation: "unique_count" });
    await insertRaw(ent, recentHour(2), 1, randomUUID(), { user: "u1" });
    await insertRaw(ent, recentHour(2), 1, randomUUID(), { user: "u2" });
    await rollupSweep(h.pool, { since: new Date(0), bucketSeconds: 3600 });

    // All three tables carry rows for tenant A before erasure.
    const before = await withTenant(h.pool, h.tenantA, async (q) => ({
      events: (await q("SELECT count(*)::int AS n FROM usage_event", [])).rows[0] as { n: number },
      rollups: (await q("SELECT count(*)::int AS n FROM usage_rollup", [])).rows[0] as { n: number },
      uniques: (await q("SELECT count(*)::int AS n FROM usage_unique_value", [])).rows[0] as { n: number },
    }));
    expect(before.events.n).toBeGreaterThan(0);
    expect(before.rollups.n).toBeGreaterThan(0);
    expect(before.uniques.n).toBeGreaterThan(0);

    const erased = await eraseTenantUsage(h.pool, h.tenantA);
    expect(erased.events).toBeGreaterThan(0);
    expect(erased.rollups).toBeGreaterThan(0);
    expect(erased.uniqueValues).toBeGreaterThan(0);

    const after = await withTenant(h.pool, h.tenantA, async (q) => ({
      events: ((await q("SELECT count(*)::int AS n FROM usage_event", [])).rows[0] as { n: number }).n,
      rollups: ((await q("SELECT count(*)::int AS n FROM usage_rollup", [])).rows[0] as { n: number }).n,
      uniques: ((await q("SELECT count(*)::int AS n FROM usage_unique_value", [])).rows[0] as { n: number }).n,
    }));
    expect(after).toEqual({ events: 0, rollups: 0, uniques: 0 });
  });
});
