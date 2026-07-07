// T009/T011 (OR-005/006/008/009/017): the validated config contract + <VAR>_FILE secret resolution.
// Pure, no DB: exercises defaults, fail-fast naming, file-mounted secrets (precedence, trim, empty=missing),
// and the secret-free startup summary.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { configSummary, ConfigError, loadConfig, resolveDatabaseUrl } from "../index.js";
import { applySecretFile, readSecret } from "../secrets.js";

const DB = "postgres://user:s3cret@db:5432/licensesrv";
const dir = mkdtempSync(path.join(tmpdir(), "e006-config-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function secretFile(name: string, contents: string): string {
  const p = path.join(dir, name);
  writeFileSync(p, contents);
  return p;
}

describe("loadConfig (OR-005/006)", () => {
  it("applies safe defaults when only the required settings are present", () => {
    const c = loadConfig({ DATABASE_URL: DB, API_KEY_SECRET: "k" });
    expect(c).toMatchObject({
      host: "0.0.0.0",
      port: 8080,
      poolMax: 10,
      shutdownTimeoutMs: 10_000,
      logLevel: "info",
      nodeEnv: "production",
      databaseUrl: DB,
      apiKeySecret: "k",
    });
  });

  it("fails fast naming a missing required setting", () => {
    expect(() => loadConfig({ API_KEY_SECRET: "k" })).toThrow(ConfigError);
    expect(() => loadConfig({ API_KEY_SECRET: "k" })).toThrow(/DATABASE_URL/);
    expect(() => loadConfig({ DATABASE_URL: DB })).toThrow(/API_KEY_SECRET/);
  });

  it("rejects an invalid port", () => {
    expect(() => loadConfig({ DATABASE_URL: DB, API_KEY_SECRET: "k", PORT: "99999" })).toThrow(ConfigError);
  });

  it("coerces numeric + honors overrides", () => {
    const c = loadConfig({ DATABASE_URL: DB, API_KEY_SECRET: "k", PORT: "9000", DB_POOL_MAX: "20", LOG_LEVEL: "debug" });
    expect(c.port).toBe(9000);
    expect(c.poolMax).toBe(20);
    expect(c.logLevel).toBe("debug");
  });
});

describe("<VAR>_FILE secret resolution (OR-008/009)", () => {
  it("reads a secret from its _FILE and trims a trailing newline", () => {
    const c = loadConfig({ DATABASE_URL_FILE: secretFile("db", `${DB}\n`), API_KEY_SECRET: "k" });
    expect(c.databaseUrl).toBe(DB); // newline trimmed, no double value
  });

  it("prefers _FILE over the direct variable", () => {
    const c = loadConfig({ API_KEY_SECRET: "direct", API_KEY_SECRET_FILE: secretFile("k", "fromfile"), DATABASE_URL: DB });
    expect(c.apiKeySecret).toBe("fromfile");
  });

  it("treats an empty secret file as missing → fail-fast", () => {
    expect(() => loadConfig({ DATABASE_URL: DB, API_KEY_SECRET_FILE: secretFile("empty", "") })).toThrow(/API_KEY_SECRET/);
  });

  it("treats a nonexistent _FILE path as missing → fail-fast", () => {
    expect(() => loadConfig({ DATABASE_URL: DB, API_KEY_SECRET_FILE: path.join(dir, "nope") })).toThrow(/API_KEY_SECRET/);
  });

  it("readSecret + applySecretFile behave as documented", () => {
    const env: NodeJS.ProcessEnv = { X_FILE: secretFile("x", "value\n") };
    expect(readSecret(env, "X")).toBe("value");
    applySecretFile(env, "X");
    expect(env.X).toBe("value"); // hydrated into the direct var for downstream readers
    // Direct var already set → applySecretFile is a no-op.
    const env2: NodeJS.ProcessEnv = { Y: "already", Y_FILE: secretFile("y", "other") };
    applySecretFile(env2, "Y");
    expect(env2.Y).toBe("already");
  });
});

describe("resolveDatabaseUrl (migrate job — OR-011)", () => {
  it("resolves the DB URL alone without requiring the API-key secret", () => {
    expect(resolveDatabaseUrl({ DATABASE_URL: DB })).toBe(DB);
    expect(() => resolveDatabaseUrl({})).toThrow(/DATABASE_URL/);
  });
});

describe("configSummary (OR-017 — no secret disclosure)", () => {
  it("masks the api-key secret and redacts the DB password", () => {
    const c = loadConfig({ DATABASE_URL: DB, API_KEY_SECRET: "super-secret-value" });
    const summary = JSON.stringify(configSummary(c));
    expect(summary).not.toContain("super-secret-value");
    expect(summary).not.toContain("s3cret"); // DB password redacted
    expect(summary).toContain("***");
    expect(summary).toContain("licensesrv"); // non-secret host/db name still shown
  });
});
