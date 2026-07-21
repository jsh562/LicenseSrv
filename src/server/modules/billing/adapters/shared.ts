// Shared adapter helpers (FR-004/018). Parses the common Stripe-style provider envelope and extracts ONLY
// the allow-listed, non-sensitive billing-lifecycle fields into a `CanonicalEvent` + minimized
// `payload_summary` (deny-by-default via `buildPayloadSummary`). NO card/PAN/CVV/expiry/PII is ever read
// into the canonical model or the ledger -- unknown/unlisted fields are dropped at the edge.
import { buildPayloadSummary, type CanonicalEvent, type CanonicalEventType, type Provider } from "../events.js";

/** A normalized provider envelope: the event id + type + timestamp + the primary object (`data.object`). */
export interface RawEnvelope {
  id: string;
  type: string;
  created: number; // epoch seconds
  object: Record<string, unknown>;
}

/** A non-empty string, or null. */
export function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** A finite number (accepts a numeric string), or null. */
export function asNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * Parse a Stripe-style envelope `{ id, type, created, data: { object } }` from the RAW body. Returns null
 * when the body is not JSON, or lacks a usable event id / type / timestamp (the ledger requires them).
 */
export function parseEnvelope(rawBody: Buffer): RawEnvelope | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString("utf8"));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const p = parsed as Record<string, unknown>;
  const id = asString(p.id);
  const type = asString(p.type);
  const created = asNumber(p.created);
  if (!id || !type || created == null) return null;
  const data = p.data;
  let object: Record<string, unknown> = {};
  if (typeof data === "object" && data !== null) {
    const inner = (data as Record<string, unknown>).object;
    if (typeof inner === "object" && inner !== null) object = inner as Record<string, unknown>;
  }
  return { id, type, created: Math.floor(created), object };
}

/** Extract the provider subscription id from the primary object (subscription id, or invoice.subscription). */
export function extractSubscriptionId(object: Record<string, unknown>): string | null {
  const objectType = asString(object.object);
  if (objectType === "subscription") return asString(object.id);
  const sub = object.subscription;
  if (typeof sub === "string") return asString(sub);
  if (typeof sub === "object" && sub !== null) return asString((sub as Record<string, unknown>).id);
  return (
    asString(object.subscriptionId) ??
    asString(object.subscription_id) ??
    (objectType == null ? asString(object.id) : null)
  );
}

/** Extract the provider plan/price key (Stripe `plan.id` / `items.data[0].price.id`, or a generic `plan`/`price`). */
export function extractPlanKey(object: Record<string, unknown>): string | null {
  const plan = object.plan;
  if (typeof plan === "string") return asString(plan);
  if (typeof plan === "object" && plan !== null) {
    const id = asString((plan as Record<string, unknown>).id);
    if (id) return id;
  }
  const items = object.items;
  if (typeof items === "object" && items !== null) {
    const list = (items as Record<string, unknown>).data;
    if (Array.isArray(list) && list[0] && typeof list[0] === "object") {
      const price = (list[0] as Record<string, unknown>).price;
      if (typeof price === "string") return asString(price);
      if (typeof price === "object" && price !== null) {
        const id = asString((price as Record<string, unknown>).id);
        if (id) return id;
      }
    }
  }
  return asString(object.price) ?? asString(object.planKey) ?? asString(object.plan_id) ?? null;
}

/**
 * Extract the PSEUDONYMOUS provider customer id (Stripe `customer` scalar / object id, or a generic
 * `customerId`/`customer_id`). This is a pseudonymous reference (`cus_…`), NOT card/PAN/PII — it maps to the
 * E008 `customer.ref` a provisioned license is issued under (FR-005). Null when absent.
 */
export function extractCustomerId(object: Record<string, unknown>): string | null {
  const customer = object.customer;
  if (typeof customer === "string") return asString(customer);
  if (typeof customer === "object" && customer !== null) {
    const id = asString((customer as Record<string, unknown>).id);
    if (id) return id;
  }
  return asString(object.customerId) ?? asString(object.customer_id) ?? null;
}

/** Extract the subscription's current period end (epoch seconds) — Stripe `current_period_end` / a generic `period_end`. */
export function extractPeriodEnd(object: Record<string, unknown>): number | null {
  const raw =
    asNumber(object.current_period_end) ??
    asNumber(object.currentPeriodEnd) ??
    asNumber(object.period_end) ??
    asNumber(object.periodEnd);
  return raw == null ? null : Math.floor(raw);
}

/**
 * Build the canonical event from a parsed envelope + its resolved canonical type. Extracts ONLY the
 * allow-listed billing metadata into `payload_summary` (deny-by-default) -- never card/PAN/PII (FR-018). The
 * pseudonymous customer id + the period end are carried on the canonical event (for provisioning + renewal
 * term extension) but are NOT persisted in the minimized ledger `payload_summary`.
 */
export function buildCanonicalEvent(
  provider: Provider,
  envelope: RawEnvelope,
  canonicalType: CanonicalEventType,
): CanonicalEvent {
  const externalSubscriptionId = extractSubscriptionId(envelope.object);
  const planKey = extractPlanKey(envelope.object);
  const externalCustomerId = extractCustomerId(envelope.object);
  const periodEndUnix = extractPeriodEnd(envelope.object);
  const subscriptionStatus = asString(envelope.object.status);
  const paymentStatus =
    asString(envelope.object.paymentStatus) ?? asString(envelope.object.payment_status) ?? null;
  const payloadSummary = buildPayloadSummary({
    type: canonicalType,
    planKey: planKey ?? undefined,
    subscriptionStatus: subscriptionStatus ?? undefined,
    paymentStatus: paymentStatus ?? undefined,
    externalSubscriptionId: externalSubscriptionId ?? undefined,
    occurredAt: envelope.created,
  });
  return {
    provider,
    providerEventId: envelope.id,
    type: canonicalType,
    externalSubscriptionId,
    planKey,
    externalCustomerId,
    periodEndUnix,
    occurredAt: envelope.created,
    payloadSummary,
  };
}
