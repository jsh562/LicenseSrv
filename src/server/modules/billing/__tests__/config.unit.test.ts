// [US1/US3/US5] (FR-011/021/022): billing config resolver unit tests. Exercises the grace-window override
// precedence (per-plan override → connection default → deployment default, each skipping a non-positive tier),
// the ledger-retention clamp (never at/below the idempotency floor), the rotation-window predicate, and
// `loadBillingConfig`'s env-override + default + clamp branches (`intEnv`). Pure unit tests — no DB.
import { describe, expect, it } from "vitest";

import {
  type BillingConfig,
  DEFAULT_GRACE_SECONDS,
  DEFAULT_LEDGER_RETENTION_SECS,
  DEFAULT_SECRET_ROTATION_WINDOW_SECS,
  DEFAULT_SIGNATURE_TOLERANCE_SECS,
  IDEMPOTENCY_FLOOR_SECS,
  isRotationWindowOpen,
  loadBillingConfig,
  resolveGraceSeconds,
  resolveLedgerRetentionSecs,
  resolveRotationWindowSecs,
  resolveToleranceSecs,
} from "../config.js";

const base: BillingConfig = {
  defaultGraceSeconds: 1_000,
  signatureToleranceSecs: 300,
  webhookRateMaxPerConnection: 120,
  webhookRateMaxPerIp: 300,
  webhookRateWindow: "1 minute",
  ledgerRetentionSecs: 31_536_000,
  secretRotationWindowSecs: 86_400,
};

describe("resolveGraceSeconds (FR-011 precedence)", () => {
  it("a positive per-plan override wins over the connection + deployment defaults", () => {
    expect(resolveGraceSeconds(base, { defaultGraceSeconds: 500, graceOverrides: { pro: 42 } }, "pro")).toBe(42);
  });

  it("floors a fractional override", () => {
    expect(resolveGraceSeconds(base, { graceOverrides: { pro: 42.9 } }, "pro")).toBe(42);
  });

  it("skips a non-positive / non-finite override and falls to the connection default", () => {
    expect(resolveGraceSeconds(base, { defaultGraceSeconds: 500, graceOverrides: { pro: 0 } }, "pro")).toBe(500);
    expect(resolveGraceSeconds(base, { defaultGraceSeconds: 500, graceOverrides: { pro: -5 } }, "pro")).toBe(500);
  });

  it("uses the connection default when there is no matching override", () => {
    expect(resolveGraceSeconds(base, { defaultGraceSeconds: 700, graceOverrides: { other: 9 } }, "pro")).toBe(700);
    expect(resolveGraceSeconds(base, { defaultGraceSeconds: 700 }, null)).toBe(700);
    expect(resolveGraceSeconds(base, { defaultGraceSeconds: 700, graceOverrides: null }, undefined)).toBe(700);
  });

  it("falls all the way to the deployment default when both tiers are absent / non-positive", () => {
    expect(resolveGraceSeconds(base, {}, "pro")).toBe(base.defaultGraceSeconds);
    expect(resolveGraceSeconds(base, { defaultGraceSeconds: 0 }, "pro")).toBe(base.defaultGraceSeconds);
    expect(resolveGraceSeconds(base, { defaultGraceSeconds: -1, graceOverrides: {} }, "pro")).toBe(base.defaultGraceSeconds);
  });
});

describe("resolveLedgerRetentionSecs (FR-003/021 clamp)", () => {
  it("keeps a value strictly above the idempotency floor", () => {
    expect(resolveLedgerRetentionSecs(DEFAULT_LEDGER_RETENTION_SECS)).toBe(DEFAULT_LEDGER_RETENTION_SECS);
    expect(resolveLedgerRetentionSecs(IDEMPOTENCY_FLOOR_SECS + 10)).toBe(IDEMPOTENCY_FLOOR_SECS + 10);
  });

  it("clamps a value at/below the floor up to floor+1 (a redeliverable event id is never pruned)", () => {
    expect(resolveLedgerRetentionSecs(IDEMPOTENCY_FLOOR_SECS)).toBe(IDEMPOTENCY_FLOOR_SECS + 1);
    expect(resolveLedgerRetentionSecs(100)).toBe(IDEMPOTENCY_FLOOR_SECS + 1);
    expect(resolveLedgerRetentionSecs(0)).toBe(IDEMPOTENCY_FLOOR_SECS + 1);
    expect(resolveLedgerRetentionSecs(Number.NaN)).toBe(IDEMPOTENCY_FLOOR_SECS + 1);
  });

  it("floors a fractional above-floor value", () => {
    expect(resolveLedgerRetentionSecs(IDEMPOTENCY_FLOOR_SECS + 5.9)).toBe(IDEMPOTENCY_FLOOR_SECS + 5);
  });
});

describe("isRotationWindowOpen (FR-022)", () => {
  const now = new Date("2026-07-20T12:00:00.000Z");

  it("is false when the secret was never rotated (null/undefined)", () => {
    expect(isRotationWindowOpen(base, null, now)).toBe(false);
    expect(isRotationWindowOpen(base, undefined, now)).toBe(false);
  });

  it("is true while now - rotatedAt is within the window", () => {
    const rotatedAt = new Date(now.getTime() - 3_600_000); // 1h ago, window is 24h
    expect(isRotationWindowOpen(base, rotatedAt, now)).toBe(true);
  });

  it("is false once the window has elapsed", () => {
    const rotatedAt = new Date(now.getTime() - (base.secretRotationWindowSecs + 1) * 1000);
    expect(isRotationWindowOpen(base, rotatedAt, now)).toBe(false);
  });

  it("is false for a future rotation timestamp (negative elapsed)", () => {
    const rotatedAt = new Date(now.getTime() + 10_000);
    expect(isRotationWindowOpen(base, rotatedAt, now)).toBe(false);
  });
});

describe("simple resolvers", () => {
  it("returns the configured tolerance + rotation window", () => {
    expect(resolveToleranceSecs(base)).toBe(300);
    expect(resolveRotationWindowSecs(base)).toBe(86_400);
  });
});

describe("loadBillingConfig (env override + default + clamp)", () => {
  it("falls back to the documented defaults for an empty env", () => {
    const cfg = loadBillingConfig({});
    expect(cfg.defaultGraceSeconds).toBe(DEFAULT_GRACE_SECONDS);
    expect(cfg.signatureToleranceSecs).toBe(DEFAULT_SIGNATURE_TOLERANCE_SECS);
    expect(cfg.ledgerRetentionSecs).toBe(DEFAULT_LEDGER_RETENTION_SECS);
    expect(cfg.secretRotationWindowSecs).toBe(DEFAULT_SECRET_ROTATION_WINDOW_SECS);
    expect(cfg.webhookRateWindow).toBe("1 minute");
  });

  it("reads positive-int env overrides and trims the rate window", () => {
    const cfg = loadBillingConfig({
      BILLING_DEFAULT_GRACE_SECONDS: "600",
      BILLING_SIGNATURE_TOLERANCE_SECS: "120",
      BILLING_WEBHOOK_RATE_MAX_PER_CONNECTION: "10",
      BILLING_WEBHOOK_RATE_MAX_PER_IP: "20",
      BILLING_WEBHOOK_RATE_WINDOW: "  30 seconds  ",
      BILLING_LEDGER_RETENTION_SECS: String(IDEMPOTENCY_FLOOR_SECS + 500),
      BILLING_SECRET_ROTATION_WINDOW_SECS: "7200",
    });
    expect(cfg.defaultGraceSeconds).toBe(600);
    expect(cfg.signatureToleranceSecs).toBe(120);
    expect(cfg.webhookRateMaxPerConnection).toBe(10);
    expect(cfg.webhookRateMaxPerIp).toBe(20);
    expect(cfg.webhookRateWindow).toBe("30 seconds");
    expect(cfg.ledgerRetentionSecs).toBe(IDEMPOTENCY_FLOOR_SECS + 500);
    expect(cfg.secretRotationWindowSecs).toBe(7_200);
  });

  it("ignores a non-positive / non-numeric env value and clamps a below-floor retention", () => {
    const cfg = loadBillingConfig({
      BILLING_DEFAULT_GRACE_SECONDS: "0",
      BILLING_SIGNATURE_TOLERANCE_SECS: "not-a-number",
      BILLING_WEBHOOK_RATE_MAX_PER_CONNECTION: "-4",
      BILLING_WEBHOOK_RATE_WINDOW: "   ",
      BILLING_LEDGER_RETENTION_SECS: "60", // below the floor → clamped
    });
    expect(cfg.defaultGraceSeconds).toBe(DEFAULT_GRACE_SECONDS);
    expect(cfg.signatureToleranceSecs).toBe(DEFAULT_SIGNATURE_TOLERANCE_SECS);
    expect(cfg.webhookRateMaxPerConnection).toBe(120);
    expect(cfg.webhookRateWindow).toBe("1 minute"); // blank trims to empty → default
    expect(cfg.ledgerRetentionSecs).toBe(IDEMPOTENCY_FLOOR_SECS + 1);
  });
});
