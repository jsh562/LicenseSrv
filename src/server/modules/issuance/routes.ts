// The /admin licensing REST surface (FR-001..016). Session-cookie authenticated via the shared console
// RBAC (viewer reads, admin+ mutates); mutations carry the CSRF double-submit. camelCase; `{code,message}`
// errors. The signed license key (public LIC1 token) is returned only by issue + GET .../key; the signing
// key is never returned. A thrown IssuanceError maps to its HTTP status.
import type { FastifyInstance, FastifyReply } from "fastify";
import type pg from "pg";
import { z } from "zod";

import { requireRole } from "../../console/rbac-middleware.js";
import type { Signer } from "../signing/signer.js";
import { createCustomer, eraseCustomer, getCustomer, listCustomers } from "./customers.js";
import { IssuanceConfig, IssuanceError } from "./index.js";
import { getLicense, getLicenseKey, issueLicense, listLicenses } from "./licenses.js";
import { reinstateLicense, revokeLicense, suspendLicense, transferLicense } from "./lifecycle.js";

/** Max rows a list endpoint returns — bounded, not paginated (AD-009). */
const LIST_CAP = 1000;

interface ApiError {
  code: string;
  message: string;
}
function err(reply: FastifyReply, status: number, code: string, message: string): FastifyReply {
  const body: ApiError = { code, message };
  return reply.code(status).send(body);
}
const validation = (r: FastifyReply, m = "invalid request"): FastifyReply => err(r, 400, "validation_error", m);

/** Run a handler, mapping a thrown IssuanceError to its HTTP status; other errors propagate (→ 500). */
async function guard(reply: FastifyReply, fn: () => Promise<FastifyReply>): Promise<FastifyReply> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof IssuanceError) return err(reply, e.status, e.code, e.message);
    throw e;
  }
}

const createCustomerSchema = z.object({ ref: z.string().min(1).max(128), name: z.string().max(256).optional(), email: z.string().email().max(256).optional() });
const issueSchema = z.object({ planId: z.string().uuid(), customerId: z.string().uuid(), expiresAt: z.string().datetime().nullable().optional() });
const transferSchema = z.object({ customerId: z.string().uuid() });
const licenseStatusSchema = z.enum(["active", "suspended", "revoked"]);
const listLicenseQuery = z.object({ status: licenseStatusSchema.optional(), customerId: z.string().uuid().optional(), planId: z.string().uuid().optional() });
const customerParams = z.object({ customerId: z.string().uuid() });
const licenseParams = z.object({ licenseId: z.string().uuid() });

export interface IssuanceRouteDeps {
  config: IssuanceConfig;
  signer: Signer | undefined;
}

/** Register the /admin licensing routes. viewer reads, admin writes; every route behind requireRole. */
export function registerIssuanceRoutes(app: FastifyInstance, pool: pg.Pool, deps: IssuanceRouteDeps): void {
  const viewer = { preHandler: requireRole(pool, "viewer") };
  const admin = { preHandler: requireRole(pool, "admin") };

  // --- Customers ----------------------------------------------------------------------------------
  app.get("/admin/customers", viewer, async (req, reply) => {
    return reply.code(200).send({ customers: await listCustomers(pool, req.admin!.tenantId, LIST_CAP) });
  });

  app.post("/admin/customers", admin, async (req, reply) => {
    const b = createCustomerSchema.safeParse(req.body);
    if (!b.success) return validation(reply, "invalid customer payload");
    return guard(reply, async () => {
      const c = await createCustomer(pool, req.admin!.tenantId, req.admin!.userId, b.data);
      return reply.code(201).header("Location", `/admin/customers/${c.id}`).send(c);
    });
  });

  app.get("/admin/customers/:customerId", viewer, async (req, reply) => {
    const p = customerParams.safeParse(req.params);
    if (!p.success) return validation(reply, "invalid customerId");
    const c = await getCustomer(pool, req.admin!.tenantId, p.data.customerId);
    return c ? reply.code(200).send(c) : err(reply, 404, "not_found", "unknown customer");
  });

  app.delete("/admin/customers/:customerId", admin, async (req, reply) => {
    const p = customerParams.safeParse(req.params);
    if (!p.success) return validation(reply, "invalid customerId");
    return guard(reply, async () => {
      await eraseCustomer(pool, req.admin!.tenantId, req.admin!.userId, p.data.customerId);
      return reply.code(204).send();
    });
  });

  // --- Licenses -----------------------------------------------------------------------------------
  app.post("/admin/licenses", admin, async (req, reply) => {
    const b = issueSchema.safeParse(req.body);
    if (!b.success) return validation(reply, "invalid issue payload");
    return guard(reply, async () => {
      // E017 (FR-008): thread the issuance-path policy seam (published by registerPolicy, which runs later in the
      // module list but is decorated before requests) so the effective definition is rule-adjusted BEFORE signing.
      const policy = app.policy ? { evaluate: app.policy.evaluate } : undefined;
      const license = await issueLicense(pool, deps.signer, req.admin!.tenantId, req.admin!.userId, b.data, undefined, policy);
      return reply.code(201).header("Location", `/admin/licenses/${license.id}`).send(license);
    });
  });

  app.get("/admin/licenses", viewer, async (req, reply) => {
    const q = listLicenseQuery.safeParse(req.query);
    if (!q.success) return validation(reply, "invalid license filters");
    const licenses = await listLicenses(pool, req.admin!.tenantId, { ...q.data, cap: LIST_CAP });
    return reply.code(200).send({ licenses });
  });

  app.get("/admin/licenses/:licenseId", viewer, async (req, reply) => {
    const p = licenseParams.safeParse(req.params);
    if (!p.success) return validation(reply, "invalid licenseId");
    const license = await getLicense(pool, req.admin!.tenantId, p.data.licenseId);
    return license ? reply.code(200).send(license) : err(reply, 404, "not_found", "unknown license");
  });

  app.get("/admin/licenses/:licenseId/key", viewer, async (req, reply) => {
    const p = licenseParams.safeParse(req.params);
    if (!p.success) return validation(reply, "invalid licenseId");
    const key = await getLicenseKey(pool, req.admin!.tenantId, p.data.licenseId);
    return key ? reply.code(200).send({ licenseKey: key }) : err(reply, 404, "not_found", "unknown license");
  });

  // --- Lifecycle ----------------------------------------------------------------------------------
  const lifecycle = (action: string, fn: (id: string, a: { tenantId: string; userId: string }) => Promise<unknown>) =>
    app.post(`/admin/licenses/:licenseId/${action}`, admin, async (req, reply) => {
      const p = licenseParams.safeParse(req.params);
      if (!p.success) return validation(reply, "invalid licenseId");
      return guard(reply, async () => reply.code(200).send(await fn(p.data.licenseId, req.admin!)));
    });

  lifecycle("revoke", (id, a) => revokeLicense(pool, a.tenantId, a.userId, id));
  lifecycle("suspend", (id, a) => suspendLicense(pool, a.tenantId, a.userId, id));
  lifecycle("reinstate", (id, a) => reinstateLicense(pool, a.tenantId, a.userId, id));

  app.post("/admin/licenses/:licenseId/transfer", admin, async (req, reply) => {
    const p = licenseParams.safeParse(req.params);
    if (!p.success) return validation(reply, "invalid licenseId");
    const b = transferSchema.safeParse(req.body);
    if (!b.success) return validation(reply, "a target customerId is required");
    return guard(reply, async () =>
      reply.code(200).send(await transferLicense(pool, req.admin!.tenantId, req.admin!.userId, p.data.licenseId, deps.config.transferLimit, b.data.customerId)),
    );
  });
}
