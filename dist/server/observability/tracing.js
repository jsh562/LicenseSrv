// Distributed tracing bootstrap (OR-013/014/020, OBJ4, per {SAD:ADR-0009}). This module is the OTel
// preload: it configures and starts a `NodeSDK` (auto-instrumentation for Fastify + pg + http, an
// OTLP/HTTP trace exporter behind a `BatchSpanProcessor`, and a parent-based ratio sampler) so that when
// it is loaded via `node --import ./dist/server/observability/tracing.js dist/server/main.js` (HINT-001)
// the SDK starts BEFORE the app/pg/fastify are imported and can patch them.
//
// THREE hard guarantees:
//  1. FAIL-OPEN (OR-014) — every SDK/exporter error is caught and logged, NEVER thrown. A broken or
//     absent Collector, a bad preload, or an export failure must never crash or block the process. When
//     `OTEL_EXPORTER_OTLP_ENDPOINT` is empty, tracing is a no-op (no exporter, no SDK) — still no throw.
//  2. NO SQL / NO KEY MATERIAL IN SPANS (OR-013/020) — the pg instrumentation runs with
//     `enhancedDatabaseReporting: false` (no bound parameters) AND a `RedactingSpanProcessor` strips the
//     raw statement text (`db.statement` / `db.query.text` / pg values) from every span before export.
//     The manual signer span (`withSignerSpan`) records ONLY availability/latency/outcome and redacts any
//     exception — never the signing-key id/bytes or the signing payload/input.
//  3. TRACE-CONTEXT ALWAYS (OR-013/SC-002) — sampling governs span EXPORT, not trace-context generation;
//     the `trace_id` is bridged into every request log line regardless of the sampling decision (that
//     bridge lives in `logger.ts`, which reads the active span context directly).
//
// Config is read from RAW ENV (not the validated `AppConfig`) because at preload time config has not been
// loaded yet: `OTEL_EXPORTER_OTLP_ENDPOINT`, `OBS_TRACE_SAMPLE_RATIO`, `OTEL_EXPORTER_OTLP_AUTH_TOKEN`.
//
// LAZY SDK LOADING (memory): the heavy OTel packages are NOT imported at module scope. Importing
// `@opentelemetry/auto-instrumentations-node` alone pulls in ~42 `instrumentation-*` packages plus
// `@grpc/grpc-js` and `protobufjs` — measured at ~37 MB RSS / ~15 MB V8 heap, roughly 43% of this
// service's idle footprint. Because tracing is a NO-OP whenever `OTEL_EXPORTER_OTLP_ENDPOINT` is empty
// (the common case for self-hosted deployments), paying that cost unconditionally is pure waste. Instead
// they load on FIRST USE via `lazy()` below, which is reached only after the endpoint check passes.
//
// The loader is `createRequire`, not `await import`, on purpose:
//   * Every `@opentelemetry/*` package here is CJS (no `type: "module"`, `main` → `build/src/index.js`;
//     the `module` field is a bundler-only hint Node ignores), so `require` yields the SAME module
//     instance `import` would from Node's CJS cache — there is no dual-package hazard.
//   * It is SYNCHRONOUS, so `startTracing()` keeps its `void` signature and the HINT-001 preload
//     guarantee holds exactly as before: the SDK still patches pg/fastify/http at import time, before
//     the app imports them. An `await import` would make this module's public API async for no gain.
import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";
import { DiagConsoleLogger, DiagLogLevel, diag, SpanStatusCode, trace, } from "@opentelemetry/api";
// --- Lazy OTel SDK module loading ------------------------------------------------------------------
const requireOtel = createRequire(import.meta.url);
/** Memoize a synchronous `require` of an OTel package so repeated calls cost one cache lookup. */
function lazy(specifier) {
    let mod;
    return () => (mod ??= requireOtel(specifier));
}
const autoInstrumentations = lazy("@opentelemetry/auto-instrumentations-node");
const otlpHttp = lazy("@opentelemetry/exporter-trace-otlp-http");
const resources = lazy("@opentelemetry/resources");
const sdkNode = lazy("@opentelemetry/sdk-node");
const sdkTraceBase = lazy("@opentelemetry/sdk-trace-base");
const semconv = lazy("@opentelemetry/semantic-conventions");
/** Logical service identity attached to every span/resource (matches the startup "license-api" name). */
export const SERVICE_NAME = "license-api";
/** Default parent-based trace sample ratio when `OBS_TRACE_SAMPLE_RATIO` is unset/invalid (OR-014). */
export const DEFAULT_TRACE_SAMPLE_RATIO = 0.1;
// --- Sampling (T034, OR-014) -----------------------------------------------------------------------
/**
 * Parse `OBS_TRACE_SAMPLE_RATIO` into a [0,1] ratio. Anything missing, non-numeric, or out of range
 * degrades to {@link DEFAULT_TRACE_SAMPLE_RATIO} — never NaN, never a throw (defensive, fail-open).
 */
export function resolveSampleRatio(raw) {
    if (raw === undefined || raw.trim() === "")
        return DEFAULT_TRACE_SAMPLE_RATIO;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed))
        return DEFAULT_TRACE_SAMPLE_RATIO;
    if (parsed < 0)
        return 0;
    if (parsed > 1)
        return 1;
    return parsed;
}
/**
 * Build the parent-based ratio sampler (OR-014): honour an upstream sampling decision when present,
 * otherwise sample the ROOT at `ratio`. Keeps trace decisions consistent across a distributed call graph
 * while bounding hot-path overhead.
 */
export function buildSampler(ratio) {
    const { ParentBasedSampler, TraceIdRatioBasedSampler } = sdkTraceBase();
    return new ParentBasedSampler({ root: new TraceIdRatioBasedSampler(ratio) });
}
// The ratio actually applied by the last `startTracing`, exposed for tests (T034 "export the sampled ratio").
let currentSampleRatio = DEFAULT_TRACE_SAMPLE_RATIO;
/** The trace sample ratio currently in effect (parent-based root ratio). Exported for tests (OR-014). */
export function getSampleRatio() {
    return currentSampleRatio;
}
// --- Span attribute redaction (T033, OR-013/020) ---------------------------------------------------
/**
 * pg auto-instrumentation config: `enhancedDatabaseReporting: false` disables bound-parameter capture so
 * no license key / PII value is ever attached as a span attribute (OR-013/020). The raw SQL TEXT is
 * additionally stripped by {@link RedactingSpanProcessor} (the pg instrumentation always sets
 * `db.statement`, so disabling params alone is insufficient — the text must be redacted too).
 */
export const PG_INSTRUMENTATION_CONFIG = { enhancedDatabaseReporting: false };
/**
 * Span attributes that may carry raw SQL text or bound parameters (license keys / PII) — STRIPPED from
 * every span before export (OR-013/020). Covers both the old (`db.statement`) and stable (`db.query.text`)
 * semantic conventions plus the pg-specific value/parameter attributes.
 */
export const SENSITIVE_SPAN_ATTRIBUTE_KEYS = [
    "db.statement",
    "db.query.text",
    "db.postgresql.values",
    "db.statement.parameters",
];
/** Remove every {@link SENSITIVE_SPAN_ATTRIBUTE_KEYS} entry from a span's attribute bag, in place. Never throws. */
export function scrubSpanAttributes(attributes) {
    for (const key of SENSITIVE_SPAN_ATTRIBUTE_KEYS) {
        if (key in attributes)
            delete attributes[key];
    }
}
/**
 * A `SpanProcessor` decorator that scrubs SQL/parameter attributes (OR-013/020) from every span in
 * `onEnd`, immediately before delegating to the wrapped exporter processor (e.g. `BatchSpanProcessor`).
 * This is the authoritative, instrumentation-agnostic guarantee that no raw SQL text or bound params are
 * ever EXPORTED — regardless of which instrumentation set them or on which code path. Fail-open: a scrub
 * error is swallowed and the (already param-free) span still exports.
 */
export class RedactingSpanProcessor {
    inner;
    constructor(inner) {
        this.inner = inner;
    }
    onStart(span, parentContext) {
        this.inner.onStart(span, parentContext);
    }
    onEnd(span) {
        try {
            // ReadableSpan.attributes is typed readonly but is the live, mutable backing object; deleting keys
            // here scrubs the exact object the exporter later serializes.
            scrubSpanAttributes(span.attributes);
        }
        catch {
            /* fail-open: never let redaction bookkeeping break span export */
        }
        this.inner.onEnd(span);
    }
    forceFlush() {
        return this.inner.forceFlush();
    }
    shutdown() {
        return this.inner.shutdown();
    }
}
/**
 * Build the auto-instrumentation set (Fastify + pg + http). The pg instrumentation is configured with
 * statement/parameter capture off ({@link PG_INSTRUMENTATION_CONFIG}); the noisy `fs` instrumentation is
 * disabled to keep overhead and span volume bounded on the hot path.
 */
export function buildInstrumentations() {
    const config = {
        "@opentelemetry/instrumentation-pg": { ...PG_INSTRUMENTATION_CONFIG },
        "@opentelemetry/instrumentation-fs": { enabled: false },
    };
    // First call here is what actually pays the ~37 MB load cost — reached only when tracing is enabled.
    return autoInstrumentations().getNodeAutoInstrumentations(config);
}
// --- Manual signer span (T035, OR-013/020) ---------------------------------------------------------
/** Tracer name for the manual signer span (distinct from auto-instrumentation tracers). */
export const SIGNER_TRACER_NAME = "license-api/signer";
/** Span name for the manual signer span. */
export const SIGNER_SPAN_NAME = "signer.sign";
/**
 * Project caller-supplied attributes onto the closed, safe signer-span attribute set (OR-020). Only
 * availability/latency/outcome survive; anything else (a `keyId`, `signingPayload`, key bytes, …) is
 * dropped. Returns OTel `Attributes` keyed under the `signer.*` namespace.
 */
export function safeSignerAttributes(attrs) {
    const out = {};
    if (!attrs)
        return out;
    if (typeof attrs.outcome === "string")
        out["signer.outcome"] = attrs.outcome;
    if (typeof attrs.available === "boolean")
        out["signer.available"] = attrs.available;
    if (typeof attrs.latencyMs === "number" && Number.isFinite(attrs.latencyMs)) {
        out["signer.latency_ms"] = attrs.latencyMs;
    }
    return out;
}
/**
 * Redact a signer exception for span recording (OR-020): keep ONLY the error's constructor name and a
 * fixed, safe message. The original message and stack are dropped entirely because they could carry
 * signing-key material or the signing input — nothing recoverable ever reaches the span.
 */
export function redactedSignerException(err) {
    const name = err instanceof Error && typeof err.name === "string" ? err.name : "Error";
    return { name, message: "signer call failed (details redacted, OR-020)" };
}
/**
 * Run `fn` inside a manual signer span that records ONLY availability/latency/outcome (OR-013/020). The
 * span never carries the signing-key id/bytes or the signing payload/input, and any thrown error is
 * recorded as a REDACTED exception (name + safe message only) before being re-thrown to the caller.
 * Exported so the signing module can adopt it later; not wired into signing here.
 */
export async function withSignerSpan(fn, attrs) {
    const tracer = trace.getTracer(SIGNER_TRACER_NAME);
    return tracer.startActiveSpan(SIGNER_SPAN_NAME, async (span) => {
        const startedAt = performance.now();
        try {
            const result = await fn();
            span.setAttributes(safeSignerAttributes({
                outcome: attrs?.outcome ?? "success",
                available: attrs?.available ?? true,
                latencyMs: attrs?.latencyMs ?? performance.now() - startedAt,
            }));
            span.setStatus({ code: SpanStatusCode.OK });
            return result;
        }
        catch (err) {
            span.setAttributes(safeSignerAttributes({
                outcome: attrs?.outcome ?? "error",
                available: attrs?.available ?? false,
                latencyMs: attrs?.latencyMs ?? performance.now() - startedAt,
            }));
            // Record a REDACTED exception only — no key material, no signing input (OR-020).
            span.recordException(redactedSignerException(err));
            span.setStatus({ code: SpanStatusCode.ERROR, message: "signer call failed (redacted)" });
            throw err;
        }
        finally {
            span.end();
        }
    });
}
// --- SDK lifecycle (T033/T034, OR-013/014) ---------------------------------------------------------
/** Log a tracing lifecycle error without pulling in the app logger (preload runs before it). Never throws. */
function logTracingError(message, err) {
    try {
        const detail = err instanceof Error ? err.message : String(err);
        // Structured, secret-free line to stderr; tracing errors must be visible but never fatal (OR-014).
        process.stderr.write(`${JSON.stringify({ level: "warn", event: "tracing", message, error: detail })}\n`);
    }
    catch {
        /* logging is best-effort; fail-open */
    }
}
let sdk;
let started = false;
/**
 * Start the OTel tracing SDK (idempotent, fail-open). Reads RAW ENV (preload runs before config loads):
 *  - `OTEL_EXPORTER_OTLP_ENDPOINT` — OTLP/HTTP trace endpoint; EMPTY disables tracing (no exporter/no-op).
 *  - `OBS_TRACE_SAMPLE_RATIO` — parent-based root ratio (default {@link DEFAULT_TRACE_SAMPLE_RATIO}).
 *  - `OTEL_EXPORTER_OTLP_AUTH_TOKEN` — optional bearer token for the exporter's `Authorization` header.
 *
 * ANY error is caught and logged, never thrown — a broken Collector/preload must not crash the process.
 */
export function startTracing(env = process.env) {
    if (started)
        return;
    // Mark started up-front so a throw mid-init can never trigger a re-entrant double start.
    started = true;
    try {
        currentSampleRatio = resolveSampleRatio(env.OBS_TRACE_SAMPLE_RATIO);
        const endpoint = (env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "").trim();
        if (endpoint === "") {
            // Tracing disabled: no exporter, no SDK, no instrumentation patching. Fail-open, no throw. The
            // trace_id-in-log bridge simply finds no active span and omits the field.
            return;
        }
        // Surface SDK/exporter errors at ERROR level without ever throwing them into the process.
        diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.ERROR);
        // Past the endpoint gate, tracing IS enabled — now (and only now) pull in the heavy SDK packages.
        // These `require`s are inside the fail-open try/catch, so a missing/broken OTel install is logged and
        // swallowed exactly like an exporter failure: the app still boots, just without tracing (OR-014).
        const { OTLPTraceExporter } = otlpHttp();
        const { defaultResource, resourceFromAttributes } = resources();
        const { NodeSDK } = sdkNode();
        const { BatchSpanProcessor } = sdkTraceBase();
        const { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } = semconv();
        const authToken = (env.OTEL_EXPORTER_OTLP_AUTH_TOKEN ?? "").trim();
        // The OTLP exporter reads `OTEL_EXPORTER_OTLP_ENDPOINT` from env itself (appending the signal path);
        // we only add the optional bearer header. A down/slow Collector is handled by the BatchSpanProcessor
        // (drops on overflow/error) — never surfaced to a request (OR-014).
        const exporter = new OTLPTraceExporter(authToken !== "" ? { headers: { Authorization: `Bearer ${authToken}` } } : {});
        sdk = new NodeSDK({
            resource: defaultResource().merge(resourceFromAttributes({
                [ATTR_SERVICE_NAME]: SERVICE_NAME,
                [ATTR_SERVICE_VERSION]: process.env.npm_package_version ?? "0.1.0",
            })),
            sampler: buildSampler(currentSampleRatio),
            // Wrap the batching exporter so raw SQL/params are scrubbed from EVERY span before export.
            spanProcessors: [new RedactingSpanProcessor(new BatchSpanProcessor(exporter))],
            instrumentations: [buildInstrumentations()],
        });
        sdk.start();
    }
    catch (err) {
        // FAIL-OPEN (OR-014): a broken exporter/SDK/preload is logged and swallowed — the app boots normally.
        logTracingError("tracing failed to start (fail-open)", err);
    }
}
/**
 * Flush and shut down the tracing SDK (best-effort, fail-open). Safe to call when tracing was disabled or
 * never started (no-op). Wired into the graceful shutdown path so batched spans get a chance to export.
 */
export async function shutdownTracing() {
    try {
        await sdk?.shutdown();
    }
    catch (err) {
        logTracingError("tracing shutdown error (fail-open)", err);
    }
    finally {
        sdk = undefined;
    }
}
// Preload side effect (HINT-001): starting the SDK at IMPORT time is what makes this file a valid
// `--import` preload — the SDK patches pg/fastify/http before the app imports them. Guarded fail-open so
// importing this module (including from unit tests, where no endpoint is set) can never throw.
startTracing();
