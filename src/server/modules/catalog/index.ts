// Catalog module wiring (E007, ADR-0005). Registers the no-code catalog REST surface at the module seam.
// The catalog persists through the E002 tenant repository (forced RLS) and gates every route through the
// shared console RBAC (viewer read / admin write). Lists are bounded, not paginated (AD-009).
import type { FastifyInstance } from "fastify";

import type { AppDeps } from "../../app.js";
import { registerCatalogRoutes } from "./routes.js";

/** Max rows a catalog list endpoint returns — the catalog is small; pagination is unwarranted (AD-009). */
export const DEFAULT_LIST_CAP = 1000;

/** E017 absolute per-entitlement authored-max ceiling default (FR-021) — mirrors the config schema default. */
export const DEFAULT_POLICY_ABSOLUTE_MAX_LIMIT = 1_000_000_000;

export interface CatalogConfig {
  listCap: number;
  policyAbsoluteMaxLimit: number;
}

/** Read catalog config from the environment (the list cap + the E017 absolute authored-max cap, FR-021). */
export function loadCatalogConfig(env: NodeJS.ProcessEnv = process.env): CatalogConfig {
  const raw = Number(env.CATALOG_LIST_CAP);
  const absMax = Number(env.POLICY_ABSOLUTE_MAX_LIMIT);
  return {
    listCap: Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_LIST_CAP,
    policyAbsoluteMaxLimit: Number.isFinite(absMax) && absMax > 0 ? absMax : DEFAULT_POLICY_ABSOLUTE_MAX_LIMIT,
  };
}

/** The module's registration seam. Wires the /admin/catalog routes under the shared console session auth. */
export function registerCatalog(app: FastifyInstance, deps: AppDeps): void {
  const catalogConfig = loadCatalogConfig();
  // Prefer the validated runtime AppConfig's absolute authored-max cap when present (production); fall back to
  // the env/default read above so config-less callers (integration tests) still get a sane ceiling (FR-021).
  const policyAbsoluteMaxLimit = deps.config?.policyAbsoluteMaxLimit ?? catalogConfig.policyAbsoluteMaxLimit;
  registerCatalogRoutes(app, deps.pool, { listCap: catalogConfig.listCap, policyAbsoluteMaxLimit });
}
