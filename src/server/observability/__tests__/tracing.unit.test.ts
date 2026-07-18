// T038 (OR-013 / OR-020, COMPLETES OR-020): pure unit tests for the tracing module — no container, no
// live Collector. Three guarantees are asserted:
//   1. pg statement capture is OFF and raw SQL / bound params are scrubbed from every span (no db.statement).
//   2. the manual signer span records ONLY availability/latency/outcome — never key material / payload —
//      and any recorded exception is redacted (no key material reaches the span).
//   3. the log↔trace bridge surfaces a trace_id even for an UNSAMPLED span (SC-002): the trace_id lives in
//      the span context regardless of the sampling decision, so an unsampled request still correlates.
import type { FastifyReply, FastifyRequest } from "fastify";
import { context, type SpanContext, trace, TraceFlags } from "@opentelemetry/api";
import { InMemorySpanExporter, type ReadableSpan, SimpleSpanProcessor, type SpanProcessor } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { activeTraceFields, buildRequestLog } from "../logger.js";
import { runWithContext } from "../request-context.js";
import {
  PG_INSTRUMENTATION_CONFIG,
  RedactingSpanProcessor,
  redactedSignerException,
  safeSignerAttributes,
  scrubSpanAttributes,
  SENSITIVE_SPAN_ATTRIBUTE_KEYS,
  SIGNER_SPAN_NAME,
  withSignerSpan,
} from "../tracing.js";

// A real in-memory tracer provider so `withSignerSpan` produces inspectable, recording spans and the
// active-span context propagates (NodeTracerProvider.register wires the AsyncLocalStorage context manager).
const exporter = new InMemorySpanExporter();
let provider: NodeTracerProvider;

beforeAll(() => {
  provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  provider.register();
});

afterAll(async () => {
  await provider.shutdown();
});

/** Minimal FastifyRequest stand-in for the fields buildRequestLog reads. */
function fakeReq(): FastifyRequest {
  return {
    id: "req-fallback",
    method: "GET",
    url: "/v1/activations",
    routeOptions: { url: "/v1/activations" },
    tenant: undefined,
  } as unknown as FastifyRequest;
}

function fakeReply(status: number): FastifyReply {
  return { statusCode: status } as unknown as FastifyReply;
}

describe("pg statement capture OFF + SQL scrubbing (OR-013/020)", () => {
  it("configures the pg instrumentation with enhancedDatabaseReporting=false (no bound params)", () => {
    expect(PG_INSTRUMENTATION_CONFIG.enhancedDatabaseReporting).toBe(false);
  });

  it("declares db.statement / db.query.text / pg values as sensitive (stripped from spans)", () => {
    expect(SENSITIVE_SPAN_ATTRIBUTE_KEYS).toContain("db.statement");
    expect(SENSITIVE_SPAN_ATTRIBUTE_KEYS).toContain("db.query.text");
    expect(SENSITIVE_SPAN_ATTRIBUTE_KEYS).toContain("db.postgresql.values");
  });

  it("scrubSpanAttributes removes sensitive keys in place, preserving the rest", () => {
    const attrs: Record<string, unknown> = {
      "db.statement": "SELECT * FROM licenses WHERE key = 'SUPER-SECRET-KEY'",
      "db.query.text": "SELECT ...",
      "db.postgresql.values": ["SUPER-SECRET-KEY"],
      "db.system": "postgresql",
    };
    scrubSpanAttributes(attrs);
    expect(attrs).toEqual({ "db.system": "postgresql" });
  });

  it("RedactingSpanProcessor strips the raw SQL from a span before delegating to export (no db.statement)", () => {
    const captured: ReadableSpan[] = [];
    const inner: SpanProcessor = {
      onStart: () => undefined,
      onEnd: (s) => void captured.push(s),
      forceFlush: () => Promise.resolve(),
      shutdown: () => Promise.resolve(),
    };
    const processor = new RedactingSpanProcessor(inner);
    const span = {
      name: "pg.query",
      attributes: {
        "db.statement": "SELECT * FROM licenses WHERE key = 'SUPER-SECRET-KEY'",
        "db.postgresql.values": ["SUPER-SECRET-KEY"],
        "db.system": "postgresql",
      },
    } as unknown as ReadableSpan;

    processor.onEnd(span);

    // The exact object handed to the exporter carries no SQL text and no bound parameters.
    expect(captured).toHaveLength(1);
    const exported = captured[0]!.attributes as Record<string, unknown>;
    expect(exported["db.statement"]).toBeUndefined();
    expect(exported["db.postgresql.values"]).toBeUndefined();
    expect(exported["db.system"]).toBe("postgresql"); // non-sensitive attribution preserved
    expect(JSON.stringify(exported)).not.toContain("SUPER-SECRET-KEY");
  });
});

describe("signer span records no key material / payload and redacts exceptions (OR-020)", () => {
  it("safeSignerAttributes is an allowlist — only availability/latency/outcome survive", () => {
    const attrs = safeSignerAttributes({
      outcome: "success",
      available: true,
      latencyMs: 3,
      // A careless caller passing key material / payload — all of it MUST be dropped.
      keyId: "kid-DEADBEEF",
      signingKeyBytes: "0xDEADBEEF",
      signingPayload: "to-be-signed-bytes",
    } as never);
    expect(attrs).toEqual({
      "signer.outcome": "success",
      "signer.available": true,
      "signer.latency_ms": 3,
    });
    const serialized = JSON.stringify(attrs);
    expect(serialized).not.toContain("kid-DEADBEEF");
    expect(serialized).not.toContain("0xDEADBEEF");
    expect(serialized).not.toContain("to-be-signed-bytes");
  });

  it("redactedSignerException keeps only the error name + a safe message (no original message/stack)", () => {
    const ex = redactedSignerException(new TypeError("boom SIGNING_KEY=DEADBEEF payload=topsecret"));
    expect(ex).toEqual({ name: "TypeError", message: "signer call failed (details redacted, OR-020)" });
    expect(JSON.stringify(ex)).not.toContain("DEADBEEF");
    expect(JSON.stringify(ex)).not.toContain("topsecret");
  });

  it("withSignerSpan on success records only signer.* availability/latency/outcome", async () => {
    exporter.reset();
    const result = await withSignerSpan(async () => "signed-token", { available: true });
    expect(result).toBe("signed-token");
    await provider.forceFlush();

    const span = exporter.getFinishedSpans().find((s) => s.name === SIGNER_SPAN_NAME);
    expect(span).toBeDefined();
    expect(span!.attributes["signer.outcome"]).toBe("success");
    expect(span!.attributes["signer.available"]).toBe(true);
    expect(typeof span!.attributes["signer.latency_ms"]).toBe("number");
    // EVERY attribute is a safe signer.* attribute — no key/payload attribute could have leaked in.
    expect(Object.keys(span!.attributes).every((k) => k.startsWith("signer."))).toBe(true);
  });

  it("withSignerSpan re-throws the original error but records a REDACTED exception (no key material)", async () => {
    exporter.reset();
    const SECRET = "SIGNING_KEY_bytes_DEADBEEF";
    await expect(
      withSignerSpan(async () => {
        throw new Error(`sign failed: ${SECRET} payload=to-be-signed`);
      }),
    ).rejects.toThrow(SECRET); // the caller still sees the real error — redaction is span-only

    await provider.forceFlush();
    const span = exporter.getFinishedSpans().find((s) => s.name === SIGNER_SPAN_NAME);
    expect(span).toBeDefined();
    expect(span!.attributes["signer.outcome"]).toBe("error");

    // Neither the attributes, the recorded exception event, nor the status message carry key material.
    const surface = JSON.stringify({ attributes: span!.attributes, events: span!.events, status: span!.status });
    expect(surface).not.toContain(SECRET);
    expect(surface).not.toContain("to-be-signed");

    const exceptionEvent = span!.events.find((e) => e.name === "exception");
    expect(exceptionEvent).toBeDefined();
    expect(String(exceptionEvent!.attributes?.["exception.message"])).toContain("redacted");
    expect(String(exceptionEvent!.attributes?.["exception.message"])).not.toContain(SECRET);
  });
});

describe("log↔trace bridge surfaces trace_id for an UNSAMPLED span (OR-013 / SC-002)", () => {
  // A span context with the sampled flag OFF — the trace_id must still be present and resolvable in logs.
  const unsampled: SpanContext = {
    traceId: "abcdef0123456789abcdef0123456789",
    spanId: "0123456789abcdef",
    traceFlags: TraceFlags.NONE, // 0 = NOT sampled → span is not exported, but the trace_id still exists
    isRemote: false,
  };

  it("sanity: the constructed context is unsampled", () => {
    expect(unsampled.traceFlags & TraceFlags.SAMPLED).toBe(0);
  });

  it("activeTraceFields returns the unsampled span's trace_id/span_id", () => {
    const nonRecording = trace.wrapSpanContext(unsampled);
    const fields = context.with(trace.setSpan(context.active(), nonRecording), () => activeTraceFields());
    expect(fields.trace_id).toBe(unsampled.traceId);
    expect(fields.span_id).toBe(unsampled.spanId);
  });

  it("buildRequestLog carries the unsampled trace_id on the request log line", () => {
    const nonRecording = trace.wrapSpanContext(unsampled);
    const line = context.with(trace.setSpan(context.active(), nonRecording), () =>
      runWithContext({ requestId: "req-unsampled" }, () => buildRequestLog(fakeReq(), fakeReply(200))),
    );
    expect(line.trace_id).toBe(unsampled.traceId);
    expect(line.span_id).toBe(unsampled.spanId);
    expect(line.request_id).toBe("req-unsampled");
  });

  it("omits trace_id/span_id entirely when there is no active span (never fabricated)", () => {
    const fields = activeTraceFields();
    expect(fields.trace_id).toBeUndefined();
    expect(fields.span_id).toBeUndefined();
    const line = runWithContext({ requestId: "req-no-span" }, () => buildRequestLog(fakeReq(), fakeReply(200)));
    expect("trace_id" in line).toBe(false);
    expect("span_id" in line).toBe(false);
  });
});
