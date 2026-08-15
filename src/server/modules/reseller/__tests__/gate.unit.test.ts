// T006 (FR-002/004/005; AD-001/002, HINT-001/002) [Foundational, TDD-first]: the subtree-membership gate +
// scoped-descent logic, PURE — a stub `SubtreeMembershipRepo` and a fake `pg.Pool`, no DB (the real RLS/link
// enforcement is proven in the migration + isolation integration tests). Asserts the load-bearing isolation
// contract:
//   * PASS  — an IN-subtree target (repo returns the row) passes the gate and returns the metadata-only row.
//   * DENY  — an OUT-of-subtree target (repo returns null: sibling/parent/platform/IDOR/self) → `not_found`
//     (404), NEVER 403, with a message that discloses no existence.
//   * SCOPED DESCENT — `withSubTenantScope` runs `fn` under the TARGET sub-tenant's OWN `app.current_tenant`
//     and ONLY after the gate passes; a denied gate never opens a scope and never invokes `fn`.
import type pg from "pg";
import { describe, expect, it, vi } from "vitest";

import { assertSubtreeMembership, withSubTenantScope } from "../gate.js";
import { ResellerError } from "../index.js";
import type { SubtreeMembershipRepo, SubTenantRow } from "../reseller-repo.js";

const RESELLER = "11111111-1111-4111-8111-111111111111";
const IN_SUBTREE = "22222222-2222-4222-8222-222222222222";
const OUT_OF_SUBTREE = "33333333-3333-4333-8333-333333333333";

const subRow = (over: Partial<SubTenantRow> = {}): SubTenantRow => ({
  id: IN_SUBTREE,
  slug: "acme-customer",
  name: "Acme Customer",
  parentResellerId: RESELLER,
  deletedAt: null,
  createdAt: new Date("2026-08-14T00:00:00Z"),
  ...over,
});

/**
 * A stub repo whose downward-only lookup returns a row ONLY for the (reseller, in-subtree) pair — exactly the
 * `parent_reseller_id = :reseller` filter the real privileged query applies; every other pair returns null.
 */
function stubRepo(): SubtreeMembershipRepo & { calls: Array<[string, string]> } {
  const calls: Array<[string, string]> = [];
  return {
    calls,
    getSubTenant: (resellerTenantId, subTenantId) => {
      calls.push([resellerTenantId, subTenantId]);
      if (resellerTenantId === RESELLER && subTenantId === IN_SUBTREE) {
        return Promise.resolve(subRow());
      }
      return Promise.resolve(null); // out-of-subtree / unknown / IDOR / self -> no disclosure
    },
  };
}

/**
 * A fake `pg.Pool` that records whether a connection was opened and the tenant id passed to `set_config`
 * (i.e. the scope the descent actually enters). Its client satisfies the control queries `withTenant` issues.
 */
function fakePool(capture: { connected: boolean; scope?: string }): pg.Pool {
  const client = {
    query: (text: string, params?: unknown[]) => {
      if (typeof text === "string" && text.includes("set_config")) {
        capture.scope = (params as string[])[0];
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    },
    release: () => undefined,
  };
  return {
    connect: () => {
      capture.connected = true;
      return Promise.resolve(client);
    },
  } as unknown as pg.Pool;
}

describe("assertSubtreeMembership — downward-only ownership gate (FR-002/004)", () => {
  it("PASSES for an in-subtree target and returns the metadata-only row", async () => {
    const repo = stubRepo();
    const row = await assertSubtreeMembership(repo, RESELLER, IN_SUBTREE);
    expect(row.id).toBe(IN_SUBTREE);
    expect(row.parentResellerId).toBe(RESELLER);
    // Membership is resolved via the ownership-filtered lookup (reseller, target).
    expect(repo.calls).toEqual([[RESELLER, IN_SUBTREE]]);
  });

  it("DENIES an out-of-subtree target with not_found (404), never 403, no existence disclosure (HINT-002)", async () => {
    const repo = stubRepo();
    await expect(assertSubtreeMembership(repo, RESELLER, OUT_OF_SUBTREE)).rejects.toMatchObject({
      name: "ResellerError",
      code: "not_found",
      status: 404,
    });
    // The denial must not leak the target id or hint at existence.
    await assertSubtreeMembership(repo, RESELLER, OUT_OF_SUBTREE).catch((e: ResellerError) => {
      expect(e.status).not.toBe(403);
      expect(e.message).not.toContain(OUT_OF_SUBTREE);
    });
  });

  it("DENIES the reseller's own id (a reseller carries no parent -> upward/self blocked)", async () => {
    const repo = stubRepo();
    await expect(assertSubtreeMembership(repo, RESELLER, RESELLER)).rejects.toMatchObject({
      code: "not_found",
      status: 404,
    });
  });
});

describe("withSubTenantScope — gated scoped descent (FR-005, AD-001)", () => {
  it("runs fn under the TARGET sub-tenant's OWN scope, only after the gate passes", async () => {
    const repo = stubRepo();
    const capture = { connected: false } as { connected: boolean; scope?: string };
    const pool = fakePool(capture);
    const fn = vi.fn(() => Promise.resolve("descended"));

    const result = await withSubTenantScope({ pool, repo }, RESELLER, IN_SUBTREE, fn);

    expect(result).toBe("descended");
    expect(fn).toHaveBeenCalledTimes(1);
    // The descent enters the TARGET sub-tenant's scope — never the reseller's.
    expect(capture.scope).toBe(IN_SUBTREE);
    expect(capture.scope).not.toBe(RESELLER);
    // Gate ran before the scope was opened.
    expect(repo.calls).toEqual([[RESELLER, IN_SUBTREE]]);
  });

  it("never opens a scope or invokes fn when the gate denies (out-of-subtree)", async () => {
    const repo = stubRepo();
    const capture = { connected: false } as { connected: boolean; scope?: string };
    const pool = fakePool(capture);
    const fn = vi.fn(() => Promise.resolve("should-not-run"));

    await expect(
      withSubTenantScope({ pool, repo }, RESELLER, OUT_OF_SUBTREE, fn),
    ).rejects.toMatchObject({ code: "not_found", status: 404 });

    expect(fn).not.toHaveBeenCalled();
    expect(capture.connected).toBe(false); // no descent on a denied target
    expect(capture.scope).toBeUndefined();
  });
});
