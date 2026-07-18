// T022 (OR-005 / OR-006 / OR-007, SC-003): the metrics-listener integration test. Starts the dedicated
// metrics listener on an ephemeral loopback port, scrapes GET /metrics, and asserts the RED + infra
// series are present in OpenMetrics/Prometheus text format. Also asserts the listener is FAIL-OPEN: a
// second bind on an already-used port resolves non-fatally (no throw), so a metrics-port collision can
// never crash startup (OR-014). Uses a lightweight FAKE pool exposing {totalCount, idleCount,
// waitingCount} rather than a testcontainer — the pool gauges only read those numbers, so no DB is needed.
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  type MetricsListener,
  recordRed,
  recordSeatContention,
  recordSignerCall,
  recordTamper,
  setPoolStatsSource,
  setSignerAvailability,
  startMetricsListener,
} from "../metrics.js";

/** A minimal stand-in for pg.Pool's connection-stats surface; the pool gauges read only these three. */
const fakePool = { totalCount: 7, idleCount: 4, waitingCount: 2 } as const;

/** Scrape GET /metrics from a bound listener and return status, content-type, and body. */
async function scrape(port: number): Promise<{ status: number; contentType: string; body: string }> {
  const res = await fetch(`http://127.0.0.1:${port}/metrics`);
  return { status: res.status, contentType: res.headers.get("content-type") ?? "", body: await res.text() };
}

describe("metrics listener scrape (OR-005/006/007)", () => {
  let listener: MetricsListener;

  beforeAll(async () => {
    setPoolStatsSource(fakePool);
    setSignerAvailability(true);
    // Generate RED + business series before the scrape so they materialise on the registry.
    recordRed({ route: "/v1/activations", method: "POST", outcome: "success", durationMs: 40 });
    recordRed({ route: "/admin/licenses", method: "POST", outcome: "server_error", durationMs: 500 });
    recordSeatContention();
    recordTamper();
    recordSignerCall({ outcome: "success", durationMs: 3 });
    listener = await startMetricsListener({ port: 0 }); // ephemeral loopback port
  });

  afterAll(async () => {
    await listener.close();
    setPoolStatsSource(undefined);
  });

  it("binds an ephemeral port and serves /metrics with a prom-client content type", async () => {
    expect(listener.bound).toBe(true);
    expect(typeof listener.port).toBe("number");
    const { status, contentType } = await scrape(listener.port as number);
    expect(status).toBe(200);
    expect(contentType).toMatch(/openmetrics-text|text\/plain/);
  });

  it("exposes the RED series (duration histogram + request/seat/tamper counters)", async () => {
    const { body } = await scrape(listener.port as number);
    expect(body).toContain("http_request_duration_seconds_bucket");
    expect(body).toContain("http_requests_total");
    expect(body).toContain("seat_contention_total");
    expect(body).toContain("tamper_detected_total");
    // RED labels present with a bounded route pattern (not a raw URL).
    expect(body).toMatch(/http_requests_total\{[^}]*route="\/v1\/activations"[^}]*\}/);
  });

  it("exposes the infra series (process, pg pool, signer) with live pool stats", async () => {
    const { body } = await scrape(listener.port as number);
    expect(body).toMatch(/process_cpu_seconds_total|process_resident_memory_bytes/);
    expect(body).toContain("signer_up");
    expect(body).toContain("signer_request_duration_seconds_bucket");
    // The pool gauges read the fake pool live on scrape.
    expect(body).toMatch(/pg_pool_connections_total\s+7/);
    expect(body).toMatch(/pg_pool_connections_idle\s+4/);
    expect(body).toMatch(/pg_pool_connections_waiting\s+2/);
  });

  it("returns 404 for a non-/metrics path", async () => {
    const res = await fetch(`http://127.0.0.1:${listener.port as number}/nope`);
    expect(res.status).toBe(404);
    await res.text();
  });
});

describe("metrics listener fail-open bind (OR-014)", () => {
  it("does not throw or crash when the port is already in use — resolves a no-op handle", async () => {
    const first = await startMetricsListener({ port: 0 });
    expect(first.bound).toBe(true);
    const usedPort = first.port as number;

    // Binding a SECOND listener on the SAME port must fail-open: resolve (never reject/throw), not bound.
    const collided = await startMetricsListener({ port: usedPort });
    expect(collided.bound).toBe(false);
    expect(collided.port).toBeNull();
    // close() on the no-op handle is safe.
    await collided.close();
    await first.close();
  });
});
