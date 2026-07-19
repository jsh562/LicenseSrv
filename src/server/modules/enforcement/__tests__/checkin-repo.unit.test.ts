// T010 (FR-008/014/019): the bounded anti-replay + idempotent-replay store and the guarded monotonic
// anchor. A fresh nonce inserts; a same-nonce/same-activation retry REPLAYS the original outcome+token (no
// second mint); a same-nonce/DIFFERENT-activation reuse is rejected 409 nonce_replayed; the anchor advance
// is a guarded, non-decreasing UPDATE. Uses a stub `TxQuery` — no DB (the real guard is proven in the
// migration integration test).
import type pg from "pg";
import { describe, expect, it } from "vitest";

import type { TxQuery } from "../../../db/client.js";
import { advanceAnchor, pruneExpiredCheckins, recordCheckin } from "../checkin-repo.js";
import { EnforcementError } from "../index.js";

const NOW = 1_800_000_000;

type QHandler = (sql: string, params: readonly unknown[]) => pg.QueryResult;

/** A stub TxQuery driven by `handler`; records every SQL string for assertions. Sync throws -> rejections. */
function makeQ(handler: QHandler): { q: TxQuery; sqls: string[]; params: readonly unknown[][] } {
  const sqls: string[] = [];
  const params: readonly unknown[][] = [];
  const q: TxQuery = (text, p = []) => {
    sqls.push(text);
    (params as unknown[][]).push([...p]);
    try {
      return Promise.resolve(handler(text, p));
    } catch (e) {
      return Promise.reject(e as Error);
    }
  };
  return { q, sqls, params };
}

const result = (rows: unknown[], rowCount = rows.length): pg.QueryResult =>
  ({ rows, rowCount, command: "", oid: 0, fields: [] }) as unknown as pg.QueryResult;

const uniqueViolation = (): Error => Object.assign(new Error("duplicate key"), { code: "23505" });

const storedRow = (over: Record<string, unknown> = {}) => ({
  id: "orig-id",
  activation_id: "act-1",
  outcome: "renewed",
  reason: null,
  renewed_token: "LIC1.original",
  created_at: new Date(NOW * 1000),
  ...over,
});

describe("recordCheckin — fresh insert (FR-008)", () => {
  it("pre-checks the nonce, then inserts a new row and returns the stored outcome (replayed=false)", async () => {
    const { q, sqls } = makeQ((sql) => {
      if (sql.includes("SELECT id, activation_id")) return result([]); // no prior nonce
      if (sql.includes("INSERT INTO checkin")) return result([storedRow()]);
      throw new Error(`unexpected query: ${sql}`);
    });
    const rec = await recordCheckin(q, { activationId: "act-1", nonce: "n1", outcome: "renewed", reason: null, renewedToken: "LIC1.original" });
    expect(rec.replayed).toBe(false);
    expect(rec.outcome).toBe("renewed");
    expect(rec.renewedToken).toBe("LIC1.original");
    // The pre-check SELECT runs BEFORE the insert (a failed insert would abort the tx, so the original can't
    // be read afterwards — matching the E009 activate nonce pattern).
    expect(sqls[0]).toContain("SELECT id, activation_id");
    expect(sqls[1]).toContain("INSERT INTO checkin");
  });

  it("writes tenant_id from the transaction-local GUC (not a bound param)", async () => {
    const { q, sqls } = makeQ((sql) => (sql.includes("INSERT") ? result([storedRow()]) : result([])));
    await recordCheckin(q, { activationId: "act-1", nonce: "n1", outcome: "refused", reason: "revoked", renewedToken: null });
    expect(sqls.find((s) => s.includes("INSERT INTO checkin"))).toContain("current_setting('app.current_tenant')");
  });
});

describe("recordCheckin — idempotent replay + forgery rejection (FR-008, SC-010)", () => {
  it("same nonce + same activation -> REPLAYS the original outcome/token (replayed=true), never re-inserts", async () => {
    const { q, sqls } = makeQ((sql) => {
      if (sql.includes("SELECT id, activation_id")) return result([storedRow()]); // prior row for this nonce
      throw new Error(`unexpected: ${sql}`);
    });
    const rec = await recordCheckin(q, { activationId: "act-1", nonce: "n1", outcome: "renewed", reason: null, renewedToken: "LIC1.NEW" });
    expect(rec.replayed).toBe(true);
    expect(rec.id).toBe("orig-id");
    expect(rec.renewedToken).toBe("LIC1.original"); // the ORIGINAL token, never the re-minted one
    expect(sqls.some((s) => s.includes("INSERT INTO checkin"))).toBe(false); // no second insert
  });

  it("same nonce + DIFFERENT activation -> throws EnforcementError nonce_replayed (409), no insert", async () => {
    const { q, sqls } = makeQ((sql) => {
      if (sql.includes("SELECT id, activation_id")) return result([storedRow({ activation_id: "act-OTHER" })]);
      throw new Error(`unexpected: ${sql}`);
    });
    await expect(
      recordCheckin(q, { activationId: "act-1", nonce: "n1", outcome: "renewed", reason: null, renewedToken: "LIC1.NEW" }),
    ).rejects.toMatchObject({ name: "EnforcementError", code: "nonce_replayed", status: 409 });
    expect(sqls.some((s) => s.includes("INSERT INTO checkin"))).toBe(false);
  });

  it("a concurrent unique violation on insert is refused nonce_replayed (409)", async () => {
    const { q } = makeQ((sql) => {
      if (sql.includes("SELECT id, activation_id")) return result([]); // pre-check clear
      if (sql.includes("INSERT INTO checkin")) throw uniqueViolation(); // concurrent grab
      throw new Error(`unexpected: ${sql}`);
    });
    await expect(
      recordCheckin(q, { activationId: "act-1", nonce: "n1", outcome: "renewed", reason: null, renewedToken: "LIC1.NEW" }),
    ).rejects.toMatchObject({ name: "EnforcementError", code: "nonce_replayed", status: 409 });
  });

  it("a non-unique DB error propagates unchanged (not swallowed as a replay)", async () => {
    const { q } = makeQ((sql) => {
      if (sql.includes("SELECT id, activation_id")) return result([]);
      if (sql.includes("INSERT INTO checkin")) throw Object.assign(new Error("fk violation"), { code: "23503" });
      throw new Error(`unexpected: ${sql}`);
    });
    await expect(
      recordCheckin(q, { activationId: "act-1", nonce: "n1", outcome: "renewed", reason: null, renewedToken: "LIC1.NEW" }),
    ).rejects.toMatchObject({ code: "23503" });
  });
});

describe("advanceAnchor — guarded monotonic non-decrease (FR-014, AD-006)", () => {
  it("issues a guarded UPDATE keyed on last_anchor_at <= the new anchor (never a trigger)", async () => {
    const { q, sqls, params } = makeQ(() => result([], 1));
    const advanced = await advanceAnchor(q, "act-1", NOW);
    expect(advanced).toBe(true);
    const sql = sqls[0]!;
    expect(sql).toContain("UPDATE activation");
    expect(sql).toContain("last_checkin_at = now()");
    expect(sql).toMatch(/last_anchor_at IS NULL OR last_anchor_at <= to_timestamp\(\$2\)/);
    expect(params[0]).toEqual(["act-1", NOW]);
  });

  it("returns false when the guard blocks the advance (rollback attempt / unknown activation)", async () => {
    const { q } = makeQ(() => result([], 0)); // guard matched no row
    expect(await advanceAnchor(q, "act-1", NOW - 500)).toBe(false);
  });
});

describe("pruneExpiredCheckins — bounded TTL retention (FR-008)", () => {
  it("deletes rows older than the retention horizon and returns the count", async () => {
    const { q, sqls, params } = makeQ(() => result([], 4));
    const pruned = await pruneExpiredCheckins(q, 172_800 + 300);
    expect(pruned).toBe(4);
    expect(sqls[0]).toContain("DELETE FROM checkin");
    expect(sqls[0]).toContain("interval '1 second'");
    expect(params[0]).toEqual([172_800 + 300]);
  });
});

describe("EnforcementError shape", () => {
  it("carries code/status/details for the routes to surface", () => {
    const e = new EnforcementError("nonce_replayed", 409, "x", { reason: "replayed_nonce" });
    expect(e).toMatchObject({ name: "EnforcementError", code: "nonce_replayed", status: 409, details: { reason: "replayed_nonce" } });
  });
});
