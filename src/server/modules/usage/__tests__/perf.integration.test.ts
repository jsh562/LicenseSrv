// T043 (SC-011 fast-ack): the runtime usage-ingest surface acknowledges quickly under a high-write burst. A
// validly-authed POST /v1/usage drives the FULL fast-ack path against real Postgres — the `usage.ingest` scope
// gate, per-event validate (dimension allow-list + skew + entitlement/license re-resolve), and the single
// idempotent `INSERT ... ON CONFLICT DO NOTHING` batch append + per-batch summary — WITHOUT the async rollup
// (accept-then-aggregate, AD-002). The ack-latency p95 must sit well under the ~200 ms fast-ack target (plan
// Performance Goals / SC-011). Measured for REAL via `inject`. CI is noisy, so a robust ceiling is used and the
// test SKIPS (never fails) when the environment is demonstrably underpowered (a slow warmed median) rather than
// reporting a false regression — exactly like the billing / lease fast-ack tests.
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { startHarness, type UsageHarness } from "./harness.js";

let h: UsageHarness;
let entitlementId: string;

const WARMUP = 8;
const SAMPLES = 50;
/** Events per ingest batch — a realistic small batch a high-write agent flushes. */
const BATCH_SIZE = 10;
/** The fast-ack ceiling (plan Performance Goals: < ~200 ms p95). Generous vs the target to stay robust on CI. */
const P95_CEILING_MS = 200;
/** If a warmed median already exceeds this, the box is too underpowered to measure meaningfully → skip. */
const UNDERPOWERED_MEDIAN_MS = 150;
const HOUR_MS = 3_600_000;

beforeAll(async () => {
  h = await startHarness("perf");
  // A SUM meter — every reported quantity accrues (no per-event refusal on the measured path).
  entitlementId = await h.createMeteredEntitlement({ aggregation: "sum" });
}, 240_000);

afterAll(async () => {
  await h?.stop();
});

function percentile(sorted: number[], p: number): number {
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return sorted[idx]!;
}

/** A batch of BATCH_SIZE distinct, valid, in-window events (unique idempotency keys → all fresh accruals). */
function batch(): { events: Record<string, unknown>[] } {
  const at = new Date(Math.floor(Date.now() / HOUR_MS) * HOUR_MS - HOUR_MS).toISOString();
  const events: Record<string, unknown>[] = [];
  for (let i = 0; i < BATCH_SIZE; i++) {
    events.push({
      licenseId: h.chainA.licenseId,
      entitlementId,
      source: "perf",
      eventId: randomUUID(),
      eventTime: at,
      quantity: 1,
      dimensions: { region: "eu", tier: "gold" },
    });
  }
  return { events };
}

describe("usage ingest fast-ack latency — p95 under a high-write burst (SC-011, plan Performance Goals)", () => {
  it(`fast-acks the ingest batch with p95 < ${P95_CEILING_MS} ms`, async (ctx) => {
    const doIngest = async (): Promise<void> => {
      const res = await h.ingest(h.usageKey, batch());
      if (res.statusCode !== 200) throw new Error(`ingest failed: ${res.statusCode} ${res.body}`);
    };

    // Warm the pool / JIT / query plans.
    for (let i = 0; i < WARMUP; i++) await doIngest();

    const ackMs: number[] = [];
    for (let i = 0; i < SAMPLES; i++) {
      const t0 = performance.now();
      await doIngest();
      ackMs.push(performance.now() - t0);
    }

    ackMs.sort((a, b) => a - b);
    const p50 = percentile(ackMs, 0.5);
    const p95 = percentile(ackMs, 0.95);
    console.info(
      `[perf] usage ingest ack latency over ${SAMPLES} samples (${BATCH_SIZE} events/batch): p50=${p50.toFixed(1)}ms p95=${p95.toFixed(1)}ms`,
    );

    // CI is noisy: if even the median is slow, the box is underpowered — skip rather than report a false fail.
    if (p50 > UNDERPOWERED_MEDIAN_MS) {
      console.warn(`[perf] median ${p50.toFixed(1)}ms > ${UNDERPOWERED_MEDIAN_MS}ms — environment underpowered; skipping the p95 assertion`);
      ctx.skip();
      return;
    }

    expect(p95).toBeLessThan(P95_CEILING_MS);
  });
});
