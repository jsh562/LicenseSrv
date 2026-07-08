// Catalog module wiring (E007, ADR-0005). Registers the no-code catalog REST surface at the module seam.
// The catalog persists through the E002 tenant repository (forced RLS) and gates every route through the
// shared console RBAC (viewer read / admin write). Lists are bounded, not paginated (AD-009).
import type { FastifyInstance } from "fastify";

import type { AppDeps } from "../../app.js";
import { registerCatalogRoutes } from "./routes.js";

/** Max rows a catalog list endpoint returns — the catalog is small; pagination is unwarranted (AD-009). */
export const DEFAULT_LIST_CAP = 1000;

export interface CatalogConfig {
  listCap: number;
}

/** Read catalog config from the environment (only the list cap today). */
export function loadCatalogConfig(env: NodeJS.ProcessEnv = process.env): CatalogConfig {
  const raw = Number(env.CATALOG_LIST_CAP);
  return { listCap: Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_LIST_CAP };
}

/** The module's registration seam. Wires the /admin/catalog routes under the shared console session auth. */
export function registerCatalog(app: FastifyInstance, deps: AppDeps): void {
  registerCatalogRoutes(app, deps.pool, { listCap: loadCatalogConfig().listCap });
}
