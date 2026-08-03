// T040 [COMPLETES FR-018] (SC-021): the append-only audit trail of the usage surface. An audit entry is written
// for EVERY FR-018 event type:
//   • an ingestion BATCH → `usage.ingest` (the per-batch summary, counts only), attributed to the reporting key;
//   • a metered-entitlement DEFINITION / EDIT → `catalog.entitlement.created` / `.updated` (the E007 authoring);
//   • an over-quota CROSSING → `usage.over_quota`, attributed to the SYNTHETIC rollup worker actor;
//   • a REVERSAL → its own `usage.ingest` batch entry (a reference-free signed-negative event is ingested like
//     any other, so its accrual is auditable as an ingestion batch);
//   • a retention PRUNE → `usage.retention_pruned`, attributed to the SYNTHETIC retention worker actor.
// The rollup + prune WORKER actions are attributed to a SYNTHETIC system actor (never a client actor) and carry
// only ids/counts — no secret/credential/dimension (SC-021). A rate-limit shed is audited as a `usage.rate_limited`
// SECURITY event. Uses the real Testcontainers harness; the async rollup + prune are driven deterministically.
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { withTenant } from "../../../db/client.js";
import { createEntitlement, updateEntitlement } from "../../catalog/entitlements.js";
import { ROLLUP_ACTOR, rollupSweep } from "../rollup-worker.js";
import { USAGE_RETENTION_ACTOR, retentionSweep } from "../retention-worker.js";
import { OVER_QUOTA_ACTOR } from "../rollup.js";
import { startHarness, type UsageHarness } from "./harness.js";

let h: UsageHarness;

/** The synthetic reporting-key actor every runtime ingest batch is attributed to (distinct from a client user). */
const INGEST_ACTOR = "usage-api";
/** The catalog authoring actor used for the definition/edit audits (a console user, NOT a synthetic worker). */
const CATALOG_ACTOR = "audit-admin";
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

beforeAll(async () => {
  h = await startHarness("audit");
}, 240_000);

afterAll(async () => {
  await h?.stop();
});

function recentHour(hoursAgo: number): Date {
  const h0 = Math.floor(Date.now() / HOUR_MS) * HOUR_MS;
  return new Date(h0 - hoursAgo * HOUR_MS);
}
/** A whole UTC hour `days` in the past (well beyond the ~35d window → a CLOSED bucket once retention runs). */
function agedHour(days: number): Date {
  return new Date(Math.floor((Date.now() - days * DAY_MS) / HOUR_MS) * HOUR_MS);
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
/** Insert a raw usage_event directly (bypassing the ingest acceptance gate) with an explicit aged timestamp. */
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

describe("usage audit trail — every FR-018 event type recorded; worker actions synthetic-actor (FR-018, SC-021)", () => {
  it("an ingestion BATCH → an append-only `usage.ingest` entry (reporting-key actor, counts only, no secret)", async () => {
    const ent = await h.createMeteredEntitlement({ aggregation: "sum" });
    const res = await h.ingest(h.usageKey, { events: [ev(ent, recentHour(1), 100), ev(ent, recentHour(1), 50)] });
    expect(res.statusCode).toBe(200);

    const rows = await h.auditRows("usage.ingest");
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0]!.actor).toBe(INGEST_ACTOR);
    expect(rows[0]!.securityEvent).toBe(false); // a routine op, not a security event
    // The batch entry carries ONLY counts — never a payload/secret/credential.
    expect(rows[0]!.after).toMatchObject({ accepted: 2, duplicate: 0, rejected: 0, total: 2 });
  });

  it("a metered-entitlement DEFINITION → a `catalog.entitlement.created` entry; an EDIT → `.updated`", async () => {
    const created = await createEntitlement(h.pool, h.tenantA, CATALOG_ACTOR, {
      key: key("meter-audit"),
      name: "Audit meter",
      type: "metered",
      aggregation: "sum",
      unit: "gb",
    });
    const createdRows = await h.auditRows("catalog.entitlement.created");
    expect(createdRows.length).toBeGreaterThanOrEqual(1);
    expect(createdRows[0]!.actor).toBe(CATALOG_ACTOR);

    // Editing the signal-only allowance is permitted even after usage; a definition edit is auditable regardless.
    await updateEntitlement(h.pool, h.tenantA, CATALOG_ACTOR, created.id, { allowance: 500 });
    const updatedRows = await h.auditRows("catalog.entitlement.updated");
    expect(updatedRows.length).toBeGreaterThanOrEqual(1);
    expect(updatedRows[0]!.actor).toBe(CATALOG_ACTOR);
  });

  it("an over-quota CROSSING → a `usage.over_quota` entry attributed to the SYNTHETIC rollup worker actor + ids", async () => {
    const ent = await h.createMeteredEntitlement({ aggregation: "sum", allowance: 100 });
    await h.ingest(h.usageKey, { events: [ev(ent, recentHour(2), 250)] }); // 250 > 100 → crossing
    await rollupSweep(h.pool, { since: new Date(0), bucketSeconds: 3600 });

    const rows = (await h.auditRows("usage.over_quota")).filter(
      (r) => (r.after as { entitlementId?: string })?.entitlementId === ent,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actor).toBe(OVER_QUOTA_ACTOR); // synthetic system actor (FR-018)
    expect(rows[0]!.actor).not.toBe(INGEST_ACTOR); // NOT a client/runtime actor
    // The crossing carries only the aggregate ids/values — no secret/credential/dimension datum.
    expect(rows[0]!.after).toMatchObject({ licenseId: h.chainA.licenseId, entitlementId: ent, value: 250, allowance: 100 });
  });

  it("a rollup pass → a `usage.rollup` entry attributed to the SYNTHETIC rollup worker actor (counts only)", async () => {
    const ent = await h.createMeteredEntitlement({ aggregation: "sum" });
    await h.ingest(h.usageKey, { events: [ev(ent, recentHour(1), 7)] });
    await rollupSweep(h.pool, { since: new Date(0), bucketSeconds: 3600 });

    const rows = await h.auditRows("usage.rollup");
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0]!.actor).toBe(ROLLUP_ACTOR);
    expect(rows[0]!.actor).not.toBe(INGEST_ACTOR); // synthetic, never a client actor (SC-021)
    expect(rows[0]!.after).toMatchObject({ processed: expect.any(Number), buckets: expect.any(Number) });
  });

  it("a REVERSAL → its own append-only `usage.ingest` batch entry (a signed-negative event is auditable)", async () => {
    const ent = await h.createMeteredEntitlement({ aggregation: "sum" });
    const before = (await h.auditRows("usage.ingest")).length;
    // A reference-free signed-negative reversal is ingested like any other event → a fresh batch audit entry.
    const res = await h.ingest(h.usageKey, { events: [ev(ent, recentHour(1), -20)] });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { accepted: number }).accepted).toBe(1);

    const after = await h.auditRows("usage.ingest");
    expect(after.length).toBe(before + 1);
    expect(after[0]!.actor).toBe(INGEST_ACTOR);
    expect(after[0]!.after).toMatchObject({ accepted: 1, total: 1 });
  });

  it("a retention PRUNE → a `usage.retention_pruned` entry attributed to the SYNTHETIC retention worker actor", async () => {
    const ent = await h.createMeteredEntitlement({ aggregation: "sum" });
    await insertRaw(ent, agedHour(40), 100); // older than the ~35d window → a CLOSED bucket
    await rollupSweep(h.pool, { since: new Date(0), bucketSeconds: 3600 });

    const swept = await retentionSweep(h.pool, { now: new Date() });
    expect(swept.events).toBeGreaterThanOrEqual(1);

    const rows = await h.auditRows("usage.retention_pruned");
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0]!.actor).toBe(USAGE_RETENTION_ACTOR); // synthetic system actor (FR-018/SC-021)
    expect(rows[0]!.actor).not.toBe(INGEST_ACTOR);
    expect(rows[0]!.after).toMatchObject({ events: expect.any(Number) });
  });
});

describe("usage rate-limit breach is audited as a `usage.rate_limited` security event (FR-005/018)", () => {
  let hr: UsageHarness;
  const RATE_MAX = 5;

  beforeAll(async () => {
    // A LOW per-API-key ingest ceiling so a modest burst trips the 429 shed path.
    hr = await startHarness("audit-rate", { rateMax: RATE_MAX });
  }, 240_000);

  afterAll(async () => {
    await hr?.stop();
  });

  it("over-limit ingest calls → 429 rate_limited + Retry-After; each shed is a `usage.rate_limited` security event", async () => {
    const ent = await hr.createMeteredEntitlement({ aggregation: "sum" });
    const at = new Date(Math.floor(Date.now() / HOUR_MS) * HOUR_MS - HOUR_MS);
    const statuses: number[] = [];
    let over: Awaited<ReturnType<typeof hr.ingest>> | undefined;
    for (let i = 0; i < RATE_MAX + 8; i++) {
      const res = await hr.ingest(hr.usageKey, {
        events: [{ licenseId: hr.chainA.licenseId, entitlementId: ent, source: "s", eventId: hr.eventId(), eventTime: at.toISOString(), quantity: 1 }],
      });
      statuses.push(res.statusCode);
      if (res.statusCode === 429) over = res;
    }
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThanOrEqual(1);
    expect(over).toBeDefined();
    const body = over!.json() as { code: string; details?: { retryAfterSeconds?: number } };
    expect(body.code).toBe("rate_limited");
    // The `Retry-After` header equals the `details.retryAfterSeconds` hint (they never disagree, FR-005).
    const retryAfter = Number(over!.headers["retry-after"]);
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(body.details?.retryAfterSeconds).toBe(retryAfter);

    // The shed request(s) are audited as a `usage.rate_limited` security event (best-effort/async → poll).
    const audited = await waitForSecurityEvent(hr, (e) => e.action === "usage.rate_limited");
    expect(audited).toBe(true);
  });
});

/** Poll the tenant-A security-event trail until `pred` matches or the timeout elapses (best-effort async audit). */
async function waitForSecurityEvent(
  harness: UsageHarness,
  pred: (r: { actor: string; action: string; target: string | null }) => boolean,
  timeoutMs = 3000,
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const events = await harness.securityEvents();
    if (events.some(pred)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}
