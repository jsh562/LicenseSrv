// T020 [US2] Unit (TDD) — the pure rollup MATH per aggregation (FR-010/013/014, HINT-002/HINT-003). Drives the
// signed net + distinct count + display floor + over-quota derivation WITHOUT a DB:
//   - SUM          → the signed sum of quantities (a negative quantity is a reversal that decrements the net);
//   - COUNT        → the signed sum of the integer quantities (a `-1` decrements the event count) — identical
//                    arithmetic on the guarded integers;
//   - UNIQUE_COUNT → the number of DISTINCT value_hashes (monotonic within a bucket — a reversal never retracts
//                    a distinct value), and identical dimension tuples hash identically (counted once);
//   - the display floor `max(0, net)` so a viewer never sees negative usage after a reversal (storage is NOT
//     floored — the true signed net remains recoverable);
//   - the derived over-quota signal (value > allowance on the TRUE net; a null allowance is never over).
import { describe, expect, it } from "vitest";

import { bucketStartFor, floorDisplay, hashDimensions, isOverQuota, sumNet, uniqueCount } from "../rollup.js";

describe("rollup math — SUM / COUNT signed net (T020)", () => {
  it("SUMs signed quantities (a reversal decrements the net)", () => {
    expect(sumNet([100, 200, 50])).toBe(350);
    expect(sumNet([1000, -200])).toBe(800); // a signed-negative reversal decrements
    expect(sumNet([])).toBe(0);
    expect(sumNet([10.5, -0.5])).toBe(10);
  });

  it("COUNT is the signed sum of the integer quantities (a -1 removes one previously-counted event)", () => {
    // COUNT quantities are non-zero integers; each event contributes its integer count, a reversal decrements.
    expect(sumNet([1, 1, 1])).toBe(3);
    expect(sumNet([1, 1, 1, -1])).toBe(2);
    expect(sumNet([5, -2])).toBe(3);
  });

  it("keeps the TRUE signed net negative when reversals exceed accrual (storage is not floored)", () => {
    expect(sumNet([100, -300])).toBe(-200);
  });
});

describe("rollup math — UNIQUE_COUNT distinct set (T020)", () => {
  it("counts DISTINCT value hashes; identical dimensions hash identically (counted once)", () => {
    const a = hashDimensions({ region: "eu-west-1" });
    const b = hashDimensions({ region: "us-east-1" });
    const aAgain = hashDimensions({ region: "eu-west-1" });
    expect(a.equals(aAgain)).toBe(true); // deterministic
    expect(a.equals(b)).toBe(false);
    expect(uniqueCount([a, b, aAgain])).toBe(2); // eu + us, the duplicate eu folds in once
  });

  it("hashes are order-independent over dimension keys (canonical) and empty dimensions are a single value", () => {
    const x = hashDimensions({ a: "1", b: "2" });
    const y = hashDimensions({ b: "2", a: "1" });
    expect(x.equals(y)).toBe(true);
    expect(uniqueCount([hashDimensions({}), hashDimensions({})])).toBe(1);
  });

  it("is monotonic — a distinct value already seen never lowers the count (a reversal cannot retract it)", () => {
    const v = hashDimensions({ user: "u1" });
    expect(uniqueCount([v, v, v])).toBe(1);
  });
});

describe("rollup math — display floor + over-quota (T020)", () => {
  it("floors the DISPLAY value at zero (max(0, net)) without mutating the true net", () => {
    expect(floorDisplay(350)).toBe(350);
    expect(floorDisplay(-200)).toBe(0); // a viewer never sees negative usage
    expect(floorDisplay(0)).toBe(0);
  });

  it("derives over-quota on the TRUE net vs allowance (a null allowance is never over)", () => {
    expect(isOverQuota(11000, 10000)).toBe(true);
    expect(isOverQuota(9000, 10000)).toBe(false);
    expect(isOverQuota(10000, 10000)).toBe(false); // strictly greater crosses
    expect(isOverQuota(500, null)).toBe(false);
    // Evaluated on the true (un-floored) net: a net-negative bucket is not over quota.
    expect(isOverQuota(-50, 10)).toBe(false);
  });
});

describe("rollup math — hourly bucketing (T020)", () => {
  it("truncates an event_time to its UTC-hour bucket start for the default 3600s grain (INV-4)", () => {
    expect(bucketStartFor(new Date("2026-08-02T08:37:12.500Z"), 3600).toISOString()).toBe("2026-08-02T08:00:00.000Z");
    expect(bucketStartFor(new Date("2026-08-02T08:00:00.000Z"), 3600).toISOString()).toBe("2026-08-02T08:00:00.000Z");
    expect(bucketStartFor(new Date("2026-08-02T08:59:59.999Z"), 3600).toISOString()).toBe("2026-08-02T08:00:00.000Z");
  });
});
