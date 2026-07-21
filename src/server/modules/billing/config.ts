// Billing configuration (NEW-CONFIG, FR-011/016/019/021/022; ADR-0011). The grace default, the webhook
// signature timestamp tolerance, the per-connection + per-source-IP webhook rate ceilings, the append-only
// ledger retention horizon, and the signing-secret rotation transition window are APP CONFIG read LIVE at
// verify + apply time (an operator retunes without a migration). SCREAMING_SNAKE env -> camelCase config,
// mirroring `loadEnforcementConfig` (deployment-wide defaults from the same env keys the central AppConfig
// reads, `src/server/config/index.ts`). Per-connection grace policy layers on top at resolve time.

/** The resolved billing config: deployment-wide defaults for grace / tolerance / rate / retention / rotation. */
export interface BillingConfig {
  /** Default grace window (seconds) applied on cancel/payment-failure before auto-suspend (~14d) (FR-011). */
  defaultGraceSeconds: number;
  /** Webhook signature timestamp recency tolerance (seconds); rejects stale AND future skew (~5m) (FR-002/016). */
  signatureToleranceSecs: number;
  /** Per-connection webhook rate ceiling per window (FR-019). */
  webhookRateMaxPerConnection: number;
  /** Per-source-IP webhook rate ceiling per window — bounds unknown/invalid {connectionId} floods pre-resolution (FR-019). */
  webhookRateMaxPerIp: number;
  /** The rate-limit window, e.g. "1 minute" (FR-019). */
  webhookRateWindow: string;
  /** Append-only ledger retention horizon (seconds); GDPR-bounded, always > the idempotency floor (FR-021). */
  ledgerRetentionSecs: number;
  /** Signing-secret rotation transition window (seconds); the previous secret is accepted this long (~24h) (FR-022). */
  secretRotationWindowSecs: number;
}

// Documented defaults (kept in sync with the Zod defaults in src/server/config/index.ts -- both read the
// same SCREAMING_SNAKE env keys).
export const DEFAULT_GRACE_SECONDS = 1_209_600; // 14 days (provider dunning order)
export const DEFAULT_SIGNATURE_TOLERANCE_SECS = 300; // 5 minutes
export const DEFAULT_WEBHOOK_RATE_MAX_PER_CONNECTION = 120;
export const DEFAULT_WEBHOOK_RATE_MAX_PER_IP = 300;
export const DEFAULT_WEBHOOK_RATE_WINDOW = "1 minute";
export const DEFAULT_LEDGER_RETENTION_SECS = 31_536_000; // 365 days

/**
 * The idempotency / provider-retry floor (48h). The ledger MUST retain every event id at least as long as a
 * provider can redeliver it, otherwise a late redelivery of a pruned event id could be re-applied (breaking
 * exactly-once, FR-003). Retention is therefore clamped to be strictly above this floor at load time.
 */
export const IDEMPOTENCY_FLOOR_SECS = 172_800; // 48 hours
export const DEFAULT_SECRET_ROTATION_WINDOW_SECS = 86_400; // 24 hours

/** Coerce a positive-int env value, falling back to `dflt` on a missing / non-positive / non-numeric input. */
function intEnv(raw: string | undefined, dflt: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : dflt;
}

/**
 * Load the billing config from the environment, falling back to the documented defaults. Reads the same
 * SCREAMING_SNAKE keys as the central AppConfig. The ledger retention horizon is CLAMPED to stay strictly
 * above the idempotency floor (`IDEMPOTENCY_FLOOR_SECS`) so a shorter operator value can never let a
 * still-redeliverable event id be pruned and re-applied (FR-003/021).
 */
export function loadBillingConfig(env: NodeJS.ProcessEnv = process.env): BillingConfig {
  const ledgerRetentionSecs = resolveLedgerRetentionSecs(
    intEnv(env.BILLING_LEDGER_RETENTION_SECS, DEFAULT_LEDGER_RETENTION_SECS),
  );
  return {
    defaultGraceSeconds: intEnv(env.BILLING_DEFAULT_GRACE_SECONDS, DEFAULT_GRACE_SECONDS),
    signatureToleranceSecs: intEnv(env.BILLING_SIGNATURE_TOLERANCE_SECS, DEFAULT_SIGNATURE_TOLERANCE_SECS),
    webhookRateMaxPerConnection: intEnv(
      env.BILLING_WEBHOOK_RATE_MAX_PER_CONNECTION,
      DEFAULT_WEBHOOK_RATE_MAX_PER_CONNECTION,
    ),
    webhookRateMaxPerIp: intEnv(env.BILLING_WEBHOOK_RATE_MAX_PER_IP, DEFAULT_WEBHOOK_RATE_MAX_PER_IP),
    webhookRateWindow: env.BILLING_WEBHOOK_RATE_WINDOW?.trim() || DEFAULT_WEBHOOK_RATE_WINDOW,
    ledgerRetentionSecs,
    secretRotationWindowSecs: intEnv(
      env.BILLING_SECRET_ROTATION_WINDOW_SECS,
      DEFAULT_SECRET_ROTATION_WINDOW_SECS,
    ),
  };
}

/** The grace policy carried by a connection: a per-plan override map over a connection-level default. */
export interface GracePolicy {
  /** The connection's default grace window (seconds); falls back to the deployment default when absent. */
  defaultGraceSeconds?: number | null;
  /** Per-plan overrides `{ planKey: seconds }`; each positive value wins for its plan (FR-011). */
  graceOverrides?: Record<string, number> | null;
}

/**
 * Resolve the effective grace window (seconds) for a plan: a positive per-plan override wins; else the
 * connection's positive default; else the deployment-wide `config.defaultGraceSeconds`. Never returns a
 * zero/negative window (FR-011) — a non-positive override/default is ignored in favour of the next tier.
 */
export function resolveGraceSeconds(config: BillingConfig, policy: GracePolicy, planKey?: string | null): number {
  const override = planKey && policy.graceOverrides ? policy.graceOverrides[planKey] : undefined;
  if (typeof override === "number" && Number.isFinite(override) && override > 0) return Math.floor(override);
  const connectionDefault = policy.defaultGraceSeconds;
  if (typeof connectionDefault === "number" && Number.isFinite(connectionDefault) && connectionDefault > 0) {
    return Math.floor(connectionDefault);
  }
  return config.defaultGraceSeconds;
}

/** The webhook signature timestamp recency tolerance (seconds) (FR-002/016). */
export function resolveToleranceSecs(config: BillingConfig): number {
  return config.signatureToleranceSecs;
}

/**
 * Clamp the ledger retention horizon to stay strictly above the idempotency floor (FR-003/021): a
 * still-redeliverable event id must never be pruned. Returns `max(requested, IDEMPOTENCY_FLOOR_SECS + 1)`.
 */
export function resolveLedgerRetentionSecs(requestedSecs: number): number {
  const floor = IDEMPOTENCY_FLOOR_SECS + 1;
  return Number.isFinite(requestedSecs) && requestedSecs > floor ? Math.floor(requestedSecs) : floor;
}

/** The signing-secret rotation transition window (seconds) (FR-022). */
export function resolveRotationWindowSecs(config: BillingConfig): number {
  return config.secretRotationWindowSecs;
}

/**
 * Is the previous signing secret still accepted? True while `now - secretRotatedAt < rotationWindow`
 * (FR-022). A null `secretRotatedAt` (never rotated) → false. Drives whether the verifier is offered the
 * `signing_secret_prev` alongside the current secret.
 */
export function isRotationWindowOpen(
  config: BillingConfig,
  secretRotatedAt: Date | null | undefined,
  now: Date = new Date(),
): boolean {
  if (!secretRotatedAt) return false;
  const elapsedSecs = (now.getTime() - secretRotatedAt.getTime()) / 1000;
  return elapsedSecs >= 0 && elapsedSecs < config.secretRotationWindowSecs;
}
