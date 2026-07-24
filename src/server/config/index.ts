// The validated 12-factor configuration contract (OR-005/006/017, AD-001). This is the single source of
// truth for runtime settings: all values come from the environment (secrets via `<VAR>_FILE`), are
// validated once at boot, and any missing/invalid required setting fails fast — naming the offending
// setting — rather than starting degraded. `configSummary` produces a secret-free view for startup logs.
import { z } from "zod";

import { readSecret } from "./secrets.js";

export interface AppConfig {
  nodeEnv: string;
  host: string;
  port: number;
  databaseUrl: string;
  apiKeySecret: string;
  poolMax: number;
  shutdownTimeoutMs: number;
  logLevel: "debug" | "info" | "warn" | "error";
  // Observability (E012, OR-018; per ADR-0009). All optional/defaulted so the API boots without an
  // observability backend (telemetry is fail-open). Secrets (fingerprint pepper, OTLP token) resolve via
  // the `<VAR>_FILE` convention and are never included in `configSummary`.
  logFormat: "json" | "pretty";
  metricsPort: number; // dedicated internal metrics-port; 0 disables the /metrics listener
  otlpEndpoint: string; // OTLP/HTTP trace endpoint; empty disables tracing export (fail-open)
  traceSampleRatio: number; // parent-based ratio sampler [0,1], default 0.1
  fingerprintPepper: string; // server-held HMAC pepper for one-way fingerprint hashing (secret; may be empty)
  otlpAuthToken: string; // optional OTLP exporter auth token (secret; may be empty)
  // Tenant-isolation canary (E012 OBJ3, OR-012). Disabled by default; when enabled it must be given the
  // two DEDICATED reserved synthetic tenant UUIDs (never real customer tenants) it probes with.
  canaryEnabled: boolean; // OBS_CANARY_ENABLED — start the synthetic isolation canary
  canaryIntervalMs: number; // OBS_CANARY_INTERVAL_MS — probe cadence (default ~60s)
  canaryScopedTenant: string; // OBS_CANARY_SCOPED_TENANT — reserved synthetic tenant the probe scopes to
  canaryTargetTenant: string; // OBS_CANARY_TARGET_TENANT — reserved synthetic tenant the probe attempts to read
  // Online enforcement & revocation (E013, FR-016; per {SAD:ADR-0010}). Deployment-wide DEFAULTS for the
  // per-plan windows; the enforcement module resolves per-plan overrides live (AD-007). All defaulted so
  // the API boots without any E013 setting. Non-secret — surfaced in `configSummary`.
  enforcementRenewalWindowSecs: number; // ENFORCEMENT_RENEWAL_WINDOW_SECS — short-token TTL / renewal window (FR-002)
  enforcementHeartbeatCadenceSecs: number; // ENFORCEMENT_HEARTBEAT_CADENCE_SECS — client renew-before cadence -> renewAfter (FR-003/007)
  enforcementHeartbeatGraceBeats: number; // ENFORCEMENT_HEARTBEAT_GRACE_BEATS — missed beats tolerated before lapse (FR-007)
  enforcementCrlNextUpdateSecs: number; // ENFORCEMENT_CRL_NEXT_UPDATE_SECS — CRL validity horizon TTL (FR-009/010)
  enforcementOfflineToleranceSecs: number; // ENFORCEMENT_OFFLINE_TOLERANCE_SECS — per-plan offline-tolerance default (FR-015)
  // Billing-driven entitlement automation (E014, FR-011/016/019/021/022; per {SAD:ADR-0011}). Deployment-
  // wide DEFAULTS for the grace window, the webhook signature timestamp tolerance, the per-connection +
  // per-source-IP webhook rate ceilings, the append-only ledger retention horizon (GDPR; floored above the
  // idempotency / provider-retry window), and the signing-secret rotation transition window. The billing
  // module (`modules/billing/config.ts`) reads the same SCREAMING_SNAKE keys LIVE. All defaulted + non-secret.
  billingDefaultGraceSeconds: number; // BILLING_DEFAULT_GRACE_SECONDS — default grace window (~14d) (FR-011)
  billingSignatureToleranceSecs: number; // BILLING_SIGNATURE_TOLERANCE_SECS — webhook timestamp recency tolerance (~5m) (FR-002/016)
  billingWebhookRateMaxPerConnection: number; // BILLING_WEBHOOK_RATE_MAX_PER_CONNECTION — per-connection webhook rate ceiling (FR-019)
  billingWebhookRateMaxPerIp: number; // BILLING_WEBHOOK_RATE_MAX_PER_IP — per-source-IP (pre-resolution) webhook rate ceiling (FR-019)
  billingWebhookRateWindow: string; // BILLING_WEBHOOK_RATE_WINDOW — rate-limit window, e.g. "1 minute" (FR-019)
  billingLedgerRetentionSecs: number; // BILLING_LEDGER_RETENTION_SECS — append-only ledger retention horizon (~365d, floored ≥48h) (FR-021)
  billingSecretRotationWindowSecs: number; // BILLING_SECRET_ROTATION_WINDOW_SECS — signing-secret rotation transition window (~24h) (FR-022)
  // Floating & concurrent seats (E015, FR-009/012/017/026; per ADR-0012). Deployment-wide DEFAULTS for the
  // per-plan lease timings (heartbeat/ttl/grace/sweep — the license snapshot overrides these live), the
  // default concurrency scope, the default soft-cap overage allowance, the reclaim-sweeper batch bound, the
  // per-API-key runtime rate ceiling + window (sized for heartbeat cadence), and the signed-handle toggle.
  // The lease module (`modules/lease/config.ts`) reads the same SCREAMING_SNAKE keys LIVE and clamps
  // TTL ≥ 3× heartbeat. All defaulted + non-secret EXCEPT the holder-key salt (server-held, per <VAR>_FILE).
  leaseHeartbeatSeconds: number; // LEASE_HEARTBEAT_SECONDS — heartbeat/renew cadence default (~10m) (FR-009)
  leaseTtlSeconds: number; // LEASE_TTL_SECONDS — lease TTL default (~30m); invariant TTL ≥ 3× heartbeat (FR-009)
  leaseGraceSeconds: number; // LEASE_GRACE_SECONDS — grace window before reclamation default (~5m) (FR-010)
  leaseSweepSeconds: number; // LEASE_SWEEP_SECONDS — reclaim-sweeper interval default (~1m) (FR-010)
  leaseScope: "session" | "machine" | "user"; // LEASE_SCOPE — default concurrency scope (FR-023)
  leaseOverageAllowance: number; // LEASE_OVERAGE_ALLOWANCE — default soft-cap allowance above base; 0 = hard cap (FR-012)
  leaseSweepMaxBatch: number; // LEASE_SWEEP_MAX_BATCH — bounded leases reclaimed per sweep run (FR-010)
  leaseRateMax: number; // LEASE_RATE_MAX — per-API-key runtime rate ceiling per window (FR-017)
  leaseRateWindow: string; // LEASE_RATE_WINDOW — runtime rate-limit window, e.g. "1 minute" (FR-017)
  leaseSignedHandle: boolean; // LEASE_SIGNED_HANDLE — default: mint an E004-signed short-TTL lease handle (FR-022)
  leaseHolderKeySalt: string; // LEASE_HOLDER_KEY_SALT — server-held holder-key salt; NEVER distributed to a client (secret; FR-026)
}

/** Thrown when required configuration is missing/invalid. Message lists each offending setting. */
export class ConfigError extends Error {
  constructor(public readonly issues: string[]) {
    super(`invalid configuration:\n- ${issues.join("\n- ")}`);
    this.name = "ConfigError";
  }
}

const schema = z.object({
  nodeEnv: z.string().min(1).default("production"),
  host: z.string().min(1).default("0.0.0.0"),
  port: z.coerce.number().int().min(0).max(65535).default(8080), // 0 = OS-assigned ephemeral port
  databaseUrl: z
    .string({ required_error: "DATABASE_URL is required (set DATABASE_URL or DATABASE_URL_FILE)" })
    .min(1, "DATABASE_URL is required (set DATABASE_URL or DATABASE_URL_FILE)"),
  apiKeySecret: z
    .string({ required_error: "API_KEY_SECRET is required (set API_KEY_SECRET or API_KEY_SECRET_FILE)" })
    .min(1, "API_KEY_SECRET is required (set API_KEY_SECRET or API_KEY_SECRET_FILE)"),
  poolMax: z.coerce.number().int().positive().max(1000).default(10),
  shutdownTimeoutMs: z.coerce.number().int().positive().default(10_000),
  logLevel: z.enum(["debug", "info", "warn", "error"]).default("info"),
  logFormat: z.enum(["json", "pretty"]).default("json"),
  metricsPort: z.coerce.number().int().min(0).max(65535).default(9464), // OpenMetrics scrape port; 0 disables
  otlpEndpoint: z.string().default(""),
  traceSampleRatio: z.coerce.number().min(0).max(1).default(0.1),
  fingerprintPepper: z.string().default(""),
  otlpAuthToken: z.string().default(""),
  canaryEnabled: z
    .enum(["true", "false", "1", "0"])
    .transform((v) => v === "true" || v === "1")
    .default("false"),
  canaryIntervalMs: z.coerce.number().int().positive().default(60_000),
  canaryScopedTenant: z.string().default(""),
  canaryTargetTenant: z.string().default(""),
  // E013 enforcement windows — sane defaults on the order of days (renewal window / CRL horizon), a
  // handful of missed beats (grace), and a short offline tolerance. Operators retune without a migration.
  enforcementRenewalWindowSecs: z.coerce.number().int().positive().default(172_800), // 2 days
  enforcementHeartbeatCadenceSecs: z.coerce.number().int().positive().default(86_400), // 1 day (~50% of TTL)
  enforcementHeartbeatGraceBeats: z.coerce.number().int().positive().default(2), // tolerate 2 missed beats
  enforcementCrlNextUpdateSecs: z.coerce.number().int().positive().default(86_400), // 1 day
  enforcementOfflineToleranceSecs: z.coerce.number().int().positive().default(3_600), // 1 hour
  // E014 billing windows — sane defaults: grace ~2 weeks (provider dunning order), signature tolerance
  // ~5 min, per-connection/per-IP webhook rate ceilings, ledger retention ~1 year, secret rotation ~24h.
  // The billing module clamps retention above the idempotency floor (≥48h) at load. Retune without a migration.
  billingDefaultGraceSeconds: z.coerce.number().int().positive().default(1_209_600), // 14 days
  billingSignatureToleranceSecs: z.coerce.number().int().positive().default(300), // 5 minutes
  billingWebhookRateMaxPerConnection: z.coerce.number().int().positive().default(120),
  billingWebhookRateMaxPerIp: z.coerce.number().int().positive().default(300),
  billingWebhookRateWindow: z.string().min(1).default("1 minute"),
  billingLedgerRetentionSecs: z.coerce.number().int().positive().default(31_536_000), // 365 days
  billingSecretRotationWindowSecs: z.coerce.number().int().positive().default(86_400), // 24 hours
  // E015 floating-seat lease defaults — heartbeat ~10m, TTL ~30m (≥ 3× heartbeat), grace ~5m, sweep ~1m,
  // scope 'session', hard cap (overage 0), bounded sweep batch 1000, runtime rate ceiling sized for
  // heartbeat cadence. The lease module clamps TTL ≥ 3× heartbeat at load. Retune without a migration.
  leaseHeartbeatSeconds: z.coerce.number().int().positive().default(600), // 10 minutes
  leaseTtlSeconds: z.coerce.number().int().positive().default(1_800), // 30 minutes
  leaseGraceSeconds: z.coerce.number().int().min(0).default(300), // 5 minutes (0 allowed)
  leaseSweepSeconds: z.coerce.number().int().positive().default(60), // 1 minute
  leaseScope: z.enum(["session", "machine", "user"]).default("session"),
  leaseOverageAllowance: z.coerce.number().int().min(0).default(0), // 0 = hard cap
  leaseSweepMaxBatch: z.coerce.number().int().positive().default(1_000),
  leaseRateMax: z.coerce.number().int().positive().default(120),
  leaseRateWindow: z.string().min(1).default("1 minute"),
  leaseSignedHandle: z
    .enum(["true", "false", "1", "0"])
    .transform((v) => v === "true" || v === "1")
    .default("true"),
  leaseHolderKeySalt: z.string().default("licensesrv-lease-salt"),
});

/**
 * Resolve + validate `DATABASE_URL` (with `<VAR>_FILE` support) on its own. The migration job needs the
 * database URL but not the API-key secret, so it uses this narrower loader (fail-fast, names the setting).
 */
export function resolveDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const url = readSecret(env, "DATABASE_URL");
  if (!url) throw new ConfigError(["DATABASE_URL is required (set DATABASE_URL or DATABASE_URL_FILE)"]);
  return url;
}

/**
 * Load and validate the full runtime configuration from `env`. Pure (no global mutation): secrets are
 * resolved via `<VAR>_FILE`. Throws `ConfigError` listing every offending setting on any failure.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = schema.safeParse({
    nodeEnv: env.NODE_ENV,
    host: env.HOST,
    port: env.PORT,
    databaseUrl: readSecret(env, "DATABASE_URL"),
    apiKeySecret: readSecret(env, "API_KEY_SECRET"),
    poolMax: env.DB_POOL_MAX,
    shutdownTimeoutMs: env.SHUTDOWN_TIMEOUT_MS,
    logLevel: env.LOG_LEVEL,
    logFormat: env.LOG_FORMAT,
    metricsPort: env.OBS_METRICS_PORT,
    otlpEndpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT,
    traceSampleRatio: env.OBS_TRACE_SAMPLE_RATIO,
    canaryEnabled: env.OBS_CANARY_ENABLED,
    canaryIntervalMs: env.OBS_CANARY_INTERVAL_MS,
    canaryScopedTenant: env.OBS_CANARY_SCOPED_TENANT,
    canaryTargetTenant: env.OBS_CANARY_TARGET_TENANT,
    enforcementRenewalWindowSecs: env.ENFORCEMENT_RENEWAL_WINDOW_SECS,
    enforcementHeartbeatCadenceSecs: env.ENFORCEMENT_HEARTBEAT_CADENCE_SECS,
    enforcementHeartbeatGraceBeats: env.ENFORCEMENT_HEARTBEAT_GRACE_BEATS,
    enforcementCrlNextUpdateSecs: env.ENFORCEMENT_CRL_NEXT_UPDATE_SECS,
    enforcementOfflineToleranceSecs: env.ENFORCEMENT_OFFLINE_TOLERANCE_SECS,
    billingDefaultGraceSeconds: env.BILLING_DEFAULT_GRACE_SECONDS,
    billingSignatureToleranceSecs: env.BILLING_SIGNATURE_TOLERANCE_SECS,
    billingWebhookRateMaxPerConnection: env.BILLING_WEBHOOK_RATE_MAX_PER_CONNECTION,
    billingWebhookRateMaxPerIp: env.BILLING_WEBHOOK_RATE_MAX_PER_IP,
    billingWebhookRateWindow: env.BILLING_WEBHOOK_RATE_WINDOW,
    billingLedgerRetentionSecs: env.BILLING_LEDGER_RETENTION_SECS,
    billingSecretRotationWindowSecs: env.BILLING_SECRET_ROTATION_WINDOW_SECS,
    leaseHeartbeatSeconds: env.LEASE_HEARTBEAT_SECONDS,
    leaseTtlSeconds: env.LEASE_TTL_SECONDS,
    leaseGraceSeconds: env.LEASE_GRACE_SECONDS,
    leaseSweepSeconds: env.LEASE_SWEEP_SECONDS,
    leaseScope: env.LEASE_SCOPE,
    leaseOverageAllowance: env.LEASE_OVERAGE_ALLOWANCE,
    leaseSweepMaxBatch: env.LEASE_SWEEP_MAX_BATCH,
    leaseRateMax: env.LEASE_RATE_MAX,
    leaseRateWindow: env.LEASE_RATE_WINDOW,
    leaseSignedHandle: env.LEASE_SIGNED_HANDLE,
    // Secrets follow the <VAR>_FILE convention (file wins; unset → the documented default salt).
    leaseHolderKeySalt: readSecret(env, "LEASE_HOLDER_KEY_SALT") ?? "licensesrv-lease-salt",
    fingerprintPepper: readSecret(env, "OBS_FINGERPRINT_PEPPER") ?? "",
    otlpAuthToken: readSecret(env, "OTEL_EXPORTER_OTLP_AUTH_TOKEN") ?? "",
  });
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => {
      const key = i.path.join(".") || "config";
      return `${key}: ${i.message}`;
    });
    throw new ConfigError(issues);
  }
  return parsed.data;
}

/** Redact credentials in a Postgres URL for logging. */
function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.password) u.password = "***";
    return u.toString();
  } catch {
    return "***";
  }
}

/**
 * A secret-free summary of the effective configuration, for structured startup logging (OR-017).
 * Credentials are never included: the DB URL is password-redacted and the API-key secret is masked.
 */
export function configSummary(c: AppConfig): Record<string, unknown> {
  return {
    nodeEnv: c.nodeEnv,
    host: c.host,
    port: c.port,
    databaseUrl: redactUrl(c.databaseUrl),
    apiKeySecret: "***",
    poolMax: c.poolMax,
    shutdownTimeoutMs: c.shutdownTimeoutMs,
    logLevel: c.logLevel,
    logFormat: c.logFormat,
    metricsPort: c.metricsPort,
    otlpEndpoint: c.otlpEndpoint || "(disabled)",
    traceSampleRatio: c.traceSampleRatio,
    canaryEnabled: c.canaryEnabled,
    canaryIntervalMs: c.canaryIntervalMs,
    // Synthetic tenant fixtures are non-secret reserved UUIDs; shown for operability. Empty when unset.
    canaryScopedTenant: c.canaryScopedTenant || "(unset)",
    canaryTargetTenant: c.canaryTargetTenant || "(unset)",
    // E013 enforcement windows (non-secret; deployment-wide defaults, per-plan overrides resolved live).
    enforcementRenewalWindowSecs: c.enforcementRenewalWindowSecs,
    enforcementHeartbeatCadenceSecs: c.enforcementHeartbeatCadenceSecs,
    enforcementHeartbeatGraceBeats: c.enforcementHeartbeatGraceBeats,
    enforcementCrlNextUpdateSecs: c.enforcementCrlNextUpdateSecs,
    enforcementOfflineToleranceSecs: c.enforcementOfflineToleranceSecs,
    // E014 billing windows (non-secret; deployment-wide defaults, per-connection grace policy resolved live).
    billingDefaultGraceSeconds: c.billingDefaultGraceSeconds,
    billingSignatureToleranceSecs: c.billingSignatureToleranceSecs,
    billingWebhookRateMaxPerConnection: c.billingWebhookRateMaxPerConnection,
    billingWebhookRateMaxPerIp: c.billingWebhookRateMaxPerIp,
    billingWebhookRateWindow: c.billingWebhookRateWindow,
    billingLedgerRetentionSecs: c.billingLedgerRetentionSecs,
    billingSecretRotationWindowSecs: c.billingSecretRotationWindowSecs,
    // E015 lease windows (non-secret; deployment-wide defaults, per-license snapshot resolved live).
    leaseHeartbeatSeconds: c.leaseHeartbeatSeconds,
    leaseTtlSeconds: c.leaseTtlSeconds,
    leaseGraceSeconds: c.leaseGraceSeconds,
    leaseSweepSeconds: c.leaseSweepSeconds,
    leaseScope: c.leaseScope,
    leaseOverageAllowance: c.leaseOverageAllowance,
    leaseSweepMaxBatch: c.leaseSweepMaxBatch,
    leaseRateMax: c.leaseRateMax,
    leaseRateWindow: c.leaseRateWindow,
    leaseSignedHandle: c.leaseSignedHandle,
    // Secrets are never summarised: presence-only, never the value.
    leaseHolderKeySalt: c.leaseHolderKeySalt ? "***" : "(unset)",
    fingerprintPepper: c.fingerprintPepper ? "***" : "(unset)",
    otlpAuthToken: c.otlpAuthToken ? "***" : "(unset)",
  };
}
