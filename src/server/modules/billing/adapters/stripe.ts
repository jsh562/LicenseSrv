// Stripe provider adapter (FR-004). Maps Stripe event types onto the internal canonical vocabulary and
// normalizes the payload into a `CanonicalEvent`, isolating Stripe quirks from core lifecycle logic. The
// signature scheme is the Stripe `t=…,v1=…` header (verified over the raw body by `signature.ts`).
import type { CanonicalEventType, ProviderAdapter } from "../events.js";
import { asString, buildCanonicalEvent, parseEnvelope } from "./shared.js";

/**
 * Map a Stripe event type (+ subscription status for the ambiguous `customer.subscription.updated`) to the
 * canonical type. Cancel/non-payment map to recoverable states (canceled/past_due); only a refund/dispute
 * maps to the terminal `subscription.refunded`. Anything unrecognized → `unknown` (dead-letter).
 */
export function mapStripeType(type: string, status: string | null): CanonicalEventType {
  switch (type) {
    case "customer.subscription.created":
      return "subscription.created";
    case "customer.subscription.deleted":
      return "subscription.canceled";
    case "invoice.paid":
    case "invoice.payment_succeeded":
      return "subscription.renewed";
    case "invoice.payment_failed":
      return "subscription.payment_failed";
    case "charge.refunded":
    case "charge.dispute.created":
      return "subscription.refunded";
    case "customer.subscription.updated":
      if (status === "canceled") return "subscription.canceled";
      if (status === "past_due" || status === "unpaid") return "subscription.payment_failed";
      if (status === "active" || status === "trialing") return "subscription.renewed";
      return "unknown";
    default:
      return "unknown";
  }
}

export const stripeAdapter: ProviderAdapter = {
  provider: "stripe",
  signatureHeaderName: "stripe-signature",
  normalize(rawBody) {
    const envelope = parseEnvelope(rawBody);
    if (!envelope) return null;
    const status = asString(envelope.object.status);
    return buildCanonicalEvent("stripe", envelope, mapStripeType(envelope.type, status));
  },
};
