// Activation module wiring (E009, ADR-0005). Registers the runtime /v1 activate/deactivate surface (API
// key + `activate` scope) and the /admin activation registry (console session) at the module seam. Consumes
// E004's published Signer via `app.signer` (registerActivation runs after registerSigning + registerIssuance)
// to re-sign machine-bound credentials, and reads the E008 `license` snapshot via a non-internal import.
import type { FastifyInstance } from "fastify";

import type { AppDeps } from "../../app.js";
import { registerActivationRoutes } from "./routes.js";

export const DEFAULT_FP_MIN = 3; // K in the K-of-N match (default 3-of-5)
export const DEFAULT_MAX_SKEW_SECS = 300;
export const DEFAULT_RATE_MAX = 60; // requests per window, per API key (FR-020)
export const DEFAULT_RETENTION_DAYS = 90;
// E010 air-gap defaults (NEW-CONFIG).
export const DEFAULT_AIRGAP_FRESHNESS_SECS = 604_800; // 7 days (E010 FR-020/AD-005)
export const DEFAULT_AIRGAP_MAX_REQUEST_BYTES = 65_536; // 64 KiB oversize guard (E010 FR-019)
export const AIRGAP_REQUEST_VERSION = "airgap-req-1"; // request-file format version (E010 FR-014)
export const AIRGAP_RESPONSE_VERSION = "airgap-resp-1"; // response-file format version (E010 FR-014)

/** The activation configuration (NEW-CONFIG, E009 + E010 air-gap keys). Operator-tunable via the environment. */
export interface ActivationConfig {
  fpMin: number; // K threshold for the K-of-N match (FR-005)
  maxSkewSecs: number; // clock-skew window stamped into the credential (`sk`)
  credentialTtlSecs: number | null; // optional; effective exp = min(license exp, now+TTL) (FR-022)
  activationSalt: string; // per-tenant/product provisioned salt for machine-id derivation (FR-019)
  rateMax: number; // rate-limit ceiling per window (FR-013/FR-020)
  rateWindow: string; // rate-limit window (e.g. "1 minute")
  nonceWindowSecs: number; // bounded nonce replay-rejection window (FR-021)
  retentionDays: number; // stale (deactivated) activation retention before purge
  // --- E010 air-gap ---
  airgapFreshnessSecs: number; // request-file freshness window; first-sight only (E010 FR-020/FR-021)
  airgapMaxRequestBytes: number; // pre-decode oversize guard on the request file (E010 FR-019)
  airgapRequestVersion: string; // accepted request-file formatVersion (E010 FR-001/FR-014)
  airgapResponseVersion: string; // emitted response-file formatVersion (E010 FR-014)
}

/** A typed activation error carrying the HTTP status + machine code the routes surface as `{code,message,details?}`. */
export class ActivationError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "ActivationError";
  }
}

function intEnv(raw: string | undefined, dflt: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : dflt;
}

/** Read the activation config from the environment, falling back to the documented defaults. */
export function loadActivationConfig(env: NodeJS.ProcessEnv = process.env): ActivationConfig {
  const ttl = Number(env.ACTIVATION_CREDENTIAL_TTL_SECS);
  return {
    fpMin: intEnv(env.ACTIVATION_FP_MIN, DEFAULT_FP_MIN),
    maxSkewSecs: intEnv(env.ACTIVATION_MAX_SKEW_SECS, DEFAULT_MAX_SKEW_SECS),
    credentialTtlSecs: Number.isFinite(ttl) && ttl > 0 ? Math.floor(ttl) : null,
    activationSalt: env.ACTIVATION_SALT ?? "licensesrv-activation-salt",
    rateMax: intEnv(env.ACTIVATION_RATE_MAX, DEFAULT_RATE_MAX),
    rateWindow: env.ACTIVATION_RATE_WINDOW ?? "1 minute",
    nonceWindowSecs: intEnv(env.ACTIVATION_NONCE_WINDOW_SECS, 86_400),
    retentionDays: intEnv(env.ACTIVATION_RETENTION_DAYS, DEFAULT_RETENTION_DAYS),
    airgapFreshnessSecs: intEnv(env.ACTIVATION_AIRGAP_FRESHNESS_SECS, DEFAULT_AIRGAP_FRESHNESS_SECS),
    airgapMaxRequestBytes: intEnv(env.ACTIVATION_AIRGAP_MAX_REQUEST_BYTES, DEFAULT_AIRGAP_MAX_REQUEST_BYTES),
    airgapRequestVersion: env.ACTIVATION_AIRGAP_REQUEST_VERSION ?? AIRGAP_REQUEST_VERSION,
    airgapResponseVersion: env.ACTIVATION_AIRGAP_RESPONSE_VERSION ?? AIRGAP_RESPONSE_VERSION,
  };
}

/** The module's registration seam. Wires the /v1 runtime + /admin registry activation routes. */
export function registerActivation(app: FastifyInstance, deps: AppDeps): void {
  registerActivationRoutes(app, deps.pool, {
    config: loadActivationConfig(),
    // Published by registerSigning (E004). May be undefined if signing isn't registered; the activate
    // route then returns 503 signer_unavailable (fail-closed, no activation).
    signer: app.signer,
    apiKeySecret: deps.apiKeySecret,
  });
}
