// The /admin/catalog REST surface (FR-001..016). Session-cookie authenticated via the shared console
// RBAC (viewer reads, admin+ mutates); mutations carry the CSRF double-submit. camelCase bodies; errors
// are the project `{code,message}` model. A thrown CatalogError maps to its HTTP status; a Postgres
// unique violation surfaces as 409 duplicate_key (via the repositories).
import type { FastifyInstance, FastifyReply } from "fastify";
import type pg from "pg";
import { z } from "zod";

import { requireRole } from "../../console/rbac-middleware.js";
import { getEffectivePlanDefinition } from "./effective.js";
import {
  archiveEntitlement,
  createEntitlement,
  getEntitlement,
  listEntitlements,
  updateEntitlement,
} from "./entitlements.js";
import { archivePlan, createPlan, getPlan, listPlans, updatePlan } from "./plans.js";
import { archiveProduct, createProduct, getProduct, listProducts, updateProduct } from "./products.js";
import { listPlanEntitlements, removePlanEntitlementValue, setPlanEntitlementValue } from "./values.js";
import { catalogKeySchema, CatalogError, entitlementTypeSchema, statusFilterSchema } from "./validation.js";

interface ApiError {
  code: string;
  message: string;
}
function err(reply: FastifyReply, status: number, code: string, message: string): FastifyReply {
  const body: ApiError = { code, message };
  return reply.code(status).send(body);
}

/** Run a handler, mapping a thrown CatalogError to its HTTP status; other errors propagate (→ 500). */
async function guard(reply: FastifyReply, fn: () => Promise<FastifyReply>): Promise<FastifyReply> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof CatalogError) return err(reply, e.status, e.code, e.message);
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
const createEntitlementSchema = z.object({
  key: catalogKeySchema,
  name: z.string().min(1),
  type: entitlementTypeSchema,
  description: z.string().optional(),
});
const updateEntitlementSchema = z
  .object({
    name: z.string().min(1).optional(),
    description: z.string().nullable().optional(),
    type: entitlementTypeSchema.optional(),
  })
  .refine((v) => v.name !== undefined || v.description !== undefined || v.type !== undefined, {
    message: "no changes supplied",
  });
const setValueSchema = z.object({ value: z.union([z.boolean(), z.number()]) });
const listQuerySchema = z.object({ status: statusFilterSchema });

const productParams = z.object({ productId: z.string().uuid() });
const planParams = z.object({ planId: z.string().uuid() });
const entitlementParams = z.object({ entitlementId: z.string().uuid() });
const valueParams = z.object({ planId: z.string().uuid(), entitlementId: z.string().uuid() });

const V = { validation: (r: FastifyReply, m = "invalid request") => err(r, 400, "validation_error", m) };

export interface CatalogRouteConfig {
  /** Max rows a list endpoint returns (AD-009 — bounded, not paginated). */
  listCap: number;
}

/** Register the catalog routes. viewer reads, admin writes; every route runs behind requireRole. */
export function registerCatalogRoutes(app: FastifyInstance, pool: pg.Pool, config: CatalogRouteConfig): void {
  const viewer = { preHandler: requireRole(pool, "viewer") };
  const admin = { preHandler: requireRole(pool, "admin") };
  const cap = config.listCap;

  // --- Products -----------------------------------------------------------------------------------
  app.get("/admin/catalog/products", viewer, async (req, reply) => {
    const q = listQuerySchema.safeParse(req.query);
    if (!q.success) return V.validation(reply, "invalid status filter");
    const products = await listProducts(pool, req.admin!.tenantId, { status: q.data.status, cap });
    return reply.code(200).send({ products });
  });

  app.post("/admin/catalog/products", admin, async (req, reply) => {
    const b = createProductSchema.safeParse(req.body);
    if (!b.success) return V.validation(reply, "invalid product payload");
    return guard(reply, async () => {
      const p = await createProduct(pool, req.admin!.tenantId, req.admin!.userId, b.data);
      return reply.code(201).header("Location", `/admin/catalog/products/${p.id}`).send(p);
    });
  });

  app.get("/admin/catalog/products/:productId", viewer, async (req, reply) => {
    const p = productParams.safeParse(req.params);
    if (!p.success) return V.validation(reply, "invalid productId");
    const product = await getProduct(pool, req.admin!.tenantId, p.data.productId);
    return product ? reply.code(200).send(product) : err(reply, 404, "not_found", "unknown product");
  });

  app.patch("/admin/catalog/products/:productId", admin, async (req, reply) => {
    const p = productParams.safeParse(req.params);
    if (!p.success) return V.validation(reply, "invalid productId");
    const b = updateProductSchema.safeParse(req.body);
    if (!b.success) return V.validation(reply, "invalid update payload");
    return guard(reply, async () => reply.code(200).send(await updateProduct(pool, req.admin!.tenantId, req.admin!.userId, p.data.productId, b.data)));
  });

  app.post("/admin/catalog/products/:productId/archive", admin, async (req, reply) => {
    const p = productParams.safeParse(req.params);
    if (!p.success) return V.validation(reply, "invalid productId");
    return guard(reply, async () => reply.code(200).send(await archiveProduct(pool, req.admin!.tenantId, req.admin!.userId, p.data.productId)));
  });

  // --- Plans --------------------------------------------------------------------------------------
  app.get("/admin/catalog/products/:productId/plans", viewer, async (req, reply) => {
    const p = productParams.safeParse(req.params);
    if (!p.success) return V.validation(reply, "invalid productId");
    const q = listQuerySchema.safeParse(req.query);
    if (!q.success) return V.validation(reply, "invalid status filter");
    const plans = await listPlans(pool, req.admin!.tenantId, p.data.productId, { status: q.data.status, cap });
    return reply.code(200).send({ plans });
  });

  app.post("/admin/catalog/products/:productId/plans", admin, async (req, reply) => {
    const p = productParams.safeParse(req.params);
    if (!p.success) return V.validation(reply, "invalid productId");
    const b = createPlanSchema.safeParse(req.body);
    if (!b.success) return V.validation(reply, "invalid plan payload");
    return guard(reply, async () => {
      const plan = await createPlan(pool, req.admin!.tenantId, req.admin!.userId, p.data.productId, b.data);
      return reply.code(201).header("Location", `/admin/catalog/plans/${plan.id}`).send(plan);
    });
  });

  app.get("/admin/catalog/plans/:planId", viewer, async (req, reply) => {
    const p = planParams.safeParse(req.params);
    if (!p.success) return V.validation(reply, "invalid planId");
    const plan = await getPlan(pool, req.admin!.tenantId, p.data.planId);
    return plan ? reply.code(200).send(plan) : err(reply, 404, "not_found", "unknown plan");
  });

  app.patch("/admin/catalog/plans/:planId", admin, async (req, reply) => {
    const p = planParams.safeParse(req.params);
    if (!p.success) return V.validation(reply, "invalid planId");
    const b = updatePlanSchema.safeParse(req.body);
    if (!b.success) return V.validation(reply, "invalid update payload");
    return guard(reply, async () => reply.code(200).send(await updatePlan(pool, req.admin!.tenantId, req.admin!.userId, p.data.planId, b.data)));
  });

  app.post("/admin/catalog/plans/:planId/archive", admin, async (req, reply) => {
    const p = planParams.safeParse(req.params);
    if (!p.success) return V.validation(reply, "invalid planId");
    return guard(reply, async () => reply.code(200).send(await archivePlan(pool, req.admin!.tenantId, req.admin!.userId, p.data.planId)));
  });

  // --- Entitlements -------------------------------------------------------------------------------
  app.get("/admin/catalog/entitlements", viewer, async (req, reply) => {
    const q = listQuerySchema.safeParse(req.query);
    if (!q.success) return V.validation(reply, "invalid status filter");
    const entitlements = await listEntitlements(pool, req.admin!.tenantId, { status: q.data.status, cap });
    return reply.code(200).send({ entitlements });
  });

  app.post("/admin/catalog/entitlements", admin, async (req, reply) => {
    const b = createEntitlementSchema.safeParse(req.body);
    if (!b.success) return V.validation(reply, "invalid entitlement payload");
    return guard(reply, async () => {
      const e = await createEntitlement(pool, req.admin!.tenantId, req.admin!.userId, b.data);
      return reply.code(201).header("Location", `/admin/catalog/entitlements/${e.id}`).send(e);
    });
  });

  app.get("/admin/catalog/entitlements/:entitlementId", viewer, async (req, reply) => {
    const p = entitlementParams.safeParse(req.params);
    if (!p.success) return V.validation(reply, "invalid entitlementId");
    const e = await getEntitlement(pool, req.admin!.tenantId, p.data.entitlementId);
    return e ? reply.code(200).send(e) : err(reply, 404, "not_found", "unknown entitlement");
  });

  app.patch("/admin/catalog/entitlements/:entitlementId", admin, async (req, reply) => {
    const p = entitlementParams.safeParse(req.params);
    if (!p.success) return V.validation(reply, "invalid entitlementId");
    const b = updateEntitlementSchema.safeParse(req.body);
    if (!b.success) return V.validation(reply, "invalid update payload");
    return guard(reply, async () => reply.code(200).send(await updateEntitlement(pool, req.admin!.tenantId, req.admin!.userId, p.data.entitlementId, b.data)));
  });

  app.post("/admin/catalog/entitlements/:entitlementId/archive", admin, async (req, reply) => {
    const p = entitlementParams.safeParse(req.params);
    if (!p.success) return V.validation(reply, "invalid entitlementId");
    return guard(reply, async () => reply.code(200).send(await archiveEntitlement(pool, req.admin!.tenantId, req.admin!.userId, p.data.entitlementId)));
  });

  // --- Per-plan values ----------------------------------------------------------------------------
  app.get("/admin/catalog/plans/:planId/entitlements", viewer, async (req, reply) => {
    const p = planParams.safeParse(req.params);
    if (!p.success) return V.validation(reply, "invalid planId");
    return guard(reply, async () => reply.code(200).send({ entitlements: await listPlanEntitlements(pool, req.admin!.tenantId, p.data.planId) }));
  });

  app.put("/admin/catalog/plans/:planId/entitlements/:entitlementId", admin, async (req, reply) => {
    const p = valueParams.safeParse(req.params);
    if (!p.success) return V.validation(reply, "invalid plan/entitlement id");
    const b = setValueSchema.safeParse(req.body);
    if (!b.success) return V.validation(reply, "a value is required");
    return guard(reply, async () =>
      reply.code(200).send(await setPlanEntitlementValue(pool, req.admin!.tenantId, req.admin!.userId, p.data.planId, p.data.entitlementId, b.data.value)),
    );
  });

  app.delete("/admin/catalog/plans/:planId/entitlements/:entitlementId", admin, async (req, reply) => {
    const p = valueParams.safeParse(req.params);
    if (!p.success) return V.validation(reply, "invalid plan/entitlement id");
    return guard(reply, async () => {
      await removePlanEntitlementValue(pool, req.admin!.tenantId, req.admin!.userId, p.data.planId, p.data.entitlementId);
      return reply.code(204).send();
    });
  });

  // --- Effective plan definition (E008 issuance read model) ---------------------------------------
  app.get("/admin/catalog/plans/:planId/effective", viewer, async (req, reply) => {
    const p = planParams.safeParse(req.params);
    if (!p.success) return V.validation(reply, "invalid planId");
    const def = await getEffectivePlanDefinition(pool, req.admin!.tenantId, p.data.planId);
    return def ? reply.code(200).send(def) : err(reply, 404, "not_found", "unknown plan");
  });
}
