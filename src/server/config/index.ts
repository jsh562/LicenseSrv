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
  // Usage metering & aggregation (E016, FR-004/005/015; per ADR-0013). Deployment-wide DEFAULTS for the
  // bounded retention/dedupe window (raw events + idempotency keys pruned after it; also the single stale-
  // event acceptance bound), the future-skew allowance (an event beyond it → future_event), the FIXED
  // hourly rollup grain, the rollup-sweep cadence, the per-API-key ingest rate ceiling + window, the max
  // batch cap (contract hard limit 1,000), and the query-window bucket-count bound. The usage module
  // (`modules/usage/config.ts`) reads the same SCREAMING_SNAKE keys LIVE. All defaulted + non-secret.
  usageRetentionSecs: number; // USAGE_RETENTION_SECS — retention/dedupe window (~35d); also the stale-event acceptance bound (FR-004/015)
  usageFutureSkewSecs: number; // USAGE_FUTURE_SKEW_SECS — allowed future skew of event_time before future_event (~5m) (FR-004)
  usageBucketSeconds: number; // USAGE_BUCKET_SECONDS — FIXED hourly rollup grain (3600) (FR-010)
  usageRollupIntervalMs: number; // USAGE_ROLLUP_INTERVAL_MS — fail-open watermark rollup sweep cadence (~1m) (FR-010)
  usageIngestRateMax: number; // USAGE_INGEST_RATE_MAX — per-API-key ingest rate ceiling per window (FR-005)
  usageIngestRateWindow: string; // USAGE_INGEST_RATE_WINDOW — ingest rate-limit window, e.g. "1 minute" (FR-005)
  usageMaxBatch: number; // USAGE_MAX_BATCH — max events per ingest batch; clamped to the contract ceiling 1000 (FR-005)
  usageQueryMaxHours: number; // USAGE_QUERY_MAX_HOURS — query-window span bound (bucket-count cap) → window_too_large (~90d) (FR-011)
  // Low-code policy rules (E017, FR-009/014/019/021; per {SAD:ADR-0014}). Deployment-wide DEFAULTS for the
  // sandbox resource bounds (per-evaluation timeout; author-time JSON size / AST-depth / complexity caps on
  // the guarded condition), the bounded decision-context caps (serialized size / JSON-depth / field-count —
  // FR-004/020, the SAME caps a dry-run supplied context is bound against), the three FR-019 cost caps (max
  // rules per entitlement + per tenant authored at author time, and max rules evaluated per issuance which
  // fails closed), the FR-021 absolute per-entitlement authored-max ceiling (`rule_max` can never exceed it),
  // the FR-014 append-only `policy_evaluation` retention window, and the conflict-resolution policy. The
  // policy module (`modules/policy/config.ts`) reads the same SCREAMING_SNAKE keys LIVE. All defaulted +
  // non-secret (the engine performs NO cryptography and holds no secret — FR-018).
  policyEvalTimeoutMs: number; // POLICY_EVAL_TIMEOUT_MS — per-evaluation sandbox timeout (fail-closed on breach) (FR-009)
  policyConditionMaxBytes: number; // POLICY_CONDITION_MAX_BYTES — author-time serialized condition size cap → condition_too_large (FR-009)
  policyConditionMaxDepth: number; // POLICY_CONDITION_MAX_DEPTH — author-time condition AST-depth cap (FR-009)
  policyConditionMaxComplexity: number; // POLICY_CONDITION_MAX_COMPLEXITY — author-time condition node-count / complexity cap (FR-009)
  policyContextMaxBytes: number; // POLICY_CONTEXT_MAX_BYTES — decision-context serialized size cap (real + dry-run supplied) (FR-004/020)
  policyContextMaxDepth: number; // POLICY_CONTEXT_MAX_DEPTH — decision-context JSON-depth cap (FR-004/020)
  policyContextMaxFields: number; // POLICY_CONTEXT_MAX_FIELDS — decision-context field-count cap (FR-004/020)
  policyMaxRulesPerEntitlement: number; // POLICY_MAX_RULES_PER_ENTITLEMENT — per-entitlement live rule-set size cap → rule_set_limit_exceeded (FR-019)
  policyMaxRulesPerTenant: number; // POLICY_MAX_RULES_PER_TENANT — per-tenant live rule-set size cap → rule_set_limit_exceeded (FR-019)
  policyMaxRulesPerIssuance: number; // POLICY_MAX_RULES_PER_ISSUANCE — max rules evaluated per issuance; over it → fail-closed (FR-019)
  policyAbsoluteMaxLimit: number; // POLICY_ABSOLUTE_MAX_LIMIT — absolute per-entitlement authored-max ceiling `rule_max` can never exceed (FR-021)
  policyEvaluationRetentionSecs: number; // POLICY_EVALUATION_RETENTION_SECS — append-only policy_evaluation retention window (~90d) (FR-014)
  policyConflictPolicy: "highest_priority_wins"; // POLICY_CONFLICT_POLICY — conflict-resolution policy (highest-priority-wins one effect) (FR-006)
  // Reseller & white-label tenancy (E018, FR-003/007/008/012; per {SAD:ADR-0015}). Deployment-wide DEFAULTS
  // for the default hard sub-tenant quota a newly-onboarded reseller receives (FR-003/010), the offboarding
  // grace window (the stable anchor `graceEndsAt = offboarding_started_at + this` — FR-012), the comma-
  // separated non-white-labelable trust-signal set the branding resolver ALWAYS sources authoritatively and
  // NEVER from `branding_profile` (FR-008), and the platform-default branding values that back the lowest
  // precedence tier (sub-tenant override → reseller default → platform default — FR-007). The reseller module
  // (`modules/reseller/config.ts`) reads the same SCREAMING_SNAKE keys LIVE. All defaulted + non-secret (this
  // epic performs NO cryptography and holds no secret — presentation-only, Principle I).
  resellerDefaultSubTenantQuota: number; // RESELLER_DEFAULT_SUBTENANT_QUOTA — default hard sub-tenant cap at onboarding (FR-003/010)
  resellerOffboardingGraceSecs: number; // RESELLER_OFFBOARDING_GRACE_SECS — offboarding grace window (~30d); graceEndsAt anchor (FR-012)
  resellerTrustSignals: string; // RESELLER_TRUST_SIGNALS — comma-separated non-white-labelable trust-signal set (FR-008)
  resellerPlatformProductName: string; // RESELLER_PLATFORM_PRODUCT_NAME — platform-default product name (branding floor) (FR-007)
  resellerPlatformColorPrimary: string; // RESELLER_PLATFORM_COLOR_PRIMARY — platform-default primary color (branding floor) (FR-007)
  resellerPlatformColorSecondary: string; // RESELLER_PLATFORM_COLOR_SECONDARY — platform-default secondary color (branding floor) (FR-007)
  resellerPlatformSupportUrl: string; // RESELLER_PLATFORM_SUPPORT_URL — platform-default support URL (branding floor) (FR-007)
  resellerPlatformHelpUrl: string; // RESELLER_PLATFORM_HELP_URL — platform-default help URL (branding floor) (FR-007)
  resellerPlatformLogoRef: string; // RESELLER_PLATFORM_LOGO_REF — platform-default logo reference (branding floor) (FR-007)
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
  // E016 usage-metering defaults — retention/dedupe window ~35d (also the stale-event bound), future-skew
  // allowance ~5m, FIXED hourly grain (3600s), rollup sweep ~1m, per-key ingest rate ceiling sized for a
  // high-write path, max batch 1000 (the contract ceiling), and a ~90d query-window bucket-count bound. The
  // usage module clamps the batch cap to ≤ 1000 at load. Operators retune without a migration.
  usageRetentionSecs: z.coerce.number().int().positive().default(3_024_000), // 35 days
  usageFutureSkewSecs: z.coerce.number().int().positive().default(300), // 5 minutes
  usageBucketSeconds: z.coerce.number().int().positive().default(3_600), // 1 hour (fixed grain)
  usageRollupIntervalMs: z.coerce.number().int().positive().default(60_000), // 1 minute
  usageIngestRateMax: z.coerce.number().int().positive().default(600),
  usageIngestRateWindow: z.string().min(1).default("1 minute"),
  usageMaxBatch: z.coerce.number().int().positive().default(1_000),
  usageQueryMaxHours: z.coerce.number().int().positive().default(2_160), // 90 days
  // E017 policy-rule defaults — a tight sandbox: a short per-evaluation timeout (issuance stays fast), small
  // author-time condition size/depth/complexity caps (the allow-list IS the security boundary), bounded
  // decision-context caps (also the dry-run supplied-context bound), the three FR-019 cost caps, a large-but-
  // finite absolute authored-max ceiling, a ~90d audit retention window, and highest-priority-wins conflict
  // resolution. The policy module reads the same SCREAMING_SNAKE keys LIVE. Operators retune without a migration.
  policyEvalTimeoutMs: z.coerce.number().int().positive().default(50), // 50 ms per-evaluation sandbox timeout
  policyConditionMaxBytes: z.coerce.number().int().positive().default(8_192), // 8 KiB serialized condition
  policyConditionMaxDepth: z.coerce.number().int().positive().default(16),
  policyConditionMaxComplexity: z.coerce.number().int().positive().default(128), // node-count / operator budget
  policyContextMaxBytes: z.coerce.number().int().positive().default(16_384), // 16 KiB serialized context
  policyContextMaxDepth: z.coerce.number().int().positive().default(8),
  policyContextMaxFields: z.coerce.number().int().positive().default(128),
  policyMaxRulesPerEntitlement: z.coerce.number().int().positive().default(50),
  policyMaxRulesPerTenant: z.coerce.number().int().positive().default(500),
  policyMaxRulesPerIssuance: z.coerce.number().int().positive().default(100),
  policyAbsoluteMaxLimit: z.coerce.number().positive().default(1_000_000_000), // absolute authored-max ceiling (numeric)
  policyEvaluationRetentionSecs: z.coerce.number().int().positive().default(7_776_000), // 90 days
  policyConflictPolicy: z.enum(["highest_priority_wins"]).default("highest_priority_wins"),
  // E018 reseller & white-label defaults — a sane default sub-tenant quota, a ~30d offboarding grace window,
  // the fixed non-white-labelable trust-signal set (revocation/tamper/signing-identity/audit/legal), and the
  // platform-default branding floor (product name + colors; support/help/logo empty by default). The reseller
  // module reads the same SCREAMING_SNAKE keys LIVE. Non-secret; operators retune without a migration.
  resellerDefaultSubTenantQuota: z.coerce.number().int().min(0).default(50),
  resellerOffboardingGraceSecs: z.coerce.number().int().positive().default(2_592_000), // 30 days
  resellerTrustSignals: z.string().min(1).default("revocation,tamper,signing_identity,audit,legal"),
  resellerPlatformProductName: z.string().default("License Server"),
  resellerPlatformColorPrimary: z.string().default("#1f2937"),
  resellerPlatformColorSecondary: z.string().default("#3b82f6"),
  resellerPlatformSupportUrl: z.string().default(""),
  resellerPlatformHelpUrl: z.string().default(""),
  resellerPlatformLogoRef: z.string().default(""),
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
    usageRetentionSecs: env.USAGE_RETENTION_SECS,
    usageFutureSkewSecs: env.USAGE_FUTURE_SKEW_SECS,
    usageBucketSeconds: env.USAGE_BUCKET_SECONDS,
    usageRollupIntervalMs: env.USAGE_ROLLUP_INTERVAL_MS,
    usageIngestRateMax: env.USAGE_INGEST_RATE_MAX,
    usageIngestRateWindow: env.USAGE_INGEST_RATE_WINDOW,
    usageMaxBatch: env.USAGE_MAX_BATCH,
    usageQueryMaxHours: env.USAGE_QUERY_MAX_HOURS,
    policyEvalTimeoutMs: env.POLICY_EVAL_TIMEOUT_MS,
    policyConditionMaxBytes: env.POLICY_CONDITION_MAX_BYTES,
    policyConditionMaxDepth: env.POLICY_CONDITION_MAX_DEPTH,
    policyConditionMaxComplexity: env.POLICY_CONDITION_MAX_COMPLEXITY,
    policyContextMaxBytes: env.POLICY_CONTEXT_MAX_BYTES,
    policyContextMaxDepth: env.POLICY_CONTEXT_MAX_DEPTH,
    policyContextMaxFields: env.POLICY_CONTEXT_MAX_FIELDS,
    policyMaxRulesPerEntitlement: env.POLICY_MAX_RULES_PER_ENTITLEMENT,
    policyMaxRulesPerTenant: env.POLICY_MAX_RULES_PER_TENANT,
    policyMaxRulesPerIssuance: env.POLICY_MAX_RULES_PER_ISSUANCE,
    policyAbsoluteMaxLimit: env.POLICY_ABSOLUTE_MAX_LIMIT,
    policyEvaluationRetentionSecs: env.POLICY_EVALUATION_RETENTION_SECS,
    policyConflictPolicy: env.POLICY_CONFLICT_POLICY,
    resellerDefaultSubTenantQuota: env.RESELLER_DEFAULT_SUBTENANT_QUOTA,
    resellerOffboardingGraceSecs: env.RESELLER_OFFBOARDING_GRACE_SECS,
    resellerTrustSignals: env.RESELLER_TRUST_SIGNALS,
    resellerPlatformProductName: env.RESELLER_PLATFORM_PRODUCT_NAME,
    resellerPlatformColorPrimary: env.RESELLER_PLATFORM_COLOR_PRIMARY,
    resellerPlatformColorSecondary: env.RESELLER_PLATFORM_COLOR_SECONDARY,
    resellerPlatformSupportUrl: env.RESELLER_PLATFORM_SUPPORT_URL,
    resellerPlatformHelpUrl: env.RESELLER_PLATFORM_HELP_URL,
    resellerPlatformLogoRef: env.RESELLER_PLATFORM_LOGO_REF,
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
    // E016 usage-metering windows (non-secret; deployment-wide defaults read live by the usage module).
    usageRetentionSecs: c.usageRetentionSecs,
    usageFutureSkewSecs: c.usageFutureSkewSecs,
    usageBucketSeconds: c.usageBucketSeconds,
    usageRollupIntervalMs: c.usageRollupIntervalMs,
    usageIngestRateMax: c.usageIngestRateMax,
    usageIngestRateWindow: c.usageIngestRateWindow,
    usageMaxBatch: c.usageMaxBatch,
    usageQueryMaxHours: c.usageQueryMaxHours,
    // E017 policy-rule bounds (non-secret; deployment-wide defaults read live by the policy module).
    policyEvalTimeoutMs: c.policyEvalTimeoutMs,
    policyConditionMaxBytes: c.policyConditionMaxBytes,
    policyConditionMaxDepth: c.policyConditionMaxDepth,
    policyConditionMaxComplexity: c.policyConditionMaxComplexity,
    policyContextMaxBytes: c.policyContextMaxBytes,
    policyContextMaxDepth: c.policyContextMaxDepth,
    policyContextMaxFields: c.policyContextMaxFields,
    policyMaxRulesPerEntitlement: c.policyMaxRulesPerEntitlement,
    policyMaxRulesPerTenant: c.policyMaxRulesPerTenant,
    policyMaxRulesPerIssuance: c.policyMaxRulesPerIssuance,
    policyAbsoluteMaxLimit: c.policyAbsoluteMaxLimit,
    policyEvaluationRetentionSecs: c.policyEvaluationRetentionSecs,
    policyConflictPolicy: c.policyConflictPolicy,
    // E018 reseller & white-label config (non-secret; deployment-wide defaults read live by the reseller module).
    resellerDefaultSubTenantQuota: c.resellerDefaultSubTenantQuota,
    resellerOffboardingGraceSecs: c.resellerOffboardingGraceSecs,
    resellerTrustSignals: c.resellerTrustSignals,
    resellerPlatformProductName: c.resellerPlatformProductName,
    resellerPlatformColorPrimary: c.resellerPlatformColorPrimary,
    resellerPlatformColorSecondary: c.resellerPlatformColorSecondary,
    resellerPlatformSupportUrl: c.resellerPlatformSupportUrl || "(unset)",
    resellerPlatformHelpUrl: c.resellerPlatformHelpUrl || "(unset)",
    resellerPlatformLogoRef: c.resellerPlatformLogoRef || "(unset)",
    // Secrets are never summarised: presence-only, never the value.
    leaseHolderKeySalt: c.leaseHolderKeySalt ? "***" : "(unset)",
    fingerprintPepper: c.fingerprintPepper ? "***" : "(unset)",
    otlpAuthToken: c.otlpAuthToken ? "***" : "(unset)",
  };
}
