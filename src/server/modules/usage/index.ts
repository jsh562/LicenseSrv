// Usage-metering module wiring (E016, ADR-0013, AD-009). Reserves the metering seam BESIDE billing (E014) /
// lease (E015) — a DISTINCT high-write ingest + async-aggregation concern, so no existing module is touched
// (only the E007 catalog gains the metered entitlement KIND, in its own module). Composes + publishes the
// usage deps: the RLS pool, the live usage config, the shared tenant-scoped {@link UsageRepo} (the idempotent
// batch append + watermark rollup/unique-value upsert + reads), and the E007 entitlement read (re-resolved
// per event within the caller's tenant, FR-006/017). registerUsage runs AFTER registerLease. The runtime
// POST /v1/usage ingest route, the admin aggregate-query route, and the fail-open rollup + retention workers
// layer onto this same seam in the US phases; the foundational blocks (config, dimension-schema, usage-repo)
// are composed here.
import type { FastifyInstance } from "fastify";
import type pg from "pg";

import type { AppDeps } from "../../app.js";
import { getEntitlement } from "../catalog/entitlements.js";
import { type UsageConfig, loadUsageConfig } from "./config.js";
import { registerUsageRoutes } from "./routes.js";
import { UsageRepo } from "./usage-repo.js";

/**
 * A typed usage error carrying the HTTP status + machine code the routes surface as `{code,message,details?}`
 * (mirrors `BillingError`/`LeaseError`). The stable snake_case codes match the usage OpenAPI contract's
 * WHOLE-REQUEST vocabulary: `batch_too_large` (400), `validation_error` (400), `window_too_large` (400),
 * `unauthorized` (401), `forbidden` (403), `not_found` (404), `rate_limited` (429). NOTE: the PER-EVENT
 * rejection codes (`not_found`/`not_metered`/`archived`/`license_inactive`/`stale_event`/`future_event`/
 * `validation_error`) are a SEPARATE, non-HTTP vocabulary reported inside the 200/202 batch summary — a
 * single bad event never fails the batch (AD-008), so they are NOT thrown as a UsageError.
 */
export class UsageError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "UsageError";
  }
}

/** A read-only view of an E007 entitlement (the metered target of an ingest event) within the caller's tenant. */
export type EntitlementRead = typeof getEntitlement;

/**
 * The composed usage dependencies (the seam the routes/workers consume): the RLS pool, the live usage config
 * (retention/skew/bucket/interval/rate-limit/cap), the shared {@link UsageRepo}, and the E007 entitlement
 * read (injected so a test can stub it; the default reads the shared `entitlement` table under RLS — a schema
 * read, NOT a cross-module internal import, so the module-boundary lint is satisfied).
 */
export interface UsageDeps {
  pool: pg.Pool;
  config: UsageConfig;
  repo: UsageRepo;
  entitlementRead: EntitlementRead;
}

declare module "fastify" {
  interface FastifyInstance {
    /** The composed usage seam (published by registerUsage; consumed by the US-phase routes/workers). */
    usage?: UsageDeps;
  }
}

/**
 * Compose the usage dependencies from the app + AppDeps: the config is resolved LIVE (the same env keys the
 * central AppConfig validates at boot), a fresh {@link UsageRepo} is the shared append/rollup accountant, and
 * `getEntitlement` is the E007 read used to re-resolve each event's metered target within the caller's tenant.
 */
export function buildUsageDeps(_app: FastifyInstance, deps: AppDeps): UsageDeps {
  return {
    pool: deps.pool,
    config: loadUsageConfig(),
    repo: new UsageRepo(),
    entitlementRead: getEntitlement,
  };
}

/**
 * The module's registration seam (ADR-0005/AD-009). Composes + publishes the usage deps on `app.usage`, then
 * registers the runtime POST /v1/usage ingest plane (US1, `usage.ingest` scope + per-key rate limit). The
 * admin aggregate-query route (US2) and the fail-open rollup + retention workers (US2/US6) layer onto this
 * same seam in the later phases, each reading `app.usage`.
 */
export function registerUsage(app: FastifyInstance, deps: AppDeps): void {
  const usage = buildUsageDeps(app, deps);
  app.decorate("usage", usage);
  registerUsageRoutes(app, usage, deps.apiKeySecret);
}
