// Usage-event batch ingest (E016, FR-002/004/006/007/013/016/021; AD-001/AD-008, HINT-001/HINT-002/HINT-005).
// The per-event validate + accrue path behind POST /v1/usage. A batch is processed PER-EVENT-IDEMPOTENTLY: a
// single bad event NEVER fails the whole batch (FR-007/AD-008). Each event runs through the DETERMINISTIC
// FR-021 refusal precedence — not_found > not_metered > archived > license_inactive > stale_event/future_event
// > validation_error — so a client receives ONE unambiguous per-event reason. The eligible events are then
// appended in ONE tenant-scoped `INSERT ... ON CONFLICT (tenant_id, source, event_id) DO NOTHING` (the shared
// UsageRepo.appendBatch), which derives new-vs-duplicate from `RETURNING` — never a pre-SELECT then insert
// (races) — so a replayed or concurrent `(source, eventId)` accrues EXACTLY ONCE (SC-001/015). A reversal is
// an ordinary event with a NEGATIVE quantity (reference-free, FR-013): it accrues like any other event and its
// signed quantity adjusts the aggregate's true net — nothing special is done here beyond letting the
// per-aggregation quantity guard admit the sign (SUM any signed; COUNT non-zero int). The per-batch summary
// `{ accepted, duplicate, rejected[] }` is assembled and audited (FR-018) — attributed to the reporting key,
// no secret/credential. Accrual is by CLIENT `eventTime` bucketed downstream; here we only bound skew.
//
// The two error vocabularies (AD-008) are kept DISJOINT: a whole-request refusal (missing scope, over-cap
// batch, malformed envelope) is an HTTP 4xx raised by the ROUTE; a bad INDIVIDUAL event is a PER-EVENT
// `RejectedEvent` reported INSIDE this summary — so this module never throws for a single bad event.
import { z } from "zod";
import { writeAudit } from "../../audit/index.js";
import { withTenant } from "../../db/client.js";
import { validateDimensions, validateQuantity } from "./dimension-schema.js";
import { classifyAcceptance } from "./rollup.js";
// Per-event STRUCTURAL schema (contract `UsageEvent`). A structurally malformed event (bad UUID, missing
// field, non-finite quantity, non-UTC eventTime) is a per-event `validation_error` — we cannot even resolve a
// non-UUID id, so structural validation necessarily precedes the semantic precedence. `dimensions` is left as
// unknown and handed to the server allow-list validator (FR-016) after the entity/skew gates.
const eventSchema = z
    .object({
    licenseId: z.string().uuid(),
    entitlementId: z.string().uuid(),
    source: z.string().min(1).max(200),
    eventId: z.string().min(1).max(200),
    eventTime: z.string().datetime(),
    quantity: z.number().finite(),
    dimensions: z.unknown().optional(),
})
    .strict();
/** A license is active IFF its lifecycle status is `active` AND it is not past any expiry (mirrors E013/E015). */
function isLicenseActive(lic, now) {
    if (lic.status !== "active")
        return false;
    return lic.expiresAt === null || lic.expiresAt.getTime() > now.getTime();
}
/** Read a license's lifecycle snapshot within the caller's tenant (RLS); a cross-tenant/unknown id → null. */
async function readLicense(q, id) {
    const r = await q("SELECT status, expires_at FROM license WHERE id = $1", [id]);
    if (!r.rowCount)
        return null;
    const row = r.rows[0];
    return { status: row.status, expiresAt: row.expires_at };
}
/** Read an entitlement's kind snapshot within the caller's tenant (RLS); a cross-tenant/unknown id → null. */
async function readEntitlement(q, id) {
    const r = await q("SELECT type, status, aggregation FROM entitlement WHERE id = $1", [id]);
    if (!r.rowCount)
        return null;
    const row = r.rows[0];
    return { type: row.type, status: row.status, aggregation: row.aggregation };
}
/**
 * Ingest a batch of raw usage events (T017 validate + T018 accrue). Runs in ONE tenant-scoped transaction so
 * the append is atomic + idempotent under RLS (FR-002/017). Every event is validated per the FR-021 precedence
 * (a bad event is a per-event rejection, never a batch failure); the eligible events are appended once via
 * `appendBatch` (ON CONFLICT DO NOTHING), and the per-batch summary is assembled + audited (FR-018).
 *
 * `now` is injectable for deterministic skew tests; production passes the wall clock. The caller (the route)
 * has already enforced the whole-request gates (scope, batch cap, non-empty envelope), so `rawEvents` is an
 * array of 1..maxBatch unstructured events.
 */
export async function ingestBatch(deps, tenantId, actor, rawEvents, now = new Date()) {
    const { pool, repo, config } = deps;
    const rejected = [];
    return withTenant(pool, tenantId, async (q) => {
        // Resolve each distinct license/entitlement ONCE within the tenant (a batch is typically one license +
        // one entitlement across many events); `null` is cached too so a repeated bad ref is not re-queried.
        const licenseCache = new Map();
        const entitlementCache = new Map();
        const getLicense = async (id) => {
            if (!licenseCache.has(id))
                licenseCache.set(id, await readLicense(q, id));
            return licenseCache.get(id) ?? null;
        };
        const getEntitlement = async (id) => {
            if (!entitlementCache.has(id))
                entitlementCache.set(id, await readEntitlement(q, id));
            return entitlementCache.get(id) ?? null;
        };
        const eligible = [];
        const eligibleIndex = [];
        const reject = (index, code, message) => {
            rejected.push({ index, code, message });
        };
        for (let i = 0; i < rawEvents.length; i++) {
            const parsed = eventSchema.safeParse(rawEvents[i]);
            if (!parsed.success) {
                reject(i, "validation_error", parsed.error.issues[0]?.message ?? "malformed usage event");
                continue;
            }
            const e = parsed.data;
            // FR-021 deterministic precedence — evaluate highest-severity gate first, report ONE reason.
            const lic = await getLicense(e.licenseId);
            if (!lic) {
                reject(i, "not_found", "no such license in this tenant");
                continue;
            }
            const ent = await getEntitlement(e.entitlementId);
            if (!ent) {
                reject(i, "not_found", "no such entitlement in this tenant");
                continue;
            }
            if (ent.type !== "metered" || ent.aggregation === null) {
                reject(i, "not_metered", "the entitlement is not a metered kind");
                continue;
            }
            if (ent.status === "archived") {
                reject(i, "archived", "the entitlement is archived");
                continue;
            }
            if (!isLicenseActive(lic, now)) {
                reject(i, "license_inactive", "the license is not in an active state");
                continue;
            }
            const eventTime = new Date(e.eventTime);
            // The retention window is the SINGLE acceptance bound (FR-012), co-defined with the sweep's late-event
            // re-open in rollup.ts so the accept gate and the re-open share one acceptance horizon.
            const skew = classifyAcceptance(eventTime, now, config);
            if (skew === "stale") {
                reject(i, "stale_event", "the event is older than the retention window");
                continue;
            }
            if (skew === "future") {
                reject(i, "future_event", "the event is dated too far into the future");
                continue;
            }
            const dims = validateDimensions(e.dimensions);
            if (!dims.ok) {
                reject(i, "validation_error", dims.message);
                continue;
            }
            const qty = validateQuantity(ent.aggregation, e.quantity);
            if (!qty.ok) {
                reject(i, "validation_error", qty.message);
                continue;
            }
            eligible.push({
                licenseId: e.licenseId,
                entitlementId: e.entitlementId,
                source: e.source,
                eventId: e.eventId,
                eventTime,
                quantity: qty.quantity,
                dimensions: dims.dimensions,
            });
            eligibleIndex.push(i);
        }
        // Accrue append: ONE idempotent multi-row INSERT ON CONFLICT DO NOTHING (AD-001/HINT-001). Outcomes are
        // position-aligned to `eligible`; a returned row is a new accrual, an absent one is a duplicate no-op.
        const outcomes = await repo.appendBatch(q, eligible);
        let accepted = 0;
        let duplicate = 0;
        for (const o of outcomes) {
            if (o.outcome === "accepted")
                accepted++;
            else
                duplicate++;
        }
        const summary = {
            accepted,
            duplicate,
            rejected: rejected.sort((a, b) => a.index - b.index),
        };
        // FR-018: audit the batch SUMMARY only (counts, not payloads) — attributed to the reporting key; no
        // secret, credential, or dimension datum. Atomic with the append in the same tenant transaction.
        await writeAudit(q, {
            actor,
            action: "usage.ingest",
            after: { accepted, duplicate, rejected: summary.rejected.length, total: rawEvents.length },
        });
        return summary;
    });
}
