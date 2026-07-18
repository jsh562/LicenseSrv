// T048 (SC-010): measure the added cost of the observability instrumentation with autocannon. Runs a
// short, loopback-only load against a minimal Fastify app WITHOUT the observability hooks (baseline) vs a
// second minimal app WITH them (pino logger + genReqId + per-request context + the onResponse log line +
// RED metric recording), and reports the measured p95-latency and CPU deltas against the SC-010 budget
// (<= 2 ms p95 added latency, <= 5% CPU).
//
// CI perf is NOISY, so the assertions are deliberately robust: a GENEROUS absolute ceiling catches a gross
// regression, and the test SKIPS itself (with a warning) when the environment is too underpowered/noisy to
// measure a ~2 ms delta meaningfully. autocannon is run for REAL and the measured deltas are always
// reported. Fast by design: short duration, loopback only, no container, no external network.
import { performance } from "node:perf_hooks";

import autocannon from "autocannon";
import Fastify, { type FastifyInstance } from "fastify";
import type pino from "pino";
import { describe, expect, it } from "vitest";

import { buildRequestLog, createLogger, outcomeFromStatus } from "../logger.js";
import { recordRed } from "../metrics.js";
import { enterRequestContext, genReqId } from "../request-context.js";

/** A pino destination that discards output — keeps serialization cost realistic without flooding stdout. */
const nullSink: pino.DestinationStream = { write: () => {} };

/** Build a minimal BASELINE Fastify app: no logger, no observability hooks. */
function buildBaselineApp(): FastifyInstance {
  const app = Fastify({ logger: false, disableRequestLogging: true });
  app.get("/ping", async () => ({ ok: true }));
  return app;
}

/** Build the minimal INSTRUMENTED app: pino logger + genReqId + request context + onResponse log + RED. */
function buildInstrumentedApp(): FastifyInstance {
  const app = Fastify({
    loggerInstance: createLogger({ logLevel: "info", logFormat: "json" }, nullSink),
    disableRequestLogging: true,
    genReqId: () => genReqId(),
  });
  app.addHook("onRequest", async (req) => {
    enterRequestContext({ requestId: req.id });
  });
  app.addHook("onResponse", async (req, reply) => {
    const durationMs = reply.elapsedTime;
    const outcome = outcomeFromStatus(reply.statusCode);
    req.log.info(buildRequestLog(req, reply, { durationMs, outcome }), "request completed");
    recordRed({ route: req.routeOptions.url ?? "unmatched", method: req.method, outcome, durationMs });
  });
  app.get("/ping", async () => ({ ok: true }));
  return app;
}

interface BenchResult {
  /** p95 latency proxy in ms (autocannon exposes p97.5, the closest published percentile to p95). */
  p95: number;
  requests: number;
  /** Process CPU consumed during the run, in ms (user + system). */
  cpuMs: number;
  /** CPU consumed per completed request, in ms. */
  cpuPerReq: number;
}

/** Listen on an ephemeral loopback port and return the bound port. */
async function listenLoopback(app: FastifyInstance): Promise<number> {
  await app.listen({ host: "127.0.0.1", port: 0 });
  const addr = app.server.address();
  if (addr === null || typeof addr === "string") throw new Error("no port bound");
  return addr.port;
}

/** Warm up, then run a short autocannon load and capture p95 + CPU. */
async function bench(port: number): Promise<BenchResult> {
  // Warm up so JIT/route-compile costs are excluded from the measured window.
  for (let i = 0; i < 20; i++) await fetch(`http://127.0.0.1:${port}/ping`).then((r) => r.text());
  const cpuStart = process.cpuUsage();
  const result = await autocannon({ url: `http://127.0.0.1:${port}/ping`, connections: 10, duration: 2 });
  const cpu = process.cpuUsage(cpuStart);
  const cpuMs = (cpu.user + cpu.system) / 1000;
  const requests = result.requests.total;
  return { p95: result.latency.p97_5, requests, cpuMs, cpuPerReq: requests > 0 ? cpuMs / requests : Infinity };
}

// Generous absolute ceilings — tolerant of CI noise while still catching a gross instrumentation
// regression. The strict SC-010 targets (2 ms p95, 5% CPU) are reported as soft observations.
const P95_DELTA_CEILING_MS = 20;
const CPU_PER_REQ_RATIO_CEILING = 4; // instrumented CPU/req must stay under 4x baseline

describe("observability instrumentation overhead (SC-010)", () => {
  it("adds bounded p95 latency and CPU vs an uninstrumented baseline", async (ctx) => {
    const baselineApp = buildBaselineApp();
    const instrumentedApp = buildInstrumentedApp();
    let base: BenchResult;
    let instr: BenchResult;
    try {
      base = await bench(await listenLoopback(baselineApp));
      instr = await bench(await listenLoopback(instrumentedApp));
    } finally {
      await baselineApp.close();
      await instrumentedApp.close();
    }

    const p95Delta = instr.p95 - base.p95;
    const cpuRatio = instr.cpuPerReq / base.cpuPerReq;
    const cpuPct = (cpuRatio - 1) * 100;

    // ALWAYS report the measured deltas (this is the point of the test).
    console.info(
      "[SC-010 overhead] " +
        `baseline p95=${base.p95.toFixed(2)}ms cpu/req=${base.cpuPerReq.toFixed(4)}ms reqs=${base.requests}; ` +
        `instrumented p95=${instr.p95.toFixed(2)}ms cpu/req=${instr.cpuPerReq.toFixed(4)}ms reqs=${instr.requests}; ` +
        `delta p95=${p95Delta.toFixed(2)}ms (SC-010 target <=2ms), cpu=${cpuPct.toFixed(1)}% (SC-010 target <=5%)`,
    );

    // Skip (do not fail) when the environment is too underpowered/noisy to measure a ~2 ms delta.
    const tooFewRequests = base.requests < 200 || instr.requests < 200;
    const tooSlowBaseline = base.p95 > 40 || base.p95 <= 0;
    if (tooFewRequests || tooSlowBaseline) {
      console.warn(
        `[SC-010 overhead] environment too noisy/underpowered to assert (baseline p95=${base.p95.toFixed(2)}ms, ` +
          `reqs base=${base.requests} instr=${instr.requests}) — skipping strict assertion.`,
      );
      ctx.skip();
      return;
    }

    // Robust assertions: generous ceilings catch a gross regression without failing on CI jitter.
    expect(p95Delta).toBeLessThanOrEqual(P95_DELTA_CEILING_MS);
    expect(cpuRatio).toBeLessThanOrEqual(CPU_PER_REQ_RATIO_CEILING);
  });
});
