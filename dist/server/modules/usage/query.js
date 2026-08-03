import { floorDisplay, isOverQuota } from "./rollup.js";
/** Hard cap on the per-entitlement result (bounded, NOT paginated); a `truncated` signal flags the clamp. */
export const MAX_ENTITLEMENTS = 1000;
/** The generous row cap that bounds the rollup read; the meaningful bound is the window span + entitlement cap. */
const ROLLUP_ROW_CAP = 200_000;
/** Truncate a bucket start to the requested grouping (hour = itself; day = UTC midnight; period = window from). */
function groupKey(bucketStart, grouping, from) {
    if (grouping === "hour")
        return bucketStart;
    if (grouping === "day") {
        return new Date(Date.UTC(bucketStart.getUTCFullYear(), bucketStart.getUTCMonth(), bucketStart.getUTCDate()));
    }
    // "period": the whole window rolls into a single period bucket anchored at `from` (billing alignment is E014's).
    return from;
}
/** Read the unit + allowance for a set of entitlement ids within the caller's tenant (RLS). */
async function readEntitlementMeta(q, ids) {
    const out = new Map();
    if (ids.length === 0)
        return out;
    const r = await q("SELECT id, unit, allowance FROM entitlement WHERE id = ANY($1::uuid[])", [ids]);
    for (const row of r.rows) {
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
export async function queryUsage(q, repo, params) {
    const { licenseId, entitlementId, from, to, bucket, raw } = params;
    const rows = await repo.readRollups(q, {
        licenseId,
        entitlementId: entitlementId ?? null,
        from,
        to,
        limit: ROLLUP_ROW_CAP,
    });
    const byEnt = new Map();
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
    const entitlements = keptIds.map((id) => {
        const acc = byEnt.get(id);
        const m = meta.get(id) ?? { unit: "", allowance: null };
        const aggregate = {
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
