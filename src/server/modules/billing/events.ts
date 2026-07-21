// Canonical billing event model + provider-adapter contract + the event->action mapper + the stale-event
// recency guard (FR-004/016; AD-005/007). Per-provider parsing lives behind the `ProviderAdapter` seam
// (adapters/*.ts) and normalizes each provider into ONE internal `CanonicalEvent`, so core lifecycle logic
// never sees a provider quirk. `mapEventToAction` maps the canonical type to a lifecycle action; the
// stale-event guard ignores any event whose `occurredAt` is not newer than the subscription's
// `lastAppliedEventAt` so out-of-order delivery cannot regress state. `payload_summary` is a CLOSED,
// deny-by-default allow-list (NO card/PAN/PII, FR-018/021).

/** The billing provider / adapter discriminator (data-model `billing_connection.provider`; FR-004). */
export type Provider = "stripe" | "paddle" | "generic";

/**
 * The internal canonical event vocabulary (adapter output). Provider-specific type strings map onto exactly
 * one of these; anything unmapped normalizes to `unknown` (-> dead-letter). Aligns to the §6 state machine.
 */
export type CanonicalEventType =
  | "subscription.created" // provision (issue + link)
  | "subscription.renewed" // renewal / invoice-paid / reactivation -> extend (or recover if not active)
  | "subscription.payment_failed" // payment failure -> past_due grace overlay (license stays active)
  | "subscription.canceled" // cancellation -> grace overlay (license stays active)
  | "subscription.refunded" // refund / chargeback -> revoke (terminal)
  | "unknown"; // unhandled type -> dead-letter

/**
 * The lifecycle ACTION a canonical event maps to. `renew` is deliberately state-dependent and refined by
 * the lifecycle (extend when the subscription is active; recover/reinstate when it is past_due/grace/
 * canceled); the mapper is a pure type->action lookup with no DB access. `ignore` -> dead-letter.
 */
export type BillingAction =
  | "provision" // FR-005 issue via E008 + 1:1 link
  | "renew" // FR-006/009 extend, or recover (reinstate + clear grace) when not active
  | "past_due" // FR-007 payment failed -> past_due overlay + grace_expires_at
  | "cancel" // FR-007 cancellation -> grace overlay + grace_expires_at
  | "revoke" // FR-010 refund/chargeback -> E008 revoke (terminal)
  | "ignore"; // unhandled -> dead-letter (never an error)

/**
 * The CLOSED, deny-by-default allow-list of fields that may ever reach the `billing_event.payload_summary`
 * ledger column (data-model §11 inv.7). ANY field outside this exhaustive set is dropped before persistence
 * on BOTH the webhook and reconciliation ingest paths — no card/PAN/CVV/expiry/PII (FR-018/021).
 */
export const PAYLOAD_SUMMARY_KEYS = [
  "type", // canonical event type
  "planKey", // provider plan/price key
  "subscriptionStatus", // provider subscription/billing status flag
  "paymentStatus", // invoice payment-status flag
  "externalSubscriptionId", // provider subscription id
  "occurredAt", // provider event timestamp
] as const;

export type PayloadSummaryKey = (typeof PAYLOAD_SUMMARY_KEYS)[number];

/** The minimized, allow-listed event summary persisted to the ledger. Scalars only (no nested objects). */
export type PayloadSummary = Partial<Record<PayloadSummaryKey, string | number>>;

/**
 * Build a `payload_summary` from arbitrary adapter-extracted fields, enforcing the closed allow-list: only
 * `PAYLOAD_SUMMARY_KEYS` survive, and only when scalar (string/number) — a nested object (which could carry
 * card/PAN/PII) is dropped. The testable invariant is that no field outside the allow-list ever reaches the
 * ledger (FR-018/021).
 */
export function buildPayloadSummary(fields: Record<string, unknown>): PayloadSummary {
  const out: PayloadSummary = {};
  for (const key of PAYLOAD_SUMMARY_KEYS) {
    const value = fields[key];
    if (value == null) continue;
    if (typeof value === "string" || typeof value === "number") out[key] = value;
  }
  return out;
}

/** The internal canonical event -- the ONLY shape core lifecycle logic sees (provider quirks stay in the adapter). */
export interface CanonicalEvent {
  provider: Provider;
  /** The provider event id -- the idempotency dedup key (FR-003). */
  providerEventId: string;
  /** The canonical (normalized) event type (FR-004). */
  type: CanonicalEventType;
  /** The provider subscription id the event resolves to; null when the payload carries none. */
  externalSubscriptionId: string | null;
  /** The provider plan/price key (drives provisioning + per-plan grace); null when absent. */
  planKey: string | null;
  /**
   * The provider customer id — a PSEUDONYMOUS reference (e.g. Stripe `cus_…`), NOT card/PAN/PII. Used ONLY
   * to resolve/create the pseudonymous E008 `customer.ref` a provisioned license is issued under (FR-005;
   * the pseudonymous customer reference is explicitly OUTSIDE the FR-018 card-data ban). Null when absent.
   */
  externalCustomerId?: string | null;
  /**
   * The provider subscription's current period end (epoch SECONDS), when the event carries one (e.g. Stripe
   * `current_period_end`). Drives the renewal term extension (FR-006 — `extend term`): a renewal/invoice-paid
   * event pushes the linked license `expires_at` forward to this value. Null/absent when the event carries no
   * period end (a perpetual license's term is left unchanged). Non-sensitive; NOT persisted in the ledger.
   */
  periodEndUnix?: number | null;
  /** The provider event timestamp (epoch SECONDS); ordering + recency guard (FR-016). */
  occurredAt: number;
  /** The minimized, allow-listed metadata to persist -- NEVER card/PAN/PII (FR-018/021). */
  payloadSummary: PayloadSummary;
}

/**
 * A thin per-provider adapter (FR-004). Owns the provider signature header name and normalizes a RAW webhook
 * body into ONE `CanonicalEvent` (or null when the body is malformed / carries no usable event id). The raw
 * body is the exact bytes the signature was verified over; the adapter JSON-parses internally.
 */
export interface ProviderAdapter {
  readonly provider: Provider;
  /** The lowercased header carrying the provider signature (e.g. "stripe-signature"). */
  readonly signatureHeaderName: string;
  /** Normalize the RAW verified body into a canonical event, or null when unparseable / id-less. */
  normalize(rawBody: Buffer): CanonicalEvent | null;
}

/**
 * Map a canonical event type to its lifecycle action (FR-004..010). Pure lookup -- no DB access. `renew` is
 * refined to extend-vs-recover by the lifecycle against the current `billing_state`; `unknown` -> `ignore`
 * (dead-letter, never an error).
 */
export function mapEventToAction(event: CanonicalEvent): BillingAction {
  switch (event.type) {
    case "subscription.created":
      return "provision";
    case "subscription.renewed":
      return "renew";
    case "subscription.payment_failed":
      return "past_due";
    case "subscription.canceled":
      return "cancel";
    case "subscription.refunded":
      return "revoke";
    default:
      return "ignore";
  }
}

/**
 * The stale/out-of-order recency guard (FR-016; AD-007). An event is STALE (must be ignored, recorded
 * `outcome='rejected', reason='stale_event'`) when its `occurredAt` is NOT strictly newer than the
 * subscription's `lastAppliedEventAt`. A null anchor (no event applied yet) is never stale. Accepts the
 * anchor as epoch seconds or a Date.
 */
export function isStaleEvent(occurredAtUnix: number, lastAppliedEventAt: number | Date | null | undefined): boolean {
  if (lastAppliedEventAt == null) return false;
  const anchorUnix =
    lastAppliedEventAt instanceof Date ? Math.floor(lastAppliedEventAt.getTime() / 1000) : lastAppliedEventAt;
  return occurredAtUnix <= anchorUnix;
}
