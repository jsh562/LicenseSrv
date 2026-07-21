// T011 (FR-003/020): ledger idempotency + dead-letter outcome-shape unit tests. Drives `recordEvent` with a
// stub `TxQuery` (no DB): a fresh insert returns a row (`duplicate:false`); an ON CONFLICT no-op returns 0
// rows (`duplicate:true`, NEVER a second row); the outcome/reason shape is guarded (applied carries no
// reason; deadletter/rejected carry one). Asserts the dedup uses `ON CONFLICT … DO NOTHING`.
import type pg from "pg";
import { describe, expect, it } from "vitest";

import type { TxQuery } from "../../../db/client.js";
import { BillingError } from "../index.js";
import { deadLetter, pruneBillingEvents, recordEvent } from "../ledger-repo.js";

interface Call {
  text: string;
  params: readonly unknown[];
}

/** A stub TxQuery capturing the SQL + returning a canned `{rows,rowCount}`. */
function stubQuery(result: { rows: unknown[]; rowCount: number }): { q: TxQuery; calls: Call[] } {
  const calls: Call[] = [];
  const q: TxQuery = (text, params = []) => {
    calls.push({ text, params });
    return Promise.resolve({ rows: result.rows, rowCount: result.rowCount } as pg.QueryResult);
  };
  return { q, calls };
}

const base = {
  provider: "stripe",
  providerEventId: "evt_1",
  type: "subscription.canceled",
  subscriptionId: "sub-uuid",
  occurredAt: 1_000,
  reason: null as string | null,
  payloadSummary: { type: "subscription.canceled" },
};

describe("recordEvent idempotency (FR-003)", () => {
  it("inserts a fresh event and reports it is not a duplicate", async () => {
    const { q, calls } = stubQuery({ rows: [{ id: "row-1" }], rowCount: 1 });
    const r = await recordEvent(q, { ...base, outcome: "applied", reason: null });
    expect(r).toEqual({ id: "row-1", duplicate: false });
    // The dedup is ON CONFLICT DO NOTHING on the idempotency key.
    expect(calls[0]!.text).toMatch(/ON CONFLICT\s*\(tenant_id,\s*provider,\s*provider_event_id\)\s*DO NOTHING/i);
  });

  it("treats an ON CONFLICT no-op (0 rows) as a duplicate with NO second row", async () => {
    const { q } = stubQuery({ rows: [], rowCount: 0 });
    const r = await recordEvent(q, { ...base, outcome: "applied", reason: null });
    expect(r).toEqual({ id: null, duplicate: true });
  });
});

describe("recordEvent outcome/reason shape (FR-020)", () => {
  it("records a dead-letter with a reason", async () => {
    const { q, calls } = stubQuery({ rows: [{ id: "row-dl" }], rowCount: 1 });
    const r = await deadLetter(q, { ...base, subscriptionId: null, reason: "unmapped_event" });
    expect(r).toEqual({ id: "row-dl", duplicate: false });
    expect(calls[0]!.params).toContain("deadletter");
    expect(calls[0]!.params).toContain("unmapped_event");
  });

  it("rejects an applied event that carries a reason", async () => {
    const { q } = stubQuery({ rows: [{ id: "x" }], rowCount: 1 });
    await expect(recordEvent(q, { ...base, outcome: "applied", reason: "should_not_be_here" })).rejects.toBeInstanceOf(
      BillingError,
    );
  });

  it("rejects a deadletter/rejected event with no reason", async () => {
    const { q } = stubQuery({ rows: [{ id: "x" }], rowCount: 1 });
    await expect(recordEvent(q, { ...base, outcome: "deadletter", reason: null })).rejects.toBeInstanceOf(BillingError);
    await expect(recordEvent(q, { ...base, outcome: "rejected", reason: null })).rejects.toBeInstanceOf(BillingError);
  });
});

describe("pruneBillingEvents retention delete (FR-021)", () => {
  it("deletes rows older than the cutoff and returns the deleted count", async () => {
    const { q, calls } = stubQuery({ rows: [], rowCount: 4 });
    const r = await pruneBillingEvents(q, 1_700_000_000);
    expect(r).toEqual({ deleted: 4 });
    expect(calls[0]!.text).toMatch(/DELETE FROM billing_event WHERE received_at < to_timestamp\(\$1\)/i);
    expect(calls[0]!.params).toEqual([1_700_000_000]);
  });

  it("reports zero deleted when nothing was aged out", async () => {
    const { q } = stubQuery({ rows: [], rowCount: 0 });
    expect(await pruneBillingEvents(q, 1)).toEqual({ deleted: 0 });
  });
});
