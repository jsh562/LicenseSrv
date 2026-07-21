// T020 [US1] (FR-003): idempotent processing against real Postgres. A redelivery of the SAME provider event
// id is a 200 `duplicate` no-op — applied at most once, no second ledger row. Concurrent/simultaneous
// in-flight redeliveries of the same event id RACE on the idempotency UNIQUE (recorded transactionally with
// the side effect) and still resolve to EXACTLY ONE `applied` — the rest are `duplicate` no-ops (SC-002).
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type BillingHarness, createdEvent, renewalEvent, startBillingHarness } from "./harness.js";

let h: BillingHarness;

beforeAll(async () => {
  h = await startBillingHarness("idem");
}, 240_000);

afterAll(async () => {
  await h?.stop();
});

describe("idempotent webhook processing (US1, FR-003)", () => {
  it("a sequential redelivery of the same event id is a 200 duplicate no-op (no 2nd ledger row)", async () => {
    const ext = "sub_idem_seq";
    const evt = createdEvent(h.eventId(), ext);
    const eventId = evt.id as string;

    const first = await h.postWebhook(h.connectionId, evt);
    expect(first.json()).toEqual({ received: true, outcome: "applied" });
    const sub = await h.getSubscription(ext);
    expect(sub).not.toBeNull();

    // Byte-identical redelivery of the same event id.
    const second = await h.postWebhook(h.connectionId, evt);
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual({ received: true, outcome: "duplicate" });

    // Applied exactly once: one ledger row, one subscription, one license still active.
    expect(await h.countEventRows(eventId)).toBe(1);
    const lic = await h.getLicense(sub!.licenseId);
    expect(lic?.status).toBe("active");
  });

  it("concurrent in-flight redeliveries of one event id resolve to exactly one applied (the rest duplicate)", async () => {
    // Provision the subscription first, then race N concurrent redeliveries of ONE renewal event id.
    const ext = "sub_idem_race";
    const t0 = Math.floor(Date.now() / 1000);
    await h.postWebhook(h.connectionId, createdEvent(h.eventId(), ext));
    expect(await h.getSubscription(ext)).not.toBeNull();

    // The renewal must occur strictly AFTER the provision (else the recency guard treats it as stale).
    const renewal = renewalEvent(h.eventId(), ext, { periodEnd: t0 + 30 * 86_400, occurred: t0 + 100 });
    const renewalId = renewal.id as string;

    const N = 6;
    const responses = await Promise.all(Array.from({ length: N }, () => h.postWebhook(h.connectionId, renewal)));
    const outcomes = responses.map((r) => {
      expect(r.statusCode).toBe(200);
      return (r.json() as { outcome: string }).outcome;
    });

    expect(outcomes.filter((o) => o === "applied")).toHaveLength(1);
    expect(outcomes.filter((o) => o === "duplicate")).toHaveLength(N - 1);
    // The idempotency UNIQUE forbids a second row: exactly one ledger row for the renewal event.
    expect(await h.countEventRows(renewalId)).toBe(1);
  });
});
