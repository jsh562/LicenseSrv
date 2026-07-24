// Lease release service (E015, FR-008; ADR-0012). Idempotent, best-effort seat return: flips a LIVE lease to
// `released` (freeing the seat immediately for reuse) and is a `200` no-op for an already-released/reclaimed
// or UNKNOWN lease — never driving the live-lease count below zero (SC-006). Under forced RLS a cross-tenant
// leaseId is invisible, so the release touches no row: the deliberate carve-out from the cross-tenant→404 rule
// (FR-008/019) that frees nothing outside the tenant and is not an enumeration oracle. [COMPLETES FR-008]
import { writeAudit } from "../../audit/index.js";
import { withTenant } from "../../db/client.js";
const ACTOR = "lease-api";
/**
 * Release a lease (FR-008). Always resolves to `{ id, status: 'released' }` (HTTP 200) whether the lease was
 * live, already ended, or unknown/cross-tenant. `changed` (whether a live seat was actually freed) is recorded
 * to the audit trail but never surfaced — the response is a uniform no-op so it is not an enumeration oracle.
 */
export async function releaseLease(deps, tenantId, leaseId) {
    const { pool, repo } = deps;
    await withTenant(pool, tenantId, async (q) => {
        const res = await repo.release(q, leaseId);
        await writeAudit(q, { actor: ACTOR, action: "lease.released", target: leaseId, after: { changed: res.changed } });
    });
    return { id: leaseId, status: "released" };
}
