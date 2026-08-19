// The /admin/policy REST surface (E017, FR-001/002/016/019; US1). ONE admin plane — session-cookie
// authenticated via the shared console RBAC (viewer reads, admin authors/edits); every mutation carries the
// double-submit CSRF token (the `requireRole` preHandler enforces both, fail-closed). camelCase bodies; errors
// are the project `{code,message,details?}` model. A thrown PolicyError maps to its HTTP status + machine code.
//
// RBAC + CSRF + audited denials (FR-016, T047, [COMPLETES FR-016]): every state-changing route — POST create,
// PATCH edit, POST .../status, POST .../dry-run — runs behind the SAME `requireRole(pool, "admin")` preHandler,
// and every read (GET list/detail) behind `requireRole(pool, "viewer")`. That shared console preHandler is the
// single choke point (mirroring the admin/catalog/usage admin routes): it fail-closed returns 401 on no/invalid
// session, 403 on a missing/insufficient role, and — on EVERY mutation — 403 on a missing/mismatched
// double-submit CSRF token, recording each such denial (CSRF miss, no-role, below-min-role) as a tenant-scoped
// security event via `recordSecurityEvent`. No policy mutation bypasses it, so RBAC/CSRF enforcement and the
// denial audit are uniform across the whole surface.
//
// This file owns the US1 authoring surface — POST create + GET list/detail + PATCH edit (T024) — with
// validate-before-persist (T025) and the author-time rule-set size cap (T026) wired in. The lifecycle status
// transition (POST .../status) and the dry-run simulate (POST .../dry-run) routes land onto this same
// registerPolicyRoutes in later phases (US4/US5); the seams are kept explicit.
//
// Validate-before-persist (FR-002, T025): every create/edit runs `validateRule` FIRST — a rejected rule throws a
// DISTINCT 400 PolicyError (`invalid_condition`/`unsafe_operator`/`effect_out_of_bounds`/`condition_too_large`)
// and is NEVER persisted (validation runs before any INSERT; the size cap runs inside the persist transaction so
// a breach rolls back). Author-time rule-set cap (FR-019, T026): a NEW LIVE rule that would push the tenant's
// per-entitlement or per-tenant live rule set past the configured maximum is refused `rule_set_limit_exceeded`
// before persist.
//
// NOTE (data model): the OpenAPI `description` field is not a `policy_rule` column (migration 0013 stores no
// description), so it is accepted+shape-validated on the wire but not persisted; reads/echoes return `null`.
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { requireRole } from "../../console/rbac-middleware.js";
import { withTenant } from "../../db/client.js";
import { getEffectivePlanDefinition } from "../catalog/effective.js";
import { PolicyError } from "./index.js";
import { buildDecisionContext, buildSuppliedContext, canonicalContextHash, ContextError, } from "./context.js";
import { applyEffect } from "./effect.js";
import { resolveEntitlementDecision } from "./evaluate.js";
import { assertRuleSetWithinCaps, lintRuleConflicts, validateRule, } from "./validate.js";
function err(reply, status, code, message, details) {
    const body = { code, message };
    if (details !== undefined)
        body.details = details;
    return reply.code(status).send(body);
}
const validation = (r, m = "invalid request", details) => err(r, 400, "validation_error", m, details);
/** Run a handler, mapping a thrown PolicyError to its HTTP status + code; other errors propagate (→ 500). */
async function guard(reply, fn) {
    try {
        return await fn();
    }
    catch (e) {
        if (e instanceof PolicyError)
            return err(reply, e.status, e.code, e.message, e.details);
        throw e;
    }
}
/** The hard, non-paginated list cap (contract: 1000 items + a `truncated` signal). */
const LIST_CAP = 1000;
/** Canonical-UUID shape guard so a malformed path id resolves to 404 (never leaks) without a DB round-trip. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ruleStatusSchema = z.enum(["active", "preview", "disabled"]);
// condition/effect are objects on the wire; their DEEP validation is owned by `validateRule` (distinct 400
// codes), so the envelope schema only shape-guards them as objects (a non-object → `validation_error`).
const createSchema = z
    .object({
    targetEntitlementId: z.string().uuid(),
    description: z.string().max(500).optional(),
    priority: z.number().int().min(0).max(1_000_000),
    status: ruleStatusSchema.optional(),
    condition: z.record(z.unknown()),
    effect: z.record(z.unknown()),
})
    .strict();
const editSchema = z
    .object({
    description: z.string().max(500).optional(),
    priority: z.number().int().min(0).max(1_000_000),
    condition: z.record(z.unknown()),
    effect: z.record(z.unknown()),
})
    .strict();
const listQuerySchema = z
    .object({
    entitlementId: z.string().uuid().optional(),
    status: ruleStatusSchema.optional(),
})
    .strict();
// Status transition (US5, FR-011/012): the closed `{status}` body. A malformed/unknown status VALUE → 400
// validation_error; a valid status the lifecycle does not permit from the current head → 409 (see below).
const statusTransitionSchema = z.object({ status: ruleStatusSchema }).strict();
/**
 * The permitted lifecycle transitions of a rule's head version (data-model status axis, FR-011/012). A `preview`
 * version promotes to `active` or is `disabled`; an `active` version may be demoted to `preview` (report-only)
 * or `disabled`; a `disabled` version is re-STAGED to `preview` (never re-activated directly — the single-live
 * slot + rollout order stay unambiguous, so a "disabled superseded version back to active" is always refused).
 * A no-op (same-status) transition, and any pairing absent from this table, is refused `409
 * invalid_state_transition` (no state changes).
 */
const PERMITTED_TRANSITIONS = {
    preview: ["active", "disabled"],
    active: ["preview", "disabled"],
    disabled: ["preview"],
};
// Dry-run (US4, FR-013/020): a supplied OR real context + an OPTIONAL unsaved candidate. `context`/`candidate`
// are shape-guarded loosely here (a non-object → `validation_error`); the SUPPLIED context is deep-validated +
// bounded by `buildSuppliedContext` (the same allow-listed schema + size/depth/field-count caps as the real
// assembled context, FR-020) and the `candidate` is author-time validated by `validateRule` (FR-002) — both
// BEFORE any evaluation.
const dryRunCandidateSchema = z
    .object({
    description: z.string().max(500).optional(),
    priority: z.number().int().min(0).max(1_000_000),
    condition: z.record(z.unknown()),
    effect: z.record(z.unknown()),
})
    .strict();
const dryRunSchema = z
    .object({
    context: z.record(z.unknown()).optional(),
    licenseId: z.string().uuid().optional(),
    candidate: dryRunCandidateSchema.optional(),
})
    .strict();
/** One IMMUTABLE version wire projection (contract `PolicyRuleVersion`). `description` is not persisted → null. */
function toVersion(row) {
    return {
        ruleKey: row.ruleKey,
        version: row.version,
        targetEntitlementId: row.entitlementId,
        description: null,
        priority: row.priority,
        status: row.status,
        condition: row.condition,
        effect: row.effect,
        author: row.author,
        createdAt: row.createdAt.toISOString(),
    };
}
/**
 * Run the non-blocking author-time overlap/unreachable lint (FR-006, SC-010) against the target entitlement's
 * existing LIVE (active|preview) peers. Maps the repo rows to the lint's minimal shape. A WARNING never blocks a
 * persist — the finding is surfaced on the create/edit response `warnings[]`.
 */
function liveRuleLint(liveRules, candidate) {
    return lintRuleConflicts(candidate, liveRules.map((r) => ({ ruleKey: r.ruleKey, version: r.version, priority: r.priority, condition: r.condition })));
}
/** The create/edit response: the persisted immutable version PLUS any non-blocking author-time lint warnings. */
function withWarnings(row, warnings) {
    return { ...toVersion(row), warnings };
}
/** A latest-version summary wire projection (contract `PolicyRuleSummary`). */
function toSummary(row) {
    const effect = row.effect;
    return {
        ruleKey: row.ruleKey,
        latestVersion: row.version,
        targetEntitlementId: row.entitlementId,
        description: null,
        priority: row.priority,
        status: row.status,
        effectKind: effect && typeof effect === "object" ? effect.kind : undefined,
        updatedAt: row.updatedAt.toISOString(),
    };
}
/**
 * Register the /admin/policy authoring routes (US1): POST create, GET list, GET detail, PATCH edit. viewer reads,
 * admin authors/edits; every mutation runs behind `requireRole(pool, "admin")` (session + RBAC + double-submit
 * CSRF, fail-closed). Validate-before-persist (FR-002) and the author-time rule-set size cap (FR-019) are wired
 * into create + edit; a rejected rule is never persisted.
 */
export function registerPolicyRoutes(app, deps) {
    const { pool, config, repo, entitlementRead } = deps;
    const viewer = { preHandler: requireRole(pool, "viewer") };
    const admin = { preHandler: requireRole(pool, "admin") };
    const validateOpts = {
        maxBytes: config.conditionMaxBytes,
        maxDepth: config.conditionMaxDepth,
        maxComplexity: config.conditionMaxComplexity,
    };
    const caps = { maxRulesPerEntitlement: config.maxRulesPerEntitlement, maxRulesPerTenant: config.maxRulesPerTenant };
    const contextCaps = {
        maxBytes: config.contextMaxBytes,
        maxDepth: config.contextMaxDepth,
        maxFields: config.contextMaxFields,
    };
    /** Resolve the target entitlement's authored bound (rule_max/rule_eligible/rule_tiers + the absolute cap). */
    function boundsOf(ent) {
        return {
            ruleMax: ent.ruleMax,
            ruleEligible: ent.ruleEligible,
            ruleTiers: ent.ruleTiers,
            absoluteMax: config.absoluteMaxLimit,
        };
    }
    // POST /admin/policy/rules — author a rule (structured-JSON condition + typed effect); validate before persist.
    app.post("/admin/policy/rules", admin, async (req, reply) => {
        const b = createSchema.safeParse(req.body);
        if (!b.success) {
            const field = b.error.issues[0]?.path.join(".") || undefined;
            return validation(reply, "invalid rule payload", field ? { field } : undefined);
        }
        const tenantId = req.admin.tenantId;
        const author = req.admin.userId;
        return guard(reply, async () => {
            const ent = await entitlementRead(pool, tenantId, b.data.targetEntitlementId);
            if (!ent)
                return err(reply, 404, "not_found", "unknown entitlement", { entitlementId: b.data.targetEntitlementId });
            // Validate-before-persist (FR-002): a rejected rule throws a distinct 400 here, before any INSERT.
            validateRule({ condition: b.data.condition, effect: b.data.effect, bounds: boundsOf(ent) }, validateOpts);
            const status = b.data.status ?? "preview";
            const ruleKey = randomUUID();
            const persisted = await withTenant(pool, tenantId, async (q) => {
                // Author-time rule-set size cap (FR-019): a NEW LIVE rule that would exceed the configured maximum is
                // refused BEFORE persist — the throw rolls back this transaction, so nothing is stored.
                if (status !== "disabled") {
                    const entitlementLive = await repo.countLiveRulesForEntitlement(q, ent.id);
                    const tenantLive = await repo.countLiveRulesForTenant(q);
                    assertRuleSetWithinCaps({ entitlementLive, tenantLive }, caps);
                }
                // Non-blocking author-time overlap/unreachable lint (FR-006, SC-010): compare against the tenant's
                // existing LIVE peers for this entitlement (the new ruleKey is fresh, so no self-exclusion is needed).
                const warnings = liveRuleLint(await repo.selectLiveRulesForEntitlement(q, ent.id, config.maxRulesPerIssuance + 1), {
                    priority: b.data.priority,
                    condition: b.data.condition,
                });
                const row = await repo.insertVersion(q, {
                    ruleKey,
                    version: 1,
                    entitlementId: ent.id,
                    planId: null,
                    condition: b.data.condition,
                    effect: b.data.effect,
                    priority: b.data.priority,
                    status,
                    author,
                });
                return { row, warnings };
            });
            return reply
                .code(201)
                .header("Location", `/admin/policy/rules/${ruleKey}`)
                .send(withWarnings(persisted.row, persisted.warnings));
        });
    });
    // GET /admin/policy/rules — deterministic, bounded list of one latest-version summary per logical rule.
    app.get("/admin/policy/rules", viewer, async (req, reply) => {
        const q = listQuerySchema.safeParse(req.query ?? {});
        if (!q.success) {
            const field = q.error.issues[0]?.path.join(".") || undefined;
            return validation(reply, "invalid list filter", field ? { field } : undefined);
        }
        const tenantId = req.admin.tenantId;
        const rows = await withTenant(pool, tenantId, (t) => repo.listLatestRules(t, { entitlementId: q.data.entitlementId, status: q.data.status, limit: LIST_CAP + 1 }));
        const truncated = rows.length > LIST_CAP;
        const page = truncated ? rows.slice(0, LIST_CAP) : rows;
        return reply.code(200).send({ rules: page.map(toSummary), truncated });
    });
    // GET /admin/policy/rules/:ruleKey — the rule head + its FULL immutable version history (cross-tenant → 404).
    app.get("/admin/policy/rules/:ruleKey", viewer, async (req, reply) => {
        const ruleKey = req.params.ruleKey;
        if (!UUID_RE.test(ruleKey))
            return err(reply, 404, "not_found", "no such rule in this tenant", { ruleKey });
        const tenantId = req.admin.tenantId;
        const versions = await withTenant(pool, tenantId, (t) => repo.getVersions(t, ruleKey));
        if (versions.length === 0)
            return err(reply, 404, "not_found", "no such rule in this tenant", { ruleKey });
        const head = versions[0];
        return reply.code(200).send({
            ruleKey,
            latestVersion: head.version,
            status: head.status,
            versions: versions.map(toVersion),
        });
    });
    // PATCH /admin/policy/rules/:ruleKey — edit content → a NEW immutable version (prior retained); validate first.
    app.patch("/admin/policy/rules/:ruleKey", admin, async (req, reply) => {
        const ruleKey = req.params.ruleKey;
        if (!UUID_RE.test(ruleKey))
            return err(reply, 404, "not_found", "no such rule in this tenant", { ruleKey });
        const b = editSchema.safeParse(req.body);
        if (!b.success) {
            const field = b.error.issues[0]?.path.join(".") || undefined;
            return validation(reply, "invalid edit payload", field ? { field } : undefined);
        }
        const tenantId = req.admin.tenantId;
        const author = req.admin.userId;
        return guard(reply, async () => {
            // Load the rule (its immutable target entitlement + current live head), tenant-scoped (cross-tenant → 404).
            const loaded = await withTenant(pool, tenantId, async (t) => {
                const versions = await repo.getVersions(t, ruleKey);
                if (versions.length === 0)
                    return null;
                const live = await repo.getLiveVersion(t, ruleKey);
                return { entitlementId: versions[0].entitlementId, live };
            });
            if (!loaded)
                return err(reply, 404, "not_found", "no such rule in this tenant", { ruleKey });
            const ent = await entitlementRead(pool, tenantId, loaded.entitlementId);
            if (!ent)
                return err(reply, 404, "not_found", "no such rule in this tenant", { ruleKey });
            // Validate-before-persist (FR-002): identical to create — a rejected edit creates NO new version.
            validateRule({ condition: b.data.condition, effect: b.data.effect, bounds: boundsOf(ent) }, validateOpts);
            // An edit is a NEW immutable version that takes over the current live slot (preserving the live status), so
            // the prior live version is disabled first — `policy_rule_one_live` stays satisfied. A rule with no live
            // version (all disabled) edits to a disabled new version.
            const newStatus = loaded.live ? loaded.live.status : "disabled";
            const persisted = await withTenant(pool, tenantId, async (t) => {
                // Author-time overlap/unreachable lint (FR-006, SC-010): compare against the OTHER live peers for this
                // entitlement (exclude this logical rule's own live version — an edit re-lints against its peers, not
                // itself) BEFORE the prior live version is disabled.
                const warnings = liveRuleLint(await repo.selectLiveRulesForEntitlement(t, loaded.entitlementId, config.maxRulesPerIssuance + 1), { priority: b.data.priority, condition: b.data.condition, ruleKey });
                if (loaded.live)
                    await repo.updateStatus(t, { ruleKey, version: loaded.live.version, status: "disabled" });
                const next = await repo.nextVersion(t, ruleKey);
                const row = await repo.insertVersion(t, {
                    ruleKey,
                    version: next,
                    entitlementId: loaded.entitlementId,
                    planId: null,
                    condition: b.data.condition,
                    effect: b.data.effect,
                    priority: b.data.priority,
                    status: newStatus,
                    author,
                });
                return { row, warnings };
            });
            return reply.code(200).send(withWarnings(persisted.row, persisted.warnings));
        });
    });
    // POST /admin/policy/rules/:ruleKey/status — lifecycle transition (active|preview|disabled) on the rule's CURRENT
    // head version; does NOT create a new content version (edits use PATCH). Single-live promotion: transitioning to
    // a live status disables any OTHER currently-live version in the SAME tenant tx so `policy_rule_one_live` stays
    // satisfied. A valid status the lifecycle does not permit from the current head state → 409
    // invalid_state_transition (no state changes). admin + CSRF (the `admin` preHandler). [COMPLETES FR-011]
    app.post("/admin/policy/rules/:ruleKey/status", admin, async (req, reply) => {
        const ruleKey = req.params.ruleKey;
        if (!UUID_RE.test(ruleKey))
            return err(reply, 404, "not_found", "no such rule in this tenant", { ruleKey });
        const b = statusTransitionSchema.safeParse(req.body);
        if (!b.success) {
            const field = b.error.issues[0]?.path.join(".") || undefined;
            return validation(reply, "invalid status payload", field ? { field } : undefined);
        }
        const tenantId = req.admin.tenantId;
        const to = b.data.status;
        return guard(reply, async () => {
            const updated = await withTenant(pool, tenantId, async (t) => {
                const versions = await repo.getVersions(t, ruleKey);
                if (versions.length === 0)
                    return null; // unknown / cross-tenant → 404 (RLS, FR-015)
                const head = versions[0];
                const from = head.status;
                // A syntactically valid status the lifecycle does not permit from the current head state (incl. a no-op
                // same-status transition) → 409, refused with NO state change (the throw rolls back this tenant tx).
                if (!PERMITTED_TRANSITIONS[from].includes(to)) {
                    throw new PolicyError("invalid_state_transition", 409, `cannot transition ${from} -> ${to}`, { from, to });
                }
                // Single-live promotion (AD-006, INV-3): a live status disables any OTHER currently-live version first.
                if (to === "active" || to === "preview") {
                    const live = await repo.getLiveVersion(t, ruleKey);
                    if (live && live.version !== head.version) {
                        await repo.updateStatus(t, { ruleKey, version: live.version, status: "disabled" });
                    }
                }
                return repo.updateStatus(t, { ruleKey, version: head.version, status: to });
            });
            if (!updated)
                return err(reply, 404, "not_found", "no such rule in this tenant", { ruleKey });
            return reply.code(200).send(toSummary(updated));
        });
    });
    /**
     * Assemble the REAL bounded decision context for a license (E007/E008), mirroring the issuance-path minimization
     * so a within-bounds SUPPLIED context evaluates identically (FR-020). Returns null when the license is unknown /
     * cross-tenant (RLS → not found, FR-015). Read-only; changes no live state (INV-9). No usage section is added
     * (a rule must `has()`-guard it) — the dry-run stays deterministic on the assembled static context.
     */
    async function assembleRealContext(tenantId, licenseId, ent) {
        const licenseRow = await withTenant(pool, tenantId, async (t) => {
            const r = await t("SELECT plan_id, status, expires_at, entitlements FROM license WHERE id = $1", [licenseId]);
            return (r.rowCount ?? 0) === 0 ? null : r.rows[0];
        });
        if (!licenseRow)
            return null;
        const eff = await getEffectivePlanDefinition(pool, tenantId, licenseRow.plan_id);
        const effEnt = eff?.entitlements.find((e) => e.key === ent.key);
        const snap = licenseRow.entitlements?.[ent.key];
        const baseValue = effEnt
            ? effEnt.value
            : typeof snap === "number" || typeof snap === "boolean"
                ? snap
                : null;
        const decisionTimestampMs = Date.now();
        const leaf = typeof baseValue === "number" || typeof baseValue === "boolean" ? baseValue : undefined;
        const context = buildDecisionContext({
            decisionTimestamp: decisionTimestampMs,
            license: {
                product: eff?.productKey,
                status: licenseRow.status,
                expiresAt: licenseRow.expires_at ? licenseRow.expires_at.toISOString() : undefined,
                plan: eff?.planKey,
                planId: licenseRow.plan_id,
                seats: eff?.maxActivations,
            },
            plan: { code: eff?.planKey, tier: eff?.planKey },
            entitlement: {
                key: ent.key,
                type: ent.type,
                value: leaf,
                baseValue: leaf,
                ruleMax: ent.ruleMax ?? undefined,
                ruleEligible: ent.ruleEligible,
                ruleTiers: ent.ruleTiers ?? undefined,
            },
        }, contextCaps);
        return { context, decisionTimestampMs, baseValue, planId: licenseRow.plan_id };
    }
    // POST /admin/policy/rules/:ruleKey/dry-run — simulate the rule (or an unsaved candidate) against a SUPPLIED or
    // REAL context; return the would-be decision + fired rule + considered-not-applied; NON-ENFORCING, mode=dry_run;
    // persists a dry_run audit row but changes NO live state (INV-9, FR-013). admin + CSRF (the `admin` preHandler).
    app.post("/admin/policy/rules/:ruleKey/dry-run", admin, async (req, reply) => {
        const ruleKey = req.params.ruleKey;
        if (!UUID_RE.test(ruleKey))
            return err(reply, 404, "not_found", "no such rule in this tenant", { ruleKey });
        const b = dryRunSchema.safeParse(req.body);
        if (!b.success) {
            const field = b.error.issues[0]?.path.join(".") || undefined;
            return validation(reply, "invalid dry-run payload", field ? { field } : undefined);
        }
        // CONTEXT SOURCE — EXACTLY ONE of `context` / `licenseId` (contract oneOf, FR-013). Neither/both → 400.
        const hasContext = b.data.context !== undefined;
        const hasLicense = b.data.licenseId !== undefined;
        if (hasContext === hasLicense) {
            return validation(reply, "provide exactly one of `context` or `licenseId`", { field: "context" });
        }
        const tenantId = req.admin.tenantId;
        return guard(reply, async () => {
            // Load the target rule (its immutable versions → head + current live), tenant-scoped (cross-tenant → 404).
            const loaded = await withTenant(pool, tenantId, async (t) => {
                const versions = await repo.getVersions(t, ruleKey);
                if (versions.length === 0)
                    return null;
                return { head: versions[0], live: await repo.getLiveVersion(t, ruleKey) };
            });
            if (!loaded)
                return err(reply, 404, "not_found", "no such rule in this tenant", { ruleKey });
            const targetEntitlementId = loaded.head.entitlementId;
            const ent = await entitlementRead(pool, tenantId, targetEntitlementId);
            if (!ent)
                return err(reply, 404, "not_found", "no such rule in this tenant", { ruleKey });
            // The rule content to simulate: an UNSAVED candidate override (validated author-time, FR-002 — never
            // persisted) or the rule's current live/head version content.
            const baseVersion = loaded.live ?? loaded.head;
            let simCondition = baseVersion.condition;
            let simEffect = baseVersion.effect;
            let simPriority = baseVersion.priority;
            if (b.data.candidate) {
                validateRule({ condition: b.data.candidate.condition, effect: b.data.candidate.effect, bounds: boundsOf(ent) }, validateOpts);
                simCondition = b.data.candidate.condition;
                simEffect = b.data.candidate.effect;
                simPriority = b.data.candidate.priority;
            }
            // Assemble the decision context + base value + effect bound. SUPPLIED → validate + bound BEFORE eval
            // (FR-020, any breach → validation_error); REAL → assemble from the license (cross-tenant/unknown → 404).
            let context;
            let decisionTimestampMs;
            let baseValue;
            let effBounds;
            let auditLicenseId;
            let auditPlanId;
            if (hasContext) {
                let supplied;
                try {
                    supplied = buildSuppliedContext(b.data.context, contextCaps);
                }
                catch (e) {
                    if (e instanceof ContextError) {
                        return validation(reply, `supplied context rejected: ${e.message}`, { reason: e.code });
                    }
                    throw e;
                }
                context = supplied.context;
                decisionTimestampMs = supplied.decisionTimestampMs;
                baseValue = supplied.baseValue;
                effBounds = { ...supplied.bounds, absoluteMax: config.absoluteMaxLimit };
                auditLicenseId = null;
                auditPlanId = null;
            }
            else {
                const real = await assembleRealContext(tenantId, b.data.licenseId, ent);
                if (!real)
                    return err(reply, 404, "not_found", "no such rule or license in this tenant", { licenseId: b.data.licenseId });
                context = real.context;
                decisionTimestampMs = real.decisionTimestampMs;
                baseValue = real.baseValue;
                effBounds = boundsOf(ent);
                auditLicenseId = b.data.licenseId;
                auditPlanId = real.planId;
            }
            const condOpts = {
                timeoutMs: config.evalTimeoutMs,
                maxBytes: config.conditionMaxBytes,
                maxDepth: config.conditionMaxDepth,
                maxComplexity: config.conditionMaxComplexity,
                now: decisionTimestampMs,
            };
            // Candidate set for highest-priority-wins: the simulated TARGET rule + the tenant's OTHER live rules for the
            // same entitlement (the considered-but-not-applied peers). Reuses the SAME pure core the issuance path uses.
            const targetCand = {
                id: baseVersion.id,
                ruleKey,
                version: baseVersion.version,
                priority: simPriority,
                condition: simCondition,
                effect: simEffect,
            };
            const otherLive = await withTenant(pool, tenantId, (t) => repo.selectLiveRulesForEntitlement(t, targetEntitlementId, config.maxRulesPerIssuance + 1));
            const others = otherLive
                .filter((r) => r.ruleKey !== ruleKey)
                .map((r) => ({ id: r.id, ruleKey: r.ruleKey, version: r.version, priority: r.priority, condition: r.condition, effect: r.effect }));
            const candidates = [targetCand, ...others];
            const baseForResolve = typeof baseValue === "number" || typeof baseValue === "boolean" || typeof baseValue === "string" ? baseValue : 0;
            const resolved = resolveEntitlementDecision(candidates, context, effBounds, baseForResolve, condOpts);
            // Effect kind + clamp flag for the wire decision — re-apply the winner's effect through the trusted clamp.
            let effectKind = null;
            let clamped = false;
            if (resolved.firedRule) {
                const winner = candidates.find((c) => c.id === resolved.firedRule.rule_id);
                if (winner) {
                    const applied = applyEffect(winner.effect, effBounds);
                    if (applied.applied) {
                        effectKind = applied.kind;
                        clamped = applied.clamped;
                    }
                }
            }
            const resolvedValue = resolved.enforced ? resolved.decision : baseValue;
            const decision = {
                targetEntitlementId,
                target: ent.key,
                effectKind,
                baseValue,
                resolvedValue,
                authoredMaximum: effBounds.ruleMax ?? null,
                clamped,
                source: resolved.enforced ? "rule" : "base",
            };
            // INV-9: a dry_run persists ONE mode-marked audit row but changes NO live decision/license/rule state. A
            // supplied-context dry-run carries a null license/plan ref (the DB license-shape CHECK permits null only for
            // dry_run). No live rule status/version is touched (nothing was inserted/updated on `policy_rule`).
            await withTenant(pool, tenantId, (t) => repo.appendEvaluation(t, {
                licenseId: auditLicenseId,
                planId: auditPlanId,
                entitlementKey: ent.key,
                firedRule: resolved.firedRule ?? undefined,
                consideredRules: resolved.consideredRules.length > 0 ? resolved.consideredRules : null,
                inputHash: canonicalContextHash(context),
                inputSnapshot: context,
                decision: resolvedValue,
                mode: "dry_run",
            }));
            return reply.code(200).send({
                mode: "dry_run",
                decisionTimestamp: new Date(decisionTimestampMs).toISOString(),
                decision,
                firedRule: resolved.firedRule ? { ruleKey: resolved.firedRule.rule_key, version: resolved.firedRule.version } : null,
                consideredNotApplied: resolved.consideredRules.map((r) => ({
                    ruleKey: r.rule_key,
                    version: r.version,
                    reason: "lower_priority",
                })),
            });
        });
    });
}
