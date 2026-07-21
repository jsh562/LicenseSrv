// Canonical billing event model + provider-adapter contract + the event->action mapper + the stale-event
// recency guard (FR-004/016; AD-005/007). Per-provider parsing lives behind the `ProviderAdapter` seam
// (adapters/*.ts) and normalizes each provider into ONE internal `CanonicalEvent`, so core lifecycle logic
// never sees a provider quirk. `mapEventToAction` maps the canonical type to a lifecycle action; the
// stale-event guard ignores any event whose `occurredAt` is not newer than the subscription's
// `lastAppliedEventAt` so out-of-order delivery cannot regress state. `payload_summary` is a CLOSED,
// deny-by-default allow-list (NO card/PAN/PII, FR-018/021).
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
];
/**
 * Build a `payload_summary` from arbitrary adapter-extracted fields, enforcing the closed allow-list: only
 * `PAYLOAD_SUMMARY_KEYS` survive, and only when scalar (string/number) — a nested object (which could carry
 * card/PAN/PII) is dropped. The testable invariant is that no field outside the allow-list ever reaches the
 * ledger (FR-018/021).
 */
export function buildPayloadSummary(fields) {
    const out = {};
    for (const key of PAYLOAD_SUMMARY_KEYS) {
        const value = fields[key];
        if (value == null)
            continue;
        if (typeof value === "string" || typeof value === "number")
            out[key] = value;
    }
    return out;
}
/**
 * Map a canonical event type to its lifecycle action (FR-004..010). Pure lookup -- no DB access. `renew` is
 * refined to extend-vs-recover by the lifecycle against the current `billing_state`; `unknown` -> `ignore`
 * (dead-letter, never an error).
 */
export function mapEventToAction(event) {
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
export function isStaleEvent(occurredAtUnix, lastAppliedEventAt) {
    if (lastAppliedEventAt == null)
        return false;
    const anchorUnix = lastAppliedEventAt instanceof Date ? Math.floor(lastAppliedEventAt.getTime() / 1000) : lastAppliedEventAt;
    return occurredAtUnix <= anchorUnix;
}
