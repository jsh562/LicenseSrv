// T019 [US1] (FR-001/002): webhook signature + timestamp verification against real Postgres + the real E004
// signer. A validly-signed, in-tolerance delivery is accepted and processed exactly ONCE (a subscription +
// license provisioned, one ledger row). A missing OR invalid (tampered) signature → 401 invalid_signature
// with NO state change and NO ledger row. A stale OR future-skewed signed timestamp → 400 stale_timestamp
// with no state change. Verify-before-process: the signature/timestamp are checked BEFORE any parse/apply.
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type BillingHarness, createdEvent, startBillingHarness } from "./harness.js";

let h: BillingHarness;

beforeAll(async () => {
  h = await startBillingHarness("verify");
}, 240_000);

afterAll(async () => {
  await h?.stop();
});

describe("webhook signature + timestamp verification (US1, FR-001/002)", () => {
  it("accepts a validly-signed, in-tolerance webhook and processes it exactly once", async () => {
    const ext = "sub_verify_ok";
    const res = await h.postWebhook(h.connectionId, createdEvent(h.eventId(), ext));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ received: true, outcome: "applied" });

    const sub = await h.getSubscription(ext);
    expect(sub).not.toBeNull();
    const lic = await h.getLicense(sub!.licenseId);
    expect(lic?.status).toBe("active");
    // Applied exactly once: a single ledger row for the event.
    const rows = await h.events();
    expect(rows.filter((r) => r.subscriptionId === sub!.id && r.outcome === "applied")).toHaveLength(1);
  });

  it("rejects a MISSING signature with 401 and no state change / no ledger row", async () => {
    const ext = "sub_verify_missing";
    const eventId = h.eventId();
    const res = await h.postWebhook(h.connectionId, createdEvent(eventId, ext), { signature: null });
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe("invalid_signature");

    expect(await h.getSubscription(ext)).toBeNull();
    expect(await h.countEventRows(eventId)).toBe(0);
  });

  it("rejects an INVALID (tampered) signature with 401 and no state change", async () => {
    const ext = "sub_verify_bad";
    const eventId = h.eventId();
    const res = await h.postWebhook(h.connectionId, createdEvent(eventId, ext), { tamper: true });
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe("invalid_signature");

    expect(await h.getSubscription(ext)).toBeNull();
    expect(await h.countEventRows(eventId)).toBe(0);
  });

  it("rejects a STALE signed timestamp with 400 stale_timestamp and no state change", async () => {
    const ext = "sub_verify_stale";
    const eventId = h.eventId();
    const stale = Math.floor(Date.now() / 1000) - 100_000; // far outside the ~5m tolerance
    const res = await h.postWebhook(h.connectionId, createdEvent(eventId, ext), { tsUnix: stale });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("stale_timestamp");

    expect(await h.getSubscription(ext)).toBeNull();
    expect(await h.countEventRows(eventId)).toBe(0);
  });

  it("rejects a FUTURE-skewed signed timestamp with 400 stale_timestamp and no state change", async () => {
    const ext = "sub_verify_future";
    const eventId = h.eventId();
    const future = Math.floor(Date.now() / 1000) + 100_000; // far outside tolerance in the future direction
    const res = await h.postWebhook(h.connectionId, createdEvent(eventId, ext), { tsUnix: future });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("stale_timestamp");

    expect(await h.getSubscription(ext)).toBeNull();
    expect(await h.countEventRows(eventId)).toBe(0);
  });
});
