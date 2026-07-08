import type { FastifyInstance } from "fastify";

import type { AppDeps } from "../app.js";
import { registerAdmin } from "./admin/index.js";
import { registerCatalog } from "./catalog/index.js";
import { registerSigning } from "./signing/index.js";

/**
 * A feature module plugs into the modular monolith here (ADR-0005, TR-010). The reserved
 * seams are for the feature epics — E004 signing, E005 admin, E007 catalog, E008 issuance,
 * E009 activation — each registering without any other module importing it. A build-failing
 * dependency-boundary lint rule (see eslint config) keeps cross-module imports out.
 */
export type ServerModule = (app: FastifyInstance, deps: AppDeps) => void;

const MODULES: ServerModule[] = [
  registerSigning, // E004 — signing service & key custody
  registerAdmin, // E005 — tenant administration & audit (human session console)
  registerCatalog, // E007 — no-code licensing catalog (products/plans/entitlements)
];

export function registerModules(app: FastifyInstance, deps: AppDeps): void {
  for (const register of MODULES) register(app, deps);
}
