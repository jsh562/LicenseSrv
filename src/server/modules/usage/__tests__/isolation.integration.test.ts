// T041 [COMPLETES FR-017] (SC-012): the usage surface is tenant-isolated, fail-closed (forced RLS on ALL THREE
// usage tables). A cross-tenant reference resolves to NOT FOUND — per-event `not_found` on ingest (a bad event
// never fails the batch, AD-008) and `404 not_found` on the admin query plane (never 403, never leaking
// existence). The forced-RLS guarantee is re-asserted DIRECTLY: with the tenant GUC UNSET the `usage_event`,
// `usage_rollup`, AND `usage_unique_value` tables each yield 0 rows despite data being present (SC-012). Uses the
// real Testcontainers harness (tenant A + tenant B keys / admin sessions); the async rollup is driven
// deterministically via `rollupSweep` so all three tables carry rows before the GUC-unset scan.
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { withTenant } from "../../../db/client.js";
import { rollupSweep } from "../rollup-worker.js";
import { startHarness, type UsageHarness } from "./harness.js";

let h: UsageHarness;

/** The non-owner app role RLS is FORCED on (matches the E015 lease isolation assertion). */
const APP_ROLE = "licensesrv_app";
const HOUR_MS = 3_600_000;

beforeAll(async () => {
  h = await startHarness("isolation");
}, 240_000);

afterAll(async () => {
  await h?.stop();
});

/** A recent WHOLE UTC hour inside the acceptance window (so ingested events are never stale). */
function recentHour(hoursAgo: number): Date {
  const h0 = Math.floor(Date.now() / HOUR_MS) * HOUR_MS;
  return new Date(h0 - hoursAgo * HOUR_MS);
}

/** Ingest one UNIQUE_COUNT event (populates usage_event) then roll it up (populates rollup + unique_value). */
async function seedAllThreeTables(): Promise<void> {
  const ent = await h.createMeteredEntitlement({ aggregation: "unique_count" });
  const res = await h.ingest(h.usageKey, {
    events: [
      {
        licenseId: h.chainA.licenseId,
        entitlementId: ent,
        source: "iso-1",
        eventId: h.eventId(),
        eventTime: recentHour(1).toISOString(),
        quantity: 1,
        dimensions: { sku: "a" },
      },
    ],
  });
  if (res.statusCode !== 200) throw new Error(`seed ingest failed: ${res.statusCode} ${res.body}`);
  await rollupSweep(h.pool, { since: new Date(0), bucketSeconds: 3600 });
}

describe("multi-tenant usage isolation — cross-tenant → not found + forced RLS on all three tables (FR-017, SC-012)", () => {
  it("forced RLS: an UNSET tenant GUC yields 0 rows on usage_event, usage_rollup AND usage_unique_value", async () => {
    await seedAllThreeTables();

    // Sanity: under a set tenant GUC (withTenant) tenant A DOES see rows on all three tables.
    const present = await withTenant(h.pool, h.tenantA, async (q) => ({
      events: ((await q("SELECT count(*)::int AS n FROM usage_event", [])).rows[0] as { n: number }).n,
      rollups: ((await q("SELECT count(*)::int AS n FROM usage_rollup", [])).rows[0] as { n: number }).n,
      uniques: ((await q("SELECT count(*)::int AS n FROM usage_unique_value", [])).rows[0] as { n: number }).n,
    }));
    expect(present.events).toBeGreaterThan(0);
    expect(present.rollups).toBeGreaterThan(0);
    expect(present.uniques).toBeGreaterThan(0);

    // With NO `app.current_tenant` GUC set, the tenant_isolation policy matches nothing on any usage table.
    const client = await h.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`SET LOCAL ROLE ${APP_ROLE}`); // the non-owner app role — RLS is FORCED
      for (const table of ["usage_event", "usage_rollup", "usage_unique_value"]) {
        const r = await client.query(`SELECT count(*)::int AS n FROM ${table}`);
        expect((r.rows[0] as { n: number }).n).toBe(0);
      }
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  });

  it("cross-tenant INGEST of tenant A's license/entitlement (tenant B key) → per-event not_found, nothing accrued", async () => {
    const ent = await h.createMeteredEntitlement({ aggregation: "sum" });
    const before = await h.countEvents(h.chainA.licenseId, ent);

    // Tenant B's key reports against tenant A's license + entitlement → each event resolves cross-tenant → not_found.
    const res = await h.ingest(h.usageKeyB, {
      events: [
        {
          licenseId: h.chainA.licenseId,
          entitlementId: ent,
          source: "iso-x",
          eventId: h.eventId(),
          eventTime: recentHour(1).toISOString(),
          quantity: 10,
        },
      ],
    });
    // A per-event refusal (AD-008): the batch still fast-acks 200; the single event is a per-event `not_found`.
    expect(res.statusCode).toBe(200);
    const body = res.json() as { accepted: number; duplicate: number; rejected: { code: string }[] };
    expect(body.accepted).toBe(0);
    expect(body.rejected).toHaveLength(1);
    expect(body.rejected[0]!.code).toBe("not_found");
    // Nothing accrued into tenant A's stream.
    expect(await h.countEvents(h.chainA.licenseId, ent)).toBe(before);
  });

  it("cross-tenant admin QUERY of tenant A's license (tenant B admin session) → 404 not_found (never 403)", async () => {
    const res = await h.getUsage(h.authAdminB, h.chainA.licenseId, {
      from: recentHour(24).toISOString(),
      to: new Date().toISOString(),
    });
    expect(res.statusCode).toBe(404);
    expect((res.json() as { code: string }).code).toBe("not_found");
  });

  it("same-tenant admin query of the tenant's OWN license → 200 (the isolation is directional, not a blanket block)", async () => {
    const res = await h.getUsage(h.authAdmin, h.chainA.licenseId, {
      from: recentHour(24).toISOString(),
      to: new Date().toISOString(),
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { licenseId: string }).licenseId).toBe(h.chainA.licenseId);
  });
});
