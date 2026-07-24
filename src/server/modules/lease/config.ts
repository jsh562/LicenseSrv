// Lease configuration + resolvers (E015, FR-009/012/017/023/026; ADR-0012). The per-plan lease timings
// (heartbeat/ttl/grace/sweep), the concurrency scope, the soft-cap overage allowance, the sweep batch
// bound, the per-API-key runtime rate ceiling, the signed-handle toggle, and the server-held holder-key
// salt are APP CONFIG read LIVE (an operator retunes without a migration). SCREAMING_SNAKE env ->
// camelCase config, mirroring `loadBillingConfig`/`loadActivationConfig` (deployment-wide defaults from the
// same env keys the central AppConfig reads, `src/server/config/index.ts`). A license SNAPSHOT (E008)
// overrides the timing/scope/cap values live at acquire; these deployment defaults seed the snapshot and
// back-stop a license that carries no override.
//
// INVARIANT (FR-009, INV-5): TTL >= 3x heartbeat, so a single missed heartbeat NEVER reclaims a live seat.
// The DB CHECK enforces it on plan/license; `resolveTimings` CLAMPS it here so a mis-tuned env combination
// (or a legacy snapshot) can never yield a TTL below the floor at runtime.

/** The concurrency-counting scope (FR-023): one live lease per (license, holder-key), keyed per scope. */
export type ConcurrencyScope = "session" | "machine" | "user";

/** The valid concurrency scopes; the single source of truth for scope validation (matches the DB CHECK). */
export const CONCURRENCY_SCOPES: readonly ConcurrencyScope[] = ["session", "machine", "user"] as const;

/** The per-plan/per-license lease timings (seconds), server-authoritative (FR-009). */
export interface LeaseTimings {
  heartbeatSeconds: number;
  ttlSeconds: number;
  graceSeconds: number;
  sweepSeconds: number;
}

/** The resolved deployment-wide lease config: timing/scope/overage defaults + rate/handle/salt. */
export interface LeaseConfig extends LeaseTimings {
  /** Default concurrency scope when a license carries none (FR-023). */
  scope: ConcurrencyScope;
  /** Default soft-cap allowance above the base cap; 0 = hard cap (FR-012). */
  overageAllowance: number;
  /** Bounded number of leases reclaimed per sweep run, oldest-first (FR-010). */
  sweepMaxBatch: number;
  /** Per-API-key runtime rate ceiling per window (FR-017). */
  rateMax: number;
  /** The rate-limit window, e.g. "1 minute" (FR-017). */
  rateWindow: string;
  /** Default: mint an E004-signed short-TTL lease handle on acquire/renew (FR-022). */
  signedHandle: boolean;
  /** Server-held holder-key salt (per-tenant/product), NEVER distributed to a client (FR-026). */
  holderKeySalt: string;
}

// Documented defaults (kept in sync with the Zod defaults in src/server/config/index.ts -- both read the
// same SCREAMING_SNAKE env keys).
export const DEFAULT_HEARTBEAT_SECONDS = 600; // 10 minutes
export const DEFAULT_TTL_SECONDS = 1_800; // 30 minutes
export const DEFAULT_GRACE_SECONDS = 300; // 5 minutes
export const DEFAULT_SWEEP_SECONDS = 60; // 1 minute
export const DEFAULT_SCOPE: ConcurrencyScope = "session";
export const DEFAULT_OVERAGE_ALLOWANCE = 0; // hard cap
export const DEFAULT_SWEEP_MAX_BATCH = 1_000;
export const DEFAULT_RATE_MAX = 120;
export const DEFAULT_RATE_WINDOW = "1 minute";
export const DEFAULT_SIGNED_HANDLE = true;
export const DEFAULT_HOLDER_KEY_SALT = "licensesrv-lease-salt";
/** The TTL floor multiple over the heartbeat (INV-5): TTL >= this × heartbeat. */
export const TTL_HEARTBEAT_MULTIPLE = 3;

/** Coerce a positive-int env value, falling back to `dflt` on a missing / non-positive / non-numeric input. */
function intEnv(raw: string | undefined, dflt: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : dflt;
}

/** Coerce a NON-NEGATIVE-int env value (0 allowed), falling back to `dflt` on a missing / negative / NaN input. */
function nonNegIntEnv(raw: string | undefined, dflt: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : dflt;
}

/** Coerce a boolean-ish env value ("true"/"1" => true, "false"/"0" => false), else `dflt`. */
function boolEnv(raw: string | undefined, dflt: boolean): boolean {
  if (raw === undefined) return dflt;
  const v = raw.trim().toLowerCase();
  if (v === "true" || v === "1") return true;
  if (v === "false" || v === "0") return false;
  return dflt;
}

/** Normalize an untrusted scope string to a valid {@link ConcurrencyScope}, falling back to `dflt`. */
export function resolveScope(raw: string | null | undefined, dflt: ConcurrencyScope = DEFAULT_SCOPE): ConcurrencyScope {
  return CONCURRENCY_SCOPES.includes(raw as ConcurrencyScope) ? (raw as ConcurrencyScope) : dflt;
}

/**
 * Resolve lease timings with the TTL >= 3× heartbeat invariant CLAMPED (FR-009, INV-5). Non-positive /
 * non-finite heartbeat/ttl/sweep fall back to the documented defaults; grace may be 0. If the resolved TTL is
 * below `3 × heartbeat`, it is RAISED to that floor so a single missed heartbeat can never reclaim a live
 * seat — the runtime back-stop for the DB CHECK. Pure; no I/O.
 */
export function resolveTimings(input: Partial<LeaseTimings> | null | undefined): LeaseTimings {
  const heartbeatSeconds = positiveOr(input?.heartbeatSeconds, DEFAULT_HEARTBEAT_SECONDS);
  const rawTtl = positiveOr(input?.ttlSeconds, DEFAULT_TTL_SECONDS);
  const graceSeconds = nonNegOr(input?.graceSeconds, DEFAULT_GRACE_SECONDS);
  const sweepSeconds = positiveOr(input?.sweepSeconds, DEFAULT_SWEEP_SECONDS);
  const floor = TTL_HEARTBEAT_MULTIPLE * heartbeatSeconds;
  const ttlSeconds = Math.max(rawTtl, floor);
  return { heartbeatSeconds, ttlSeconds, graceSeconds, sweepSeconds };
}

function positiveOr(n: number | null | undefined, dflt: number): number {
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.floor(n) : dflt;
}

function nonNegOr(n: number | null | undefined, dflt: number): number {
  return typeof n === "number" && Number.isFinite(n) && n >= 0 ? Math.floor(n) : dflt;
}

/**
 * The effective cap for a license (FR-012): `max_concurrent + overage allowance`. A non-positive/absent
 * overage collapses to the hard cap. `maxConcurrent` NULL is NOT resolved here — absent floating entitlement
 * is a fail-closed refusal decided in `acquire.ts` (INV-6), never treated as unlimited.
 */
export function effectiveCap(maxConcurrent: number, overageAllowance: number): number {
  const overage = Number.isFinite(overageAllowance) && overageAllowance > 0 ? Math.floor(overageAllowance) : 0;
  return Math.floor(maxConcurrent) + overage;
}

/**
 * Overage math (FR-012/013): would a NEW seat admitted when `liveCountBefore` leases already exist be an
 * OVER-BASE (soft-cap) seat? True once the base `maxConcurrent` is already filled — i.e. the new seat lands
 * at index `>= maxConcurrent`. The authoritative meter is the append-only audit entry; this boolean is the
 * non-authoritative `overage` flag stamped on the lease row.
 */
export function isOverageSeat(liveCountBefore: number, maxConcurrent: number): boolean {
  return liveCountBefore >= maxConcurrent;
}

/**
 * Can a NEW seat be admitted given `liveCountBefore` live leases against the effective cap? True while the
 * live count is strictly below `max_concurrent + overage`; the authoritative race-safe check is the
 * advisory-locked count+insert in `lease-repo.ts` (AD-001), this pure helper mirrors that boundary.
 */
export function canAdmit(liveCountBefore: number, maxConcurrent: number, overageAllowance: number): boolean {
  return liveCountBefore < effectiveCap(maxConcurrent, overageAllowance);
}

/** Read the lease config from the environment, falling back to the documented defaults. */
export function loadLeaseConfig(env: NodeJS.ProcessEnv = process.env): LeaseConfig {
  const timings = resolveTimings({
    heartbeatSeconds: env.LEASE_HEARTBEAT_SECONDS ? Number(env.LEASE_HEARTBEAT_SECONDS) : undefined,
    ttlSeconds: env.LEASE_TTL_SECONDS ? Number(env.LEASE_TTL_SECONDS) : undefined,
    graceSeconds: env.LEASE_GRACE_SECONDS !== undefined ? Number(env.LEASE_GRACE_SECONDS) : undefined,
    sweepSeconds: env.LEASE_SWEEP_SECONDS ? Number(env.LEASE_SWEEP_SECONDS) : undefined,
  });
  return {
    ...timings,
    scope: resolveScope(env.LEASE_SCOPE, DEFAULT_SCOPE),
    overageAllowance: nonNegIntEnv(env.LEASE_OVERAGE_ALLOWANCE, DEFAULT_OVERAGE_ALLOWANCE),
    sweepMaxBatch: intEnv(env.LEASE_SWEEP_MAX_BATCH, DEFAULT_SWEEP_MAX_BATCH),
    rateMax: intEnv(env.LEASE_RATE_MAX, DEFAULT_RATE_MAX),
    rateWindow: env.LEASE_RATE_WINDOW?.trim() || DEFAULT_RATE_WINDOW,
    signedHandle: boolEnv(env.LEASE_SIGNED_HANDLE, DEFAULT_SIGNED_HANDLE),
    holderKeySalt: env.LEASE_HOLDER_KEY_SALT ?? DEFAULT_HOLDER_KEY_SALT,
  };
}
