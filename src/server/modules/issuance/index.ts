// Issuance module wiring (E008, ADR-0005). Registers the /admin licenses + customers REST at the module
// seam. Consumes E004's published Signer via `app.signer` (decorated by registerSigning, which runs
// earlier in the module list) and E007's effective read model. Never constructs a second signer.
import type { FastifyInstance } from "fastify";

import type { AppDeps } from "../../app.js";
import { registerIssuanceRoutes } from "./routes.js";

/** Default per-license transfer limit (FR-009, AD-006) — operator-configurable. */
export const DEFAULT_TRANSFER_LIMIT = 3;

export interface IssuanceConfig {
  transferLimit: number;
}

/** A typed issuance error carrying the HTTP status + machine code the routes surface as `{code,message}`. */
export class IssuanceError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "IssuanceError";
  }
}

/** Read issuance config from the environment (only the transfer limit today). */
export function loadIssuanceConfig(env: NodeJS.ProcessEnv = process.env): IssuanceConfig {
  const raw = Number(env.LICENSE_TRANSFER_LIMIT);
  return { transferLimit: Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_TRANSFER_LIMIT };
}

/** The module's registration seam. Wires the /admin issuance routes under the shared console session auth. */
export function registerIssuance(app: FastifyInstance, deps: AppDeps): void {
  registerIssuanceRoutes(app, deps.pool, {
    config: loadIssuanceConfig(),
    // The signer is published by registerSigning (E004). May be undefined if signing isn't registered;
    // the issue route then returns 503 signer_unavailable.
    signer: app.signer,
  });
}
