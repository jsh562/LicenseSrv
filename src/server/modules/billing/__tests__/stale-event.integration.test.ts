// T040 [US6] (FR-016): the out-of-order / stale-event recency guard on the WEBHOOK path. An event whose
// `occurred_at` is not strictly newer than the subscription's `last_applied_event_at` is IGNORED — recorded
// in the ledger as `outcome='rejected', reason='stale_event'` and it never regresses the newer state (SC-010).
// Uses the real Testcontainers + E004-signer harness.
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { canceledEvent, createdEvent, renewalEvent, startBillingHarness, type BillingHarness } from "./harness.js";

let h: BillingHarness;

beforeAll(async () => {
  h = await startBillingHarness("stale");
}, 240_000);

afterAll(async () => {
  await h?.stop();
});

describe("stale / out-of-order event guard on the webhook path (US6, FR-016)", () => {
  it("an older event is ignored, recorded rejected/stale_event, and does not regress newer state", async () => {
    const ext = "sub_stale_order";
    const t0 = Math.floor(Date.now() / 1000);
    await h.postWebhook(h.connectionId, createdEvent(h.eventId(), ext));
    // A newer renewal advances the recency anchor to t0+500.
    await h.postWebhook(h.connectionId, renewalEvent(h.eventId(), ext, { occurred: t0 + 500 }));
    const sub = await h.getSubscription(ext);
    expect(sub!.billingState).toBe("active");
    expect(sub!.lastAppliedEventAt).not.toBeNull();

    // An out-of-order CANCEL with an OLDER occurred_at (t0+100 ≤ t0+500) → ignored.
    const staleId = h.eventId();
    const res = await h.postWebhook(h.connectionId, canceledEvent(staleId, ext, { occurred: t0 + 100 }));
    expect(res.statusCode).toBe(200);

    // It did NOT regress state (still active, no grace overlay).
    const after = await h.getSubscription(ext);
    expect(after!.billingState).toBe("active");
    expect(after!.graceExpiresAt).toBeNull();

    // It was recorded in the ledger as rejected / stale_event (never applied, never a lifecycle change).
    const events = await h.events();
    const rec = events.find((e) => e.providerEventId === staleId);
    expect(rec).toBeDefined();
    expect(rec!.outcome).toBe("rejected");
    expect(rec!.reason).toBe("stale_event");
  });

  it("an event with occurred_at EQUAL to the last applied is also stale (≤ boundary), no regression", async () => {
    const ext = "sub_stale_equal";
    const t0 = Math.floor(Date.now() / 1000);
    await h.postWebhook(h.connectionId, createdEvent(h.eventId(), ext));
    // Advance the anchor to exactly t0+300 via a renewal.
    await h.postWebhook(h.connectionId, renewalEvent(h.eventId(), ext, { occurred: t0 + 300 }));

    // A cancel at the SAME timestamp (t0+300) is not strictly newer → stale, rejected.
    const equalId = h.eventId();
    const res = await h.postWebhook(h.connectionId, canceledEvent(equalId, ext, { occurred: t0 + 300 }));
    expect(res.statusCode).toBe(200);
    expect((await h.getSubscription(ext))!.billingState).toBe("active");

    const rec = (await h.events()).find((e) => e.providerEventId === equalId);
    expect(rec!.outcome).toBe("rejected");
    expect(rec!.reason).toBe("stale_event");
  });
});
