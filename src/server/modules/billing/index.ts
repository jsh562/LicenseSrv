// Billing module wiring (E014, ADR-0011). Reserves the billing-integration seam: the signature-verified
// webhook ingestion plane (verify -> dedupe -> apply), the subscription<->license grace overlay driving the
// E008 lifecycle, and the operator config surface. It DRIVES the E008 issuance/lifecycle services with a
// SYNTHETIC actor (the provider webhook / time-driven workers, not a human admin) and reuses the E004
// keystore custody to envelope-encrypt the inbound webhook HMAC secret (a DISTINCT secret class from the
// Ed25519 signing key). registerBilling runs AFTER registerEnforcement so app.signer + app.custody are
// published. The webhook + admin routes and the grace/reconcile workers layer onto this seam in the US
// phases; the foundational blocks (signature, events, ledger/connection/subscription repos, adapters) are
// composed here.
import type { FastifyInstance } from "fastify";
import type pg from "pg";

import type { AppDeps } from "../../app.js";
import { getEffectivePlanDefinition } from "../catalog/effective.js";
import type { Signer } from "../signing/signer.js";
import { type BillingConfig, loadBillingConfig } from "./config.js";
import { noopProviderFetch, type ProviderFetch } from "./reconcile-worker.js";
import { registerBillingRoutes } from "./routes.js";

/**
 * A typed billing error carrying the HTTP status + machine code the routes surface as `{code,message,
 * details?}` (mirrors `IssuanceError`/`EnforcementError`). NOTE: a billing NO-OP (duplicate/dead-letter/
 * stale) is NOT an error -- it is a `200` ack with an `outcome`. This class is only for genuine protocol
 * faults: `invalid_signature` (401), `stale_timestamp` (400), `connection_not_found` (404), etc.
 */
export class BillingError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "BillingError";
  }
}

/**
 * The minimal envelope-encryption capability the billing module needs from the E004 keystore custody to
 * store/recompute the inbound webhook HMAC secret. `Custody` (signing/custody.ts) satisfies it structurally
 * -- a generic AES-256-GCM wrap/unwrap over any Buffer; no new crypto (HINT-004).
 */
export interface SecretCustody {
  wrap(plaintext: Buffer): Buffer;
  unwrap(blob: Buffer): Buffer;
}

/**
 * The composed billing dependencies (the seam the routes/workers consume): the RLS pool, the E004 signer
 * (provisioning; may be undefined -> a provision returns 503 fail-closed), the E004 custody (webhook-secret
 * envelope encryption; may be undefined -> secret writes fail-closed), the E007 effective-plan read, and the
 * live billing config.
 */
export interface BillingDeps {
  pool: pg.Pool;
  signer?: Signer;
  custody?: SecretCustody;
  effective: typeof getEffectivePlanDefinition;
  config: BillingConfig;
  /**
   * The reconciliation provider-state fetch (US6/FR-017; AD-005/006). A real provider-API adapter in
   * production; the default {@link noopProviderFetch} when no live provider is wired (self-host default). The
   * reconcile route + worker read it live, so a test can inject a deterministic stub via `app.billing`.
   */
  providerFetch: ProviderFetch;
}

declare module "fastify" {
  interface FastifyInstance {
    /** The composed billing seam (published by registerBilling; consumed by the US-phase routes/workers). */
    billing?: BillingDeps;
  }
}

/**
 * Compose the billing dependencies from the app + AppDeps: `app.signer` / `app.custody` are published by
 * registerSigning (may be undefined in a deployment not yet signing), `getEffectivePlanDefinition` is the
 * E007 read, and the config is resolved LIVE (boot fail-fast on a bad env value via the central AppConfig).
 */
export function buildBillingDeps(app: FastifyInstance, deps: AppDeps): BillingDeps {
  return {
    pool: deps.pool,
    signer: app.signer,
    custody: app.custody,
    effective: getEffectivePlanDefinition,
    config: loadBillingConfig(),
    providerFetch: noopProviderFetch,
  };
}

/**
 * The module's registration seam (ADR-0005). Composes + publishes the billing deps, then registers the
 * webhook INGESTION plane (US1). The admin connection/registry/reconcile routes (US5/US6) and the grace/
 * reconcile workers (US3/US6) layer onto this same seam, each reading `app.billing`.
 */
export function registerBilling(app: FastifyInstance, deps: AppDeps): void {
  const billing = buildBillingDeps(app, deps);
  app.decorate("billing", billing);
  registerBillingRoutes(app, billing);
}
