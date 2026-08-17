import { z } from "zod";
import { requireRole } from "../../console/rbac-middleware.js";
import { getEffectivePlanDefinition } from "./effective.js";
import { archiveEntitlement, createEntitlement, getEntitlement, listEntitlements, setEntitlementRuleBounds, updateEntitlement, } from "./entitlements.js";
import { archivePlan, createPlan, getPlan, listPlans, updatePlan } from "./plans.js";
import { archiveProduct, createProduct, getProduct, listProducts, updateProduct } from "./products.js";
import { listPlanEntitlements, removePlanEntitlementValue, setPlanEntitlementValue } from "./values.js";
import { catalogKeySchema, CatalogError, meteredAggregationSchema, statusFilterSchema } from "./validation.js";
function err(reply, status, code, message) {
    const body = { code, message };
    return reply.code(status).send(body);
}
/** Run a handler, mapping a thrown CatalogError to its HTTP status; other errors propagate (→ 500). */
async function guard(reply, fn) {
    try {
        return await fn();
    }
    catch (e) {
        if (e instanceof CatalogError)
            return err(reply, e.status, e.code, e.message);
        throw e;
    }
}
const createProductSchema = z.object({ key: catalogKeySchema, name: z.string().min(1), description: z.string().optional() });
const updateProductSchema = z
    .object({ name: z.string().min(1).optional(), description: z.string().nullable().optional() })
    .refine((v) => v.name !== undefined || v.description !== undefined, { message: "no changes supplied" });
const createPlanSchema = z.object({
    key: catalogKeySchema,
    name: z.string().min(1),
    description: z.string().optional(),
    maxActivations: z.number().int().positive().optional(),
});
const updatePlanSchema = z
    .object({
    name: z.string().min(1).optional(),
    description: z.string().nullable().optional(),
    maxActivations: z.number().int().positive().optional(),
})
    .refine((v) => v.name !== undefined || v.description !== undefined || v.maxActivations !== undefined, {
    message: "no changes supplied",
});
// The `type`/kind the HTTP layer admits: the E007 boolean/integer_limit PLUS the additive E016 `metered` kind
// (FR-008). A metered create/edit carries the metered-only fields; `entitlements.ts:assertMeteredShape` is the
// authoritative validator (counter-only aggregation, non-empty unit, non-negative allowance) — the route schema
// only shape-guards so a malformed metered body is a 400 before it reaches the repository.
const entitlementKindSchema = z.enum(["boolean", "integer_limit", "metered"]);
const createEntitlementSchema = z.object({
    key: catalogKeySchema,
    name: z.string().min(1),
    type: entitlementKindSchema,
    description: z.string().optional(),
    // Metered-only (FR-008): present for `type: "metered"`; ignored for boolean/integer_limit. A gauge/peak
    // aggregation is refused here (enum), a missing unit is refused downstream by assertMeteredShape (400).
    aggregation: meteredAggregationSchema.optional(),
    unit: z.string().min(1).optional(),
    allowance: z.number().nonnegative().optional(),
});
const updateEntitlementSchema = z
    .object({
    name: z.string().min(1).optional(),
    description: z.string().nullable().optional(),
    type: entitlementKindSchema.optional(),
    // Metered-only edits (FR-009 freeze-on-usage is enforced in entitlements.ts once usage exists).
    aggregation: meteredAggregationSchema.optional(),
    unit: z.string().min(1).optional(),
    allowance: z.number().nonnegative().nullable().optional(),
})
    .refine((v) => v.name !== undefined ||
    v.description !== undefined ||
    v.type !== undefined ||
    v.aggregation !== undefined ||
    v.unit !== undefined ||
    v.allowance !== undefined, { message: "no changes supplied" });
// E017 authored-max governance (FR-021, AD-003, INV-4): the admin-only, CSRF-protected, audited surface that
// sets/raises the per-entitlement rule bound the issuance-time policy applier clamps to — `rule_max` (the
// adjust_limit ceiling), `rule_eligible` (the toggle_boolean gate), and `rule_tiers` (the select_tier options).
// The route only shape-guards; `entitlements.ts:setEntitlementRuleBounds` (via `assertRuleBounds`) is the
// authoritative validator — an out-of-range `rule_max` (< the base plan value or > the configured absolute cap)
// is a 400 `validation_error` there, so the ceiling can never be raised arbitrarily to defeat the bound.
const ruleBoundsSchema = z
    .object({
    ruleMax: z.number().nullable().optional(),
    ruleEligible: z.boolean().optional(),
    ruleTiers: z.array(z.unknown()).nullable().optional(),
})
    .refine((v) => v.ruleMax !== undefined || v.ruleEligible !== undefined || v.ruleTiers !== undefined, {
    message: "no rule bounds supplied",
});
const setValueSchema = z.object({ value: z.union([z.boolean(), z.number()]) });
const listQuerySchema = z.object({ status: statusFilterSchema });
const productParams = z.object({ productId: z.string().uuid() });
const planParams = z.object({ planId: z.string().uuid() });
const entitlementParams = z.object({ entitlementId: z.string().uuid() });
const valueParams = z.object({ planId: z.string().uuid(), entitlementId: z.string().uuid() });
const V = { validation: (r, m = "invalid request") => err(r, 400, "validation_error", m) };
/** Register the catalog routes. viewer reads, admin writes; every route runs behind requireRole. */
export function registerCatalogRoutes(app, pool, config) {
    const viewer = { preHandler: requireRole(pool, "viewer") };
    const admin = { preHandler: requireRole(pool, "admin") };
    const cap = config.listCap;
    const absoluteMax = config.policyAbsoluteMaxLimit;
    // --- Products -----------------------------------------------------------------------------------
    app.get("/admin/catalog/products", viewer, async (req, reply) => {
        const q = listQuerySchema.safeParse(req.query);
        if (!q.success)
            return V.validation(reply, "invalid status filter");
        const products = await listProducts(pool, req.admin.tenantId, { status: q.data.status, cap });
        return reply.code(200).send({ products });
    });
    app.post("/admin/catalog/products", admin, async (req, reply) => {
        const b = createProductSchema.safeParse(req.body);
        if (!b.success)
            return V.validation(reply, "invalid product payload");
        return guard(reply, async () => {
            const p = await createProduct(pool, req.admin.tenantId, req.admin.userId, b.data);
            return reply.code(201).header("Location", `/admin/catalog/products/${p.id}`).send(p);
        });
    });
    app.get("/admin/catalog/products/:productId", viewer, async (req, reply) => {
        const p = productParams.safeParse(req.params);
        if (!p.success)
            return V.validation(reply, "invalid productId");
        const product = await getProduct(pool, req.admin.tenantId, p.data.productId);
        return product ? reply.code(200).send(product) : err(reply, 404, "not_found", "unknown product");
    });
    app.patch("/admin/catalog/products/:productId", admin, async (req, reply) => {
        const p = productParams.safeParse(req.params);
        if (!p.success)
            return V.validation(reply, "invalid productId");
        const b = updateProductSchema.safeParse(req.body);
        if (!b.success)
            return V.validation(reply, "invalid update payload");
        return guard(reply, async () => reply.code(200).send(await updateProduct(pool, req.admin.tenantId, req.admin.userId, p.data.productId, b.data)));
    });
    app.post("/admin/catalog/products/:productId/archive", admin, async (req, reply) => {
        const p = productParams.safeParse(req.params);
        if (!p.success)
            return V.validation(reply, "invalid productId");
        return guard(reply, async () => reply.code(200).send(await archiveProduct(pool, req.admin.tenantId, req.admin.userId, p.data.productId)));
    });
    // --- Plans --------------------------------------------------------------------------------------
    app.get("/admin/catalog/products/:productId/plans", viewer, async (req, reply) => {
        const p = productParams.safeParse(req.params);
        if (!p.success)
            return V.validation(reply, "invalid productId");
        const q = listQuerySchema.safeParse(req.query);
        if (!q.success)
            return V.validation(reply, "invalid status filter");
        const plans = await listPlans(pool, req.admin.tenantId, p.data.productId, { status: q.data.status, cap });
        return reply.code(200).send({ plans });
    });
    app.post("/admin/catalog/products/:productId/plans", admin, async (req, reply) => {
        const p = productParams.safeParse(req.params);
        if (!p.success)
            return V.validation(reply, "invalid productId");
        const b = createPlanSchema.safeParse(req.body);
        if (!b.success)
            return V.validation(reply, "invalid plan payload");
        return guard(reply, async () => {
            const plan = await createPlan(pool, req.admin.tenantId, req.admin.userId, p.data.productId, b.data);
            return reply.code(201).header("Location", `/admin/catalog/plans/${plan.id}`).send(plan);
        });
    });
    app.get("/admin/catalog/plans/:planId", viewer, async (req, reply) => {
        const p = planParams.safeParse(req.params);
        if (!p.success)
            return V.validation(reply, "invalid planId");
        const plan = await getPlan(pool, req.admin.tenantId, p.data.planId);
        return plan ? reply.code(200).send(plan) : err(reply, 404, "not_found", "unknown plan");
    });
    app.patch("/admin/catalog/plans/:planId", admin, async (req, reply) => {
        const p = planParams.safeParse(req.params);
        if (!p.success)
            return V.validation(reply, "invalid planId");
        const b = updatePlanSchema.safeParse(req.body);
        if (!b.success)
            return V.validation(reply, "invalid update payload");
        return guard(reply, async () => reply.code(200).send(await updatePlan(pool, req.admin.tenantId, req.admin.userId, p.data.planId, b.data)));
    });
    app.post("/admin/catalog/plans/:planId/archive", admin, async (req, reply) => {
        const p = planParams.safeParse(req.params);
        if (!p.success)
            return V.validation(reply, "invalid planId");
        return guard(reply, async () => reply.code(200).send(await archivePlan(pool, req.admin.tenantId, req.admin.userId, p.data.planId)));
    });
    // --- Entitlements -------------------------------------------------------------------------------
    app.get("/admin/catalog/entitlements", viewer, async (req, reply) => {
        const q = listQuerySchema.safeParse(req.query);
        if (!q.success)
            return V.validation(reply, "invalid status filter");
        const entitlements = await listEntitlements(pool, req.admin.tenantId, { status: q.data.status, cap });
        return reply.code(200).send({ entitlements });
    });
    app.post("/admin/catalog/entitlements", admin, async (req, reply) => {
        const b = createEntitlementSchema.safeParse(req.body);
        if (!b.success)
            return V.validation(reply, "invalid entitlement payload");
        return guard(reply, async () => {
            const e = await createEntitlement(pool, req.admin.tenantId, req.admin.userId, b.data);
            return reply.code(201).header("Location", `/admin/catalog/entitlements/${e.id}`).send(e);
        });
    });
    app.get("/admin/catalog/entitlements/:entitlementId", viewer, async (req, reply) => {
        const p = entitlementParams.safeParse(req.params);
        if (!p.success)
            return V.validation(reply, "invalid entitlementId");
        const e = await getEntitlement(pool, req.admin.tenantId, p.data.entitlementId);
        return e ? reply.code(200).send(e) : err(reply, 404, "not_found", "unknown entitlement");
    });
    app.patch("/admin/catalog/entitlements/:entitlementId", admin, async (req, reply) => {
        const p = entitlementParams.safeParse(req.params);
        if (!p.success)
            return V.validation(reply, "invalid entitlementId");
        const b = updateEntitlementSchema.safeParse(req.body);
        if (!b.success)
            return V.validation(reply, "invalid update payload");
        return guard(reply, async () => reply.code(200).send(await updateEntitlement(pool, req.admin.tenantId, req.admin.userId, p.data.entitlementId, b.data)));
    });
    app.post("/admin/catalog/entitlements/:entitlementId/archive", admin, async (req, reply) => {
        const p = entitlementParams.safeParse(req.params);
        if (!p.success)
            return V.validation(reply, "invalid entitlementId");
        return guard(reply, async () => reply.code(200).send(await archiveEntitlement(pool, req.admin.tenantId, req.admin.userId, p.data.entitlementId)));
    });
    // Set/raise the E017 authored rule bound (FR-021, SC-019): admin-only (requireRole "admin") + CSRF (both via
    // the shared preHandler) + audited (setEntitlementRuleBounds writes `catalog.entitlement.rule_bounds_set`). A
    // viewer is refused 403 by requireRole; `rule_max` < the base plan value or > the configured absolute cap is a
    // 400 `validation_error` from `setEntitlementRuleBounds` (via assertRuleBounds), so the ceiling can never be
    // raised arbitrarily to defeat the effect bound. Partial-update merge — an omitted field keeps its value.
    app.put("/admin/catalog/entitlements/:entitlementId/rule-bounds", admin, async (req, reply) => {
        const p = entitlementParams.safeParse(req.params);
        if (!p.success)
            return V.validation(reply, "invalid entitlementId");
        const b = ruleBoundsSchema.safeParse(req.body);
        if (!b.success)
            return V.validation(reply, "invalid rule bounds payload");
        return guard(reply, async () => reply.code(200).send(await setEntitlementRuleBounds(pool, req.admin.tenantId, req.admin.userId, p.data.entitlementId, b.data, absoluteMax)));
    });
    // --- Per-plan values ----------------------------------------------------------------------------
    app.get("/admin/catalog/plans/:planId/entitlements", viewer, async (req, reply) => {
        const p = planParams.safeParse(req.params);
        if (!p.success)
            return V.validation(reply, "invalid planId");
        return guard(reply, async () => reply.code(200).send({ entitlements: await listPlanEntitlements(pool, req.admin.tenantId, p.data.planId) }));
    });
    app.put("/admin/catalog/plans/:planId/entitlements/:entitlementId", admin, async (req, reply) => {
        const p = valueParams.safeParse(req.params);
        if (!p.success)
            return V.validation(reply, "invalid plan/entitlement id");
        const b = setValueSchema.safeParse(req.body);
        if (!b.success)
            return V.validation(reply, "a value is required");
        return guard(reply, async () => reply.code(200).send(await setPlanEntitlementValue(pool, req.admin.tenantId, req.admin.userId, p.data.planId, p.data.entitlementId, b.data.value)));
    });
    app.delete("/admin/catalog/plans/:planId/entitlements/:entitlementId", admin, async (req, reply) => {
        const p = valueParams.safeParse(req.params);
        if (!p.success)
            return V.validation(reply, "invalid plan/entitlement id");
        return guard(reply, async () => {
            await removePlanEntitlementValue(pool, req.admin.tenantId, req.admin.userId, p.data.planId, p.data.entitlementId);
            return reply.code(204).send();
        });
    });
    // --- Effective plan definition (E008 issuance read model) ---------------------------------------
    app.get("/admin/catalog/plans/:planId/effective", viewer, async (req, reply) => {
        const p = planParams.safeParse(req.params);
        if (!p.success)
            return V.validation(reply, "invalid planId");
        const def = await getEffectivePlanDefinition(pool, req.admin.tenantId, p.data.planId);
        return def ? reply.code(200).send(def) : err(reply, 404, "not_found", "unknown plan");
    });
}
