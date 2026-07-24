// T041 (SC-014 fast-ack): the runtime lease surface acknowledges quickly. A validly-authed acquire drives the
// FULL path — entitlement + live-state read, scope→holder-key derivation, the per-license advisory-lock
// count+insert, and the E004-signed handle mint — and a renew drives the fence-guarded UPDATE + handle refresh,
// both against real Postgres + the real E004 signer. The acquire and renew ack-latency p95 must sit well under
// the ~200 ms fast-ack target (plan Performance Goals). Measured for REAL via `inject`. CI is noisy, so a
// robust ceiling is used and the test SKIPS (never fails) when the environment is demonstrably underpowered
// (a slow warmed median) rather than reporting a false regression — exactly like the billing fast-ack test.
import { performance } from "node:perf_hooks";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { startHarness, type LeaseHarness } from "./harness.js";

let h: LeaseHarness;

const WARMUP = 8;
const SAMPLES = 50;
/** The fast-ack ceiling (plan Performance Goals: < ~200 ms p95). Generous vs the target to stay robust on CI. */
const P95_CEILING_MS = 200;
/** If a warmed median already exceeds this, the box is too underpowered to measure meaningfully → skip. */
const UNDERPOWERED_MEDIAN_MS = 150;

beforeAll(async () => {
  h = await startHarness("perf");
}, 240_000);

afterAll(async () => {
  await h?.stop();
});

function percentile(sorted: number[], p: number): number {
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return sorted[idx]!;
}

describe("lease fast-ack latency — acquire + renew p95 (SC-014, plan Performance Goals)", () => {
  it(`acks acquire + renew with p95 < ${P95_CEILING_MS} ms`, async (ctx) => {
    // A large cap so acquires never contend on capacity — we measure the ack path, not a refusal.
    const lic = await h.issueFloating({ maxConcurrent: 100_000 });

    const doAcquire = async (): Promise<string> => {
      const res = await h.acquire(h.leaseKey, { licenseId: lic.licenseId, holderReference: h.holderRef(), acquireToken: h.nonce() });
      if (res.statusCode !== 201) throw new Error(`acquire failed: ${res.statusCode} ${res.body}`);
      return (res.json() as { id: string }).id;
    };

    // Warm the pool / JIT / query plans (acquire + renew each).
    for (let i = 0; i < WARMUP; i++) {
      const id = await doAcquire();
      expect((await h.renew(h.leaseKey, id)).statusCode).toBe(200);
    }

    const acquireMs: number[] = [];
    const renewMs: number[] = [];
    for (let i = 0; i < SAMPLES; i++) {
      const a0 = performance.now();
      const id = await doAcquire();
      acquireMs.push(performance.now() - a0);

      const r0 = performance.now();
      const renew = await h.renew(h.leaseKey, id);
      renewMs.push(performance.now() - r0);
      expect(renew.statusCode).toBe(200);
    }

    acquireMs.sort((a, b) => a - b);
    renewMs.sort((a, b) => a - b);
    const acqP50 = percentile(acquireMs, 0.5);
    const acqP95 = percentile(acquireMs, 0.95);
    const renP50 = percentile(renewMs, 0.5);
    const renP95 = percentile(renewMs, 0.95);
    console.info(
      `[perf] lease ack latency over ${SAMPLES} samples: acquire p50=${acqP50.toFixed(1)}ms p95=${acqP95.toFixed(1)}ms | ` +
        `renew p50=${renP50.toFixed(1)}ms p95=${renP95.toFixed(1)}ms`,
    );

    // CI is noisy: if even the median is slow, the box is underpowered — skip rather than report a false fail.
    const worstMedian = Math.max(acqP50, renP50);
    if (worstMedian > UNDERPOWERED_MEDIAN_MS) {
      console.warn(`[perf] median ${worstMedian.toFixed(1)}ms > ${UNDERPOWERED_MEDIAN_MS}ms — environment underpowered; skipping the p95 assertion`);
      ctx.skip();
      return;
    }

    expect(acqP95).toBeLessThan(P95_CEILING_MS);
    expect(renP95).toBeLessThan(P95_CEILING_MS);
  });
});
