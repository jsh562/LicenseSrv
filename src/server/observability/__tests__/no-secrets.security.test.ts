// T049 (OR-004/020, {SAD:ADR-0009} tenant-safe telemetry): a security assertion that NO secret or
// signing-key material ever survives into an emitted telemetry signal — the log line, the metrics
// exposition, or a span's attributes — and that the metrics listener binds to a NON-PUBLIC (loopback)
// interface, never 0.0.0.0. Pure, fast, no container.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type pino from "pino";
import { describe, expect, it } from "vitest";

import { loadConfig } from "../../config/index.js";
import { createLogger, REDACTION_PLACEHOLDER, redact } from "../logger.js";
import { FORBIDDEN_LABEL_NAMES, recordRed, recordSignerCall, registry, setSignerAvailability } from "../metrics.js";
import {
  redactedSignerException,
  safeSignerAttributes,
  scrubSpanAttributes,
  SENSITIVE_SPAN_ATTRIBUTE_KEYS,
  type SignerSpanAttributes,
} from "../tracing.js";

// Distinctive, unique secret tokens so a substring search is unambiguous. If ANY of these appears in a
// rendered signal, redaction/exclusion failed.
const API_KEY = "sk_live_APIKEY_5f3a9c2e7b1d4082";
const LICENSE_KEY = "LIC-DEADBEEF-CAFEBABE-0F1E2D3C";
const DSN_PASSWORD = "SUPERSECRETpw9000";
const DSN = `postgres://dbuser:${DSN_PASSWORD}@db.internal:5432/licensesrv`;
const SIGNING_KEY_BYTES = "ed25519priv9a8b7c6d5e4f30211f2e3d4c5b6a7988";
const SIGNING_KEY_ID = "key-2026-07-primary-xyz";
const SIGNING_PAYLOAD = "tobesigned-claims-payload-42";
const FINGERPRINT = "machine-fp-112233445566-AABBCCDD";

/** Every raw secret that MUST NOT appear verbatim in any emitted signal. */
const ALL_SECRETS = [
  API_KEY,
  LICENSE_KEY,
  DSN_PASSWORD,
  SIGNING_KEY_BYTES,
  SIGNING_KEY_ID,
  SIGNING_PAYLOAD,
  FINGERPRINT,
];

/** Assert none of the raw secrets appear in `text`. */
function assertNoSecrets(text: string, context: string): void {
  for (const secret of ALL_SECRETS) {
    expect(text.includes(secret), `${context} leaked secret "${secret}"`).toBe(false);
  }
}

/** A secret-laden object planted across secret / signing-key / fingerprint / free-text field shapes. */
function secretLadenPayload(): Record<string, unknown> {
  return {
    msg: "handling activation",
    authorization: `Bearer ${API_KEY}`,
    "x-api-key": API_KEY,
    apiKey: API_KEY,
    licenseKey: LICENSE_KEY,
    databaseUrl: DSN,
    // Signing-key material — OR-020 total exclusion (omitted, never masked).
    keyId: SIGNING_KEY_ID,
    signingKey: SIGNING_KEY_BYTES,
    signingPayload: SIGNING_PAYLOAD,
    keyBytes: new Uint8Array([1, 2, 3, 4]),
    // Raw PII fingerprint — one-way hashed.
    fingerprint: FINGERPRINT,
    // Secrets embedded in free text (error messages / notes) — scrubbed in place.
    note: `connect ${DSN} using Bearer ${API_KEY}`,
    nested: { password: DSN_PASSWORD, inner: { token: API_KEY, machineFingerprint: FINGERPRINT } },
  };
}

describe("no secrets in the LOG signal (OR-004/020)", () => {
  it("emits a redacted log line carrying no raw secret / signing-key / fingerprint material", () => {
    let captured = "";
    const sink: pino.DestinationStream = { write: (s: string) => (captured += s) };
    const logger = createLogger({ logLevel: "info", logFormat: "json", fingerprintPepper: "unit-pepper" }, sink);

    logger.info(secretLadenPayload(), "request completed");

    expect(captured.length).toBeGreaterThan(0);
    assertNoSecrets(captured, "log line");
    // Positive evidence redaction actually ran: masked placeholder + a hashed (fp_) fingerprint present.
    expect(captured).toContain(REDACTION_PLACEHOLDER);
    expect(captured).toMatch(/fp_[0-9a-f]{64}/);
  });

  it("redact() returns a structure with no raw secret material", () => {
    const cleaned = JSON.stringify(redact(secretLadenPayload(), "unit-pepper"));
    assertNoSecrets(cleaned, "redact() output");
    // Signing-key FIELDS are omitted entirely (not even a placeholder confirms their presence).
    const obj = redact(secretLadenPayload(), "unit-pepper") as Record<string, unknown>;
    expect("keyId" in obj).toBe(false);
    expect("signingKey" in obj).toBe(false);
    expect("signingPayload" in obj).toBe(false);
    expect("keyBytes" in obj).toBe(false);
  });
});

describe("no secrets in the METRICS signal (OR-008/020)", () => {
  it("renders no secret material and no high-cardinality identity labels", async () => {
    // Record benign RED + signer series (the recording APIs only accept bounded, non-secret fields).
    setSignerAvailability(true);
    recordRed({ route: "/v1/activations", method: "POST", outcome: "success", durationMs: 12 });
    recordSignerCall({ outcome: "success", durationMs: 3 });

    const text = await registry.metrics();
    assertNoSecrets(text, "metrics exposition");

    // The binding cardinality/tenant-safety policy: these identity labels MUST NOT appear anywhere.
    for (const forbidden of FORBIDDEN_LABEL_NAMES) {
      expect(text.includes(`${forbidden}=`), `metrics carried forbidden label ${forbidden}`).toBe(false);
    }
    // Signer telemetry is availability/outcome only — never key material. (The word "key" appears only in
    // the metrics' HELP text as "no key material"; the guarantee is the absence of any real key VALUE,
    // asserted above, and that no key-identity LABEL is attached to the signer series.)
    expect(text).toContain("signer_up");
    expect(text).not.toMatch(/signer_[a-z_]*\{[^}]*key/i);
  });
});

describe("no secrets in the SPAN signal (OR-013/020)", () => {
  it("safeSignerAttributes drops everything but availability/latency/outcome", () => {
    // A loosely-typed caller tries to smuggle key material onto the signer span.
    const smuggled = {
      outcome: "error",
      available: false,
      latencyMs: 7,
      keyId: SIGNING_KEY_ID,
      signingKey: SIGNING_KEY_BYTES,
      signingPayload: SIGNING_PAYLOAD,
    } as unknown as SignerSpanAttributes;

    const attrs = safeSignerAttributes(smuggled);
    assertNoSecrets(JSON.stringify(attrs), "signer span attributes");
    expect(Object.keys(attrs).sort()).toEqual(["signer.available", "signer.latency_ms", "signer.outcome"]);
  });

  it("redactedSignerException keeps only the error name and a fixed safe message", () => {
    const err = new Error(`signing failed with key ${SIGNING_KEY_BYTES} payload ${SIGNING_PAYLOAD}`);
    err.name = "SignerError";
    const ex = redactedSignerException(err);
    assertNoSecrets(JSON.stringify(ex), "redacted signer exception");
    expect(ex.name).toBe("SignerError");
    expect(ex.message).not.toContain(SIGNING_KEY_BYTES);
  });

  it("scrubSpanAttributes strips raw SQL / parameter attributes that could carry keys or PII", () => {
    const attributes: Record<string, unknown> = {
      "db.system": "postgresql",
      "db.statement": `SELECT * FROM licenses WHERE key = '${LICENSE_KEY}'`,
      "db.query.text": `INSERT ... '${LICENSE_KEY}'`,
      "db.postgresql.values": `['${FINGERPRINT}']`,
      "http.route": "/v1/activations",
    };
    scrubSpanAttributes(attributes);
    assertNoSecrets(JSON.stringify(attributes), "scrubbed span attributes");
    for (const key of SENSITIVE_SPAN_ATTRIBUTE_KEYS) {
      expect(key in attributes).toBe(false);
    }
    // Non-sensitive attributes survive.
    expect(attributes["http.route"]).toBe("/v1/activations");
  });
});

describe("metrics listener binds a NON-PUBLIC interface (OR-005 / AD-001)", () => {
  it("defaults to loopback (127.0.0.1), never 0.0.0.0, in source", () => {
    const src = readFileSync(fileURLToPath(new URL("../metrics.ts", import.meta.url)), "utf8");
    // The listener defaults its bind host to loopback.
    expect(src).toMatch(/opts\.host\s*\?\?\s*"127\.0\.0\.1"/);
    // It must never default the metrics bind to the public wildcard interface.
    expect(src).not.toContain('host = opts.host ?? "0.0.0.0"');
  });

  it("exposes metrics on a DEDICATED port distinct from the public API listener", () => {
    const config = loadConfig({
      DATABASE_URL: "postgres://u:p@localhost:5432/db",
      API_KEY_SECRET: "unit-secret",
    } as NodeJS.ProcessEnv);
    // Metrics live on their own port, off the public API port (AD-001).
    expect(config.metricsPort).not.toBe(config.port);
    // The public API listener defaults to the wildcard interface; metrics stay on loopback (above), so the
    // two are genuinely separate surfaces — metrics is never co-hosted on the public interface.
    expect(config.host).toBe("0.0.0.0");
  });
});
