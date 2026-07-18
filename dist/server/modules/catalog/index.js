import { registerCatalogRoutes } from "./routes.js";
/** Max rows a catalog list endpoint returns — the catalog is small; pagination is unwarranted (AD-009). */
export const DEFAULT_LIST_CAP = 1000;
/** Read catalog config from the environment (only the list cap today). */
export function loadCatalogConfig(env = process.env) {
    const raw = Number(env.CATALOG_LIST_CAP);
    return { listCap: Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_LIST_CAP };
}
/** The module's registration seam. Wires the /admin/catalog routes under the shared console session auth. */
export function registerCatalog(app, deps) {
    registerCatalogRoutes(app, deps.pool, { listCap: loadCatalogConfig().listCap });
}
