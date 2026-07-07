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
  };
}
