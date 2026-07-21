import { asString, buildCanonicalEvent, parseEnvelope } from "./shared.js";
/**
 * Map a Stripe event type (+ subscription status for the ambiguous `customer.subscription.updated`) to the
 * canonical type. Cancel/non-payment map to recoverable states (canceled/past_due); only a refund/dispute
 * maps to the terminal `subscription.refunded`. Anything unrecognized → `unknown` (dead-letter).
 */
export function mapStripeType(type, status) {
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
            if (status === "canceled")
                return "subscription.canceled";
            if (status === "past_due" || status === "unpaid")
                return "subscription.payment_failed";
            if (status === "active" || status === "trialing")
                return "subscription.renewed";
            return "unknown";
        default:
            return "unknown";
    }
}
export const stripeAdapter = {
    provider: "stripe",
    signatureHeaderName: "stripe-signature",
    normalize(rawBody) {
        const envelope = parseEnvelope(rawBody);
        if (!envelope)
            return null;
        const status = asString(envelope.object.status);
        return buildCanonicalEvent("stripe", envelope, mapStripeType(envelope.type, status));
    },
};
