// Provider-adapter registry (FR-004; AD-005). Resolves a connection's `provider` to its adapter. Stripe has
// a dedicated adapter; `generic` and `paddle` share the provider-agnostic Stripe-style adapter (each bound
// to its own signature header). Core lifecycle logic only ever sees the resulting `CanonicalEvent`.
import type { Provider, ProviderAdapter } from "../events.js";
import { genericAdapter, makeGenericAdapter } from "./generic.js";
import { stripeAdapter } from "./stripe.js";

export const ADAPTERS: Record<Provider, ProviderAdapter> = {
  stripe: stripeAdapter,
  paddle: makeGenericAdapter("paddle", "paddle-signature"),
  generic: genericAdapter,
};

/** Resolve the adapter for a provider (falls back to the generic adapter for an unrecognized value). */
export function getAdapter(provider: Provider): ProviderAdapter {
  return ADAPTERS[provider] ?? genericAdapter;
}

export { genericAdapter, makeGenericAdapter } from "./generic.js";
export { stripeAdapter } from "./stripe.js";
