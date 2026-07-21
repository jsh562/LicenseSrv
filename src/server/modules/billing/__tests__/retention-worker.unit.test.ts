// [US1] (FR-021/SC-015): retention prune worker unit tests. Drives `pruneBillingLedger` + the worker with a
// FAKE pg pool (no DB): the cutoff is `now - clamped-retention` and a below-floor horizon is clamped strictly
// above the idempotency floor; the prune runs on the owner (privileged) connection; the worker is FAIL-OPEN (a
// prune fault never throws out of `runOnce`), never overlaps sweeps, unref's its cadence timer, and only logs a
// count when rows were actually pruned.
import type pg from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";

import { IDEMPOTENCY_FLOOR_SECS, loadBillingConfig } from "../config.js";
import {
  DEFAULT_RETENTION_WORKER_INTERVAL_MS,
  pruneBillingLedger,
  startBillingRetentionWorker,
} from "../retention-worker.js";

interface QueryCall {
  text: string;
  params: readonly unknown[];
}

/** A fake pg pool whose single client's `query` runs `onQuery`; records every query + release. */
function fakePool(onQuery: (text: string, params: readonly unknown[]) => Promise<{ rowCount: number }>): {
  pool: pg.Pool;
  calls: QueryCall[];
  released: number;
} {
  const calls: QueryCall[] = [];
  const state = { released: 0 };
  const client = {
    query: (text: string, params: readonly unknown[] = []) => {
      calls.push({ text, params });
      return onQuery(text, params);
    },
    release: () => {
      state.released += 1;
    },
  };
  const pool = { connect: () => Promise.resolve(client) } as unknown as pg.Pool;
  return {
    pool,
    calls,
    get released() {
      return state.released;
    },
  };
}

const config = loadBillingConfig({}); // default 365d retention

afterEach(() => {
  vi.useRealTimers();
});

describe("pruneBillingLedger", () => {
  it("deletes on the owner connection with cutoff = now - clamped retention and returns the count", async () => {
    const { pool, calls } = fakePool(() => Promise.resolve({ rowCount: 3 }));
    const nowUnix = 1_000_000_000;
    const cfg = { ...config, ledgerRetentionSecs: 259_200 }; // 72h
    const { deleted } = await pruneBillingLedger(pool, cfg, nowUnix);

    expect(deleted).toBe(3);
    expect(calls[0]!.text).toMatch(/DELETE FROM billing_event WHERE received_at < to_timestamp/i);
    expect(calls[0]!.params).toEqual([nowUnix - 259_200]);
  });

  it("clamps a below-floor horizon strictly above the idempotency floor (FR-003)", async () => {
    const { pool, calls } = fakePool(() => Promise.resolve({ rowCount: 0 }));
    const nowUnix = 1_000_000_000;
    await pruneBillingLedger(pool, { ...config, ledgerRetentionSecs: 60 }, nowUnix);
    // 60s < floor → clamped to floor+1, so the cutoff sits a full floor+1 in the past (never inside the window).
    expect(calls[0]!.params).toEqual([nowUnix - (IDEMPOTENCY_FLOOR_SECS + 1)]);
  });
});

describe("startBillingRetentionWorker", () => {
  it("runs a prune on immediate:true and reports the count via the logger", async () => {
    const info = vi.fn();
    const { pool } = fakePool(() => Promise.resolve({ rowCount: 5 }));
    const worker = startBillingRetentionWorker(pool, config, { immediate: false, logger: { warn: vi.fn(), info } });
    try {
      await worker.runOnce();
    } finally {
      worker.stop();
    }
    expect(info).toHaveBeenCalledWith(expect.objectContaining({ event: "retention_pruned", deleted: 5 }), expect.any(String));
  });

  it("does NOT log a count when nothing was pruned", async () => {
    const info = vi.fn();
    const { pool } = fakePool(() => Promise.resolve({ rowCount: 0 }));
    const worker = startBillingRetentionWorker(pool, config, { immediate: false, logger: { warn: vi.fn(), info } });
    try {
      await worker.runOnce();
    } finally {
      worker.stop();
    }
    expect(info).not.toHaveBeenCalled();
  });

  it("is FAIL-OPEN: a prune fault is caught + logged and never throws out of runOnce", async () => {
    const warn = vi.fn();
    const onError = vi.fn();
    const { pool } = fakePool(() => Promise.reject(new Error("db is down")));
    const worker = startBillingRetentionWorker(pool, config, { immediate: false, logger: { warn }, onError });
    try {
      await expect(worker.runOnce()).resolves.toBeUndefined(); // never rejects
    } finally {
      worker.stop();
    }
    expect(warn).toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(expect.any(Error));
  });

  it("never overlaps sweeps (a second runOnce while one is in-flight is a no-op)", async () => {
    let inFlight = 0;
    let maxConcurrent = 0;
    const { pool } = fakePool(async () => {
      inFlight += 1;
      maxConcurrent = Math.max(maxConcurrent, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return { rowCount: 0 };
    });
    const worker = startBillingRetentionWorker(pool, config, { immediate: false });
    try {
      await Promise.all([worker.runOnce(), worker.runOnce()]);
    } finally {
      worker.stop();
    }
    expect(maxConcurrent).toBe(1); // the running guard prevented an overlapping sweep
  });

  it("unref's its cadence timer so it never keeps the process alive", () => {
    vi.useFakeTimers();
    const unref = vi.fn();
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval").mockReturnValue({ unref } as unknown as NodeJS.Timeout);
    const { pool } = fakePool(() => Promise.resolve({ rowCount: 0 }));
    const worker = startBillingRetentionWorker(pool, config, { immediate: false });
    expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), DEFAULT_RETENTION_WORKER_INTERVAL_MS);
    expect(unref).toHaveBeenCalled();
    worker.stop();
    setIntervalSpy.mockRestore();
  });
});
