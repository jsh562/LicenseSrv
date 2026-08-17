import { withTenant } from "../../db/client.js";
import { recordResellerSecurityEvent } from "./audit.js";
import { ResellerError } from "./index.js";
/**
 * Assert the acting reseller OWNS the target sub-tenant (AD-001, FR-002/004). Resolves the sub-tenant through
 * the repo's DOWNWARD-ONLY, ownership-filtered lookup: a match confirms the `parent_reseller_id = reseller`
 * link; ANY non-match — an out-of-subtree sibling/parent/platform reference, an IDOR-by-id, or the reseller's
 * own id (a reseller carries no parent) — fails CLOSED to `not_found` (404) with no existence disclosure,
 * never 403 (HINT-002). On success returns the metadata-only {@link SubTenantRow} so callers avoid a re-read.
 *
 * The caller MUST have already authenticated `resellerTenantId` as the acting principal's own reseller tenant
 * (session tenant == reseller, admin/owner role) — this gate governs the reseller→sub-tenant reach, not the
 * caller's authorization over the reseller itself.
 */
export async function assertSubtreeMembership(repo, resellerTenantId, subTenantId) {
    const sub = await repo.getSubTenant(resellerTenantId, subTenantId);
    if (!sub) {
        // Downward-only, no disclosure: an out-of-subtree/unknown target is indistinguishable from "not found".
        throw new ResellerError("not_found", 404, "sub-tenant not found");
    }
    return sub;
}
/**
 * The SCOPED DESCENT (AD-001, FR-005): assert subtree membership FIRST, then run `fn` under the sub-tenant's
 * OWN `app.current_tenant` via `withTenant` — so the operation is subject to the sub-tenant's own forced RLS,
 * never the reseller's scope and never a widened predicate. If the gate throws (`not_found`), `fn` is NEVER
 * invoked and no tenant scope is ever entered — the descent is strictly gate-then-act. Returns `fn`'s result.
 */
export async function withSubTenantScope(deps, resellerTenantId, subTenantId, fn) {
    // GATE FIRST — a denial short-circuits before any scope is opened (no descent on an out-of-subtree target).
    await assertSubtreeMembership(deps.repo, resellerTenantId, subTenantId);
    // DESCENT — under the TARGET sub-tenant's own scope (never the reseller's), so RLS checks its own rows.
    return withTenant(deps.pool, subTenantId, fn);
}
/**
 * {@link assertSubtreeMembership} with a data-layer SECURITY-EVENT audit on denial (T031, FR-005). On an
 * out-of-subtree target the underlying gate throws `not_found` (404, no disclosure); this wrapper additionally
 * appends a dual-identity `security_event` row under the acting reseller's OWN scope BEFORE re-throwing, so the
 * denied upward/lateral/IDOR attempt is recorded at the data-access layer regardless of caller. Returns the
 * metadata-only {@link SubTenantRow} on success (the gate passed — no security event).
 */
export async function assertSubtreeMembershipAudited(deps, resellerTenantId, subTenantId, audit) {
    try {
        return await assertSubtreeMembership(deps.repo, resellerTenantId, subTenantId);
    }
    catch (e) {
        if (e instanceof ResellerError && e.code === "not_found") {
            await recordResellerSecurityEvent(deps.pool, {
                scopeTenantId: resellerTenantId,
                actor: audit.actorUserId,
                actorResellerId: audit.actorResellerId,
                action: audit.action ?? "reseller.subtree.denied",
                target: audit.attempted ?? null,
            });
        }
        throw e;
    }
}
/**
 * {@link withSubTenantScope} with a data-layer SECURITY-EVENT audit on denial (T031, FR-005/009). The gate is
 * asserted (recording a dual-identity `security_event` on an out-of-subtree denial) BEFORE the scoped descent, so
 * `fn` runs under the TARGET sub-tenant's OWN `app.current_tenant` ONLY after a passed gate — and a denied
 * escalation is both refused (404) and audited at the data-access layer without ever widening the RLS predicate.
 */
export async function withSubTenantScopeAudited(deps, resellerTenantId, subTenantId, audit, fn) {
    // GATE (audited) FIRST — a denial records a security event and short-circuits before any scope is opened.
    await assertSubtreeMembershipAudited(deps, resellerTenantId, subTenantId, audit);
    // DESCENT — under the TARGET sub-tenant's own scope (never the reseller's), so RLS checks its own rows.
    return withTenant(deps.pool, subTenantId, fn);
}
/**
 * Assert a tenant's mutation is not blocked by its managing reseller's suspension (FR-011, AD-007, SC-009). If the
 * tenant is a SUB-TENANT (`parent_reseller_id` set) whose reseller is `suspended`, a mutation is refused
 * `409 reseller_suspended`; a direct-platform tenant (no parent) or a tenant under an active/offboarding reseller
 * is unaffected. DERIVED at request time — no fan-out write, reversible by flipping the reseller status. Reads
 * flow unchanged (callers gate ONLY mutations through this).
 */
export async function assertResellerNotSuspended(repo, tenantId) {
    const parentId = await repo.getParentResellerId(tenantId);
    if (!parentId)
        return; // a direct-platform tenant or a reseller itself carries no managing reseller — no cascade
    const parent = await repo.getReseller(parentId);
    if (parent && parent.status === "suspended") {
        throw new ResellerError("reseller_suspended", 409, "the managing reseller is suspended", {
            resellerId: parentId,
        });
    }
}
