// [US1/US3] (FR-007/008/012/016): subscription repository unit tests. Drives the tx-composable functions with a
// stub `TxQuery` (no DB): the set-once link (success, and the UNIQUE-violation → duplicate_subscription, and a
// non-unique error rethrow), the monotonic-recency-guarded state advance (updated row vs guard-blocked null),
// the resolve/get lookups (found vs not-found), and the registry filter clauses (each filter + the cap param).
import type pg from "pg";
import { describe, expect, it } from "vitest";

import type { TxQuery } from "../../../db/client.js";
import { BillingError } from "../index.js";
import {
  applySubscriptionState,
  getSubscriptionById,
  linkSubscription,
  listSubscriptions,
  resolveSubscriptionByExternalId,
  type SubscriptionRecord,
} from "../subscription-repo.js";

interface Call {
  text: string;
  params: readonly unknown[];
}

/** A stub TxQuery capturing every SQL call and returning a canned result (or throwing a canned error). */
function stub(result: { rows: unknown[]; rowCount: number } | Error): { q: TxQuery; calls: Call[] } {
  const calls: Call[] = [];
  const q: TxQuery = (text, params = []) => {
    calls.push({ text, params });
    if (result instanceof Error) return Promise.reject(result);
    return Promise.resolve({ rows: result.rows, rowCount: result.rowCount } as pg.QueryResult);
  };
  return { q, calls };
}

/** A representative subscription row (Date columns as the pg driver returns them). */
function subRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "sub-uuid",
    provider: "stripe",
    external_subscription_id: "sub_ext",
    license_id: "lic-uuid",
    billing_state: "active",
    grace_expires_at: null,
    last_applied_event_at: null,
    created_at: new Date("2026-07-01T00:00:00.000Z"),
    updated_at: new Date("2026-07-02T00:00:00.000Z"),
    ...overrides,
  };
}

function pgError(code: string): Error & { code: string } {
  return Object.assign(new Error(`pg ${code}`), { code });
}

describe("linkSubscription (FR-005/012 set-once link)", () => {
  it("returns the created record with defaulted billing_state", async () => {
    const { q, calls } = stub({ rows: [subRow()], rowCount: 1 });
    const rec = await linkSubscription(q, { provider: "stripe", externalSubscriptionId: "sub_ext", licenseId: "lic-uuid" });
    expect(rec).toMatchObject<Partial<SubscriptionRecord>>({ id: "sub-uuid", billingState: "active", licenseId: "lic-uuid" });
    expect(calls[0]!.text).toMatch(/INSERT INTO subscription/i);
    expect(calls[0]!.params).toContain("active"); // billingState defaulted to 'active'
  });

  it("maps a UNIQUE violation (23505) to a 409 duplicate_subscription BillingError", async () => {
    const { q } = stub(pgError("23505"));
    await expect(
      linkSubscription(q, { provider: "stripe", externalSubscriptionId: "sub_ext", licenseId: "lic-uuid" }),
    ).rejects.toMatchObject({ code: "duplicate_subscription", status: 409 });
  });

  it("rethrows a non-unique DB error unchanged", async () => {
    const { q } = stub(pgError("42P01"));
    await expect(
      linkSubscription(q, { provider: "stripe", externalSubscriptionId: "sub_ext", licenseId: "lic-uuid" }),
    ).rejects.not.toBeInstanceOf(BillingError);
  });
});

describe("applySubscriptionState (FR-016 monotonic guard)", () => {
  it("returns the updated record when the guarded UPDATE matched a row", async () => {
    const { q, calls } = stub({ rows: [subRow({ billing_state: "grace" })], rowCount: 1 });
    const rec = await applySubscriptionState(q, "sub-uuid", { billingState: "grace", graceExpiresAt: null, occurredAt: 2_000 });
    expect(rec?.billingState).toBe("grace");
    // the recency guard is expressed inline in the WHERE clause, never a trigger
    expect(calls[0]!.text).toMatch(/last_applied_event_at IS NULL OR last_applied_event_at < to_timestamp/i);
  });

  it("returns null when the recency guard blocked the update (stale event / unknown id)", async () => {
    const { q } = stub({ rows: [], rowCount: 0 });
    const rec = await applySubscriptionState(q, "sub-uuid", { billingState: "active", graceExpiresAt: null, occurredAt: 1 });
    expect(rec).toBeNull();
  });
});

describe("resolve / get lookups", () => {
  it("resolveSubscriptionByExternalId returns the record when present, null otherwise", async () => {
    const found = stub({ rows: [subRow()], rowCount: 1 });
    expect(await resolveSubscriptionByExternalId(found.q, "stripe", "sub_ext")).not.toBeNull();
    const missing = stub({ rows: [], rowCount: 0 });
    expect(await resolveSubscriptionByExternalId(missing.q, "stripe", "sub_ext")).toBeNull();
  });

  it("getSubscriptionById returns the record when present, null otherwise", async () => {
    const found = stub({ rows: [subRow()], rowCount: 1 });
    expect(await getSubscriptionById(found.q, "sub-uuid")).not.toBeNull();
    const missing = stub({ rows: [], rowCount: 0 });
    expect(await getSubscriptionById(missing.q, "nope")).toBeNull();
  });
});

describe("listSubscriptions (FR-012 filters)", () => {
  it("issues no WHERE clause and only the cap param for an unfiltered list", async () => {
    const { q, calls } = stub({ rows: [subRow()], rowCount: 1 });
    await listSubscriptions(q, { cap: 50 });
    expect(calls[0]!.text).not.toMatch(/WHERE/i);
    expect(calls[0]!.params).toEqual([50]);
  });

  it("composes every supplied filter with the cap last", async () => {
    const { q, calls } = stub({ rows: [], rowCount: 0 });
    await listSubscriptions(q, { billingState: "grace", provider: "stripe", licenseId: "lic-uuid", cap: 25 });
    expect(calls[0]!.text).toMatch(/WHERE billing_state = \$1 AND provider = \$2 AND license_id = \$3/i);
    expect(calls[0]!.params).toEqual(["grace", "stripe", "lic-uuid", 25]);
  });
});
