// [Foundational] (FR-004/005/015): usage config resolver unit tests. Exercises `loadUsageConfig`'s
// default + env-override branches for every key (retention/dedupe window, future-skew allowance, hourly
// bucket grain, rollup sweep interval, ingest rate ceiling + window, batch cap, query-window bound) and the
// batch-cap clamp to the contract ceiling (`resolveMaxBatch`). Pure unit tests — no DB.
import { describe, expect, it } from "vitest";

import {
  DEFAULT_BUCKET_SECONDS,
  DEFAULT_FUTURE_SKEW_SECS,
  DEFAULT_INGEST_RATE_MAX,
  DEFAULT_INGEST_RATE_WINDOW,
  DEFAULT_MAX_BATCH,
  DEFAULT_QUERY_MAX_HOURS,
  DEFAULT_RETENTION_SECS,
  DEFAULT_ROLLUP_INTERVAL_MS,
  loadUsageConfig,
  MAX_BATCH_CEILING,
  resolveMaxBatch,
} from "../config.js";

describe("loadUsageConfig (FR-004/005/015 defaults)", () => {
  it("returns the documented defaults when the environment is empty", () => {
    expect(loadUsageConfig({})).toEqual({
      retentionSecs: DEFAULT_RETENTION_SECS,
      futureSkewSecs: DEFAULT_FUTURE_SKEW_SECS,
      bucketSeconds: DEFAULT_BUCKET_SECONDS,
      rollupIntervalMs: DEFAULT_ROLLUP_INTERVAL_MS,
      ingestRateMax: DEFAULT_INGEST_RATE_MAX,
      ingestRateWindow: DEFAULT_INGEST_RATE_WINDOW,
      maxBatch: DEFAULT_MAX_BATCH,
      queryMaxHours: DEFAULT_QUERY_MAX_HOURS,
    });
  });

  it("has a ~35-day retention window and a 3600s (one-hour) fixed bucket grain by default", () => {
    expect(DEFAULT_RETENTION_SECS).toBe(35 * 24 * 3600);
    expect(DEFAULT_BUCKET_SECONDS).toBe(3_600);
    expect(DEFAULT_MAX_BATCH).toBe(1_000);
  });

  it("honours valid env overrides for every key", () => {
    const cfg = loadUsageConfig({
      USAGE_RETENTION_SECS: "86400",
      USAGE_FUTURE_SKEW_SECS: "120",
      USAGE_BUCKET_SECONDS: "3600",
      USAGE_ROLLUP_INTERVAL_MS: "15000",
      USAGE_INGEST_RATE_MAX: "999",
      USAGE_INGEST_RATE_WINDOW: "30 seconds",
      USAGE_MAX_BATCH: "500",
      USAGE_QUERY_MAX_HOURS: "720",
    });
    expect(cfg).toEqual({
      retentionSecs: 86_400,
      futureSkewSecs: 120,
      bucketSeconds: 3_600,
      rollupIntervalMs: 15_000,
      ingestRateMax: 999,
      ingestRateWindow: "30 seconds",
      maxBatch: 500,
      queryMaxHours: 720,
    });
  });

  it("falls back to defaults for non-positive / non-numeric env values", () => {
    const cfg = loadUsageConfig({
      USAGE_RETENTION_SECS: "0",
      USAGE_FUTURE_SKEW_SECS: "-5",
      USAGE_BUCKET_SECONDS: "notanumber",
      USAGE_ROLLUP_INTERVAL_MS: "",
      USAGE_INGEST_RATE_MAX: "abc",
      USAGE_INGEST_RATE_WINDOW: "   ",
      USAGE_MAX_BATCH: "-1",
      USAGE_QUERY_MAX_HOURS: "0",
    });
    expect(cfg.retentionSecs).toBe(DEFAULT_RETENTION_SECS);
    expect(cfg.futureSkewSecs).toBe(DEFAULT_FUTURE_SKEW_SECS);
    expect(cfg.bucketSeconds).toBe(DEFAULT_BUCKET_SECONDS);
    expect(cfg.rollupIntervalMs).toBe(DEFAULT_ROLLUP_INTERVAL_MS);
    expect(cfg.ingestRateMax).toBe(DEFAULT_INGEST_RATE_MAX);
    expect(cfg.ingestRateWindow).toBe(DEFAULT_INGEST_RATE_WINDOW);
    expect(cfg.maxBatch).toBe(DEFAULT_MAX_BATCH);
    expect(cfg.queryMaxHours).toBe(DEFAULT_QUERY_MAX_HOURS);
  });

  it("floors a fractional env value to an integer", () => {
    expect(loadUsageConfig({ USAGE_FUTURE_SKEW_SECS: "90.9" }).futureSkewSecs).toBe(90);
  });
});

describe("resolveMaxBatch (FR-005 batch-cap clamp)", () => {
  it("clamps a request above the contract ceiling down to 1000", () => {
    expect(resolveMaxBatch(5_000)).toBe(MAX_BATCH_CEILING);
    expect(MAX_BATCH_CEILING).toBe(1_000);
  });

  it("keeps a valid in-range request", () => {
    expect(resolveMaxBatch(250)).toBe(250);
  });

  it("falls back to the default for a non-positive / non-finite request", () => {
    expect(resolveMaxBatch(0)).toBe(DEFAULT_MAX_BATCH);
    expect(resolveMaxBatch(-10)).toBe(DEFAULT_MAX_BATCH);
    expect(resolveMaxBatch(Number.NaN)).toBe(DEFAULT_MAX_BATCH);
  });

  it("clamps the env override too — an over-ceiling USAGE_MAX_BATCH resolves to 1000", () => {
    expect(loadUsageConfig({ USAGE_MAX_BATCH: "9999" }).maxBatch).toBe(MAX_BATCH_CEILING);
  });
});
