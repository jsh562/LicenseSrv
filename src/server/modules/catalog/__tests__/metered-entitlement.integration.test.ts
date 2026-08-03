// T029 [US3] IT (TDD) — the metered entitlement DEFINITION (E016 FR-008/FR-009; SC-005/SC-006). Against real
// Postgres via the shared usage harness (a seeded license chain + a usage.ingest key + the async rollup driven
// deterministically), it authors metered entitlements through the E007 catalog repository (`createEntitlement`/
// `updateEntitlement`) — the aggregation type + unit are captured on a NEW `metered` kind distinct from
// boolean/integer_limit — and confirms:
//   - SC-005: the SAME conceptual event stream accrues per the entitlement's aggregation TYPE — SUM sums the
//     reported quantities, COUNT counts events (each +1), and UNIQUE_COUNT counts distinct dimension values —
//     so three meters yield three distinct totals from one definition axis.
//   - SC-006: an aggregation/unit edit SUCCEEDS while no usage exists, and is REFUSED `aggregation_frozen`
//     (409) once any usage_event has accrued — while the signal-only allowance stays editable (FR-014).
//   - counter-only (FR-008): a gauge/peak aggregation is refused `validation_error` at authoring time.
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { withTenant } from "../../../db/client.js";
import { startHarness, type UsageHarness } from "../../usage/__tests__/harness.js";
import { rollupSweep } from "../../usage/rollup-worker.js";
import { createEntitlement, updateEntitlement } from "../entitlements.js";
import { CatalogError } from "../validation.js";

let h: UsageHarness;
const ACTOR = "test-admin";

beforeAll(async () => {
  h = await startHarness("metered");
}, 240_000);

afterAll(async () => {
  await h?.stop();
});

const HOUR_MS = 3_600_000;
/** A recent WHOLE UTC hour inside the acceptance window (so ingested events are never stale). */
function recentHour(hoursAgo: number): Date {
  const h0 = Math.floor(Date.now() / HOUR_MS) * HOUR_MS;
  return new Date(h0 - hoursAgo * HOUR_MS);
}
function ev(entitlementId: string, at: Date, quantity: number, dimensions?: Record<string, unknown>): Record<string, unknown> {
  return {
    licenseId: h.chainA.licenseId,
    entitlementId,
    source: "node-1",
    eventId: h.eventId(),
    eventTime: at.toISOString(),
    quantity,
    ...(dimensions ? { dimensions } : {}),
  };
}
function key(prefix: string): string {
  return `${prefix}-${randomUUID().slice(0, 8)}`;
}

/** The summed durable rollup `value` (true signed net) for an entitlement in tenant A. */
async function rollupValue(entitlementId: string): Promise<number> {
  return withTenant(h.pool, h.tenantA, async (q) => {
    const r = await q(
      "SELECT COALESCE(sum(value), 0)::float8 AS v FROM usage_rollup WHERE entitlement_id = $1",
      [entitlementId],
    );
    return Number((r.rows[0] as { v: number }).v);
  });
}

describe("metered entitlement definition — aggregation type drives accrual (US3, T029, SC-005)", () => {
  it("defines SUM / COUNT / UNIQUE_COUNT meters that accrue distinct totals from the SAME event axis", async () => {
    const sumEnt = await createEntitlement(h.pool, h.tenantA, ACTOR, {
      key: key("meter-sum"), name: "SUM meter", type: "metered", aggregation: "sum", unit: "gb",
    });
    const countEnt = await createEntitlement(h.pool, h.tenantA, ACTOR, {
      key: key("meter-count"), name: "COUNT meter", type: "metered", aggregation: "count", unit: "calls",
    });
    const uniqueEnt = await createEntitlement(h.pool, h.tenantA, ACTOR, {
      key: key("meter-uniq"), name: "UNIQUE meter", type: "metered", aggregation: "unique_count", unit: "users",
    });

    // Each is a NEW `metered` kind, distinct from boolean/integer_limit, carrying its aggregation + unit.
    expect(sumEnt).toMatchObject({ type: "metered", aggregation: "sum", unit: "gb", allowance: null });
    expect(countEnt).toMatchObject({ type: "metered", aggregation: "count", unit: "calls" });
    expect(uniqueEnt).toMatchObject({ type: "metered", aggregation: "unique_count", unit: "users" });

    const hr = recentHour(2);
    // SUM: reported quantities 100+200+50 → 350.
    expect((await h.ingest(h.usageKey, { events: [ev(sumEnt.id, hr, 100), ev(sumEnt.id, hr, 200), ev(sumEnt.id, hr, 50)] })).statusCode).toBe(200);
    // COUNT: each event contributes +1 → 4 events → 4.
    expect((await h.ingest(h.usageKey, { events: [ev(countEnt.id, hr, 1), ev(countEnt.id, hr, 1), ev(countEnt.id, hr, 1), ev(countEnt.id, hr, 1)] })).statusCode).toBe(200);
    // UNIQUE_COUNT: distinct dimension values u1,u2,u1 → 2 distinct.
    expect((await h.ingest(h.usageKey, { events: [ev(uniqueEnt.id, hr, 1, { user: "u1" }), ev(uniqueEnt.id, hr, 1, { user: "u2" }), ev(uniqueEnt.id, hr, 1, { user: "u1" })] })).statusCode).toBe(200);

    await rollupSweep(h.pool, { since: new Date(0), bucketSeconds: 3600 });

    expect(await rollupValue(sumEnt.id)).toBe(350); // SUM sums quantities
    expect(await rollupValue(countEnt.id)).toBe(4); // COUNT counts events
    expect(await rollupValue(uniqueEnt.id)).toBe(2); // UNIQUE_COUNT counts distinct values
  });

  it("refuses a gauge/peak aggregation at authoring time (counter-only MVP, FR-008)", async () => {
    await expect(
      createEntitlement(h.pool, h.tenantA, ACTOR, {
        key: key("meter-gauge"), name: "Gauge", type: "metered", aggregation: "max", unit: "concurrent",
      } as never),
    ).rejects.toMatchObject({ code: "validation_error", status: 400 });

    // A metered kind also REQUIRES a unit (the DB shape CHECK mirror).
    await expect(
      createEntitlement(h.pool, h.tenantA, ACTOR, {
        key: key("meter-nounit"), name: "No unit", type: "metered", aggregation: "sum",
      } as never),
    ).rejects.toMatchObject({ code: "validation_error", status: 400 });
  });
});

describe("metered entitlement freeze-on-usage (US3, T029, SC-006)", () => {
  it("allows an aggregation/unit edit while empty, then refuses it once usage exists (aggregation_frozen)", async () => {
    const ent = await createEntitlement(h.pool, h.tenantA, ACTOR, {
      key: key("meter-freeze"), name: "Freeze", type: "metered", aggregation: "sum", unit: "gb",
    });

    // No usage yet → editing the aggregation + unit succeeds.
    const edited = await updateEntitlement(h.pool, h.tenantA, ACTOR, ent.id, { aggregation: "count", unit: "calls" });
    expect(edited).toMatchObject({ aggregation: "count", unit: "calls" });

    // Accrue one usage_event against it (aggregation is now COUNT → a +1 event).
    expect((await h.ingest(h.usageKey, { events: [ev(ent.id, recentHour(1), 1)] })).statusCode).toBe(200);
    expect(await h.countEvents(h.chainA.licenseId, ent.id)).toBe(1);

    // Once usage exists the aggregation + unit are FROZEN → 409 aggregation_frozen.
    await expect(updateEntitlement(h.pool, h.tenantA, ACTOR, ent.id, { aggregation: "sum" })).rejects.toMatchObject({
      code: "aggregation_frozen",
      status: 409,
    });
    await expect(updateEntitlement(h.pool, h.tenantA, ACTOR, ent.id, { unit: "seat-hours" })).rejects.toMatchObject({
      code: "aggregation_frozen",
      status: 409,
    });
    // A metered→other KIND change is likewise frozen once usage exists.
    await expect(updateEntitlement(h.pool, h.tenantA, ACTOR, ent.id, { type: "boolean" })).rejects.toMatchObject({
      code: "aggregation_frozen",
      status: 409,
    });

    // …but the signal-only ALLOWANCE (FR-014) stays editable even after usage exists, and a name edit is fine.
    const withQuota = await updateEntitlement(h.pool, h.tenantA, ACTOR, ent.id, { allowance: 500, name: "Freeze v2" });
    expect(withQuota).toMatchObject({ aggregation: "count", unit: "calls", allowance: 500, name: "Freeze v2" });

    // The refusal is the typed catalog error (mapped to a 409 by the routes).
    const caught = await updateEntitlement(h.pool, h.tenantA, ACTOR, ent.id, { aggregation: "sum" }).catch((e: unknown) => e);
    expect(caught).toBeInstanceOf(CatalogError);
  });
});
