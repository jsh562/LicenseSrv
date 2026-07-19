// Enforcement configuration (NEW-CONFIG, FR-015/016; AD-007). The per-plan renewal window, renew-before
// cadence, heartbeat grace, CRL next_update horizon, and offline tolerance are APP CONFIG keyed by plan —
// NOT a `plan` DB column — resolved LIVE at each validate/heartbeat via the license's plan (so an operator
// retunes without a migration and without reissuing tokens). SCREAMING_SNAKE env -> camelCase, mirroring
// `loadActivationConfig`. Deployment-wide defaults come from the same env keys the central AppConfig reads
// (src/server/config/index.ts); a JSON `ENFORCEMENT_PLAN_OVERRIDES` layers per-plan overrides on top.

/** The resolved per-plan enforcement windows (all seconds except `graceBeats`). */
export interface PlanWindows {
  /** Short-token TTL = the renewal window; the renewed LIC1's `exp` = now + this (FR-002/005). */
  renewalWindowSecs: number;
  /** When the client SHOULD renew (before `exp`, ~50-70% of the TTL); drives `renewAfter` (FR-003/007). */
  renewAfterSecs: number;
  /** Missed heartbeats tolerated before the effective authorization lapses — no false lockout (FR-007). */
  graceBeats: number;
  /** The CRL validity horizon TTL written into `revocation_list.next_update` (FR-009/010). */
  crlNextUpdateSecs: number;
  /** How long a client may run without a fresh server anchor before it must re-anchor/renew (FR-015). */
  offlineToleranceSecs: number;
}

/** The full enforcement config: the deployment-wide defaults + per-plan overrides + the rate-limit knobs. */
export interface EnforcementConfig {
  /** Deployment-wide default windows (used when a plan has no override). */
  defaults: PlanWindows;
  /**
   * Per-plan overrides keyed by `plan.key` OR `plan.id` (either resolves). A partial override merges over
   * `defaults`, so an operator can retune only the knobs a plan needs (AD-007).
   */
  planOverrides: Record<string, Partial<PlanWindows>>;
  /** Rate-limit ceiling per window, per API key (FR-021); mirrors the activation surface. */
  rateMax: number;
  /** Rate-limit window (e.g. "1 minute"). */
  rateWindow: string;
  /**
   * Extra retention skew (seconds) beyond the renewal window before a check-in nonce may be pruned — a
   * nonce past `renewalWindow + skew` could only replay an already-expired token (fail-closed), so it is
   * safe to forget (FR-008 boundedness). Used by the platform retention purge (`pruneExpiredCheckins`).
   */
  nonceRetentionSkewSecs: number;
}

/** The bounded revocation-staleness disclosure (FR-013; SC-006) — surfaced in-band on every result. */
export interface StalenessWindow {
  seconds: number; // = max(tokenTtl, crlNextUpdate) + offlineTolerance
  tokenTtlSeconds: number;
  crlNextUpdateSeconds: number;
  offlineToleranceSeconds: number;
}

// Documented defaults (on the order of days for the windows; a handful of beats for grace). Kept in sync
// with the Zod defaults in src/server/config/index.ts — both read the same SCREAMING_SNAKE env keys.
export const DEFAULT_RENEWAL_WINDOW_SECS = 172_800; // 2 days
export const DEFAULT_HEARTBEAT_CADENCE_SECS = 86_400; // 1 day (~50% of the TTL)
export const DEFAULT_HEARTBEAT_GRACE_BEATS = 2;
export const DEFAULT_CRL_NEXT_UPDATE_SECS = 86_400; // 1 day
export const DEFAULT_OFFLINE_TOLERANCE_SECS = 3_600; // 1 hour
export const DEFAULT_NONCE_RETENTION_SKEW_SECS = 300; // 5 minutes of clock skew
export const DEFAULT_RATE_MAX = 60; // requests per window, per API key (FR-021; mirrors the activation surface)

function intEnv(raw: string | undefined, dflt: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : dflt;
}

/** The knobs a per-plan override may set — a subset of `PlanWindows`, all optional. */
const OVERRIDE_KEYS: readonly (keyof PlanWindows)[] = [
  "renewalWindowSecs",
  "renewAfterSecs",
  "graceBeats",
  "crlNextUpdateSecs",
  "offlineToleranceSecs",
];

/**
 * Parse the optional `ENFORCEMENT_PLAN_OVERRIDES` JSON into a validated override map. Shape:
 * `{ "<planKeyOrId>": { renewalWindowSecs?, renewAfterSecs?, graceBeats?, crlNextUpdateSecs?,
 * offlineToleranceSecs? } }`. Throws on malformed JSON (fail-fast at boot); silently drops unknown keys and
 * non-positive/ non-numeric values so a typo can never widen a window to an unsafe value.
 */
function parsePlanOverrides(raw: string | undefined): Record<string, Partial<PlanWindows>> {
  if (!raw || raw.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`ENFORCEMENT_PLAN_OVERRIDES is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("ENFORCEMENT_PLAN_OVERRIDES must be a JSON object keyed by plan key/id");
  }
  const out: Record<string, Partial<PlanWindows>> = {};
  for (const [plan, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
    const partial: Partial<PlanWindows> = {};
    for (const key of OVERRIDE_KEYS) {
      const v = (value as Record<string, unknown>)[key];
      if (typeof v === "number" && Number.isFinite(v) && v > 0) partial[key] = Math.floor(v);
    }
    if (Object.keys(partial).length > 0) out[plan] = partial;
  }
  return out;
}

/**
 * Load the enforcement config from the environment, falling back to the documented defaults. Reads the
 * same SCREAMING_SNAKE keys as the central AppConfig plus `ENFORCEMENT_PLAN_OVERRIDES` (per-plan) and the
 * `ENFORCEMENT_RATE_*` limiter knobs. Throws only on a malformed overrides JSON (fail-fast).
 */
export function loadEnforcementConfig(env: NodeJS.ProcessEnv = process.env): EnforcementConfig {
  const defaults: PlanWindows = {
    renewalWindowSecs: intEnv(env.ENFORCEMENT_RENEWAL_WINDOW_SECS, DEFAULT_RENEWAL_WINDOW_SECS),
    renewAfterSecs: intEnv(env.ENFORCEMENT_HEARTBEAT_CADENCE_SECS, DEFAULT_HEARTBEAT_CADENCE_SECS),
    graceBeats: intEnv(env.ENFORCEMENT_HEARTBEAT_GRACE_BEATS, DEFAULT_HEARTBEAT_GRACE_BEATS),
    crlNextUpdateSecs: intEnv(env.ENFORCEMENT_CRL_NEXT_UPDATE_SECS, DEFAULT_CRL_NEXT_UPDATE_SECS),
    offlineToleranceSecs: intEnv(env.ENFORCEMENT_OFFLINE_TOLERANCE_SECS, DEFAULT_OFFLINE_TOLERANCE_SECS),
  };
  return {
    defaults,
    planOverrides: parsePlanOverrides(env.ENFORCEMENT_PLAN_OVERRIDES),
    rateMax: intEnv(env.ENFORCEMENT_RATE_MAX, DEFAULT_RATE_MAX),
    rateWindow: env.ENFORCEMENT_RATE_WINDOW ?? "1 minute",
    nonceRetentionSkewSecs: intEnv(env.ENFORCEMENT_NONCE_RETENTION_SKEW_SECS, DEFAULT_NONCE_RETENTION_SKEW_SECS),
  };
}

/**
 * Resolve the effective per-plan windows for a license, keyed by the license's plan. An override matches by
 * `plan.key` first, then `plan.id`; the matched partial merges over `defaults`. With no key/id or no
 * override, the deployment-wide defaults are returned (AD-007 — read LIVE per validate/heartbeat).
 */
export function resolvePlanWindows(
  config: EnforcementConfig,
  plan: { planKey?: string | null; planId?: string | null } = {},
): PlanWindows {
  const override =
    (plan.planKey != null ? config.planOverrides[plan.planKey] : undefined) ??
    (plan.planId != null ? config.planOverrides[plan.planId] : undefined);
  return override ? { ...config.defaults, ...override } : { ...config.defaults };
}

/**
 * Compute the honestly-disclosed bounded revocation-staleness window (FR-013; SC-006) for a plan's windows:
 * `seconds = max(renewalWindow, crlNextUpdate) + offlineTolerance`. Returned in-band on every enforcement
 * result so the disclosure is not only in documentation.
 */
export function computeStalenessWindow(windows: PlanWindows): StalenessWindow {
  const tokenTtlSeconds = windows.renewalWindowSecs;
  const crlNextUpdateSeconds = windows.crlNextUpdateSecs;
  const offlineToleranceSeconds = windows.offlineToleranceSecs;
  return {
    seconds: Math.max(tokenTtlSeconds, crlNextUpdateSeconds) + offlineToleranceSeconds,
    tokenTtlSeconds,
    crlNextUpdateSeconds,
    offlineToleranceSeconds,
  };
}
