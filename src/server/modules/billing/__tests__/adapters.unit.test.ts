// [US1] (FR-004/018): provider-adapter normalization + registry unit tests. Exercises the generic adapter's
// type-synonym map and the ambiguous `subscription.updated`-by-status branches, its field-extraction edge cases
// (absent customer / period / plan → null, unknown type → `unknown`), and the registry's provider selection
// including the unknown-provider fallback. Pure unit tests — no DB, no container.
import { describe, expect, it } from "vitest";

import { getAdapter, makeGenericAdapter } from "../adapters/index.js";
import { mapGenericType } from "../adapters/generic.js";
import type { CanonicalEventType, Provider } from "../events.js";

/** Build a Stripe-style raw body buffer from a partial `data.object`. */
function body(type: string, object: Record<string, unknown>, opts: { id?: string; created?: number } = {}): Buffer {
  return Buffer.from(
    JSON.stringify({ id: opts.id ?? "evt_1", type, created: opts.created ?? 1_752_000_000, data: { object } }),
  );
}

describe("mapGenericType (FR-004 synonym normalization)", () => {
  const canonical: CanonicalEventType[] = [
    "subscription.created",
    "subscription.renewed",
    "subscription.payment_failed",
    "subscription.canceled",
    "subscription.refunded",
  ];
  for (const t of canonical) {
    it(`passes the canonical type ${t} through unchanged`, () => {
      expect(mapGenericType(t, null)).toBe(t);
    });
  }

  const synonyms: [string, CanonicalEventType][] = [
    ["subscription_created", "subscription.created"],
    ["subscription_renewed", "subscription.renewed"],
    ["payment_succeeded", "subscription.renewed"],
    ["invoice_paid", "subscription.renewed"],
    ["payment_failed", "subscription.payment_failed"],
    ["subscription_canceled", "subscription.canceled"],
    ["subscription_deleted", "subscription.canceled"],
    ["refund", "subscription.refunded"],
    ["chargeback", "subscription.refunded"],
  ];
  for (const [raw, expected] of synonyms) {
    it(`maps the synonym ${raw} -> ${expected}`, () => {
      expect(mapGenericType(raw, null)).toBe(expected);
    });
  }

  it("resolves the ambiguous subscription.updated by status", () => {
    expect(mapGenericType("subscription.updated", "canceled")).toBe("subscription.canceled");
    expect(mapGenericType("subscription.updated", "past_due")).toBe("subscription.payment_failed");
    expect(mapGenericType("subscription.updated", "unpaid")).toBe("subscription.payment_failed");
    expect(mapGenericType("subscription.updated", "active")).toBe("subscription.renewed");
    expect(mapGenericType("subscription.updated", "incomplete")).toBe("unknown"); // unrecognized status
    expect(mapGenericType("subscription.updated", null)).toBe("unknown"); // no status to disambiguate
    // the snake_case spelling shares the same status-driven branch
    expect(mapGenericType("subscription_updated", "canceled")).toBe("subscription.canceled");
  });

  it("maps an unrecognized type to unknown (-> dead-letter)", () => {
    expect(mapGenericType("customer.updated", null)).toBe("unknown");
    expect(mapGenericType("", null)).toBe("unknown");
  });
});

describe("makeGenericAdapter normalization edge cases (FR-004/018)", () => {
  const adapter = makeGenericAdapter("paddle", "paddle-signature");

  it("carries the provider + signature header the factory was bound to", () => {
    expect(adapter.provider).toBe("paddle");
    expect(adapter.signatureHeaderName).toBe("paddle-signature");
  });

  it("returns null for an unparseable body", () => {
    expect(adapter.normalize(Buffer.from("not-json"))).toBeNull();
  });

  it("returns null when the envelope lacks a usable event id / type / timestamp", () => {
    expect(adapter.normalize(Buffer.from(JSON.stringify({ type: "subscription_created", created: 1, data: {} })))).toBeNull();
    expect(adapter.normalize(Buffer.from(JSON.stringify({ id: "evt", created: 1, data: {} })))).toBeNull();
    expect(adapter.normalize(Buffer.from(JSON.stringify({ id: "evt", type: "subscription_created", data: {} })))).toBeNull();
  });

  it("extracts sub id / plan key / customer / period end from a full subscription object", () => {
    const canonical = adapter.normalize(
      body("subscription_created", {
        id: "sub_9",
        object: "subscription",
        status: "active",
        plan: "plan_pro",
        customer: "cus_42",
        current_period_end: 1_800_000_000,
      }),
    );
    expect(canonical).toMatchObject({
      provider: "paddle",
      type: "subscription.created",
      externalSubscriptionId: "sub_9",
      planKey: "plan_pro",
      externalCustomerId: "cus_42",
      periodEndUnix: 1_800_000_000,
    });
  });

  it("leaves optional fields null when the object omits customer / period / plan", () => {
    const canonical = adapter.normalize(body("subscription_created", { id: "sub_min", object: "subscription", status: "active" }))!;
    expect(canonical.externalSubscriptionId).toBe("sub_min");
    expect(canonical.planKey).toBeNull();
    expect(canonical.externalCustomerId).toBeNull();
    expect(canonical.periodEndUnix).toBeNull();
  });

  it("resolves the sub id from an invoice object's `subscription` reference", () => {
    const canonical = adapter.normalize(body("invoice_paid", { id: "in_1", object: "invoice", subscription: "sub_inv" }))!;
    expect(canonical.type).toBe("subscription.renewed");
    expect(canonical.externalSubscriptionId).toBe("sub_inv");
  });

  it("normalizes an unknown type but still extracts the resolvable fields (-> dead-letter downstream)", () => {
    const canonical = adapter.normalize(body("wat.happened", { id: "sub_u", object: "subscription", status: "active" }))!;
    expect(canonical.type).toBe("unknown");
    expect(canonical.externalSubscriptionId).toBe("sub_u");
  });
});

describe("adapter registry provider selection (FR-004)", () => {
  it("resolves each configured provider to its adapter", () => {
    expect(getAdapter("stripe").provider).toBe("stripe");
    expect(getAdapter("paddle").provider).toBe("paddle");
    expect(getAdapter("paddle").signatureHeaderName).toBe("paddle-signature");
    expect(getAdapter("generic").provider).toBe("generic");
    expect(getAdapter("generic").signatureHeaderName).toBe("webhook-signature");
  });

  it("falls back to the generic adapter for an unknown provider value", () => {
    const adapter = getAdapter("nonesuch" as Provider);
    expect(adapter.provider).toBe("generic");
  });
});
