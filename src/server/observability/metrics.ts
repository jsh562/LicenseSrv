// RED + infra metrics and the dedicated metrics-port listener (OR-005/006/007/008/020, per
// {SAD:ADR-0009}). A single prom-client `Registry` with a STATIC, bounded label allowlist. The
// cardinality policy is BINDING: high-cardinality / per-tenant identity (`tenant_id`, `request_id`,
// `license_key`) MUST NEVER be a metric label — it lives in logs and trace attributes, bridged to
// metrics only via histogram exemplars. Every instrument here draws its labels solely from
// `RED_LABEL_NAMES` (`route`, `method`, `outcome`). All recording helpers are FAIL-OPEN — they never
// throw into a request path (OR-014). Signer signals expose availability / latency / outcome ONLY;
// signing-key material is excluded entirely from every signal (OR-020).
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import {
  collectDefaultMetrics,
  Counter,
  Gauge,
  Histogram,
  type OpenMetricsContentType,
  Registry,
} from "prom-client";

/**
 * The ONLY labels any RED / business metric may carry (OR-008). Bounded and enumerable — a route
 * PATTERN (not a raw URL), an HTTP method, and a coarse outcome bucket — so the time-series count has a
 * fixed ceiling. This allowlist is the single source of truth for every RED instrument below.
 */
export const RED_LABEL_NAMES = ["route", "method", "outcome"] as const;
export type RedLabel = (typeof RED_LABEL_NAMES)[number];

/**
 * Labels that MUST NEVER appear on ANY metric — the binding cardinality / tenant-safety policy from
 * {SAD:ADR-0009}. Exported so the label-allowlist unit test (SC-006) can assert their total absence.
 */
export const FORBIDDEN_LABEL_NAMES = ["tenant_id", "request_id", "license_key"] as const;

/**
 * SLO-aligned request-duration buckets (seconds). MUST include the DOD SLO thresholds 0.12s (validate
 * p95, pending E013) and 0.30s (issuance p95) so the recording rules / dashboards read the exact SLI
 * boundary bucket (SC-006). Kept short and bounded to hold histogram series cardinality down.
 */
export const RED_DURATION_BUCKETS = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.12, 0.2, 0.3, 0.5, 1, 2.5, 5,
] as const;

/**
 * The dedicated metrics registry. Content type is OpenMetrics so histogram EXEMPLARS (the sanctioned
 * bridge from a latency bucket to a representative trace, {SAD:ADR-0009}) can render; a Prometheus
 * scraper reads OpenMetrics natively. This is the only registry the metrics listener exposes.
 */
export const registry = new Registry<OpenMetricsContentType>();
registry.setContentType(Registry.OPENMETRICS_CONTENT_TYPE);

// --- RED instruments (OR-006) ----------------------------------------------------------------------

/** Request duration histogram — the core latency SLI source. Exemplars enabled for trace drill-down. */
const requestDuration = new Histogram({
  name: "http_request_duration_seconds",
  help: "HTTP server request duration in seconds, labelled by bounded route pattern, method and outcome (RED).",
  labelNames: RED_LABEL_NAMES,
  buckets: [...RED_DURATION_BUCKETS],
  registers: [registry],
  enableExemplars: true,
});

/** Request counter by outcome — the availability / rate SLI source. */
const requestsTotal = new Counter({
  name: "http_requests_total",
  help: "Total HTTP server requests, labelled by bounded route pattern, method and outcome (RED).",
  labelNames: RED_LABEL_NAMES,
  registers: [registry],
});

/** Seat-contention counter — activation attempts denied by seat-limit contention. No identity labels. */
const seatContentionTotal = new Counter({
  name: "seat_contention_total",
  help: "Activation attempts denied by seat-limit contention (no per-tenant / identity labels).",
  registers: [registry],
});

/** Failed-validation / tamper counter — rejected or tampered license tokens. No identity labels. */
const tamperDetectedTotal = new Counter({
  name: "tamper_detected_total",
  help: "Failed license-token validations / tamper-detection events (no per-tenant / identity labels).",
  registers: [registry],
});

/** A single RED observation for one completed request. `durationMs` is server-measured (ms). */
export interface RedObservation {
  /** Bounded route PATTERN (e.g. `/v1/activations`), never a raw URL (cardinality ceiling, OR-008). */
  route: string;
  method: string;
  /** Coarse outcome bucket: `success` | `client_error` | `server_error` (see `outcomeFromStatus`). */
  outcome: string;
  durationMs: number;
}

/** Coerce a millisecond duration into non-negative seconds; a bad value degrades to 0, never NaN. */
function toSeconds(durationMs: number): number {
  return Number.isFinite(durationMs) && durationMs >= 0 ? durationMs / 1000 : 0;
}

/**
 * Record the RED signals for one completed request (OR-006). Called from the `app.ts` `onResponse`
 * hook — the SAME hook that logs — so a metric and a log line share one measurement. FAIL-OPEN: any
 * internal error is swallowed so metric recording never throws into the request path (OR-014).
 */
export function recordRed(obs: RedObservation): void {
  try {
    const labels = { route: obs.route, method: obs.method, outcome: obs.outcome };
    requestsTotal.inc(labels);
    // Exemplar-enabled histograms take the object form of `observe`; exemplar labels (trace_id) are
    // attached later by the tracing phase (OBJ4) — omitting them here is valid (no-op exemplar).
    requestDuration.observe({ labels, value: toSeconds(obs.durationMs) });
  } catch {
    /* fail-open: telemetry must never affect request handling (OR-014) */
  }
}

/** Bump the seat-contention counter (OR-006). Fail-open — never throws into the caller. */
export function recordSeatContention(value = 1): void {
  try {
    seatContentionTotal.inc(value);
  } catch {
    /* fail-open */
  }
}

/** Bump the failed-validation / tamper counter (OR-006). Fail-open — never throws into the caller. */
export function recordTamper(value = 1): void {
  try {
    tamperDetectedTotal.inc(value);
  } catch {
    /* fail-open */
  }
}

// --- Infra metrics (OR-007, OR-020) ----------------------------------------------------------------

// Process CPU / memory / event-loop / GC — the standard Node runtime metrics on the SAME registry.
collectDefaultMetrics({ register: registry });

/** The minimal pg.Pool connection-stats surface the pool gauges read (a live `pg.Pool` satisfies it). */
export interface PoolStatsSource {
  readonly totalCount: number;
  readonly idleCount: number;
  readonly waitingCount: number;
}

// The live pool whose stats the gauges expose on scrape. Set once at bootstrap via `setPoolStatsSource`.
let poolRef: PoolStatsSource | undefined;

/**
 * Register the live pg pool whose connection stats the pool gauges expose on scrape. Idempotent — the
 * gauges read the current `poolRef` lazily inside their `collect` callback, so re-registering just
 * repoints them. Pass `undefined` to detach (e.g. on shutdown / in tests).
 */
export function setPoolStatsSource(pool: PoolStatsSource | undefined): void {
  poolRef = pool;
}

/** Register a labelless gauge whose value is read from the live pool on each scrape (fail-open read). */
function registerPoolGauge(name: string, help: string, read: (p: PoolStatsSource) => number): void {
  new Gauge({
    name,
    help,
    registers: [registry],
    collect(this: Gauge) {
      const p = poolRef;
      if (p) this.set(read(p));
    },
  });
}

registerPoolGauge("pg_pool_connections_total", "Total connections currently in the pg pool.", (p) => p.totalCount);
registerPoolGauge("pg_pool_connections_idle", "Idle connections currently in the pg pool.", (p) => p.idleCount);
registerPoolGauge(
  "pg_pool_connections_waiting",
  "Queued requests waiting for a pg pool connection (contention indicator).",
  (p) => p.waitingCount,
);

/** Signer availability gauge — 1 reachable/healthy, 0 unavailable. Availability ONLY, never key material. */
const signerUp = new Gauge({
  name: "signer_up",
  help: "Signer availability: 1 when the signer is reachable/healthy, 0 when unavailable (no key material, OR-020).",
  registers: [registry],
});

/** Signer call latency by outcome ONLY — never key material, key id, or the signing payload (OR-020). */
const signerRequestDuration = new Histogram({
  name: "signer_request_duration_seconds",
  help: "Signer call latency in seconds, labelled by outcome only (no key material / payload, OR-020).",
  labelNames: ["outcome"] as const,
  buckets: [...RED_DURATION_BUCKETS],
  registers: [registry],
});

/** Set the signer availability gauge (OR-007). Fail-open — never throws into the caller. */
export function setSignerAvailability(up: boolean): void {
  try {
    signerUp.set(up ? 1 : 0);
  } catch {
    /* fail-open */
  }
}

/**
 * Record a signer call's latency + outcome (OR-007/020). Availability/latency/outcome ONLY — the caller
 * MUST NOT pass any key material or payload; only the coarse `outcome` becomes a (bounded) label.
 */
export function recordSignerCall(obs: { outcome: string; durationMs: number }): void {
  try {
    signerRequestDuration.observe({ outcome: obs.outcome }, toSeconds(obs.durationMs));
  } catch {
    /* fail-open */
  }
}

// --- Dedicated metrics-port listener (OR-005, AD-001) ----------------------------------------------

/** A minimal structural logger (pino / Fastify `app.log` satisfies it) for fail-open warnings. */
export interface MetricsLogger {
  warn: (obj: object, msg?: string) => void;
  info?: (obj: object, msg?: string) => void;
}

/** Options for the dedicated internal metrics listener. */
export interface MetricsListenerOptions {
  /** Port to bind; `0` requests an OS-assigned ephemeral port (tests). Callers gate `0`-means-disabled. */
  port: number;
  /** Bind interface. Defaults to loopback (`127.0.0.1`) — an internal, non-public interface (AD-001). */
  host?: string;
  /** Optional logger for fail-open bind/runtime warnings. */
  logger?: MetricsLogger;
}

/** A started (or fail-open no-op) metrics listener handle. */
export interface MetricsListener {
  /** The actually-bound port, or `null` when the bind failed (fail-open). */
  readonly port: number | null;
  /** True when the listener is bound and serving `/metrics`; false on a fail-open bind failure. */
  readonly bound: boolean;
  /** Stop the listener; resolves once closed (no-op when the bind failed). */
  close(): Promise<void>;
}

/** Serve `GET /metrics` from the registry; any other path is 404; a render failure is 500 to the scraper only. */
async function handleMetricsRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const path = (req.url ?? "").split("?", 1)[0];
  if (req.method !== "GET" || path !== "/metrics") {
    res.statusCode = 404;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("not found");
    return;
  }
  try {
    const body = await registry.metrics();
    res.statusCode = 200;
    res.setHeader("Content-Type", registry.contentType);
    res.end(body);
  } catch {
    // Fail-safe isolate: a metrics-render failure surfaces only to the scraper, never the API path.
    res.statusCode = 500;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("metrics collection error");
  }
}

/**
 * Start the dedicated internal metrics listener serving OpenMetrics `/metrics` (OR-005). Binding is
 * FAIL-OPEN (OR-014): a bind failure (EADDRINUSE / EACCES) logs a warning and resolves a no-op handle
 * (`bound: false`, `port: null`) — it NEVER rejects, throws, or crashes startup. Callers skip this when
 * the configured metrics port is `0` (disabled). The returned promise always resolves.
 */
export function startMetricsListener(opts: MetricsListenerOptions): Promise<MetricsListener> {
  const host = opts.host ?? "127.0.0.1";
  const warn = (obj: object, msg: string): void => opts.logger?.warn(obj, msg);

  return new Promise<MetricsListener>((resolve) => {
    const server = createServer((req, res) => void handleMetricsRequest(req, res));

    const onBindError = (err: NodeJS.ErrnoException): void => {
      warn(
        { error: err.message, code: err.code, port: opts.port, host },
        "metrics listener bind failed; continuing without /metrics (fail-open)",
      );
      resolve({ port: null, bound: false, close: () => Promise.resolve() });
    };
    server.once("error", onBindError);

    server.once("listening", () => {
      server.removeListener("error", onBindError);
      // Post-bind runtime errors must not crash the process either (fail-open).
      server.on("error", (e: NodeJS.ErrnoException) =>
        warn({ error: e.message, code: e.code }, "metrics listener runtime error"),
      );
      const addr = server.address();
      const port = addr !== null && typeof addr === "object" ? addr.port : opts.port;
      resolve({
        port,
        bound: true,
        close: () => new Promise<void>((res) => server.close(() => res())),
      });
    });

    server.listen(opts.port, host);
  });
}
