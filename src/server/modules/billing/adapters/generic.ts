// Generic provider adapter (FR-004). The provider-agnostic adapter for a Stripe-style HMAC webhook: it
// accepts a body whose `type` is ALREADY a canonical type (or a small set of synonyms) and normalizes it,
// so a self-hosted / bespoke provider can integrate without a dedicated adapter. Built via a factory so the
// same logic backs the `generic` and `paddle` connections (each with its own provider + signature header).
import { type CanonicalEventType, type Provider, type ProviderAdapter } from "../events.js";
import { asString, buildCanonicalEvent, parseEnvelope } from "./shared.js";

const CANONICAL_TYPES = new Set<CanonicalEventType>([
  "subscription.created",
  "subscription.renewed",
  "subscription.payment_failed",
  "subscription.canceled",
  "subscription.refunded",
]);

/**
 * Map a generic event type to the canonical vocabulary: pass a canonical type through unchanged; else map a
 * small synonym set (and the ambiguous `subscription.updated` by status). Unrecognized → `unknown`.
 */
export function mapGenericType(type: string, status: string | null): CanonicalEventType {
  if (CANONICAL_TYPES.has(type as CanonicalEventType)) return type as CanonicalEventType;
  switch (type) {
    case "subscription_created":
      return "subscription.created";
    case "subscription_renewed":
    case "payment_succeeded":
    case "invoice_paid":
      return "subscription.renewed";
    case "payment_failed":
      return "subscription.payment_failed";
    case "subscription_canceled":
    case "subscription_deleted":
      return "subscription.canceled";
    case "refund":
    case "chargeback":
      return "subscription.refunded";
    case "subscription.updated":
    case "subscription_updated":
      if (status === "canceled") return "subscription.canceled";
      if (status === "past_due" || status === "unpaid") return "subscription.payment_failed";
      if (status === "active") return "subscription.renewed";
      return "unknown";
    default:
      return "unknown";
  }
}

/** Build a generic Stripe-style adapter bound to a specific provider + signature header. */
export function makeGenericAdapter(provider: Provider, signatureHeaderName: string): ProviderAdapter {
  return {
    provider,
    signatureHeaderName,
    normalize(rawBody) {
      const envelope = parseEnvelope(rawBody);
      if (!envelope) return null;
      const status = asString(envelope.object.status);
      return buildCanonicalEvent(provider, envelope, mapGenericType(envelope.type, status));
    },
  };
}

export const genericAdapter: ProviderAdapter = makeGenericAdapter("generic", "webhook-signature");
