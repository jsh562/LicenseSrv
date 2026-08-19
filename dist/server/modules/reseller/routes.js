import { z } from "zod";
import { recordSecurityEvent, writeAudit } from "../../audit/index.js";
import { requireRole } from "../../console/rbac-middleware.js";
import { withTenant } from "../../db/client.js";
import { recordResellerSecurityEvent } from "./audit.js";
import { resolveBranding, } from "./branding.js";
import { assertResellerNotSuspended, assertSubtreeMembershipAudited } from "./gate.js";
import { ResellerError } from "./index.js";
import { moveSubTenant, offboardReseller, onboardReseller, provisionSubTenant, reinstateReseller, suspendReseller, } from "./lifecycle.js";
function err(reply, status, code, message, details) {
    const body = { code, message };
    if (details !== undefined)
        body.details = details;
    return reply.code(status).send(body);
}
const validation = (r, m = "invalid request", details) => err(r, 400, "validation_error", m, details);
/** Run a handler, mapping a thrown ResellerError to its HTTP status + code; other errors propagate (→ 500). */
async function guard(reply, fn) {
    try {
        return await fn();
    }
    catch (e) {
        if (e instanceof ResellerError)
            return err(reply, e.status, e.code, e.message, e.details);
        throw e;
    }
}
/** The hard, non-paginated list cap (contract: 1000 items + a `truncated` signal). */
const LIST_CAP = 1000;
/** Canonical-UUID shape guard so a malformed path id resolves to 404 (never leaks) without a DB round-trip. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const provisionSchema = z
    .object({
    displayName: z.string().min(1).max(128),
    firstAdminUserReference: z.string().min(1).max(128),
})
    .strict();
const moveSchema = z
    .object({
    destination: z.discriminatedUnion("type", [
        z.object({ type: z.literal("to_reseller"), destinationResellerId: z.string().uuid() }).strict(),
        z.object({ type: z.literal("to_direct_platform") }).strict(),
    ]),
})
    .strict();
// The 8 contract BrandingFieldName values — the ONLY white-labelable fields (trust signals are never here, FR-008).
const HEX_COLOR = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const brandingFieldsSchema = z
    .object({
    logoUrl: z.string().url().max(2048).optional(),
    primaryColor: z.string().regex(HEX_COLOR).optional(),
    secondaryColor: z.string().regex(HEX_COLOR).optional(),
    productName: z.string().min(1).max(128).optional(),
    supportUrl: z.string().url().max(2048).optional(),
    helpUrl: z.string().url().max(2048).optional(),
    emailSenderAddress: z.string().email().max(320).optional(),
    customDomain: z.string().min(1).max(253).optional(),
})
    .strict();
const brandingFieldNameSchema = z.enum([
    "logoUrl",
    "primaryColor",
    "secondaryColor",
    "productName",
    "supportUrl",
    "helpUrl",
    "emailSenderAddress",
    "customDomain",
]);
const setResellerBrandingSchema = z
    .object({ fields: brandingFieldsSchema, locked: z.array(brandingFieldNameSchema).optional() })
    .strict();
const setSubTenantBrandingSchema = z.object({ overrides: brandingFieldsSchema }).strict();
// The onboard-a-reseller body (FR-001/010) — ONE create-or-select flow discriminated on `mode`.
const onboardResellerSchema = z.discriminatedUnion("mode", [
    z
        .object({
        mode: z.literal("create_new"),
        displayName: z.string().min(1).max(128),
        firstAdminUserReference: z.string().min(1).max(128),
        subTenantQuota: z.number().int().min(0).nullable().optional(),
    })
        .strict(),
    z
        .object({
        mode: z.literal("promote_existing"),
        tenantId: z.string().uuid(),
        firstAdminUserReference: z.string().min(1).max(128),
        subTenantQuota: z.number().int().min(0).nullable().optional(),
    })
        .strict(),
]);
const updateQuotaSchema = z.object({ subTenantQuota: z.number().int().min(0) }).strict();
const resellerStatusSchema = z.enum(["active", "suspended", "offboarding"]);
const listResellersQuerySchema = z.object({ status: resellerStatusSchema.optional() }).strict();
// The initiate-domain-verification body (FR-013) — a custom `domain` (TXT/CNAME) or an `email_sender` (SPF/DKIM/DMARC).
const verificationKindSchema = z.enum(["domain", "email_sender"]);
const initiateVerificationSchema = z
    .object({ kind: verificationKindSchema, host: z.string().min(1).max(253) })
    .strict();
/**
 * The set of binding-backed branding fields (customDomain/emailSenderAddress) EFFECTIVE for a sub-tenant's
 * applied branding — the UNION of the sub-tenant's own active bindings and (on the privileged seam) its
 * managing reseller's, since either layer may supply the resolved value and each is guaranteed backed by its
 * own active binding at write time (FR-013, US5). For a direct-platform tenant (`parentId` null) only its own.
 */
async function resolveActiveBoundFields(deps, tenantId, parentId) {
    const own = await deps.verifier.activeBoundFields(tenantId);
    if (!parentId)
        return own;
    const reseller = await deps.verifier.activeBoundFieldsPrivileged(parentId);
    return new Set([...own, ...reseller]);
}
/** The DomainBinding wire projection (contract `DomainBinding`) — dates serialized ISO-8601; challenge PUBLIC. */
function toDomainBindingWire(b) {
    return {
        bindingId: b.bindingId,
        kind: b.kind,
        host: b.host,
        status: b.status,
        challenge: b.challenge,
        verifiedAt: b.verifiedAt ? b.verifiedAt.toISOString() : null,
        activatedAt: b.activatedAt ? b.activatedAt.toISOString() : null,
        createdAt: b.createdAt.toISOString(),
    };
}
/**
 * The METADATA-ONLY sub-tenant wire projection (FR-017, T020, [COMPLETES FR-017]). Emits ONLY a sub-tenant's
 * administrative metadata — id, display name, own status, the DERIVED read-only-cascade flag, and created-at.
 * It NEVER emits license, usage, or activation data (the source {@link SubTenantRow} carries none either). The
 * managing `resellerId` is OMITTED on the reseller plane and included ONLY on the operator plane so the reseller
 * hierarchy is never disclosed downward (FR-014, SC-012).
 */
function toSubTenantWire(row, readOnly, opts = {}) {
    const wire = {
        subTenantId: row.id,
        displayName: row.name ?? "",
        // A sub-tenant's own lifecycle status (metadata). A tombstoned tenant reads `suspended`; the read-only
        // cascade from a suspended RESELLER is reported separately by `readOnly` (AD-007), not conflated here.
        status: row.deletedAt ? "suspended" : "active",
        readOnly,
        createdAt: row.createdAt.toISOString(),
    };
    if (opts.includeResellerId)
        wire.resellerId = row.parentResellerId;
    return wire;
}
/**
 * The operator-plane `Reseller` wire projection (contract `Reseller`) — identity, lifecycle status, and quota
 * position. `displayName` is the reseller's `tenant.name`; `subTenantCount` is its live sub-tenant count. No
 * secret/PII; no license/usage/activation data.
 */
function toResellerWire(row, displayName, subTenantCount) {
    return {
        resellerId: row.tenantId,
        displayName: displayName ?? "",
        status: row.status,
        subTenantQuota: row.subTenantQuota,
        subTenantCount,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
    };
}
/**
 * The RESELLER-plane gate (T017, [COMPLETES FR-002]). Runs AFTER the console `requireRole` preHandler (which has
 * already enforced session + role + — on a mutation — CSRF, and set `req.admin`). Asserts the session tenant IS
 * a reseller (has a `reseller` row) — the "reseller-admin = admin/owner of a reseller tenant" identity (AD-001).
 * Fails CLOSED: a non-reseller session is denied `403 forbidden` and the attempt is recorded as a tenant-scoped
 * security event. On success it stashes the acting reseller row on `req.reseller` for the handlers.
 */
function requireResellerPlane(deps) {
    return async function preHandler(req, reply) {
        const admin = req.admin;
        if (!admin) {
            await reply.code(401).send({ code: "unauthorized", message: "authentication required" });
            return;
        }
        const reseller = await deps.repo.getReseller(admin.tenantId);
        if (!reseller) {
            await withTenant(deps.pool, admin.tenantId, (q) => recordSecurityEvent(q, {
                actor: admin.userId,
                action: "reseller.plane.denied",
                target: `${req.method} ${req.url}`,
            }));
            await reply.code(403).send({ code: "forbidden", message: "reseller plane required" });
            return;
        }
        req.reseller = reseller;
    };
}
/**
 * The OPERATOR-plane gate (US1-AS4). Runs AFTER `requireRole`. The operator is the platform actor above all
 * resellers; a reseller-admin (session tenant is a reseller) OR a sub-tenant admin (session tenant is linked to
 * a reseller) attempting an operator-reserved action is denied `403 forbidden` + a security event — so the
 * delegated-vs-operator boundary is enforced fail-closed (spec US1 scenario 4). The full operator lifecycle
 * business logic lands in US4.
 */
function requireOperatorPlane(deps) {
    return async function preHandler(req, reply) {
        const admin = req.admin;
        if (!admin) {
            await reply.code(401).send({ code: "unauthorized", message: "authentication required" });
            return;
        }
        const [reseller, parent] = await Promise.all([
            deps.repo.getReseller(admin.tenantId),
            deps.repo.getParentResellerId(admin.tenantId),
        ]);
        if (reseller || parent) {
            // A reseller-admin (or sub-tenant admin) escalating to an operator-reserved action: record a DUAL-IDENTITY
            // security event (T032) — actor_reseller_id = the acting reseller's home tenant (its own id when the actor is
            // a reseller, else its managing reseller) — under the actor's OWN scope, then fail closed 403 (US1-AS4).
            await recordResellerSecurityEvent(deps.pool, {
                scopeTenantId: admin.tenantId,
                actor: admin.userId,
                actorResellerId: reseller ? admin.tenantId : parent,
                action: "operator.plane.denied",
                target: `${req.method} ${req.url}`,
            });
            await reply.code(403).send({ code: "forbidden", message: "operator plane required" });
            return;
        }
    };
}
/**
 * Register the reseller + operator admin routes (US1). The reseller plane is `requireRole` (session + RBAC + CSRF)
 * THEN `requireResellerPlane` (reseller-tenant assertion, fail-closed + security event). Reads require `viewer`,
 * mutations require `admin` + CSRF. The subtree-membership gate confines every sub-tenant reference downward-only
 * (out-of-subtree → 404 + security event, no disclosure). Sub-tenant projections are metadata-only (FR-017).
 */
export function registerResellerRoutes(app, deps) {
    const { pool, repo, config, branding } = deps;
    const resellerPlane = requireResellerPlane(deps);
    const operatorPlane = requireOperatorPlane(deps);
    const resellerViewer = { preHandler: [requireRole(pool, "viewer"), resellerPlane] };
    const resellerAdmin = { preHandler: [requireRole(pool, "admin"), resellerPlane] };
    const operatorViewer = { preHandler: [requireRole(pool, "viewer"), operatorPlane] };
    const operatorAdmin = { preHandler: [requireRole(pool, "admin"), operatorPlane] };
    // The SUB-TENANT branding plane acts on the session's OWN tenant only (no cross-tenant reach) — plain
    // session + RBAC; the managing reseller's default layer + locks are derived SERVER-SIDE (FR-014, T028).
    const ownViewer = { preHandler: [requireRole(pool, "viewer")] };
    const ownAdmin = { preHandler: [requireRole(pool, "admin")] };
    // GET /admin/reseller/sub-tenants — list MY sub-tenants, METADATA-ONLY, deterministic + bounded + truncated,
    // plus the reseller's OWN quota position (FR-002/004/017, SC-001/008). [COMPLETES FR-004 (list side)]
    app.get("/admin/reseller/sub-tenants", resellerViewer, async (req, reply) => {
        const reseller = req.reseller;
        const resellerId = reseller.tenantId;
        return guard(reply, async () => {
            const rows = await repo.listSubTenants(resellerId, { limit: LIST_CAP + 1 });
            const count = await repo.countSubTenants(resellerId);
            const truncated = rows.length > LIST_CAP;
            const page = (truncated ? rows.slice(0, LIST_CAP) : rows).sort((a, b) => (a.name ?? "").localeCompare(b.name ?? "") || a.id.localeCompare(b.id));
            const readOnly = reseller.status === "suspended";
            return reply.code(200).send({
                subTenants: page.map((r) => toSubTenantWire(r, readOnly)),
                truncated,
                subTenantQuota: reseller.subTenantQuota,
                subTenantCount: count,
            });
        });
    });
    // POST /admin/reseller/sub-tenants — provision a new sub-tenant under the HARD quota (409 quota_exceeded at the
    // cap); dual-identity audited. admin + CSRF (the `resellerAdmin` preHandler). (FR-003, [COMPLETES FR-003])
    app.post("/admin/reseller/sub-tenants", resellerAdmin, async (req, reply) => {
        const b = provisionSchema.safeParse(req.body);
        if (!b.success) {
            const field = b.error.issues[0]?.path.join(".") || undefined;
            return validation(reply, "invalid provision payload", field ? { field } : undefined);
        }
        const admin = req.admin;
        return guard(reply, async () => {
            const row = await provisionSubTenant({ pool, repo }, {
                resellerTenantId: admin.tenantId,
                actorUserId: admin.userId,
                displayName: b.data.displayName,
                firstAdminUserReference: b.data.firstAdminUserReference,
            });
            return reply
                .code(201)
                .header("Location", `/admin/reseller/sub-tenants/${row.id}`)
                .send(toSubTenantWire(row, false));
        });
    });
    // GET /admin/reseller/sub-tenants/:subTenantId — get ONE of my sub-tenants, METADATA-ONLY, DOWNWARD-ONLY. An
    // out-of-subtree id (sibling/parent/platform/IDOR) → 404 no disclosure + a security event, NEVER 403 (T018,
    // [COMPLETES FR-004], HINT-002).
    app.get("/admin/reseller/sub-tenants/:subTenantId", resellerViewer, async (req, reply) => {
        const subTenantId = req.params.subTenantId;
        const admin = req.admin;
        const reseller = req.reseller;
        if (!UUID_RE.test(subTenantId)) {
            return err(reply, 404, "not_found", "sub-tenant not found", { subTenantId });
        }
        try {
            // The DATA-LAYER audited gate (T031): out-of-subtree → 404 (no disclosure) + a dual-identity security event
            // recorded in the gate itself (actor = reseller-admin, actor_reseller_id = the acting reseller), never 403.
            const row = await assertSubtreeMembershipAudited({ pool, repo }, reseller.tenantId, subTenantId, {
                actorUserId: admin.userId,
                actorResellerId: reseller.tenantId,
                action: "reseller.subtree.denied",
                attempted: `${req.method} ${req.url}`,
            });
            return reply.code(200).send(toSubTenantWire(row, reseller.status === "suspended"));
        }
        catch (e) {
            if (e instanceof ResellerError && e.code === "not_found") {
                return err(reply, 404, "not_found", "sub-tenant not found", { subTenantId });
            }
            throw e;
        }
    });
    // POST /admin/operator/sub-tenants/:subTenantId/move — OPERATOR-only move of a sub-tenant between resellers or
    // to/from direct-platform (FR-015, T041, [COMPLETES FR-015]). Re-points parent, PRESERVES the sub-tenant's own
    // overrides, RE-RESOLVES per-field locks against the destination, and writes a dual-identity audit on BOTH the
    // source and the destination. Unknown sub-tenant/destination → 404; suspended source/destination → 409
    // reseller_suspended; offboarding destination → 409 invalid_state_transition; destination at cap → 409
    // quota_exceeded. A reseller-admin attempting this is denied 403 + a security event (US1-AS4, operatorAdmin).
    app.post("/admin/operator/sub-tenants/:subTenantId/move", operatorAdmin, async (req, reply) => {
        const subTenantId = req.params.subTenantId;
        if (!UUID_RE.test(subTenantId)) {
            return err(reply, 404, "not_found", "sub-tenant not found", { subTenantId });
        }
        const b = moveSchema.safeParse(req.body);
        if (!b.success) {
            const field = b.error.issues[0]?.path.join(".") || undefined;
            return validation(reply, "invalid move payload", field ? { field } : undefined);
        }
        const admin = req.admin;
        return guard(reply, async () => {
            const moved = await moveSubTenant({ pool, repo, branding, config }, { subTenantId, destination: b.data.destination, actorUserId: admin.userId });
            return reply.code(200).send(toSubTenantWire(moved.subTenant, false, { includeResellerId: true }));
        });
    });
    // POST /admin/operator/resellers/:resellerId/suspend — suspend a reseller (reversible; derived read-only cascade,
    // FR-011, T039). Only an active reseller → else 409 invalid_state_transition; unknown → 404. operator + admin + CSRF.
    app.post("/admin/operator/resellers/:resellerId/suspend", operatorAdmin, async (req, reply) => {
        const resellerId = req.params.resellerId;
        if (!UUID_RE.test(resellerId)) {
            return err(reply, 404, "not_found", "reseller not found", { resellerId });
        }
        const admin = req.admin;
        return guard(reply, async () => {
            const updated = await suspendReseller({ pool, repo }, resellerId, admin.userId);
            const meta = await repo.getResellerWithMeta(resellerId);
            return reply.code(200).send(toResellerWire(updated, meta?.displayName ?? "", meta?.subTenantCount ?? 0));
        });
    });
    // POST /admin/operator/resellers/:resellerId/reinstate — reinstate a suspended reseller (FR-011, T039). Only a
    // suspended reseller → else 409 invalid_state_transition; unknown → 404. operator + admin + CSRF.
    app.post("/admin/operator/resellers/:resellerId/reinstate", operatorAdmin, async (req, reply) => {
        const resellerId = req.params.resellerId;
        if (!UUID_RE.test(resellerId)) {
            return err(reply, 404, "not_found", "reseller not found", { resellerId });
        }
        const admin = req.admin;
        return guard(reply, async () => {
            const updated = await reinstateReseller({ pool, repo }, resellerId, admin.userId);
            const meta = await repo.getResellerWithMeta(resellerId);
            return reply.code(200).send(toResellerWire(updated, meta?.displayName ?? "", meta?.subTenantCount ?? 0));
        });
    });
    // POST /admin/operator/resellers/:resellerId/offboard — offboard: blocked 409 sub_tenants_unresolved until every
    // sub-tenant is transferred/reassigned; applies the notice/grace window; audited; idempotent (FR-012, T040). A
    // suspended reseller → 409 invalid_state_transition; unknown → 404. operator + admin + CSRF.
    app.post("/admin/operator/resellers/:resellerId/offboard", operatorAdmin, async (req, reply) => {
        const resellerId = req.params.resellerId;
        if (!UUID_RE.test(resellerId)) {
            return err(reply, 404, "not_found", "reseller not found", { resellerId });
        }
        const admin = req.admin;
        return guard(reply, async () => {
            const outcome = await offboardReseller({ pool, repo, config }, resellerId, admin.userId);
            return reply.code(200).send({
                resellerId,
                status: outcome.reseller.status,
                unresolvedSubTenantCount: outcome.unresolvedSubTenantCount,
                graceEndsAt: outcome.graceEndsAt.toISOString(),
            });
        });
    });
    // ===========================================================================================================
    // OPERATOR plane — reseller lifecycle: onboard (create-or-promote) + list/get + quota (US4, FR-001/003/010).
    // Operator-only: `operatorPlane` fails a reseller-admin (or sub-tenant admin) closed 403 + a security event.
    // ===========================================================================================================
    // POST /admin/operator/resellers — onboard a reseller via ONE create-or-select flow (create-new OR
    // promote-existing); establishes the reseller + first reseller-admin + hard quota. A tenant already a
    // reseller/sub-tenant → 409 onboarding_conflict (the one-level rule). admin + CSRF. (FR-001/010, T037/T038)
    app.post("/admin/operator/resellers", operatorAdmin, async (req, reply) => {
        const b = onboardResellerSchema.safeParse(req.body);
        if (!b.success) {
            const field = b.error.issues[0]?.path.join(".") || undefined;
            return validation(reply, "invalid onboarding payload", field ? { field } : undefined);
        }
        const admin = req.admin;
        return guard(reply, async () => {
            const result = await onboardReseller({ pool, repo, config }, b.data, admin.userId);
            return reply
                .code(201)
                .header("Location", `/admin/operator/resellers/${result.reseller.tenantId}`)
                .send(toResellerWire(result.reseller, result.displayName, result.subTenantCount));
        });
    });
    // GET /admin/operator/resellers — list all resellers (deterministic by displayName then id, bounded +
    // truncated). Optional `?status` filter. viewer+. (FR-001/010, T052)
    app.get("/admin/operator/resellers", operatorViewer, async (req, reply) => {
        const q = listResellersQuerySchema.safeParse(req.query);
        if (!q.success) {
            const field = q.error.issues[0]?.path.join(".") || undefined;
            return validation(reply, "invalid reseller filters", field ? { field } : undefined);
        }
        return guard(reply, async () => {
            const rows = await repo.listResellersWithMeta({ status: q.data.status, limit: LIST_CAP + 1 });
            const truncated = rows.length > LIST_CAP;
            const page = truncated ? rows.slice(0, LIST_CAP) : rows;
            return reply.code(200).send({
                resellers: page.map((m) => ({
                    resellerId: m.reseller.tenantId,
                    displayName: m.displayName ?? "",
                    status: m.reseller.status,
                    subTenantQuota: m.reseller.subTenantQuota,
                    subTenantCount: m.subTenantCount,
                })),
                truncated,
            });
        });
    });
    // GET /admin/operator/resellers/:resellerId — get one reseller (status + quota position). An unknown id →
    // 404 not_found. viewer+. (FR-001/010, T052)
    app.get("/admin/operator/resellers/:resellerId", operatorViewer, async (req, reply) => {
        const resellerId = req.params.resellerId;
        if (!UUID_RE.test(resellerId)) {
            return err(reply, 404, "not_found", "reseller not found", { resellerId });
        }
        return guard(reply, async () => {
            const m = await repo.getResellerWithMeta(resellerId);
            if (!m)
                return err(reply, 404, "not_found", "reseller not found", { resellerId });
            return reply.code(200).send(toResellerWire(m.reseller, m.displayName, m.subTenantCount));
        });
    });
    // PATCH /admin/operator/resellers/:resellerId/quota — set the hard sub-tenant quota (FR-003). OPERATOR-ONLY
    // (a reseller can never raise its own — enforced by `operatorPlane`). Per the contract + data-model, the quota
    // is a HARD CAP that NEVER deletes existing sub-tenants: lowering it BELOW the current sub-tenant count is
    // ALLOWED and simply blocks FURTHER provisioning until the count falls back under the new cap (T052 reconciled).
    // admin + CSRF + audited.
    app.patch("/admin/operator/resellers/:resellerId/quota", operatorAdmin, async (req, reply) => {
        const resellerId = req.params.resellerId;
        if (!UUID_RE.test(resellerId)) {
            return err(reply, 404, "not_found", "reseller not found", { resellerId });
        }
        const b = updateQuotaSchema.safeParse(req.body);
        if (!b.success) {
            const field = b.error.issues[0]?.path.join(".") || undefined;
            return validation(reply, "invalid quota payload", field ? { field } : undefined);
        }
        const admin = req.admin;
        return guard(reply, async () => {
            const existing = await repo.getResellerWithMeta(resellerId);
            if (!existing)
                return err(reply, 404, "not_found", "reseller not found", { resellerId });
            // A hard cap never deletes existing sub-tenants — lowering below the live count is allowed; it only
            // blocks FUTURE provisioning (the provision path re-checks `used >= quota` at request time).
            const updated = await repo.setQuota(resellerId, b.data.subTenantQuota);
            if (!updated)
                return err(reply, 404, "not_found", "reseller not found", { resellerId });
            await withTenant(pool, resellerId, (q) => writeAudit(q, {
                actor: admin.userId,
                action: "reseller.quota.updated",
                target: resellerId,
                before: { subTenantQuota: existing.reseller.subTenantQuota },
                after: { subTenantQuota: b.data.subTenantQuota },
            }));
            return reply
                .code(200)
                .send(toResellerWire(updated, existing.displayName, existing.subTenantCount));
        });
    });
    // ===========================================================================================================
    // RESELLER plane — the reseller's OWN branding profile (+ per-field locks). US2 (FR-006/007, [COMPLETES FR-006]).
    // ===========================================================================================================
    // GET /admin/reseller/branding — the reseller's own field values, its lock set, and its RESOLVED branding
    // (reseller value → platform default per field). Trust signals are never part of branding (FR-008). viewer+.
    app.get("/admin/reseller/branding", resellerViewer, async (req, reply) => {
        const reseller = req.reseller;
        return guard(reply, async () => {
            const profile = await branding.getProfile(reseller.tenantId);
            const layer = profile ?? { fields: {}, lockedFields: [] };
            // A binding-backed field (customDomain/emailSenderAddress) takes effect only when its host is
            // verified+active (FR-013) — the verifier supplies the reseller's active-bound field set (US5).
            const activeBoundFields = await deps.verifier.activeBoundFields(reseller.tenantId);
            const resolved = resolveBranding({ reseller: layer, platform: config.platformBranding, activeBoundFields });
            return reply.code(200).send({
                fields: layer.fields,
                locked: [...layer.lockedFields],
                resolved,
                updatedAt: (profile?.updatedAt ?? new Date()).toISOString(),
            });
        });
    });
    // PUT /admin/reseller/branding — set the reseller's own field values + per-field locks (REPLACE semantics). A
    // locked field becomes authoritative for all its sub-tenants. Unverified custom-domain/email → 409 not_verified
    // (placeholder until US5). admin + CSRF. Audited (ordinary — a reseller acting on its OWN tenant).
    app.put("/admin/reseller/branding", resellerAdmin, async (req, reply) => {
        const b = setResellerBrandingSchema.safeParse(req.body);
        if (!b.success) {
            const field = b.error.issues[0]?.path.join(".") || undefined;
            return validation(reply, "invalid branding payload", field ? { field } : undefined);
        }
        const reseller = req.reseller;
        const admin = req.admin;
        return guard(reply, async () => {
            // Derived read-only cascade (FR-011): a suspended reseller cannot mutate its own branding.
            if (reseller.status === "suspended") {
                throw new ResellerError("reseller_suspended", 409, "the reseller is suspended; branding changes are blocked", {
                    resellerId: reseller.tenantId,
                });
            }
            // Verify-before-activate (FR-013, US5): a customDomain/emailSenderAddress may be set ONLY when its host is
            // an ACTIVE binding (else 409 not_verified) — the real DNS-backed check replacing the US2 placeholder.
            await deps.verifier.assertBrandingFieldsBacked(reseller.tenantId, b.data.fields);
            const profile = await branding.setProfile(reseller.tenantId, {
                fields: b.data.fields,
                lockedFields: b.data.locked ?? [],
            });
            await withTenant(pool, reseller.tenantId, (q) => writeAudit(q, {
                actor: admin.userId,
                action: "reseller.branding.set",
                target: reseller.tenantId,
                after: { fields: b.data.fields, locked: b.data.locked ?? [] },
            }));
            const activeBoundFields = await deps.verifier.activeBoundFields(reseller.tenantId);
            const resolved = resolveBranding({ reseller: profile, platform: config.platformBranding, activeBoundFields });
            return reply.code(200).send({
                fields: profile.fields,
                locked: [...profile.lockedFields],
                resolved,
                updatedAt: profile.updatedAt.toISOString(),
            });
        });
    });
    // ===========================================================================================================
    // SUB-TENANT plane — a tenant's OWN branding overrides + the RESOLVED applied branding. US2 (FR-006/007/014,
    // [COMPLETES FR-014]). The reseller hierarchy is NEVER disclosed: a locked field is surfaced as non-editable
    // ("set by your provider") via `lockedFields`, and no reseller identity appears in any response (T028, STF-004).
    // ===========================================================================================================
    // GET /admin/branding — the calling tenant's own overrides, the fields it may NOT override (its reseller's
    // locks, hierarchy-concealed), and the per-field RESOLVED applied branding (sub-tenant → reseller → platform).
    app.get("/admin/branding", ownViewer, async (req, reply) => {
        const admin = req.admin;
        return guard(reply, async () => {
            const own = await branding.getProfile(admin.tenantId);
            const parentId = await repo.getParentResellerId(admin.tenantId);
            const resellerLayer = parentId ? await branding.getProfilePrivileged(parentId) : null;
            const ownLayer = own ?? { fields: {}, lockedFields: [] };
            // A binding-backed field is effective if the LAYER that supplies it has an active binding — the union of
            // the sub-tenant's own active-bound fields and (privileged) its reseller's (FR-013, US5). Each layer's
            // stored binding-backed value is guaranteed backed by that layer's own active binding (enforced at write).
            const activeBoundFields = await resolveActiveBoundFields(deps, admin.tenantId, parentId);
            const resolved = resolveBranding({
                subTenant: ownLayer,
                reseller: resellerLayer,
                platform: config.platformBranding,
                activeBoundFields,
            });
            return reply.code(200).send({
                overrides: ownLayer.fields,
                lockedFields: resellerLayer ? [...resellerLayer.lockedFields] : [],
                resolved,
                updatedAt: (own?.updatedAt ?? new Date()).toISOString(),
            });
        });
    });
    // PUT /admin/branding — set the calling tenant's own overrides (REPLACE). Overriding a reseller-LOCKED field is
    // refused 409 field_locked (no hierarchy disclosure); an unverified custom-domain/email → 409 not_verified.
    // admin + CSRF. Audited (ordinary — the tenant acting on itself).
    app.put("/admin/branding", ownAdmin, async (req, reply) => {
        const b = setSubTenantBrandingSchema.safeParse(req.body);
        if (!b.success) {
            const field = b.error.issues[0]?.path.join(".") || undefined;
            return validation(reply, "invalid branding payload", field ? { field } : undefined);
        }
        const admin = req.admin;
        return guard(reply, async () => {
            // Derived read-only cascade (FR-011, AD-007): a sub-tenant under a SUSPENDED reseller cannot mutate branding
            // (409 reseller_suspended); sign-in + reads stay allowed. No fan-out write — derived at request time.
            await assertResellerNotSuspended(repo, admin.tenantId);
            const parentId = await repo.getParentResellerId(admin.tenantId);
            const resellerLayer = parentId ? await branding.getProfilePrivileged(parentId) : null;
            const lockedSet = new Set(resellerLayer?.lockedFields ?? []);
            // A reseller-locked field is authoritative — refuse the override WITHOUT revealing the reseller (STF-001/004).
            for (const f of Object.keys(b.data.overrides)) {
                if (lockedSet.has(f)) {
                    throw new ResellerError("field_locked", 409, "field is set by your provider and cannot be overridden", {
                        field: f,
                    });
                }
            }
            // Verify-before-activate (FR-013, US5): a customDomain/emailSenderAddress override may be set ONLY when
            // the sub-tenant itself holds an ACTIVE binding for that host (else 409 not_verified).
            await deps.verifier.assertBrandingFieldsBacked(admin.tenantId, b.data.overrides);
            const profile = await branding.setProfile(admin.tenantId, { fields: b.data.overrides, lockedFields: [] });
            await withTenant(pool, admin.tenantId, (q) => writeAudit(q, { actor: admin.userId, action: "branding.set", target: admin.tenantId, after: { overrides: b.data.overrides } }));
            const activeBoundFields = await resolveActiveBoundFields(deps, admin.tenantId, parentId);
            const resolved = resolveBranding({
                subTenant: profile,
                reseller: resellerLayer,
                platform: config.platformBranding,
                activeBoundFields,
            });
            return reply.code(200).send({
                overrides: profile.fields,
                lockedFields: resellerLayer ? [...resellerLayer.lockedFields] : [],
                resolved,
                updatedAt: profile.updatedAt.toISOString(),
            });
        });
    });
    // ===========================================================================================================
    // RESELLER plane — domain / email-sender ownership verification (US5, FR-013, [COMPLETES FR-013]). Initiate
    // returns the PUBLIC DNS challenge; verify runs the (injected) DNS proof pending→verified; activate promotes
    // verified→active for white-label (refused 409 not_verified until verified). A host bound to another tenant →
    // 409 binding_conflict. All mutations require admin + CSRF (`resellerAdmin`) + a non-suspended reseller.
    // ===========================================================================================================
    /** Derived read-only cascade (FR-011): a suspended reseller cannot mutate its own domain bindings. */
    function assertResellerActive(reseller) {
        if (reseller.status === "suspended") {
            throw new ResellerError("reseller_suspended", 409, "the reseller is suspended; domain changes are blocked", {
                resellerId: reseller.tenantId,
            });
        }
    }
    // GET /admin/reseller/domains — list MY bindings + status, deterministic (host, bindingId), bounded + truncated.
    app.get("/admin/reseller/domains", resellerViewer, async (req, reply) => {
        const reseller = req.reseller;
        return guard(reply, async () => {
            const all = await deps.verifier.list(reseller.tenantId);
            const truncated = all.length > LIST_CAP;
            const page = truncated ? all.slice(0, LIST_CAP) : all;
            return reply.code(200).send({ bindings: page.map(toDomainBindingWire), truncated });
        });
    });
    // POST /admin/reseller/domains — initiate DNS verification; returns the DNS challenge records to publish. A host
    // already verified/active by another tenant → 409 binding_conflict. admin + CSRF. Audited (own tenant).
    app.post("/admin/reseller/domains", resellerAdmin, async (req, reply) => {
        const b = initiateVerificationSchema.safeParse(req.body);
        if (!b.success) {
            const field = b.error.issues[0]?.path.join(".") || undefined;
            return validation(reply, "invalid verification payload", field ? { field } : undefined);
        }
        const reseller = req.reseller;
        const admin = req.admin;
        return guard(reply, async () => {
            assertResellerActive(reseller);
            const binding = await deps.verifier.initiate(reseller.tenantId, { kind: b.data.kind, host: b.data.host });
            await withTenant(pool, reseller.tenantId, (q) => writeAudit(q, {
                actor: admin.userId,
                action: "reseller.domain.initiated",
                target: binding.bindingId,
                after: { kind: binding.kind, host: binding.host, status: binding.status },
            }));
            return reply
                .code(201)
                .header("Location", `/admin/reseller/domains/${binding.bindingId}`)
                .send(toDomainBindingWire(binding));
        });
    });
    // GET /admin/reseller/domains/:bindingId — get ONE of my bindings + status. Unknown/cross-tenant → 404.
    app.get("/admin/reseller/domains/:bindingId", resellerViewer, async (req, reply) => {
        const bindingId = req.params.bindingId;
        const reseller = req.reseller;
        if (!UUID_RE.test(bindingId))
            return err(reply, 404, "not_found", "binding not found", { bindingId });
        return guard(reply, async () => {
            const binding = await deps.verifier.get(reseller.tenantId, bindingId);
            if (!binding)
                return err(reply, 404, "not_found", "binding not found", { bindingId });
            return reply.code(200).send(toDomainBindingWire(binding));
        });
    });
    // POST /admin/reseller/domains/:bindingId/verify — check DNS; pending→verified. Unmet → 409 not_verified (stays
    // pending); host raced by another tenant → 409 binding_conflict; unknown → 404. admin + CSRF. Audited.
    app.post("/admin/reseller/domains/:bindingId/verify", resellerAdmin, async (req, reply) => {
        const bindingId = req.params.bindingId;
        const reseller = req.reseller;
        const admin = req.admin;
        if (!UUID_RE.test(bindingId))
            return err(reply, 404, "not_found", "binding not found", { bindingId });
        return guard(reply, async () => {
            assertResellerActive(reseller);
            const binding = await deps.verifier.verify(reseller.tenantId, bindingId);
            await withTenant(pool, reseller.tenantId, (q) => writeAudit(q, {
                actor: admin.userId,
                action: "reseller.domain.verified",
                target: binding.bindingId,
                after: { host: binding.host, status: binding.status },
            }));
            return reply.code(200).send(toDomainBindingWire(binding));
        });
    });
    // POST /admin/reseller/domains/:bindingId/activate — verified→active for white-label. Pending → 409 not_verified;
    // host raced by another tenant → 409 binding_conflict; unknown → 404. admin + CSRF. Audited.
    app.post("/admin/reseller/domains/:bindingId/activate", resellerAdmin, async (req, reply) => {
        const bindingId = req.params.bindingId;
        const reseller = req.reseller;
        const admin = req.admin;
        if (!UUID_RE.test(bindingId))
            return err(reply, 404, "not_found", "binding not found", { bindingId });
        return guard(reply, async () => {
            assertResellerActive(reseller);
            const binding = await deps.verifier.activate(reseller.tenantId, bindingId);
            await withTenant(pool, reseller.tenantId, (q) => writeAudit(q, {
                actor: admin.userId,
                action: "reseller.domain.activated",
                target: binding.bindingId,
                after: { host: binding.host, status: binding.status },
            }));
            return reply.code(200).send(toDomainBindingWire(binding));
        });
    });
}
