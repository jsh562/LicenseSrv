// T010 (FR-004/016/018): canonical event model + mapper + stale-event guard + adapter normalization unit
// tests. Asserts each canonical type maps to its lifecycle action, the recency guard ignores non-newer
// events, and adapter normalization extracts ONLY allow-listed metadata (NO card/PAN) from a provider body.
import { describe, expect, it } from "vitest";

import { getAdapter } from "../adapters/index.js";
import { stripeAdapter } from "../adapters/stripe.js";
import {
  type BillingAction,
  buildPayloadSummary,
  type CanonicalEvent,
  type CanonicalEventType,
  isStaleEvent,
  mapEventToAction,
  PAYLOAD_SUMMARY_KEYS,
} from "../events.js";

function ev(type: CanonicalEventType): CanonicalEvent {
  return {
    provider: "stripe",
    providerEventId: "evt_x",
    type,
    externalSubscriptionId: "sub_1",
    planKey: "price_1",
    occurredAt: 1_000,
    payloadSummary: {},
  };
}

describe("mapEventToAction (FR-004..010)", () => {
  const cases: [CanonicalEventType, BillingAction][] = [
    ["subscription.created", "provision"],
    ["subscription.renewed", "renew"],
    ["subscription.payment_failed", "past_due"],
    ["subscription.canceled", "cancel"],
    ["subscription.refunded", "revoke"],
    ["unknown", "ignore"],
  ];
  for (const [type, action] of cases) {
    it(`maps ${type} -> ${action}`, () => {
      expect(mapEventToAction(ev(type))).toBe(action);
    });
  }
});

describe("isStaleEvent (FR-016 recency guard)", () => {
  it("is not stale when no event has been applied yet (null anchor)", () => {
    expect(isStaleEvent(1_000, null)).toBe(false);
  });
  it("is stale when occurredAt is not strictly newer than the anchor", () => {
    expect(isStaleEvent(1_000, 1_000)).toBe(true); // equal -> stale (<=)
    expect(isStaleEvent(999, 1_000)).toBe(true);
  });
  it("is not stale when occurredAt is strictly newer", () => {
    expect(isStaleEvent(1_001, 1_000)).toBe(false);
  });
  it("accepts a Date anchor", () => {
    const anchor = new Date(1_000_000);
    expect(isStaleEvent(1_000, anchor)).toBe(true);
    expect(isStaleEvent(1_001, anchor)).toBe(false);
  });
});

describe("buildPayloadSummary (FR-018 closed allow-list)", () => {
  it("keeps only allow-listed scalar fields and drops everything else", () => {
    const summary = buildPayloadSummary({
      type: "subscription.canceled",
      planKey: "price_1",
      subscriptionStatus: "canceled",
      externalSubscriptionId: "sub_1",
      occurredAt: 1_000,
      // NONE of the following may survive:
      card: { number: "4242424242424242", cvc: "123" },
      pan: "4242424242424242",
      email: "user@example.com",
      nested: { anything: true },
    } as Record<string, unknown>);
    expect(Object.keys(summary).sort()).toEqual(
      ["externalSubscriptionId", "occurredAt", "planKey", "subscriptionStatus", "type"].sort(),
    );
    for (const key of Object.keys(summary)) expect(PAYLOAD_SUMMARY_KEYS).toContain(key);
  });

  it("drops a non-scalar value even on an allow-listed key", () => {
    const summary = buildPayloadSummary({ planKey: { id: "price_1" } } as Record<string, unknown>);
    expect(summary.planKey).toBeUndefined();
  });
});

describe("stripe adapter normalization (FR-004/018)", () => {
  it("normalizes a subscription.deleted event to canonical subscription.canceled with sub id + plan key", () => {
    const raw = Buffer.from(
      JSON.stringify({
        id: "evt_cancel",
        type: "customer.subscription.deleted",
        created: 1_752_829_200,
        data: { object: { id: "sub_1", object: "subscription", status: "canceled", plan: { id: "price_1Pro" } } },
      }),
    );
    const canonical = stripeAdapter.normalize(raw);
    expect(canonical).not.toBeNull();
    expect(canonical).toMatchObject({
      provider: "stripe",
      providerEventId: "evt_cancel",
      type: "subscription.canceled",
      externalSubscriptionId: "sub_1",
      planKey: "price_1Pro",
      occurredAt: 1_752_829_200,
    });
  });

  it("resolves the subscription id from an invoice.paid event and maps to subscription.renewed", () => {
    const raw = Buffer.from(
      JSON.stringify({
        id: "evt_paid",
        type: "invoice.paid",
        created: 1_752_829_800,
        data: { object: { id: "in_1", object: "invoice", subscription: "sub_1", status: "paid" } },
      }),
    );
    const canonical = stripeAdapter.normalize(raw);
    expect(canonical).toMatchObject({ type: "subscription.renewed", externalSubscriptionId: "sub_1" });
  });

  it("NEVER lets card/PAN data into the payload_summary (FR-018)", () => {
    const raw = Buffer.from(
      JSON.stringify({
        id: "evt_card",
        type: "customer.subscription.created",
        created: 1_752_829_200,
        data: {
          object: {
            id: "sub_1",
            object: "subscription",
            status: "active",
            plan: { id: "price_1Pro" },
            // hostile / sensitive fields the adapter must NOT persist:
            card: { number: "4242424242424242", cvc: "123", exp_month: 12 },
            default_payment_method: { card: { last4: "4242" } },
            customer_email: "user@example.com",
          },
        },
      }),
    );
    const canonical = stripeAdapter.normalize(raw)!;
    const serialized = JSON.stringify(canonical.payloadSummary);
    expect(serialized).not.toContain("4242");
    expect(serialized).not.toContain("cvc");
    expect(serialized).not.toContain("user@example.com");
    for (const key of Object.keys(canonical.payloadSummary)) expect(PAYLOAD_SUMMARY_KEYS).toContain(key);
  });

  it("returns null for an unparseable body", () => {
    expect(stripeAdapter.normalize(Buffer.from("not json"))).toBeNull();
  });

  it("maps an unhandled type to canonical 'unknown' (-> dead-letter downstream)", () => {
    const raw = Buffer.from(JSON.stringify({ id: "evt_u", type: "customer.updated", created: 1_000, data: { object: {} } }));
    expect(stripeAdapter.normalize(raw)?.type).toBe("unknown");
  });
});

describe("adapter registry + generic adapter", () => {
  it("resolves the stripe adapter and a generic adapter", () => {
    expect(getAdapter("stripe").provider).toBe("stripe");
    expect(getAdapter("generic").provider).toBe("generic");
    expect(getAdapter("paddle").signatureHeaderName).toBe("paddle-signature");
  });

  it("generic adapter passes a canonical type through and extracts fields", () => {
    const raw = Buffer.from(
      JSON.stringify({
        id: "evt_g",
        type: "subscription.canceled",
        created: 2_000,
        data: { object: { id: "sub_g", object: "subscription", status: "canceled", plan: "plan_g" } },
      }),
    );
    const canonical = getAdapter("generic").normalize(raw);
    expect(canonical).toMatchObject({
      provider: "generic",
      type: "subscription.canceled",
      externalSubscriptionId: "sub_g",
      planKey: "plan_g",
    });
  });
});
