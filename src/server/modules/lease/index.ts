// Lease module wiring (E015, ADR-0012, AD-008). Reserves the floating-seat concurrency seam BESIDE
// activation (E009) / enforcement (E013) / billing (E014) — a DISTINCT dimension from node-lock activation,
// so the E009 `max_activations` accounting stays untouched (module-boundary lint). Composes + publishes the
// lease deps: the RLS pool, the E004 signer (`app.signer`, for the domain-separated `LICSRV-LEASE-v1` handle;
// may be undefined -> a signed-handle acquire returns 503 fail-closed), the E007 effective-plan read, an
// E009 activation read (optional "activated-devices-only" gating, FR-025), and the live lease config.
// registerLease runs AFTER registerEnforcement/registerBilling so `app.signer` is published. The runtime
// acquire/renew/release routes, the admin registry/force-release routes, and the fail-open reclaim worker
// layer onto this seam in the US phases; the foundational blocks (config, holder-key, handle, lease-repo)
// are composed here.
import type { FastifyInstance } from "fastify";
import type pg from "pg";

import type { AppDeps } from "../../app.js";
import { withTenant } from "../../db/client.js";
import { getEffectivePlanDefinition } from "../catalog/effective.js";
import type { Signer } from "../signing/signer.js";
import { type LeaseConfig, loadLeaseConfig } from "./config.js";
import { LeaseRepo } from "./lease-repo.js";
import { registerLeaseRoutes } from "./routes.js";

/**
 * A typed lease error carrying the HTTP status + machine code the routes surface as `{code,message,details?}`
 * (mirrors `ActivationError`/`BillingError`/`EnforcementError`). The stable snake_case codes match the lease
 * OpenAPI contract: `no_concurrency_entitlement` (403), `license_not_active` (409), `seat_capacity_exhausted`
 * (409), `activation_required` (409), `lease_not_renewable` (409), `signer_unavailable` (503), etc.
 */
export class LeaseError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "LeaseError";
  }
}

/** A read-only view of an E009 node-lock activation for the optional "activated-devices-only" gating (FR-025). */
export interface ActivationRef {
  id: string;
  licenseId: string;
  status: "active" | "deactivated";
}

/**
 * Reads a CURRENT node-lock activation within the caller's tenant (FR-025 gating). A cross-tenant / unknown
 * id resolves to `null` (RLS). Injected as a dep so a test can stub it; the default reads the shared
 * `activation` table (a schema read, NOT a cross-module internal import — module-boundary lint safe).
 */
export type ActivationRead = (pool: pg.Pool, tenantId: string, activationId: string) => Promise<ActivationRef | null>;

/** The default {@link ActivationRead}: reads the `activation` table under RLS for the given tenant. */
export const defaultActivationRead: ActivationRead = (pool, tenantId, activationId) =>
  withTenant(pool, tenantId, async (q) => {
    const r = await q("SELECT id, license_id, status FROM activation WHERE id = $1", [activationId]);
    if (!r.rowCount) return null;
    const row = r.rows[0] as { id: string; license_id: string; status: "active" | "deactivated" };
    return { id: row.id, licenseId: row.license_id, status: row.status };
  });

/**
 * The composed lease dependencies (the seam the routes/worker consume): the RLS pool, the E004 signer
 * (provisioning; may be undefined -> a signed-handle acquire returns 503 fail-closed), the E007 effective-plan
 * read, the E009 activation read (optional gating), the race-safe {@link LeaseRepo}, and the live lease config.
 */
export interface LeaseDeps {
  pool: pg.Pool;
  signer?: Signer;
  effective: typeof getEffectivePlanDefinition;
  activationRead: ActivationRead;
  repo: LeaseRepo;
  config: LeaseConfig;
}

declare module "fastify" {
  interface FastifyInstance {
    /** The composed lease seam (published by registerLease; consumed by the US-phase routes/worker). */
    lease?: LeaseDeps;
  }
}

/**
 * Compose the lease dependencies from the app + AppDeps: `app.signer` is published by registerSigning (may be
 * undefined in a deployment not yet signing), `getEffectivePlanDefinition` is the E007 read, the config is
 * resolved LIVE (the same env keys the central AppConfig validates at boot), and a fresh {@link LeaseRepo} is
 * the shared race-safe accountant.
 */
export function buildLeaseDeps(app: FastifyInstance, deps: AppDeps): LeaseDeps {
  return {
    pool: deps.pool,
    signer: app.signer,
    effective: getEffectivePlanDefinition,
    activationRead: defaultActivationRead,
    repo: new LeaseRepo(),
    config: loadLeaseConfig(),
  };
}

/**
 * The module's registration seam (ADR-0005/AD-008). Composes + publishes the lease deps on `app.lease`. The
 * runtime acquire/renew/release routes (US1/US2), the admin registry/force-release routes (US5), and the
 * fail-open reclaim worker (US3) layer onto this same seam, each reading `app.lease`.
 */
export function registerLease(app: FastifyInstance, deps: AppDeps): void {
  const lease = buildLeaseDeps(app, deps);
  app.decorate("lease", lease);
  // Mount the /v1 runtime lease routes (acquire/renew/release) — API key + `lease` scope + rate limit (US1/US2).
  registerLeaseRoutes(app, lease, deps.apiKeySecret);
}
