import { loadEnforcementConfig } from "./config.js";
import { registerEnforcementRoutes } from "./routes.js";
/**
 * A typed enforcement error carrying the HTTP status + machine code the routes surface as
 * `{code,message,details?}` (mirrors `ActivationError`/`IssuanceError`). NOTE: an enforcement REFUSAL
 * (revoked/suspended/expired/deactivated) is NOT an error — it is a `200` + `verdict` (AD-001). This class
 * is only for genuine protocol faults: `nonce_replayed` (409), `signer_unavailable` (503), etc.
 */
export class EnforcementError extends Error {
    code;
    status;
    details;
    constructor(code, status, message, details) {
        super(message);
        this.code = code;
        this.status = status;
        this.details = details;
        this.name = "EnforcementError";
    }
}
/**
 * The module's registration seam (ADR-0005). Resolves the LIVE enforcement config so a malformed
 * `ENFORCEMENT_PLAN_OVERRIDES` fails fast at boot, then wires the /v1 runtime plane. The routes consume
 * `deps.pool` (RLS reads/writes), `app.signer` (E004 short-TTL LIC1; published by registerSigning — may be
 * undefined, in which case a `valid` binding returns 503 signer_unavailable, fail-closed), and the E007
 * effective entitlements read — all resolved per request. US1 registers POST /v1/validate; US3 (heartbeat)
 * and US4 (revocation-list) layer onto the same seam.
 */
export function registerEnforcement(app, deps) {
    // Validate + prepare the enforcement config at registration (boot-time fail-fast on bad overrides).
    const config = loadEnforcementConfig();
    registerEnforcementRoutes(app, deps.pool, {
        config,
        signer: app.signer,
        apiKeySecret: deps.apiKeySecret,
    });
}
