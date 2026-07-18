// T013 (OR-002/004/020): secret/PII redaction + request-id trust boundary. Pure — no DB/testcontainers.
// Verifies secrets/headers/keys are masked, signing-key material is EXCLUDED (not masked), machine
// fingerprints are HMAC-hashed (deterministic + irreversible), redaction FAILS CLOSED (unsafe fields
// dropped), and the server request_id is a DISTINCT field from the sanitized client_request_id.
import { type FastifyReply, type FastifyRequest } from "fastify";
import { describe, expect, it } from "vitest";

import {
  buildRequestLog,
  createLogger,
  hashFingerprint,
  redact,
  REDACTION_PLACEHOLDER,
  REDACTION_RULES,
} from "../logger.js";
import { genReqId, runWithContext, sanitizeClientRequestId } from "../request-context.js";

type Rec = Record<string, unknown>;

function fakeReq(method: string, url: string): FastifyRequest {
  return { id: "fallback-id", method, url, routeOptions: { url } } as unknown as FastifyRequest;
}
function fakeReply(statusCode: number): FastifyReply {
  return { statusCode } as unknown as FastifyReply;
}

describe("redact — secrets, headers, keys (OR-004)", () => {
  it("masks credential/secret fields with the placeholder", () => {
    const r = redact({
      authorization: "Bearer abc.def-123",
      "x-api-key": "k-secret-123",
      apiKeySecret: "s-456",
      password: "hunter2",
      licenseKey: "LIC-ZZZ",
      licenseToken: "eyJhbGciOi.payload.sig",
      databaseUrl: "postgres://u:pw@h:5432/db",
      otlpAuthToken: "otlp-token-789",
    }) as Rec;

    for (const key of [
      "authorization",
      "x-api-key",
      "apiKeySecret",
      "password",
      "licenseKey",
      "licenseToken",
      "databaseUrl",
      "otlpAuthToken",
    ]) {
      expect(r[key]).toBe(REDACTION_PLACEHOLDER);
    }
    const serialized = JSON.stringify(r);
    for (const secret of ["k-secret-123", "hunter2", "LIC-ZZZ", "otlp-token-789", "eyJhbGciOi"]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("redacts nested headers and scrubs embedded DSN / bearer tokens in free text", () => {
    const r = redact({
      req: { headers: { authorization: "Bearer t-123", "x-api-key": "kk-99" } },
      note: "connect postgres://user:supersecret@db:5432/app failed",
      trace: "downstream sent Authorization: Bearer sk-9.ab-c earlier",
    }) as Rec;

    const headers = (r.req as Rec).headers as Rec;
    expect(headers.authorization).toBe(REDACTION_PLACEHOLDER);
    expect(headers["x-api-key"]).toBe(REDACTION_PLACEHOLDER);
    expect(r.note).not.toContain("supersecret");
    expect(r.note).toContain(REDACTION_PLACEHOLDER);
    expect(r.trace).toContain(`Bearer ${REDACTION_PLACEHOLDER}`);
    expect(JSON.stringify(r)).not.toContain("sk-9.ab-c");
  });

  it("excludes signing-key material entirely — omitted, never masked (OR-020)", () => {
    const r = redact({
      keyId: "kid-1",
      signingKey: "PRIVATE-BYTES",
      signingPayload: "to-be-signed-blob",
      privateKey: "PRIV-XYZ",
      keyBytes: "RAW-KEY-BYTES",
      outcome: "signed",
    }) as Rec;

    for (const key of ["keyId", "signingKey", "signingPayload", "privateKey", "keyBytes"]) {
      expect(r).not.toHaveProperty(key);
    }
    expect(r.outcome).toBe("signed"); // non-sensitive signer attribute survives
    const serialized = JSON.stringify(r);
    // Neither the values nor a masking placeholder appear — the fields are gone entirely.
    for (const material of ["PRIVATE-BYTES", "to-be-signed-blob", "PRIV-XYZ", "RAW-KEY-BYTES"]) {
      expect(serialized).not.toContain(material);
    }
    expect(serialized).not.toContain(REDACTION_PLACEHOLDER);
  });

  it("scrubs secrets from Error message and stack payloads", () => {
    const err = new Error("db connect failed for postgres://svc:topsecret@pg/app");
    const r = redact({ err }) as Rec;
    const serialized = JSON.stringify(r.err);
    const errObj = r.err as Rec;
    expect(errObj.type).toBe("Error");
    expect(String(errObj.message)).toContain(REDACTION_PLACEHOLDER);
    expect(serialized).not.toContain("topsecret");
  });

  it("exposes the redaction rule set as an inspectable, fail-closed contract", () => {
    expect(REDACTION_RULES.failClosed).toBe(true);
    expect(REDACTION_RULES.masked).toContain("authorization");
    expect(REDACTION_RULES.masked).toContain("xapikey");
    expect(REDACTION_RULES.omitted).toContain("signingpayload");
    expect(REDACTION_RULES.hashed).toContain("fingerprint");
  });
});

describe("hashFingerprint — deterministic one-way keyed hash (OR-004)", () => {
  it("is deterministic and irreversible with a pepper", () => {
    const raw = "MACHINE-FP-9f3c1a";
    const a = hashFingerprint(raw, "pepper-A");
    const b = hashFingerprint(raw, "pepper-A");
    expect(a).toBe(b); // same input + pepper → same hash (correlatable)
    expect(a.startsWith("fp_")).toBe(true);
    expect(a).not.toContain(raw); // raw value not recoverable from the digest
  });

  it("is keyed — a different pepper yields a different hash", () => {
    const raw = "MACHINE-FP-9f3c1a";
    expect(hashFingerprint(raw, "pepper-A")).not.toBe(hashFingerprint(raw, "pepper-B"));
  });

  it("still hashes one-way with an empty pepper (weaker, documented guarantee)", () => {
    const raw = "abc-123";
    const h = hashFingerprint(raw);
    expect(h.startsWith("fp_")).toBe(true);
    expect(h).not.toContain(raw);
    expect(hashFingerprint(raw)).toBe(h); // still deterministic
  });

  it("hashes fingerprint fields through redact with the supplied pepper", () => {
    const raw = "MACHINE-XYZ";
    const r1 = redact({ fingerprint: raw }, "pep") as Rec;
    const r2 = redact({ fingerprint: raw }, "pep") as Rec;
    expect(r1.fingerprint).toBe(hashFingerprint(raw, "pep"));
    expect(r1.fingerprint).toBe(r2.fingerprint);
    expect(String(r1.fingerprint)).not.toContain(raw);
  });
});

describe("redact — fail closed (OR-004)", () => {
  it("drops values that cannot be safely serialized", () => {
    const r = redact({
      keep: "safe",
      fn: () => 1,
      sym: Symbol("s"),
      undef: undefined,
      bin: Buffer.from("raw-key-bytes"),
    }) as Rec;
    expect(r.keep).toBe("safe");
    for (const key of ["fn", "sym", "undef", "bin"]) {
      expect(r).not.toHaveProperty(key);
    }
    expect(JSON.stringify(r)).not.toContain("raw-key-bytes");
  });

  it("drops a field whose getter throws rather than emitting it", () => {
    const hostile: Rec = {};
    Object.defineProperty(hostile, "boom", {
      enumerable: true,
      get() {
        throw new Error("cannot read");
      },
    });
    expect(redact(hostile)).toEqual({}); // the unreadable field is omitted
  });

  it("drops circular references instead of throwing", () => {
    const circular: Rec = { a: 1 };
    circular.self = circular;
    const r = redact(circular) as Rec;
    expect(r.a).toBe(1);
    expect(r).not.toHaveProperty("self");
  });
});

describe("createLogger — redaction is wired into emitted lines (OR-004)", () => {
  it("masks secrets and hashes fingerprints in the JSON output", () => {
    const lines: Rec[] = [];
    const logger = createLogger(
      { logLevel: "info", logFormat: "json", fingerprintPepper: "pep" },
      { write: (s: string) => void lines.push(JSON.parse(s) as Rec) },
    );
    logger.info({ authorization: "Bearer secret-xyz", fingerprint: "M-1", tenant_id: "t1" }, "hello");
    const line = lines.at(-1) as Rec;
    expect(line.authorization).toBe(REDACTION_PLACEHOLDER);
    expect(line.fingerprint).toBe(hashFingerprint("M-1", "pep"));
    expect(line.tenant_id).toBe("t1"); // non-secret business field preserved
    expect(JSON.stringify(line)).not.toContain("secret-xyz");
  });
});

describe("request_id vs client_request_id — trust boundary (OR-002)", () => {
  it("sanitizes the inbound client tag (bounded length, printable ASCII, trimmed)", () => {
    expect(sanitizeClientRequestId("corr-123")).toBe("corr-123");
    expect(sanitizeClientRequestId("  trimmed \n")).toBe("trimmed");
    expect(sanitizeClientRequestId("a".repeat(200))).toHaveLength(128);
    expect(sanitizeClientRequestId("")).toBeUndefined();
    expect(sanitizeClientRequestId(12345)).toBeUndefined();
  });

  it("records client_request_id as a DISTINCT field that never overwrites request_id", () => {
    const serverId = genReqId();
    const clientId = sanitizeClientRequestId("client-corr-42");
    expect(clientId).toBe("client-corr-42");
    expect(serverId).not.toBe(clientId); // server id is authoritative + independent

    const fields = runWithContext({ requestId: serverId, clientRequestId: clientId, tenantId: "t1" }, () =>
      buildRequestLog(fakeReq("GET", "/v1/x"), fakeReply(200)),
    );
    expect(fields.request_id).toBe(serverId);
    expect(fields.client_request_id).toBe(clientId);
    expect(fields.request_id).not.toBe(fields.client_request_id);
  });

  it("omits client_request_id entirely when the client supplied nothing usable", () => {
    const serverId = genReqId();
    const fields = runWithContext({ requestId: serverId }, () =>
      buildRequestLog(fakeReq("GET", "/v1/x"), fakeReply(200)),
    );
    expect(fields.request_id).toBe(serverId);
    expect(fields).not.toHaveProperty("client_request_id");
  });
});
