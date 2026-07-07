// File-mounted secret resolution (FR/OR-008/009, AD-002, DDR-005). Secrets are injected as mounted
// files, not baked into the image or exposed via `docker inspect`. The `<VAR>_FILE` convention wins
// over a direct `<VAR>`: if `NAME_FILE` points at a readable, non-empty file, its trimmed contents are
// the value; otherwise the direct `NAME` env var is used. An empty/unreadable file for a required
// secret resolves to `undefined` so config validation fails fast, naming the setting (OR-009).
import { readFileSync } from "node:fs";

/**
 * Resolve a secret by name using the `<VAR>_FILE` convention with a direct-env fallback.
 * Returns the trimmed value, or `undefined` when neither source yields a non-empty value
 * (an empty file or missing var is treated as "not set" — the caller fails fast if required).
 */
export function readSecret(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const filePath = env[`${name}_FILE`];
  if (filePath && filePath.trim() !== "") {
    try {
      const raw = readFileSync(filePath, "utf8").replace(/\r?\n$/, "");
      return raw === "" ? undefined : raw;
    } catch {
      return undefined; // unreadable/missing file → treat as unset (required check names it)
    }
  }
  const direct = env[name];
  return direct && direct !== "" ? direct : undefined;
}

/**
 * Hydrate a module-owned secret from its `<VAR>_FILE` into `env[name]` when the direct var is unset,
 * so downstream 12-factor env readers (e.g. the signing custody loader) see file-mounted secrets too.
 * No-op when the direct var is already set or no file is provided.
 */
export function applySecretFile(env: NodeJS.ProcessEnv, name: string): void {
  if (env[name] && env[name] !== "") return;
  const resolved = readSecret(env, name);
  if (resolved !== undefined) env[name] = resolved;
}
