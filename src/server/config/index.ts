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
    // Secrets follow the <VAR>_FILE convention (file wins; unset → empty, telemetry stays fail-open).
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
    // Secrets are never summarised: presence-only, never the value.
    fingerprintPepper: c.fingerprintPepper ? "***" : "(unset)",
    otlpAuthToken: c.otlpAuthToken ? "***" : "(unset)",
  };
}
