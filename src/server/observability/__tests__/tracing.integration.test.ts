// T039 (OR-013 / OR-014, COMPLETES OR-013): tracing pipeline integration test. Uses an in-memory span
// exporter (InMemorySpanExporter + SimpleSpanProcessor) wired behind the REAL RedactingSpanProcessor and
// the REAL auto-instrumentation set (buildInstrumentations) from tracing.ts — no live Collector. Asserts:
//   A. an exercised request path yields app + DB (auto-instrumented pg) + (manual) signer spans that share
//      one trace, and the request log line carries that same trace_id (log↔trace correlation, SC-002);
//      and NO raw SQL text / bound parameters appear in any span (OR-013/020).
//   B. FAIL-OPEN (OR-014): pointing the OTLP exporter at a dead endpoint never makes span export throw /
//      reject into request handling.
// Real Postgres comes from @testcontainers/postgresql so the pg auto-instrumentation produces a real DB
// span. pg is imported DYNAMICALLY, AFTER sdk.start(), so the instrumentation patches it (HINT-001).
import { context, type SpanContext, SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { BatchSpanProcessor, InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import type { FastifyReply, FastifyRequest } from "fastify";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildRequestLog, createLogger } from "../logger.js";
import { runWithContext } from "../request-context.js";
import {
  buildInstrumentations,
  buildSampler,
  RedactingSpanProcessor,
  SIGNER_SPAN_NAME,
  withSignerSpan,
} from "../tracing.js";

// A recognizable literal placed in the SQL TEXT (a column alias) — it MUST NOT appear in ANY exported span
// once the pg statement is scrubbed (OR-013/020). Distinct from bound-parameter values (also excluded).
const SQL_MARKER = "sensitive_marker_col";

const exporter = new InMemorySpanExporter();
let sdk: NodeSDK;
let container: StartedPostgreSqlContainer;
let pool: pg.Pool;

beforeAll(async () => {
  // Start the SDK BEFORE importing pg so the auto-instrumentation can patch it. Wrap the in-memory
  // exporter in the REAL RedactingSpanProcessor so the end-to-end SQL scrub is exercised.
  sdk = new NodeSDK({
    spanProcessors: [new RedactingSpanProcessor(new SimpleSpanProcessor(exporter))],
    instrumentations: [buildInstrumentations()],
    sampler: buildSampler(1), // sample everything for deterministic assertions
  });
  sdk.start();

  container = await new PostgreSqlContainer("postgres:16-alpine").start();
  // Dynamic import AFTER sdk.start() so pg is instrumented (HINT-001).
  const { makePool } = await import("../../db/client.js");
  pool = makePool(container.getConnectionUri(), 4);
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
  await sdk?.shutdown();
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

describe("tracing pipeline: app + DB + signer spans correlate to the log line (OR-013, SC-002/007)", () => {
  it("A: yields app/DB/signer spans sharing a trace; the log line carries that trace_id; no SQL/params leak", async () => {
    exporter.reset();
    const logLines: Array<Record<string, unknown>> = [];
    const logger = createLogger(
      { logLevel: "info", logFormat: "json" },
      { write: (s: string) => void logLines.push(JSON.parse(s) as Record<string, unknown>) },
    );

    const tracer = trace.getTracer("license-api/test");
    // The "app"/server span — the request-scoped root the DB and signer spans hang off.
    await tracer.startActiveSpan(
      "GET /v1/activations",
      { kind: SpanKind.SERVER, attributes: { "http.route": "/v1/activations" } },
      async (appSpan) => {
        try {
          // DB span (auto-instrumented pg). The SQL TEXT carries SQL_MARKER (must be scrubbed); the bound
          // parameter carries a secret value (must never be captured — enhancedDatabaseReporting=false).
          // A schema-less query so it runs against a fresh, unmigrated testcontainer DB.
          await pool.query(`SELECT $1::text AS ${SQL_MARKER}`, ["no-such-tenant-PARAM-SECRET"]);
          // Signer span (manual, availability/latency/outcome only).
          await withSignerSpan(async () => "signed-token", { available: true });
          // The request log line, built within the active-span context → trace bridge attaches trace_id.
          logger.info(
            runWithContext({ requestId: "req-trace-1" }, () => buildRequestLog(fakeReq(), fakeReply(200), { durationMs: 5 })),
            "request completed",
          );
          appSpan.setStatus({ code: SpanStatusCode.OK });
        } finally {
          appSpan.end();
        }
      },
    );

    const spans = exporter.getFinishedSpans();
    const appSpan = spans.find((s) => s.name === "GET /v1/activations");
    const dbSpan = spans.find((s) => s.attributes["db.system"] === "postgresql");
    const signerSpan = spans.find((s) => s.name === SIGNER_SPAN_NAME);

    // App + DB + signer span attribution (SC-007).
    expect(appSpan, "app/server span").toBeDefined();
    expect(dbSpan, "auto-instrumented pg DB span").toBeDefined();
    expect(signerSpan, "manual signer span").toBeDefined();

    // All three share one trace.
    const traceId = appSpan!.spanContext().traceId;
    expect(dbSpan!.spanContext().traceId).toBe(traceId);
    expect(signerSpan!.spanContext().traceId).toBe(traceId);

    // The emitted request log line carries the SAME trace_id (log↔trace correlation, SC-002).
    const requestLine = logLines.find((l) => l.msg === "request completed");
    expect(requestLine).toBeDefined();
    expect(requestLine!.trace_id).toBe(traceId);
    expect(requestLine!.span_id).toBe(appSpan!.spanContext().spanId);

    // OR-013/020: NO raw SQL text and NO bound parameters in ANY span. Serialize only name+attributes
    // (the raw SpanImpl objects hold circular processor/exporter references).
    const serializedSpans = JSON.stringify(spans.map((s) => ({ name: s.name, attributes: s.attributes })));
    expect(serializedSpans).not.toContain(SQL_MARKER); // db.statement was scrubbed
    expect(serializedSpans).not.toContain("PARAM-SECRET"); // bound param never captured
    expect(dbSpan!.attributes["db.statement"]).toBeUndefined();
    expect(dbSpan!.attributes["db.postgresql.values"]).toBeUndefined();

    // The signer span carries ONLY safe signer.* attributes (OR-020).
    expect(signerSpan!.attributes["signer.outcome"]).toBe("success");
    expect(Object.keys(signerSpan!.attributes).every((k) => k.startsWith("signer."))).toBe(true);
  });
});

describe("fail-open: a dead OTLP Collector never breaks request handling (OR-014, SC-009)", () => {
  it("span export to an unreachable endpoint does not throw into request handling", async () => {
    // Port 9 (discard) is closed → export attempts fail. Export is batched/async off the request path;
    // the BatchSpanProcessor swallows the failure so request handling is never affected (OR-014).
    const deadExporter = new OTLPTraceExporter({ url: "http://127.0.0.1:9/v1/traces" });
    const provider = new NodeTracerProvider({
      spanProcessors: [new BatchSpanProcessor(deadExporter)],
      sampler: buildSampler(1),
    });
    const tracer = provider.getTracer("failopen-test");

    let threw = false;
    try {
      // The REQUEST PATH: create + end spans and run the "handler" body. It must complete normally even
      // though the configured Collector is dead — the span lifecycle never awaits or surfaces an export.
      for (let i = 0; i < 5; i++) {
        await new Promise<void>((resolve) => {
          tracer.startActiveSpan("GET /v1/activations", (span) => {
            span.setAttribute("http.route", "/v1/activations");
            span.end();
            resolve();
          });
        });
      }
    } catch {
      threw = true;
    }

    expect(threw).toBe(false); // request handling completed despite the dead Collector
    // The background/explicit export attempt against the dead endpoint is FAIL-OPEN — swallowed, never
    // surfaced to a request. `forceFlush`/`shutdown` are off the request path, so a rejection here is fine.
    await provider.forceFlush().catch(() => undefined);
    await provider.shutdown().catch(() => undefined);
  });
});

describe("trace context exists regardless of sampling (OR-013 / SC-002)", () => {
  it("an UNSAMPLED span context still yields a trace_id on the request log line", () => {
    const unsampled: SpanContext = {
      traceId: "11112222333344445555666677778888",
      spanId: "aaaabbbbccccdddd",
      traceFlags: 0, // NOT sampled
      isRemote: false,
    };
    const line = context.with(trace.setSpan(context.active(), trace.wrapSpanContext(unsampled)), () =>
      runWithContext({ requestId: "req-unsampled" }, () => buildRequestLog(fakeReq(), fakeReply(200))),
    );
    expect(line.trace_id).toBe(unsampled.traceId);
    expect(line.span_id).toBe(unsampled.spanId);
  });
});
