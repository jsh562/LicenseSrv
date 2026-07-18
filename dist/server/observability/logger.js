// Structured logging core (OR-001/002/003/004/020, per {SAD:ADR-0009}). `createLogger` builds the pino
// instance Fastify runs on; `buildRequestLog` shapes the single per-request log line emitted exactly
// once by the `onResponse` hook in `app.ts`. This module also owns the secret/PII redaction rule set
// (`redact` / `hashFingerprint`) and the documented log-field contract (`REQUEST_LOG_CONTRACT`).
//
// Redaction is enforced UNIVERSALLY via pino `formatters.log` — every log object (not just the request
// line) is deep-scrubbed before serialization — and additionally via declarative pino `redact` paths +
// std serializers as an idiomatic belt-and-suspenders layer. Redaction FAILS CLOSED: any field that
// cannot be confidently rendered safe is dropped rather than emitted in the clear (OR-004). Signing-key
// material is excluded entirely, never merely masked (OR-020).
import { createHash, createHmac } from "node:crypto";
import { isSpanContextValid, trace } from "@opentelemetry/api";
import pino from "pino";
import { getRequestContext } from "./request-context.js";
/** The censor string substituted for a masked secret value. */
export const REDACTION_PLACEHOLDER = "[REDACTED]";
/** Prefix on a hashed machine fingerprint, so a hashed value is recognizable as such in logs. */
const FINGERPRINT_HASH_PREFIX = "fp_";
/** Max object depth `redact` walks before failing closed (guards pathological/hostile nesting). */
const MAX_REDACT_DEPTH = 8;
/**
 * Normalize a field key for rule matching: lowercase, strip every non-alphanumeric char. So
 * `x-api-key`, `x_api_key`, and `xApiKey` all collapse to `xapikey`.
 */
function normalizeKey(key) {
    return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}
/**
 * Signing-key material — OR-020 TOTAL EXCLUSION. Fields matching these names are OMITTED entirely
 * (key + value dropped), never masked: key ids, key bytes, and the signing payload/input must never
 * appear in any signal, not even as a `[REDACTED]` placeholder that would confirm their presence.
 */
const SIGNING_KEY_FIELDS = new Set([
    "keyid",
    "kid",
    "signingkeyid",
    "signingkey",
    "signingkeybytes",
    "privatekey",
    "keybytes",
    "keymaterial",
    "signingpayload",
    "signinginput",
    "signbytes",
    "tobesigned",
]);
/**
 * Secret / credential fields — OR-004 masking. The value is replaced with `REDACTION_PLACEHOLDER`.
 * Covers API keys + `Authorization`/`x-api-key` headers, bearer/session tokens, license keys and signed
 * license-token payloads, DB connection strings/DSNs, and OTLP/exporter secrets.
 */
const SECRET_FIELDS = new Set([
    "authorization",
    "cookie",
    "setcookie",
    "apikey",
    "xapikey",
    "apikeysecret",
    "password",
    "passwd",
    "pwd",
    "secret",
    "token",
    "accesstoken",
    "refreshtoken",
    "sessiontoken",
    "session",
    "bearertoken",
    "bearer",
    "licensekey",
    "licensetoken",
    "signedlicensetoken",
    "dsn",
    "connectionstring",
    "databaseurl",
    "dburl",
    "otlpauthtoken",
    "otelexporterotlpauthtoken",
    "exportersecret",
    "exporterpassword",
    "fingerprintpepper",
    "pepper",
    "salt",
]);
/**
 * Raw-PII fingerprint fields — OR-004 hashing. The value is replaced with a deterministic one-way
 * keyed hash (`hashFingerprint`) so the same machine stays correlatable across signals while the raw
 * fingerprint cannot be recovered.
 */
const FINGERPRINT_FIELDS = new Set([
    "fingerprint",
    "machinefingerprint",
    "devicefingerprint",
    "hwfingerprint",
    "hardwarefingerprint",
]);
/**
 * Declarative pino `redact` paths (fast-redact). Idiomatic belt for the classic request-header
 * locations; the universal `formatters.log` pass below is the authoritative, fail-closed enforcement.
 */
const REDACT_PATHS = [
    "req.headers.authorization",
    'req.headers["x-api-key"]',
    "req.headers.cookie",
    "res.headers[\"set-cookie\"]",
    "headers.authorization",
    'headers["x-api-key"]',
    "headers.cookie",
    "request.headers.authorization",
    'request.headers["x-api-key"]',
];
/**
 * Hash a raw machine fingerprint with a deterministic, one-way KEYED hash — HMAC-SHA-256 keyed by the
 * server-held `pepper` (OR-004). Same input → same output (correlatable across signals) while the raw
 * value cannot be recovered or cheaply brute-forced.
 *
 * WEAKER-GUARANTEE FALLBACK: when `pepper` is empty the hash is still one-way (unkeyed SHA-256) but
 * NOT keyed — an attacker who can enumerate a low-entropy fingerprint space can brute-force the digest
 * offline. Deployments handling real fingerprints MUST set `OBS_FINGERPRINT_PEPPER` to obtain the
 * keyed guarantee; the empty-pepper path exists only so the API stays bootable without the secret.
 */
export function hashFingerprint(raw, pepper = "") {
    if (pepper.length > 0) {
        return FINGERPRINT_HASH_PREFIX + createHmac("sha256", pepper).update(raw).digest("hex");
    }
    return FINGERPRINT_HASH_PREFIX + createHash("sha256").update(`fp:${raw}`).digest("hex");
}
// Embedded-secret patterns scrubbed from free-text string leaves (error messages, stack traces, notes).
/** A connection URI carrying `scheme://user:password@` credentials. */
const DSN_CREDENTIALS_RE = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s:/@]+:[^\s:/@]+@/gi;
/** An HTTP `Bearer <token>` credential appearing inside free text. */
const BEARER_TOKEN_RE = /\bBearer\s+[A-Za-z0-9._-]+/gi;
/** Scrub structured secrets embedded in a free-text string (DSN credentials, bearer tokens). */
function scrubString(value) {
    return value
        .replace(DSN_CREDENTIALS_RE, `$1${REDACTION_PLACEHOLDER}@`)
        .replace(BEARER_TOKEN_RE, `Bearer ${REDACTION_PLACEHOLDER}`);
}
/** Sentinel returned by the walker to signal "drop this field/element" (fail-closed omission). */
const DROP = Symbol("redact.drop");
/** True for binary payloads (may carry key bytes) — always dropped (fail-closed, OR-020). */
function isBinaryLike(value) {
    return value instanceof Uint8Array || value instanceof ArrayBuffer || value instanceof DataView;
}
/** Flatten an `Error` into a plain, scrub-able object: `{ type, message, stack, ...ownProps }`. */
function errorToPlain(err) {
    const plain = { type: err.name, message: err.message, stack: err.stack };
    for (const key of Object.keys(err)) {
        if (key === "type" || key === "message" || key === "stack")
            continue;
        try {
            plain[key] = err[key];
        }
        catch {
            /* unreadable own-prop → fail closed (omit) */
        }
    }
    return plain;
}
/** Recursively redact a value, returning the sanitized value or the `DROP` sentinel. */
function redactValue(value, pepper, depth, seen) {
    if (value === null)
        return null;
    const t = typeof value;
    if (t === "string")
        return scrubString(value);
    if (t === "number" || t === "boolean")
        return value;
    if (t === "bigint")
        return value.toString();
    // undefined | function | symbol → not safely serializable → fail closed (drop).
    if (t !== "object")
        return DROP;
    if (depth >= MAX_REDACT_DEPTH)
        return DROP;
    if (value instanceof Error) {
        return redactValue(errorToPlain(value), pepper, depth + 1, seen);
    }
    if (isBinaryLike(value))
        return DROP;
    if (seen.has(value))
        return DROP; // circular reference → fail closed
    seen.add(value);
    try {
        if (Array.isArray(value)) {
            const out = [];
            for (const item of value) {
                const r = redactValue(item, pepper, depth + 1, seen);
                if (r !== DROP)
                    out.push(r);
            }
            return out;
        }
        const out = {};
        let keys;
        try {
            keys = Object.keys(value);
        }
        catch {
            return DROP; // cannot even enumerate → fail closed
        }
        for (const key of keys) {
            const norm = normalizeKey(key);
            if (SIGNING_KEY_FIELDS.has(norm))
                continue; // OR-020: omit entirely, never mask
            if (SECRET_FIELDS.has(norm)) {
                out[key] = REDACTION_PLACEHOLDER;
                continue;
            }
            let raw;
            try {
                raw = value[key];
            }
            catch {
                continue; // throwing getter → fail closed (omit)
            }
            if (FINGERPRINT_FIELDS.has(norm)) {
                out[key] = typeof raw === "string" ? hashFingerprint(raw, pepper) : REDACTION_PLACEHOLDER;
                continue;
            }
            let child;
            try {
                child = redactValue(raw, pepper, depth + 1, seen);
            }
            catch {
                child = DROP; // any per-field failure → fail closed
            }
            if (child !== DROP)
                out[key] = child;
        }
        return out;
    }
    finally {
        seen.delete(value);
    }
}
/**
 * Deep-redact an arbitrary value for safe logging (OR-004/020). Rules, in precedence order:
 * 1. Signing-key material → OMITTED entirely (OR-020).
 * 2. Secret/credential fields → masked with `REDACTION_PLACEHOLDER`.
 * 3. Machine-fingerprint fields → replaced with a one-way keyed hash (`hashFingerprint`).
 * 4. String leaves → embedded DSNs / bearer tokens scrubbed.
 * 5. Anything not safely serializable (functions, symbols, binary, circular, throwing getter, over-deep)
 *    → DROPPED (fail closed). Never throws.
 */
export function redact(value, pepper = "") {
    try {
        const r = redactValue(value, pepper, 0, new WeakSet());
        return r === DROP ? undefined : r;
    }
    catch {
        return undefined; // top-level guard: redaction never throws into the log path
    }
}
/**
 * Build the configured pino logger backing the Fastify instance. Level comes from `config.logLevel`.
 * An optional `destination` stream is accepted for tests (in-memory capture); production callers omit it.
 *
 * `logFormat: "pretty"` deliberately falls through to standard structured pino (plain JSON) — we do NOT
 * pull in `pino-pretty`. A real pretty transport can be layered later without changing this contract.
 *
 * Returns the pino instance typed as `FastifyBaseLogger` so it drops straight into
 * `Fastify({ loggerInstance })`. Redaction is wired three ways: declarative `redact` paths, std
 * serializers (`err`/`req`/`res`), and the universal fail-closed `formatters.log` deep scrub.
 */
export function createLogger(config, destination) {
    const pepper = config.fingerprintPepper ?? "";
    const options = {
        level: config.logLevel,
        // Declarative belt for the classic request-header locations (fast-redact runs at stringify time).
        redact: { paths: [...REDACT_PATHS], censor: REDACTION_PLACEHOLDER },
        // Idiomatic `err` serializer. `formatters.log` (below) runs first and has already converted any
        // Error to a scrubbed `{ type, message, stack }`; this pass is idempotent (re-scrubs strings, keeps
        // the shape) — deliberately NOT `pino.stdSerializers.err`, which would re-wrap that plain object.
        serializers: {
            err: (err) => redact(err, pepper),
        },
        // Universal, fail-closed enforcement: EVERY log object is deep-redacted before serialization
        // (secrets masked, signing-key material omitted, fingerprints hashed, unsafe fields dropped).
        formatters: {
            log(object) {
                const scrubbed = redact(object, pepper);
                return scrubbed && typeof scrubbed === "object" && !Array.isArray(scrubbed)
                    ? scrubbed
                    : {};
            },
        },
    };
    // "pretty" deliberately falls through to standard pino to avoid a pino-pretty dependency.
    return destination ? pino(options, destination) : pino(options);
}
/** The required/optional fields carried by every per-request log line (OR-001/002/003). Exported contract. */
export const REQUEST_LOG_CONTRACT = [
    {
        field: "tenant_id",
        required: true,
        nullable: true,
        description: "Authenticated tenant; null on pre-auth / internal paths. First-class top-level field for per-tenant filtering (OR-003).",
    },
    {
        field: "request_id",
        required: true,
        nullable: false,
        description: "Server-generated authoritative correlation id (OR-002); never client-controlled.",
    },
    {
        field: "client_request_id",
        required: false,
        nullable: false,
        description: "Sanitized inbound correlation tag (OR-002); diagnostic only, never authoritative, never a security/routing/metric key. Present only when the client supplied a usable value.",
    },
    {
        field: "product_id",
        required: true,
        nullable: true,
        description: "Resolved product for the request; null when unknown.",
    },
    {
        field: "outcome",
        required: true,
        nullable: false,
        description: "Coarse status-derived bucket: success | client_error | server_error.",
    },
    { field: "method", required: true, nullable: false, description: "HTTP method." },
    {
        field: "route",
        required: true,
        nullable: false,
        description: "Matched route pattern (bounded cardinality); raw URL fallback for unrouted 404s.",
    },
    { field: "status", required: true, nullable: false, description: "HTTP response status code." },
    { field: "duration_ms", required: true, nullable: false, description: "Server-measured request duration." },
    {
        field: "trace_id",
        required: false,
        nullable: false,
        description: "Telemetry correlation id from the active span context; present for every request with an active span, regardless of the sampling decision — the log↔trace bridge (OR-013 / SC-002).",
    },
    {
        field: "span_id",
        required: false,
        nullable: false,
        description: "Active span id accompanying trace_id when a span is active (OR-013).",
    },
];
/**
 * The redaction rule set as an exported, inspectable contract (OR-004/020) — for documentation and
 * conformance tests. `omitted` fields are excluded entirely; `masked` are replaced with the placeholder;
 * `hashed` are one-way keyed-hashed; redaction is fail-closed.
 */
export const REDACTION_RULES = {
    omitted: [...SIGNING_KEY_FIELDS],
    masked: [...SECRET_FIELDS],
    hashed: [...FINGERPRINT_FIELDS],
    placeholder: REDACTION_PLACEHOLDER,
    failClosed: true,
};
/**
 * Read the active OTel span's `trace_id`/`span_id` for the log↔trace bridge (OR-013 / SC-002). The
 * `trace_id` exists in the span context REGARDLESS of the sampling decision — sampling governs span
 * EXPORT, not trace-context generation — so a log line carries a resolvable `trace_id` for both sampled
 * and unsampled requests. When there is no active span the fields are OMITTED (never fabricated). Depends
 * only on `@opentelemetry/api` (no SDK), so it is inert and safe when tracing is disabled/unloaded.
 */
export function activeTraceFields() {
    try {
        const span = trace.getActiveSpan();
        if (!span)
            return {};
        const ctx = span.spanContext();
        // `isSpanContextValid` checks the trace/span ids, NOT the sampled flag — an unsampled (flags=0)
        // context is still valid, so its trace_id is surfaced (the SC-002 bridge for unsampled requests).
        if (!ctx || !isSpanContextValid(ctx))
            return {};
        return { trace_id: ctx.traceId, span_id: ctx.spanId };
    }
    catch {
        return {}; // never let the trace bridge break the log path (fail-open)
    }
}
/**
 * Classify an HTTP status into a coarse outcome bucket. Exported so the `onResponse` hook (T008) derives
 * the same buckets the log line records: `success` (<400), `client_error` (4xx), `server_error` (5xx).
 */
export function outcomeFromStatus(status) {
    if (status >= 500)
        return "server_error";
    if (status >= 400)
        return "client_error";
    return "success";
}
/**
 * Assemble the structured per-request log object from the request, reply, and active request context.
 * `tenant_id` / `product_id` may be null (unauthenticated or product-less paths); the `route` is the
 * matched route pattern (bounded cardinality), falling back to the raw URL for unrouted (404) requests.
 * The sanitized `client_request_id` is included ONLY when the request context carries one, and it never
 * overwrites the authoritative `request_id` (OR-002). The response hook emits this exactly once per request.
 */
export function buildRequestLog(req, reply, extra = {}) {
    const ctx = getRequestContext();
    const status = reply.statusCode;
    const fields = {
        tenant_id: req.tenant?.tenantId ?? ctx?.tenantId ?? null,
        request_id: ctx?.requestId ?? req.id,
        product_id: extra.productId ?? null,
        outcome: extra.outcome ?? outcomeFromStatus(status),
        method: req.method,
        route: req.routeOptions.url ?? req.url,
        status,
        duration_ms: extra.durationMs ?? 0,
    };
    // Distinct, non-authoritative diagnostic field — recorded only when present, never conflated with
    // `request_id` and never used for any security/routing/metric decision (OR-002, T011).
    const clientRequestId = ctx?.clientRequestId;
    if (clientRequestId !== undefined)
        fields.client_request_id = clientRequestId;
    // Log↔trace bridge (OR-013 / SC-002): attach trace_id/span_id from the active span context when a span
    // is active — for BOTH sampled and unsampled requests. Omitted entirely when there is no active span.
    const traceFields = activeTraceFields();
    if (traceFields.trace_id !== undefined)
        fields.trace_id = traceFields.trace_id;
    if (traceFields.span_id !== undefined)
        fields.span_id = traceFields.span_id;
    return fields;
}
