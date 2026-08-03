// T014 [US1] (FR-001/007; SC-002/011/016): the POST /v1/usage ingest surface against real Postgres. Asserts a
// batch of distinct events fast-acks 200/202 with the per-batch summary and each accrues exactly once; a
// re-report of the identical batch is all `duplicate` and accrues nothing further (SC-002); a MIXED batch
// (new + duplicate + an invalid per-event reference) accrues the new, no-ops the duplicate, and reports the
// bad event per-event WITHOUT failing the batch (FR-007/AD-008); a key lacking the `usage.ingest` scope is
// refused 403 with nothing accrued (SC-016); and an over-cap batch is refused 400 `batch_too_large` BEFORE any
// accrual (SC-011). Whole-request vs per-event refusals are the two disjoint vocabularies.
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { startHarness, type UsageHarness } from "./harness.js";

let h: UsageHarness;

beforeAll(async () => {
  h = await startHarness("ingest");
}, 240_000);

afterAll(async () => {
  await h?.stop();
});

/** Build a structurally-valid SUM event within the acceptance window (a recent whole-ish instant). */
function makeEvent(h: UsageHarness, entitlementId: string, over: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    licenseId: h.chainA.licenseId,
    entitlementId,
    source: "node-1",
    eventId: h.eventId(),
    eventTime: new Date(Date.now() - 3_600_000).toISOString(),
    quantity: 100,
    ...over,
  };
}

describe("POST /v1/usage — idempotent batch ingest (US1, T014)", () => {
  it("fast-acks a batch of distinct events with a per-batch summary and accrues each once", async () => {
    const ent = await h.createMeteredEntitlement({ aggregation: "sum" });
    const events = [makeEvent(h, ent), makeEvent(h, ent), makeEvent(h, ent)];

    const res = await h.ingest(h.usageKey, { events });
    expect([200, 202]).toContain(res.statusCode);
    const body = res.json() as { accepted: number; duplicate: number; rejected: unknown[] };
    expect(body).toEqual({ accepted: 3, duplicate: 0, rejected: [] });
    expect(await h.countEvents(h.chainA.licenseId, ent)).toBe(3);
    expect(await h.sumQuantity(h.chainA.licenseId, ent)).toBe(300);
  });

  it("re-reporting the identical batch is all `duplicate` and accrues nothing further (SC-002)", async () => {
    const ent = await h.createMeteredEntitlement({ aggregation: "sum" });
    const events = [makeEvent(h, ent), makeEvent(h, ent)];

    const first = (await h.ingest(h.usageKey, { events })).json() as { accepted: number; duplicate: number };
    expect(first).toMatchObject({ accepted: 2, duplicate: 0 });
    expect(await h.countEvents(h.chainA.licenseId, ent)).toBe(2);

    const replay = (await h.ingest(h.usageKey, { events })).json() as { accepted: number; duplicate: number; rejected: unknown[] };
    expect(replay).toEqual({ accepted: 0, duplicate: 2, rejected: [] });
    // No second accrual — the count is unchanged.
    expect(await h.countEvents(h.chainA.licenseId, ent)).toBe(2);
  });

  it("processes a MIXED batch per-event (new accrues, duplicate no-ops, invalid rejected — never fails the batch)", async () => {
    const ent = await h.createMeteredEntitlement({ aggregation: "sum" });
    const dup = makeEvent(h, ent);
    // Accrue `dup` first so the mixed batch re-reports it as a duplicate.
    await h.ingest(h.usageKey, { events: [dup] });

    const fresh = makeEvent(h, ent);
    const bad = makeEvent(h, ent, { entitlementId: "00000000-0000-4000-8000-000000000000" }); // unknown entitlement
    const events = [fresh, dup, bad];

    const res = await h.ingest(h.usageKey, { events });
    expect([200, 202]).toContain(res.statusCode);
    const body = res.json() as { accepted: number; duplicate: number; rejected: { index: number; code: string }[] };
    expect(body.accepted).toBe(1);
    expect(body.duplicate).toBe(1);
    expect(body.rejected).toHaveLength(1);
    expect(body.rejected[0]).toMatchObject({ index: 2, code: "not_found" });
    // The fresh event accrued; the count is the original 1 (dup) + 1 (fresh) = 2 (bad accrued nothing).
    expect(await h.countEvents(h.chainA.licenseId, ent)).toBe(2);
  });

  it("refuses a key lacking the `usage.ingest` scope with 403 and accrues nothing (SC-016)", async () => {
    const ent = await h.createMeteredEntitlement({ aggregation: "sum" });
    const res = await h.ingest(h.noScopeKey, { events: [makeEvent(h, ent)] });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: "forbidden", details: { requiredScope: "usage.ingest" } });
    expect(await h.countEvents(h.chainA.licenseId, ent)).toBe(0);
  });

  it("refuses an over-cap batch with 400 `batch_too_large` BEFORE any accrual (SC-011)", async () => {
    const ent = await h.createMeteredEntitlement({ aggregation: "sum" });
    const events = Array.from({ length: 1001 }, () => makeEvent(h, ent));
    const res = await h.ingest(h.usageKey, { events });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: "batch_too_large", details: { max: 1000, size: 1001 } });
    // Pre-accrual refusal — not one event was appended.
    expect(await h.countEvents(h.chainA.licenseId, ent)).toBe(0);
  });

  it("refuses a malformed envelope (empty events) with 400 `validation_error`", async () => {
    const res = await h.ingest(h.usageKey, { events: [] });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: "validation_error" });
  });

  it("audits the batch summary attributed to the reporting key (FR-018)", async () => {
    const ent = await h.createMeteredEntitlement({ aggregation: "sum" });
    await h.ingest(h.usageKey, { events: [makeEvent(h, ent), makeEvent(h, ent)] });
    const rows = await h.auditRows("usage.ingest");
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].actor).toBe("usage-api");
    expect(rows[0].after).toMatchObject({ accepted: 2, duplicate: 0 });
  });
});
