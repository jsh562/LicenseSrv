// [Foundational] (FR-009/012/017/023/026): lease config resolver unit tests. Exercises the lease-timing
// resolution + the TTL ≥ 3× heartbeat invariant CLAMP (INV-5), scope normalization, the cap/overage
// effective-cap math, and `loadLeaseConfig`'s env-override + default + clamp branches (timings, scope,
// overage, sweep batch, rate limit, signed-handle toggle, holder-key salt). Pure unit tests — no DB.
import { describe, expect, it } from "vitest";

import {
  CONCURRENCY_SCOPES,
  DEFAULT_GRACE_SECONDS,
  DEFAULT_HEARTBEAT_SECONDS,
  DEFAULT_HOLDER_KEY_SALT,
  DEFAULT_OVERAGE_ALLOWANCE,
  DEFAULT_RATE_MAX,
  DEFAULT_RATE_WINDOW,
  DEFAULT_SWEEP_MAX_BATCH,
  DEFAULT_SWEEP_SECONDS,
  DEFAULT_TTL_SECONDS,
  effectiveCap,
  loadLeaseConfig,
  resolveScope,
  resolveTimings,
  TTL_HEARTBEAT_MULTIPLE,
} from "../config.js";

describe("resolveTimings (FR-009 timings + TTL ≥ 3× heartbeat clamp, INV-5)", () => {
  it("returns the documented defaults for empty input", () => {
    expect(resolveTimings(undefined)).toEqual({
      heartbeatSeconds: DEFAULT_HEARTBEAT_SECONDS,
      ttlSeconds: DEFAULT_TTL_SECONDS,
      graceSeconds: DEFAULT_GRACE_SECONDS,
      sweepSeconds: DEFAULT_SWEEP_SECONDS,
    });
  });

  it("keeps a valid TTL that already satisfies the 3× heartbeat floor", () => {
    const t = resolveTimings({ heartbeatSeconds: 100, ttlSeconds: 900, graceSeconds: 60, sweepSeconds: 30 });
    expect(t).toEqual({ heartbeatSeconds: 100, ttlSeconds: 900, graceSeconds: 60, sweepSeconds: 30 });
  });

  it("RAISES a too-small TTL up to exactly 3× heartbeat (the missed-heartbeat invariant)", () => {
    const t = resolveTimings({ heartbeatSeconds: 600, ttlSeconds: 601 });
    expect(t.ttlSeconds).toBe(TTL_HEARTBEAT_MULTIPLE * 600); // 1800
    expect(t.ttlSeconds).toBeGreaterThanOrEqual(3 * t.heartbeatSeconds);
  });

  it("allows a zero grace but floors non-positive heartbeat/ttl/sweep to defaults", () => {
    const t = resolveTimings({ heartbeatSeconds: 0, ttlSeconds: -5, graceSeconds: 0, sweepSeconds: -1 });
    expect(t.heartbeatSeconds).toBe(DEFAULT_HEARTBEAT_SECONDS);
    expect(t.ttlSeconds).toBe(DEFAULT_TTL_SECONDS);
    expect(t.graceSeconds).toBe(0);
    expect(t.sweepSeconds).toBe(DEFAULT_SWEEP_SECONDS);
  });

  it("floors fractional inputs", () => {
    const t = resolveTimings({ heartbeatSeconds: 10.9, ttlSeconds: 100.9, graceSeconds: 5.9, sweepSeconds: 2.9 });
    expect(t).toEqual({ heartbeatSeconds: 10, ttlSeconds: 100, graceSeconds: 5, sweepSeconds: 2 });
  });
});

describe("resolveScope (FR-023)", () => {
  it("passes through every valid scope", () => {
    for (const s of CONCURRENCY_SCOPES) expect(resolveScope(s)).toBe(s);
  });

  it("falls back to session (or a supplied default) for an unknown / null / empty value", () => {
    expect(resolveScope("bogus")).toBe("session");
    expect(resolveScope(null)).toBe("session");
    expect(resolveScope(undefined)).toBe("session");
    expect(resolveScope("", "machine")).toBe("machine");
  });
});

describe("effectiveCap (FR-012 cap/overage)", () => {
  it("is the base cap under a hard cap (overage 0)", () => {
    expect(effectiveCap(5, 0)).toBe(5);
  });

  it("adds a positive overage allowance to the base cap", () => {
    expect(effectiveCap(5, 2)).toBe(7);
  });

  it("treats a negative / non-finite overage as a hard cap", () => {
    expect(effectiveCap(5, -3)).toBe(5);
    expect(effectiveCap(5, Number.NaN)).toBe(5);
  });
});

describe("loadLeaseConfig (env override + default + clamp)", () => {
  it("falls back to the documented defaults for an empty env", () => {
    const cfg = loadLeaseConfig({});
    expect(cfg.heartbeatSeconds).toBe(DEFAULT_HEARTBEAT_SECONDS);
    expect(cfg.ttlSeconds).toBe(DEFAULT_TTL_SECONDS);
    expect(cfg.graceSeconds).toBe(DEFAULT_GRACE_SECONDS);
    expect(cfg.sweepSeconds).toBe(DEFAULT_SWEEP_SECONDS);
    expect(cfg.scope).toBe("session");
    expect(cfg.overageAllowance).toBe(DEFAULT_OVERAGE_ALLOWANCE);
    expect(cfg.sweepMaxBatch).toBe(DEFAULT_SWEEP_MAX_BATCH);
    expect(cfg.rateMax).toBe(DEFAULT_RATE_MAX);
    expect(cfg.rateWindow).toBe(DEFAULT_RATE_WINDOW);
    expect(cfg.signedHandle).toBe(true);
    expect(cfg.holderKeySalt).toBe(DEFAULT_HOLDER_KEY_SALT);
  });

  it("reads env overrides, trims the rate window, and honours the signed-handle toggle", () => {
    const cfg = loadLeaseConfig({
      LEASE_HEARTBEAT_SECONDS: "300",
      LEASE_TTL_SECONDS: "1200",
      LEASE_GRACE_SECONDS: "120",
      LEASE_SWEEP_SECONDS: "30",
      LEASE_SCOPE: "machine",
      LEASE_OVERAGE_ALLOWANCE: "3",
      LEASE_SWEEP_MAX_BATCH: "250",
      LEASE_RATE_MAX: "600",
      LEASE_RATE_WINDOW: "  30 seconds  ",
      LEASE_SIGNED_HANDLE: "false",
      LEASE_HOLDER_KEY_SALT: "tenant-salt-xyz",
    });
    expect(cfg.heartbeatSeconds).toBe(300);
    expect(cfg.ttlSeconds).toBe(1200); // 1200 ≥ 3×300, no clamp
    expect(cfg.graceSeconds).toBe(120);
    expect(cfg.sweepSeconds).toBe(30);
    expect(cfg.scope).toBe("machine");
    expect(cfg.overageAllowance).toBe(3);
    expect(cfg.sweepMaxBatch).toBe(250);
    expect(cfg.rateMax).toBe(600);
    expect(cfg.rateWindow).toBe("30 seconds");
    expect(cfg.signedHandle).toBe(false);
    expect(cfg.holderKeySalt).toBe("tenant-salt-xyz");
  });

  it("clamps a too-small TTL up to 3× heartbeat from the env values (INV-5)", () => {
    const cfg = loadLeaseConfig({ LEASE_HEARTBEAT_SECONDS: "600", LEASE_TTL_SECONDS: "700" });
    expect(cfg.ttlSeconds).toBe(1800);
  });

  it("ignores non-positive / non-numeric env values and an unknown scope", () => {
    const cfg = loadLeaseConfig({
      LEASE_HEARTBEAT_SECONDS: "0",
      LEASE_TTL_SECONDS: "not-a-number",
      LEASE_SCOPE: "bogus",
      LEASE_OVERAGE_ALLOWANCE: "-4",
      LEASE_RATE_MAX: "-1",
      LEASE_RATE_WINDOW: "   ",
      LEASE_SIGNED_HANDLE: "maybe",
    });
    expect(cfg.heartbeatSeconds).toBe(DEFAULT_HEARTBEAT_SECONDS);
    expect(cfg.ttlSeconds).toBe(DEFAULT_TTL_SECONDS);
    expect(cfg.scope).toBe("session");
    expect(cfg.overageAllowance).toBe(DEFAULT_OVERAGE_ALLOWANCE);
    expect(cfg.rateMax).toBe(DEFAULT_RATE_MAX);
    expect(cfg.rateWindow).toBe(DEFAULT_RATE_WINDOW); // blank trims to empty → default
    expect(cfg.signedHandle).toBe(true); // unrecognised → default
  });
});
