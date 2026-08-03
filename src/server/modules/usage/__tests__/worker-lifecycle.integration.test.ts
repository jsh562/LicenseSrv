// T044 (coverage close-out) — the fail-open rollup + retention WORKER lifecycle (E016 FR-010/015/018; AD-002/
// AD-007, HINT-004). These are wired from main.ts (excluded from coverage), so this suite drives them directly:
//   • startRollupWorker / startUsageRetentionWorker — immediate run, manual runOnce, the overlap guard (a
//     re-entrant runOnce is a no-op), the watermark advance, and the info-log branch (a sweep that folded/pruned
//     rows), then stop() (cancel the unref'd cadence);
//   • the FAIL-OPEN contract — a sweep against a broken pool (connect rejects) NEVER throws and reports zero
//     progress, invoking the onError hook; a throwing logger is swallowed (logging is best-effort); a worker
//     started on a broken pool boots + stops cleanly (a rollup/prune fault never crashes boot or blocks ingest).
// The DB-backed paths use the real Testcontainers harness; the fail-open paths use a stub pool whose connect
// rejects. Confirms the module-aggregate >=80% line+branch gate holds with the worker files fully exercised.
import { randomUUID } from "node:crypto";

import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { withTenant } from "../../../db/client.js";
import { retentionSweep, startUsageRetentionWorker } from "../retention-worker.js";
import { rollupSweep, startRollupWorker } from "../rollup-worker.js";
import { startHarness, type UsageHarness } from "./harness.js";

let h: UsageHarness;

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

beforeAll(async () => {
  h = await startHarness("worker-lifecycle");
}, 240_000);

afterAll(async () => {
  await h?.stop();
});

function recentHour(hoursAgo: number): Date {
  const h0 = Math.floor(Date.now() / HOUR_MS) * HOUR_MS;
  return new Date(h0 - hoursAgo * HOUR_MS);
}
function agedHour(days: number): Date {
  return new Date(Math.floor((Date.now() - days * DAY_MS) / HOUR_MS) * HOUR_MS);
}
function ev(entitlementId: string, at: Date, quantity: number): Record<string, unknown> {
  return { licenseId: h.chainA.licenseId, entitlementId, source: "wl", eventId: h.eventId(), eventTime: at.toISOString(), quantity };
}
async function insertRaw(entitlementId: string, at: Date, quantity: number): Promise<void> {
  await withTenant(h.pool, h.tenantA, async (q) => {
    await q(
      `INSERT INTO usage_event
         (id, tenant_id, license_id, entitlement_id, source, event_id, event_time, quantity, dimensions, ingested_at)
       VALUES (gen_random_uuid(), current_setting('app.current_tenant')::uuid, $1, $2, 's1', $3, $4, $5, '{}'::jsonb, $4)`,
      [h.chainA.licenseId, entitlementId, randomUUID(), at, quantity],
    );
  });
}
async function rollupValue(entitlementId: string): Promise<number> {
  return withTenant(h.pool, h.tenantA, async (q) => {
    const r = await q("SELECT COALESCE(sum(value), 0)::float8 AS v FROM usage_rollup WHERE entitlement_id = $1", [entitlementId]);
    return Number((r.rows[0] as { v: number }).v);
  });
}

/** A stub pool whose `connect` rejects — drives every fail-open catch (the sweep never throws). */
const brokenPool = { connect: () => Promise.reject(new Error("pool down")) } as unknown as pg.Pool;

describe("rollup worker lifecycle (FR-010) — start, runOnce, overlap guard, watermark, fail-open", () => {
  it("folds fresh raw on runOnce, advances the watermark, guards against overlap, and stops cleanly", async () => {
    const ent = await h.createMeteredEntitlement({ aggregation: "sum" });
    await h.ingest(h.usageKey, { events: [ev(ent, recentHour(1), 5), ev(ent, recentHour(1), 7)] });

    const worker = startRollupWorker(h.pool, { immediate: false, bucketSeconds: 3600, logger: h.app.log });
    try {
      await worker.runOnce(); // folds the fresh raw → buckets > 0 (the info-log branch)
      expect(worker.watermark().getTime()).toBeGreaterThan(0);
      expect(await rollupValue(ent)).toBe(12);

      // Re-entrant runOnce: two concurrent calls — the second hits the running-guard no-op branch.
      await Promise.all([worker.runOnce(), worker.runOnce()]);
      expect(await rollupValue(ent)).toBe(12); // idempotent recompute, no double-count
    } finally {
      worker.stop();
    }
  });

  it("boots immediately + stops on a healthy pool without throwing", async () => {
    const worker = startRollupWorker(h.pool, { immediate: true, bucketSeconds: 3600 });
    await new Promise((r) => setImmediate(r)); // let the immediate sweep kick off
    worker.stop();
    expect(true).toBe(true);
  });

  it("is FAIL-OPEN: a sweep against a broken pool never throws and reports zero progress (onError fired)", async () => {
    let errored = false;
    const r = await rollupSweep(brokenPool, { onError: () => (errored = true) });
    expect(r.processed).toBe(0);
    expect(r.buckets).toBe(0);
    expect(errored).toBe(true);

    // A throwing logger is swallowed (logging is best-effort) — the sweep still resolves.
    const throwing = { warn: () => { throw new Error("log sink down"); } };
    await expect(rollupSweep(brokenPool, { logger: throwing })).resolves.toBeDefined();

    // A worker started on the broken pool boots (immediate) + stops without crashing.
    const worker = startRollupWorker(brokenPool, { immediate: true, intervalMs: 60_000 });
    await new Promise((res) => setImmediate(res));
    worker.stop();
  });
});

describe("retention worker lifecycle (FR-015) — start, runOnce, info branch, fail-open", () => {
  it("prunes aged closed-bucket raw on runOnce (info branch) and stops cleanly", async () => {
    const ent = await h.createMeteredEntitlement({ aggregation: "sum" });
    await insertRaw(ent, agedHour(40), 100); // older than the ~35d window → a CLOSED bucket
    await rollupSweep(h.pool, { since: new Date(0), bucketSeconds: 3600 });
    expect(await h.countEvents(h.chainA.licenseId, ent)).toBe(1);

    const worker = startUsageRetentionWorker(h.pool, { immediate: false, bucketSeconds: 3600, logger: h.app.log });
    try {
      await worker.runOnce(); // prunes the aged raw → events > 0 (the info-log branch)
      expect(await h.countEvents(h.chainA.licenseId, ent)).toBe(0);
      expect(await rollupValue(ent)).toBe(100); // the durable rollup SURVIVES the prune (INV-6)
    } finally {
      worker.stop();
    }
  });

  it("boots immediately + stops on a healthy pool without throwing", async () => {
    const worker = startUsageRetentionWorker(h.pool, { immediate: true, bucketSeconds: 3600 });
    await new Promise((r) => setImmediate(r));
    worker.stop();
    expect(true).toBe(true);
  });

  it("is FAIL-OPEN: a prune against a broken pool never throws and reports zero (onError fired)", async () => {
    let errored = false;
    const r = await retentionSweep(brokenPool, { onError: () => (errored = true) });
    expect(r.events).toBe(0);
    expect(r.tenants).toBe(0);
    expect(errored).toBe(true);

    const throwing = { warn: () => { throw new Error("log sink down"); } };
    await expect(retentionSweep(brokenPool, { logger: throwing })).resolves.toBeDefined();

    const worker = startUsageRetentionWorker(brokenPool, { immediate: true, intervalMs: 60_000 });
    await new Promise((res) => setImmediate(res));
    worker.stop();
  });

  it("is PER-TENANT fail-open: one tenant's prune fault is caught and never aborts the sweep", async () => {
    // A pool whose tenant ENUMERATION succeeds (returns one tenant) but whose per-tenant prune DELETE throws —
    // so the per-tenant catch fires (fail-open) while the overall sweep still resolves cleanly.
    const partialPool = {
      connect: async () => ({
        query: async (text: string) => {
          if (/SELECT DISTINCT tenant_id/.test(text)) return { rows: [{ tenant_id: h.tenantA }], rowCount: 1 };
          throw new Error("prune boom"); // the DELETE inside pruneTenant
        },
        release: () => undefined,
      }),
    } as unknown as pg.Pool;

    let errored = false;
    const r = await retentionSweep(partialPool, { now: new Date(), onError: () => (errored = true) });
    expect(r.events).toBe(0); // the faulting tenant contributed nothing
    expect(r.tenants).toBe(0);
    expect(errored).toBe(true); // the per-tenant catch fired
  });
});
