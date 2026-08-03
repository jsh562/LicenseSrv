// T015 [US1] (FR-002; SC-001/015): the concurrent-dedupe RACE. The same `(source, eventId)` reported by
// GENUINELY PARALLEL producers must accrue EXACTLY ONCE — never double-counted — because dedupe is a UNIQUE
// (tenant, source, event_id) constraint + a single `INSERT ... ON CONFLICT DO NOTHING` (never a pre-SELECT
// then insert, which races). We fire the parallel load two ways: (1) many concurrent HTTP ingests via
// Promise.all through the app's own pool, and (2) — the tightest race — many parallel `appendBatch` calls each
// on its OWN pool client so the INSERTs genuinely contend on the unique index at the same instant. In both,
// exactly one raw row exists afterward and the summary accounting nets to one `accepted` across all callers.
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { withTenant } from "../../../db/client.js";
import { UsageRepo } from "../usage-repo.js";
import { startHarness, type UsageHarness } from "./harness.js";

let h: UsageHarness;
const repo = new UsageRepo();

beforeAll(async () => {
  h = await startHarness("dedupe");
}, 240_000);

afterAll(async () => {
  await h?.stop();
});

describe("POST /v1/usage — concurrent-dedupe race (US1, T015)", () => {
  it("accrues exactly once when parallel HTTP producers report the same (source, eventId) (SC-015)", async () => {
    const ent = await h.createMeteredEntitlement({ aggregation: "sum" });
    const source = "race-http";
    const eventId = h.eventId();
    const event = {
      licenseId: h.chainA.licenseId,
      entitlementId: ent,
      source,
      eventId,
      eventTime: new Date(Date.now() - 3_600_000).toISOString(),
      quantity: 100,
    };

    // 16 genuinely-concurrent ingests of the IDENTICAL key.
    const responses = await Promise.all(Array.from({ length: 16 }, () => h.ingest(h.usageKey, { events: [event] })));
    for (const r of responses) expect([200, 202]).toContain(r.statusCode);

    const summaries = responses.map((r) => r.json() as { accepted: number; duplicate: number; rejected: unknown[] });
    const totalAccepted = summaries.reduce((s, x) => s + x.accepted, 0);
    const totalDuplicate = summaries.reduce((s, x) => s + x.duplicate, 0);
    expect(summaries.every((x) => x.rejected.length === 0)).toBe(true);
    // Exactly one caller won the insert; every other saw the key already present (a duplicate no-op).
    expect(totalAccepted).toBe(1);
    expect(totalDuplicate).toBe(15);

    // The database holds a single raw row — no double-count.
    expect(await h.countEvents(h.chainA.licenseId, ent)).toBe(1);
    expect(await h.sumQuantity(h.chainA.licenseId, ent)).toBe(100);
  });

  it("accrues exactly once under parallel appendBatch on independent pool clients (tightest race, SC-001)", async () => {
    const ent = await h.createMeteredEntitlement({ aggregation: "sum" });
    const source = "race-repo";
    const eventId = h.eventId();
    const appendEvent = {
      licenseId: h.chainA.licenseId,
      entitlementId: ent,
      source,
      eventId,
      eventTime: new Date(Date.now() - 3_600_000),
      quantity: 100,
      dimensions: {},
    };

    // Each appendBatch runs in its OWN withTenant transaction (own pool client) so the single-row INSERTs
    // contend directly on usage_event_idem_uniq — the exact concurrent-producer scenario AD-001 hardens.
    const outcomes = await Promise.all(
      Array.from({ length: 24 }, () => withTenant(h.pool, h.tenantA, (q) => repo.appendBatch(q, [appendEvent]))),
    );

    const accepted = outcomes.filter((o) => o[0].outcome === "accepted").length;
    const duplicate = outcomes.filter((o) => o[0].outcome === "duplicate").length;
    expect(accepted).toBe(1);
    expect(duplicate).toBe(23);
    expect(await h.countEvents(h.chainA.licenseId, ent)).toBe(1);
  });
});
