import { genericAdapter, makeGenericAdapter } from "./generic.js";
import { stripeAdapter } from "./stripe.js";
export const ADAPTERS = {
    stripe: stripeAdapter,
    paddle: makeGenericAdapter("paddle", "paddle-signature"),
    generic: genericAdapter,
};
/** Resolve the adapter for a provider (falls back to the generic adapter for an unrecognized value). */
export function getAdapter(provider) {
    return ADAPTERS[provider] ?? genericAdapter;
}
export { genericAdapter, makeGenericAdapter } from "./generic.js";
export { stripeAdapter } from "./stripe.js";
