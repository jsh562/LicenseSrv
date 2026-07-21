// Billing HTTP surface (FR-001/015/017/019/020/022; AD-001/008). TWO auth planes:
//   • WEBHOOK plane — `POST /v1/billing/webhooks/:connectionId`: a provider HMAC over the RAW body (NO
//     X-API-Key / session / CSRF), rate-limited at TWO granularities and a fast `{ received, outcome }` ack.
//   • ADMIN plane — `/admin/billing/*`: the console session cookie + RBAC + double-submit CSRF on every
//     mutation (the E008/E009 admin pattern). The operator connects/updates a provider (secret WRITE-ONLY,
//     never returned), rotates the signing secret (current+prev transition window, FR-022), browses the
//     managed subscriptions + billing-event ledger (viewer, FR-012/020), and triggers on-demand
//     reconciliation (async `202 {jobId}`, FR-017). The `planMap` is app-validated against the E007 catalog
//     on create/update (an unknown/archived product/plan → `409 invalid_plan_map`). The whole admin plane is
//     itself rate-limited (a bounded per-source-IP ceiling) so a hammering flood cannot degrade the console.
// RATE LIMITING (FR-019/SC-013): the webhook plane is bounded at BOTH the per-source-IP granularity (applied
// BEFORE connection resolution / signature verification — so a flood of unknown/invalid `{connectionId}`
// values that never resolve is still shed) AND the per-resolved-connection granularity (keyed by the
// `{connectionId}` path param). An over-limit delivery on either dimension → `429 rate_limited` with a
// `Retry-After` header; a rate-limited delivery to a KNOWN connection is audited as a security event
// (fail-safe — the audit never throws into the shed path). Genuine faults surface via the project
// `{ code, message, details? }` error model; refusals/lifecycle changes on the webhook plane are INTERNAL
// (a duplicate/unmapped/disabled delivery is a 200 ack + outcome).
import { randomUUID } from "node:crypto";

import rateLimit from "@fastify/rate-limit";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import { recordSecurityEvent } from "../../audit/index.js";
import { requireRole } from "../../console/rbac-middleware.js";
import { privileged, withTenant, type TxQuery } from "../../db/client.js";
import { ConnectionRepo, type PlanMap } from "./connection-repo.js";
import type { BillingDeps } from "./index.js";
import { BillingError } from "./index.js";
import { listEvents } from "./ledger-repo.js";
import { reconcile } from "./reconcile-worker.js";
import { handleWebhook } from "./webhook.js";

/** Hard cap on a registry list (bounded, NOT paginated); a `truncated` signal flags the newest-1000 clamp. */
const LIST_CAP = 1000;
/** Canonical-UUID shape guard so a rate-limit audit never runs an invalid-syntax id through the DB. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface ApiError {
  code: string;
  message: string;
  details?: unknown;
}
function err(reply: FastifyReply, status: number, code: string, message: string, details?: unknown): FastifyReply {
  const body: ApiError = { code, message };
  if (details !== undefined) body.details = details;
  return reply.code(status).send(body);
}
const validation = (r: FastifyReply, m = "invalid request", details?: unknown): FastifyReply =>
  err(r, 400, "validation_error", m, details);

/** Run a handler, mapping a thrown BillingError to its HTTP status; other errors propagate (→ 500). */
async function guard(reply: FastifyReply, fn: () => Promise<FastifyReply>): Promise<FastifyReply> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof BillingError) return err(reply, e.status, e.code, e.message, e.details);
    throw e;
  }
}

/** The per-connection rate-limit key: the `{connectionId}` path param, falling back to the source IP. */
function connectionKey(req: FastifyRequest): string {
  const params = req.params as { connectionId?: string } | undefined;
  return params?.connectionId ?? req.ip;
}

/** The per-source-IP rate-limit key (bounds a pre-resolution flood of unknown/invalid connection ids). */
function ipKey(req: FastifyRequest): string {
  return req.ip;
}

/**
 * The shared 429 body for a shed webhook/admin delivery (FR-019). The `Retry-After` header is added by
 * @fastify/rate-limit itself (its default `addHeaders.retryAfter`); this body mirrors it in `details` so a
 * JSON-only client still sees the backoff. Carries the project `{ code, message, details }` error shape.
 */
function rateLimitBody(retryAfterSeconds: number): {
  statusCode: number;
  error: string;
  code: string;
  message: string;
  details: { retryAfterSeconds: number };
} {
  return {
    statusCode: 429,
    error: "Too Many Requests",
    code: "rate_limited",
    message: `rate limit exceeded, retry in ${retryAfterSeconds}s`,
    details: { retryAfterSeconds },
  };
}

/**
 * Audit a rate-limited WEBHOOK delivery as a security event (FR-019). Best-effort + FAIL-SAFE: it resolves
 * the `{connectionId}` → tenant via a privileged read (the same bootstrap the ingest path uses) and records a
 * tenant-scoped security event; a delivery to an UNKNOWN/invalid id (a per-IP flood that never resolves) has
 * no tenant to scope, so it is shed WITHOUT an audit row. Never throws into the rate-limit plugin.
 */
async function auditWebhookRateLimited(deps: BillingDeps, req: FastifyRequest): Promise<void> {
  const params = req.params as { connectionId?: string } | undefined;
  const connectionId = params?.connectionId;
  if (!connectionId || !UUID_RE.test(connectionId)) return; // unknown/invalid id → no tenant to scope
  const owner = await privileged(deps.pool, (q) =>
    q("SELECT tenant_id FROM billing_connection WHERE id = $1", [connectionId]),
  );
  if (!owner.rowCount) return;
  const tenantId = (owner.rows[0] as { tenant_id: string }).tenant_id;
  await withTenant(deps.pool, tenantId, (q) =>
    recordSecurityEvent(q, {
      actor: "billing-webhook",
      action: "billing.webhook.rate_limited",
      target: connectionId,
    }),
  );
}

// --- Admin request schemas (mirror contracts/billing-api.openapi.yaml) -----------------------------
const providerSchema = z.enum(["stripe", "paddle", "generic"]);
const billingStateSchema = z.enum(["active", "past_due", "grace", "canceled", "refunded"]);
const eventOutcomeSchema = z.enum(["applied", "deadletter", "rejected"]);
const planMappingSchema = z.object({ productId: z.string().uuid(), planId: z.string().uuid() }).strict();
const planMapSchema = z.record(planMappingSchema);
const graceOverridesSchema = z.record(z.number().int().positive());
const secretSchema = z.string().min(8).max(512);

const createConnectionSchema = z
  .object({
    provider: providerSchema,
    signingSecret: secretSchema,
    secretCustodyScheme: z.string().min(1).optional(),
    planMap: planMapSchema.optional(),
    defaultGraceSeconds: z.number().int().positive().optional(),
    graceOverrides: graceOverridesSchema.optional(),
  })
  .strict();

const updateConnectionSchema = z
  .object({
    status: z.enum(["active", "disabled"]).optional(),
    signingSecret: secretSchema.optional(),
    secretCustodyScheme: z.string().min(1).optional(),
    planMap: planMapSchema.optional(),
    defaultGraceSeconds: z.number().int().positive().optional(),
    graceOverrides: graceOverridesSchema.optional(),
  })
  .strict()
  .refine((o) => Object.keys(o).length > 0, { message: "at least one field is required" });

const rotateSecretSchema = z
  .object({ signingSecret: secretSchema, secretCustodyScheme: z.string().min(1).optional() })
  .strict();

const reconcileSchema = z
  .object({ connectionId: z.string().uuid().optional(), subscriptionId: z.string().uuid().optional() })
  .strict()
  .refine((o) => !(o.connectionId && o.subscriptionId), { message: "supply at most one scope" });

const connectionParams = z.object({ id: z.string().uuid() });

const subscriptionsQuerySchema = z
  .object({
    billingState: billingStateSchema.optional(),
    provider: providerSchema.optional(),
    licenseId: z.string().uuid().optional(),
  })
  .strict();

const eventsQuerySchema = z
  .object({
    outcome: eventOutcomeSchema.optional(),
    subscriptionId: z.string().uuid().optional(),
    provider: providerSchema.optional(),
  })
  .strict();

/** One row of the managed-subscription registry (contract `SubscriptionSummary`); no secret / card / PII. */
interface SubscriptionSummary {
  id: string;
  provider: string;
  externalSubscriptionId: string;
  licenseId: string;
  licenseStatus: string | null;
  billingState: string;
  graceExpiresAt: string | null;
  lastAppliedEventAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface SubscriptionSummaryRow {
  id: string;
  provider: string;
  external_subscription_id: string;
  license_id: string;
  license_status: string | null;
  billing_state: string;
  grace_expires_at: Date | null;
  last_applied_event_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

/**
 * List the tenant's managed subscriptions joined to their E008 license status (FR-012). Deterministic order
 * (`created_at DESC, id DESC`); fetches `LIST_CAP + 1` so the caller can flag the newest-1000 truncation.
 * Tenant-scoped by the caller's `withTenant` (RLS, FR-014). Reads only pseudonymous provider/license ids.
 */
async function listSubscriptionSummaries(
  q: TxQuery,
  filters: z.infer<typeof subscriptionsQuerySchema>,
): Promise<SubscriptionSummary[]> {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (filters.billingState) {
    params.push(filters.billingState);
    clauses.push(`s.billing_state = $${params.length}`);
  }
  if (filters.provider) {
    params.push(filters.provider);
    clauses.push(`s.provider = $${params.length}`);
  }
  if (filters.licenseId) {
    params.push(filters.licenseId);
    clauses.push(`s.license_id = $${params.length}`);
  }
  params.push(LIST_CAP + 1);
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const r = await q(
    `SELECT s.id, s.provider, s.external_subscription_id, s.license_id, l.status AS license_status,
            s.billing_state, s.grace_expires_at, s.last_applied_event_at, s.created_at, s.updated_at
       FROM subscription s
       LEFT JOIN license l ON l.id = s.license_id
      ${where}
      ORDER BY s.created_at DESC, s.id DESC
      LIMIT $${params.length}`,
    params,
  );
  return (r.rows as SubscriptionSummaryRow[]).map((row) => ({
    id: row.id,
    provider: row.provider,
    externalSubscriptionId: row.external_subscription_id,
    licenseId: row.license_id,
    licenseStatus: row.license_status,
    billingState: row.billing_state,
    graceExpiresAt: row.grace_expires_at ? row.grace_expires_at.toISOString() : null,
    lastAppliedEventAt: row.last_applied_event_at ? row.last_applied_event_at.toISOString() : null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  }));
}

/**
 * Validate a plan map against the E007 catalog (FR-005/015). Each provider plan key must map to a product/
 * plan that resolves to an ACTIVE catalog plan owned by the same product; else a `409 invalid_plan_map`
 * carrying `{ planKey, reason }` (`unknown_plan` | `unknown_product` | `archived_plan`). An empty map is valid.
 */
async function validatePlanMap(deps: BillingDeps, tenantId: string, planMap: PlanMap): Promise<void> {
  for (const [planKey, mapping] of Object.entries(planMap)) {
    const eff = await deps.effective(deps.pool, tenantId, mapping.planId);
    if (!eff) {
      throw new BillingError("invalid_plan_map", 409, "planMap references an unknown plan", { planKey, reason: "unknown_plan" });
    }
    if (eff.productId !== mapping.productId) {
      throw new BillingError("invalid_plan_map", 409, "planMap references the wrong product for the plan", {
        planKey,
        reason: "unknown_product",
      });
    }
    if (eff.planStatus === "archived") {
      throw new BillingError("invalid_plan_map", 409, "planMap references an archived plan", { planKey, reason: "archived_plan" });
    }
  }
}

/**
 * Register the billing HTTP surface. Both planes are encapsulated Fastify scopes with their own
 * @fastify/rate-limit registration (fail-safe, non-leaking): the webhook scope layers a per-source-IP limit
 * (pre-resolution flood guard) UNDER a per-connection limit; the admin scope carries a bounded per-IP limit
 * behind `requireRole` + CSRF. The reconcile route reads `deps.providerFetch` live (injectable), so it uses a
 * real adapter in production and a test-injected stub via `app.billing`.
 */
export function registerBillingRoutes(app: FastifyInstance, deps: BillingDeps): void {
  const repo = new ConnectionRepo(deps.pool, deps.custody, deps.config);
  const admin = { preHandler: requireRole(deps.pool, "admin") };
  const viewer = { preHandler: requireRole(deps.pool, "viewer") };

  // --- WEBHOOK plane (US1) — provider HMAC; rate-limited per-IP (pre-resolution) AND per-connection -------
  void app.register(async (scope) => {
    // Per-SOURCE-IP limit FIRST (FR-019/SC-013): keyed by `req.ip`, applied as an onRequest hook BEFORE the
    // route handler resolves/verifies anything — so a flood of unknown/invalid `{connectionId}` values that
    // never resolve is still bounded (a per-connection key cannot bound an id that resolves to nothing).
    await scope.register(rateLimit, {
      global: true,
      max: deps.config.webhookRateMaxPerIp,
      timeWindow: deps.config.webhookRateWindow,
      keyGenerator: ipKey,
      errorResponseBuilder: (_req, ctx) => rateLimitBody(Math.max(1, Math.ceil(ctx.ttl / 1000))),
      onExceeded: (req) => void auditWebhookRateLimited(deps, req).catch(() => undefined),
    });
    // Per-RESOLVED-CONNECTION limit: keyed by the `{connectionId}` path param — absorbs a single provider's
    // retry storm without letting one connection exhaust another's (or the whole IP's) budget.
    await scope.register(rateLimit, {
      global: true,
      max: deps.config.webhookRateMaxPerConnection,
      timeWindow: deps.config.webhookRateWindow,
      keyGenerator: connectionKey,
      errorResponseBuilder: (_req, ctx) => rateLimitBody(Math.max(1, Math.ceil(ctx.ttl / 1000))),
      onExceeded: (req) => void auditWebhookRateLimited(deps, req).catch(() => undefined),
    });

    scope.post("/v1/billing/webhooks/:connectionId", async (req, reply): Promise<FastifyReply> => {
      const connectionId = (req.params as { connectionId: string }).connectionId;
      const rawBody = req.rawBody ?? Buffer.alloc(0);
      try {
        const result = await handleWebhook(deps, { connectionId, rawBody, headers: req.headers });
        return reply.code(200).send({ received: true, outcome: result.outcome });
      } catch (e) {
        if (e instanceof BillingError) return err(reply, e.status, e.code, e.message, e.details);
        throw e;
      }
    });
  });

  // --- ADMIN plane (US5/US6 + registries) — session + RBAC + CSRF, itself rate-limited -------------------
  void app.register(async (adminScope) => {
    // A bounded per-source-IP ceiling on the operator plane (FR-019). Session + RBAC + CSRF are the primary
    // control; this sheds a hammering/credential-stuffing flood with a `429 rate_limited` + `Retry-After`.
    await adminScope.register(rateLimit, {
      global: true,
      max: deps.config.webhookRateMaxPerIp,
      timeWindow: deps.config.webhookRateWindow,
      keyGenerator: ipKey,
      errorResponseBuilder: (_req, ctx) => rateLimitBody(Math.max(1, Math.ceil(ctx.ttl / 1000))),
    });

    // --- provider connections (US5) — RBAC admin + CSRF -------------------------------------------------
    adminScope.get("/admin/billing/connections", admin, async (req, reply) => {
      const connections = await repo.list(req.admin!.tenantId);
      return reply.code(200).send({ connections });
    });

    adminScope.post("/admin/billing/connections", admin, async (req, reply) => {
      const b = createConnectionSchema.safeParse(req.body);
      if (!b.success) return validation(reply, "invalid connection payload");
      return guard(reply, async () => {
        await validatePlanMap(deps, req.admin!.tenantId, b.data.planMap ?? {});
        const conn = await repo.create(req.admin!.tenantId, req.admin!.userId, b.data);
        return reply.code(201).header("Location", `/admin/billing/connections/${conn.id}`).send(conn);
      });
    });

    adminScope.patch("/admin/billing/connections/:id", admin, async (req, reply) => {
      const p = connectionParams.safeParse(req.params);
      if (!p.success) return validation(reply, "invalid connection id");
      const b = updateConnectionSchema.safeParse(req.body);
      if (!b.success) return validation(reply, "invalid connection update");
      return guard(reply, async () => {
        if (b.data.planMap !== undefined) await validatePlanMap(deps, req.admin!.tenantId, b.data.planMap);
        const conn = await repo.update(req.admin!.tenantId, req.admin!.userId, p.data.id, b.data);
        return reply.code(200).send(conn);
      });
    });

    adminScope.post("/admin/billing/connections/:id/rotate-secret", admin, async (req, reply) => {
      const p = connectionParams.safeParse(req.params);
      if (!p.success) return validation(reply, "invalid connection id");
      const b = rotateSecretSchema.safeParse(req.body);
      if (!b.success) return validation(reply, "a new signingSecret is required");
      return guard(reply, async () => {
        const conn = await repo.rotateSecret(req.admin!.tenantId, req.admin!.userId, p.data.id, b.data.signingSecret);
        return reply.code(200).send(conn);
      });
    });

    // --- registry reads (US6/FR-012/020) — RBAC viewer, deterministic order + truncation signal ----------
    adminScope.get("/admin/billing/subscriptions", viewer, async (req, reply) => {
      const qy = subscriptionsQuerySchema.safeParse(req.query ?? {});
      if (!qy.success) return validation(reply, "invalid subscription filter");
      const rows = await withTenant(deps.pool, req.admin!.tenantId, (q) => listSubscriptionSummaries(q, qy.data));
      const truncated = rows.length > LIST_CAP;
      return reply
        .code(200)
        .send({ subscriptions: truncated ? rows.slice(0, LIST_CAP) : rows, ...(truncated ? { truncated: true } : {}) });
    });

    adminScope.get("/admin/billing/events", viewer, async (req, reply) => {
      const qy = eventsQuerySchema.safeParse(req.query ?? {});
      if (!qy.success) return validation(reply, "invalid event filter");
      const rows = await withTenant(deps.pool, req.admin!.tenantId, (q) => listEvents(q, { ...qy.data, cap: LIST_CAP + 1 }));
      const truncated = rows.length > LIST_CAP;
      return reply
        .code(200)
        .send({ events: truncated ? rows.slice(0, LIST_CAP) : rows, ...(truncated ? { truncated: true } : {}) });
    });

    // --- reconciliation (US6) — async 202 {jobId}, correlation-only -------------------------------------
    adminScope.post("/admin/billing/reconcile", admin, async (req, reply) => {
      const b = reconcileSchema.safeParse(req.body ?? {});
      if (!b.success) return validation(reply, "invalid reconcile scope");
      const tenantId = req.admin!.tenantId;
      return guard(reply, async () => {
        // Resolve + verify the scope exists in the session tenant BEFORE acking (404 on an unknown scope).
        if (b.data.connectionId) {
          const conn = await repo.get(tenantId, b.data.connectionId);
          if (!conn) return err(reply, 404, "not_found", "unknown connection", { connectionId: b.data.connectionId });
        }
        if (b.data.subscriptionId) {
          const exists = await subscriptionExists(deps, tenantId, b.data.subscriptionId);
          if (!exists) return err(reply, 404, "not_found", "unknown subscription", { subscriptionId: b.data.subscriptionId });
        }
        const jobId = randomUUID();
        const scopeLabel = b.data.subscriptionId ? "subscription" : b.data.connectionId ? "connection" : "tenant";
        // Fire-and-forget, fail-open: reconciliation runs in a decoupled worker and never blocks the ack. The
        // jobId is correlation-only (NOT pollable); corrections surface via the subscription/event registries.
        void reconcile(
          deps,
          deps.providerFetch,
          { tenantId, connectionId: b.data.connectionId, subscriptionId: b.data.subscriptionId },
          { jobId, logger: adminScope.log },
        ).catch((e: unknown) => adminScope.log.warn({ error: e instanceof Error ? e.message : String(e) }, "reconcile job failed (fail-open)"));
        return reply.code(202).send({ jobId, status: "accepted", scope: scopeLabel });
      });
    });
  });
}

/** Does a subscription id resolve within the session tenant? (RLS-scoped existence check for the 404 gate.) */
function subscriptionExists(deps: BillingDeps, tenantId: string, subscriptionId: string): Promise<boolean> {
  return withTenant(deps.pool, tenantId, async (q) => {
    const r = await q("SELECT 1 FROM subscription WHERE id = $1", [subscriptionId]);
    return Boolean(r.rowCount);
  });
}
