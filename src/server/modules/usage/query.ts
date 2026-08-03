// Reproducible aggregate query (E016, FR-011/013/019/020; AD-003/AD-004, HINT-003). The read surface behind
// GET /admin/licenses/:licenseId/usage (and the E014/app internal true-net read) — QUERY-STABLE per FR-011:
// it returns the DURABLE stored `usage_rollup` values, so an identical query over an unchanged window returns
// IDENTICAL totals (SC-004) and the aggregate survives raw-event pruning (what E014 true-up consumes). It is
// DISTINCT from the in-window recompute-from-raw of FR-010 (that is the rollup worker's job) — the query
// never touches raw. "Per period" rolls the FIXED hourly buckets up over the caller window (AD-003): a single
// window total by default, or an ordered `hour`/`day`/`period` breakdown.
//
// FLOOR-AT-ZERO vs TRUE SIGNED NET (FR-013/020, SC-017/019): the stored `value` is the TRUE SIGNED NET. A
// DEFAULT (viewer) read FLOORS every value at `max(0, net)` so an operator never sees negative usage; a
// `raw=true` read (bounded to admin+/E014 by the ROUTE, never here) returns the true signed net so a
// net-negative correction stays visible to billing true-up. The over-quota flag is DERIVED on the TRUE net
// (value > allowance, FR-014), independent of the display floor. No secret/credential/PII is ever read
// (FR-019) — only license/entitlement refs + aggregate values.
import type { TxQuery } from "../../db/client.js";
import type { Aggregation } from "./dimension-schema.js";
import { floorDisplay, isOverQuota } from "./rollup.js";
import type { RollupRow, UsageRepo } from "./usage-repo.js";

/** The optional per-bucket grouping granularity (matches the contract `bucket` query param). */
export type BucketGrouping = "hour" | "day" | "period";

/** Hard cap on the per-entitlement result (bounded, NOT paginated); a `truncated` signal flags the clamp. */
export const MAX_ENTITLEMENTS = 1000;

/** One time-bucket of an entitlement's usage (contract `UsageBucket`). `value` is floored unless `raw`. */
export interface UsageBucket {
  bucketStart: string;
  value: number;
}

/** The aggregated usage for one metered entitlement over the window (contract `UsageEntitlementAggregate`). */
export interface UsageEntitlementAggregate {
  entitlementId: string;
  aggregation: Aggregation;
  unit: string;
  /** The window total per the aggregation type; floored at zero for display unless `raw` (FR-013). */
  value: number;
  allowance: number | null;
  /** Derived on the TRUE net vs allowance (FR-014), independent of the display floor. */
  overQuota: boolean;
  /** The ordered per-bucket breakdown, present ONLY when a `bucket` grouping was requested. */
  buckets?: UsageBucket[];
}

/** A license's aggregated usage over a window (contract `UsageQueryResult`). Reproducible + self-describing. */
export interface UsageQueryResult {
  licenseId: string;
  window: { from: string; to: string; bucket: BucketGrouping | null };
  raw: boolean;
  entitlements: UsageEntitlementAggregate[];
  truncated: boolean;
}

/** The query parameters (already validated + authorized by the route: `raw` is admin-gated, window bounded). */
export interface UsageQueryParams {
  licenseId: string;
  entitlementId?: string | null;
  from: Date;
  to: Date;
  bucket?: BucketGrouping | null;
  /** True signed net (admin+/E014) vs the floor-at-zero display (viewer). The ROUTE enforces the RBAC bound. */
  raw: boolean;
}

/** The generous row cap that bounds the rollup read; the meaningful bound is the window span + entitlement cap. */
const ROLLUP_ROW_CAP = 200_000;

/** One entitlement's metadata joined into the aggregate (its unit + optional quota). */
interface EntitlementMeta {
  unit: string;
  allowance: number | null;
}

/** Truncate a bucket start to the requested grouping (hour = itself; day = UTC midnight; period = window from). */
function groupKey(bucketStart: Date, grouping: BucketGrouping, from: Date): Date {
  if (grouping === "hour") return bucketStart;
  if (grouping === "day") {
    return new Date(
      Date.UTC(bucketStart.getUTCFullYear(), bucketStart.getUTCMonth(), bucketStart.getUTCDate()),
    );
  }
  // "period": the whole window rolls into a single period bucket anchored at `from` (billing alignment is E014's).
  return from;
}

/** Read the unit + allowance for a set of entitlement ids within the caller's tenant (RLS). */
async function readEntitlementMeta(q: TxQuery, ids: string[]): Promise<Map<string, EntitlementMeta>> {
  const out = new Map<string, EntitlementMeta>();
  if (ids.length === 0) return out;
  const r = await q("SELECT id, unit, allowance FROM entitlement WHERE id = ANY($1::uuid[])", [ids]);
  for (const row of r.rows as { id: string; unit: string | null; allowance: string | null }[]) {
    out.set(row.id, { unit: row.unit ?? "", allowance: row.allowance === null ? null : Number(row.allowance) });
  }
  return out;
}

/**
 * Query a license's per-entitlement aggregated usage over `[from, to)` (FR-011). Reads the DURABLE hourly
 * rollups (QUERY-STABLE, reproducible, prune-surviving), sums each entitlement's true signed net over the
 * window (and, when a `bucket` grouping is requested, an ordered hour/day/period breakdown), derives the
 * over-quota flag on the TRUE net, and applies the display floor unless `raw`. Entitlements are ordered
 * DETERMINISTICALLY by `entitlementId`; bounded to {@link MAX_ENTITLEMENTS} with a `truncated` signal. Runs
 * under the caller's tenant tx `q` (forced RLS): a cross-tenant license simply yields no rows (the route
 * maps an unknown license to 404 before calling here).
 */
export async function queryUsage(
  q: TxQuery,
  repo: UsageRepo,
  params: UsageQueryParams,
): Promise<UsageQueryResult> {
  const { licenseId, entitlementId, from, to, bucket, raw } = params;

  const rows: RollupRow[] = await repo.readRollups(q, {
    licenseId,
    entitlementId: entitlementId ?? null,
    from,
    to,
    limit: ROLLUP_ROW_CAP,
  });

  // Group rollup rows by entitlement (readRollups already orders by entitlement_id, bucket). Track the true
  // signed net window total, the folded buckets, and the aggregation type snapshot per entitlement.
  interface Acc {
    aggType: Aggregation;
    net: number;
    buckets: Map<number, number>; // grouped bucketStart(ms) -> true net
  }
  const byEnt = new Map<string, Acc>();
  for (const row of rows) {
    let acc = byEnt.get(row.entitlementId);
    if (!acc) {
      acc = { aggType: row.aggType, net: 0, buckets: new Map() };
      byEnt.set(row.entitlementId, acc);
    }
    acc.net += row.value;
    if (bucket) {
      const key = groupKey(row.bucket, bucket, from).getTime();
      acc.buckets.set(key, (acc.buckets.get(key) ?? 0) + row.value);
    }
  }

  const meta = await readEntitlementMeta(q, [...byEnt.keys()]);

  // Deterministic order by entitlementId; bounded to the entitlement cap with a truncation signal.
  const orderedIds = [...byEnt.keys()].sort();
  const truncated = orderedIds.length > MAX_ENTITLEMENTS;
  const keptIds = truncated ? orderedIds.slice(0, MAX_ENTITLEMENTS) : orderedIds;

  const entitlements: UsageEntitlementAggregate[] = keptIds.map((id) => {
    const acc = byEnt.get(id)!;
    const m = meta.get(id) ?? { unit: "", allowance: null };
    const aggregate: UsageEntitlementAggregate = {
      entitlementId: id,
      aggregation: acc.aggType,
      unit: m.unit,
      value: raw ? acc.net : floorDisplay(acc.net),
      allowance: m.allowance,
      overQuota: isOverQuota(acc.net, m.allowance),
    };
    if (bucket) {
      aggregate.buckets = [...acc.buckets.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([ms, net]) => ({ bucketStart: new Date(ms).toISOString(), value: raw ? net : floorDisplay(net) }));
    }
    return aggregate;
  });

  return {
    licenseId,
    window: { from: from.toISOString(), to: to.toISOString(), bucket: bucket ?? null },
    raw,
    entitlements,
    truncated,
  };
}
