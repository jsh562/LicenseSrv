// T034 [US5] IT (TDD) — the over-quota crossing signal (E016 FR-014; SC-009). Against real Postgres + the
// async rollup driven deterministically via `rollupSweep`:
//   - crossing a metered entitlement's allowance flags the aggregate `over_quota` (evaluated on the stored
//     TRUE signed net) AND writes exactly one append-only crossing audit attributed to a synthetic worker
//     actor with no secret/credential;
//   - once over, further events STILL ingest and accrue (signal only, never a block);
//   - a later reversal that drops the net below the allowance CLEARS the derived flag while the historical
//     crossing audit is RETAINED (append-only).
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { withTenant } from "../../../db/client.js";
import { rollupSweep } from "../rollup-worker.js";
import { startHarness, type UsageHarness } from "./harness.js";

let h: UsageHarness;

beforeAll(async () => {
  h = await startHarness("overquota");
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
async function overQuotaFlag(entitlementId: string): Promise<boolean> {
  return withTenant(h.pool, h.tenantA, async (q) => {
    const r = await q("SELECT bool_or(over_quota) AS f FROM usage_rollup WHERE entitlement_id = $1", [entitlementId]);
    return Boolean((r.rows[0] as { f: boolean | null }).f);
  });
}

describe("over-quota crossing signal (US5, T034, SC-009)", () => {
  it("flags over_quota on the true net and writes one crossing audit; further events still ingest", async () => {
    const ent = await h.createMeteredEntitlement({ aggregation: "sum", allowance: 250 });
    const hr = recentHour(2);

    // Cross the allowance: 200 + 100 = 300 > 250.
    await h.ingest(h.usageKey, { events: [ev(ent, hr, 200), ev(ent, hr, 100)] });
    await rollupSweep(h.pool, { since: new Date(0), bucketSeconds: 3600 });

    expect(await overQuotaFlag(ent)).toBe(true);
    const crossings = await h.auditRows("usage.over_quota");
    const mine = crossings.filter((c) => (c.after as { entitlementId?: string })?.entitlementId === ent);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.actor).toBe("usage-rollup-worker"); // synthetic system actor (FR-018)
    expect(mine[0]!.after).toMatchObject({ value: 300, allowance: 250 }); // signal carries only aggregate values

    // Once over, more events STILL ingest and accrue (no block) — the flag persists on a re-sweep (no re-audit).
    expect((await h.ingest(h.usageKey, { events: [ev(ent, hr, 50)] })).statusCode).toBe(200);
    await rollupSweep(h.pool, { since: new Date(0), bucketSeconds: 3600 });
    expect(await overQuotaFlag(ent)).toBe(true);
    expect((await h.auditRows("usage.over_quota")).filter((c) => (c.after as { entitlementId?: string })?.entitlementId === ent)).toHaveLength(1);
  });

  it("clears the DERIVED flag on a reversal below the allowance while retaining the crossing audit", async () => {
    const ent = await h.createMeteredEntitlement({ aggregation: "sum", allowance: 250 });
    const hr = recentHour(3);

    await h.ingest(h.usageKey, { events: [ev(ent, hr, 300)] });
    await rollupSweep(h.pool, { since: new Date(0), bucketSeconds: 3600 });
    expect(await overQuotaFlag(ent)).toBe(true);
    const before = (await h.auditRows("usage.over_quota")).filter((c) => (c.after as { entitlementId?: string })?.entitlementId === ent);
    expect(before).toHaveLength(1);

    // A reference-free reversal drops the true net to 100 (< 250) → the DERIVED flag clears on the next sweep.
    await h.ingest(h.usageKey, { events: [ev(ent, hr, -200)] });
    await rollupSweep(h.pool, { since: new Date(0), bucketSeconds: 3600 });
    expect(await overQuotaFlag(ent)).toBe(false);

    // …but the historical crossing audit is RETAINED (append-only) — no clearing audit, the old one persists.
    const after = (await h.auditRows("usage.over_quota")).filter((c) => (c.after as { entitlementId?: string })?.entitlementId === ent);
    expect(after).toHaveLength(1);
    expect(after[0]!.after).toMatchObject({ allowance: 250 });
  });
});
