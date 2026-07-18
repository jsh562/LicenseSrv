import { registerIssuanceRoutes } from "./routes.js";
/** Default per-license transfer limit (FR-009, AD-006) — operator-configurable. */
export const DEFAULT_TRANSFER_LIMIT = 3;
/** A typed issuance error carrying the HTTP status + machine code the routes surface as `{code,message}`. */
export class IssuanceError extends Error {
    code;
    status;
    constructor(code, status, message) {
        super(message);
        this.code = code;
        this.status = status;
        this.name = "IssuanceError";
    }
}
/** Read issuance config from the environment (only the transfer limit today). */
export function loadIssuanceConfig(env = process.env) {
    const raw = Number(env.LICENSE_TRANSFER_LIMIT);
    return { transferLimit: Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_TRANSFER_LIMIT };
}
/** The module's registration seam. Wires the /admin issuance routes under the shared console session auth. */
export function registerIssuance(app, deps) {
    registerIssuanceRoutes(app, deps.pool, {
        config: loadIssuanceConfig(),
        // The signer is published by registerSigning (E004). May be undefined if signing isn't registered;
        // the issue route then returns 503 signer_unavailable.
        signer: app.signer,
    });
}
