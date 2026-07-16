// The activation REST surface across the two auth planes. RUNTIME (/v1, the licensed app): authenticated by
// the app.ts API-key context (`req.tenant`) and gated on the `activate` scope; rate-limited (FR-013/020).
// ADMIN (/admin, operators): the shared console session + RBAC (viewer reads, admin reclaims) with CSRF on
// mutations. The machine-bound credential is returned ONLY by activate; the registry never exposes it or the
// raw signals. Errors use the project `{code,message,details?}` model; a thrown ActivationError maps to it.
import rateLimit from "@fastify/rate-limit";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type pg from "pg";
import { z } from "zod";

import { resolveApiKey } from "../../auth/apikey.js";
import { recordSecurityEvent } from "../../audit/index.js";
import { requireRole } from "../../console/rbac-middleware.js";
import { withTenant } from "../../db/client.js";
import type { Signer } from "../signing/signer.js";
import { activate, type ActivationResult } from "./activate.js";
import { deactivate } from "./deactivate.js";
import { ActivationError, type ActivationConfig } from "./index.js";
import { listActivations } from "./registry.js";

/** Max activations a registry list returns — bounded, not paginated (AD-009); seat totals stay accurate. */
const LIST_CAP = 1000;

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
const validation = (r: FastifyReply, m = "invalid request"): FastifyReply => err(r, 400, "validation_error", m);

/**
 * Run a handler, mapping a thrown ActivationError to its HTTP status; other errors propagate (→ 500). A
 * client-side denial (status < 500) is passed to `onDenied` first so the route can audit the refused attempt
 * (FR-014) — the business transaction has already rolled back, so this runs in its own fresh transaction.
 */
async function guard(
  reply: FastifyReply,
  fn: () => Promise<FastifyReply>,
  onDenied?: (e: ActivationError) => Promise<void>,
): Promise<FastifyReply> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof ActivationError) {
      if (onDenied && e.status < 500) await onDenied(e).catch(() => undefined);
      return err(reply, e.status, e.code, e.message, e.details);
    }
    throw e;
  }
}

/** Runtime preHandler: the app.ts API-key context must be present and carry the `activate` scope (FR-002). */
function requireActivateScope(req: FastifyRequest, reply: FastifyReply): boolean {
  if (!req.tenant) {
    void err(reply, 401, "unauthorized", "missing tenant context");
    return false;
  }
  if (!req.tenant.scopes.includes("activate")) {
    void err(reply, 403, "forbidden", "the activate scope is required");
    return false;
  }
  return true;
}

const signalHash = z.string().min(1).max(256);
const activateSchema = z
  .object({
    licenseId: z.string().uuid().optional(),
    licenseKey: z.string().min(1).optional(),
    fingerprint: z.object({ signals: z.array(signalHash).min(1).max(32) }),
    nonce: z.string().min(32).max(256), // single-use nonce; >= 32 chars guarantees >= 128-bit in any encoding (FR-021)
    label: z.string().max(256).optional(),
  })
  .refine((b) => Boolean(b.licenseId) !== Boolean(b.licenseKey), {
    message: "exactly one of licenseId or licenseKey is required",
  });
const activationParams = z.object({ activationId: z.string().uuid() });
const licenseParams = z.object({ licenseId: z.string().uuid() });
const reclaimParams = z.object({ licenseId: z.string().uuid(), activationId: z.string().uuid() });

function activationBody(r: ActivationResult) {
  return {
    id: r.id,
    licenseId: r.licenseId,
    machineId: r.machineId,
    status: r.status,
    activatedAt: r.activatedAt,
    seatsUsed: r.seatsUsed,
    seatLimit: r.seatLimit,
    machineBoundKey: r.machineBoundKey,
  };
}

export interface ActivationRouteDeps {
  config: ActivationConfig;
  signer: Signer | undefined;
  apiKeySecret: string;
}

/** The rate-limit key: the caller's API key (per-key limiting, FR-020), falling back to the client IP. */
function apiKeyKey(req: FastifyRequest): string {
  const raw = req.headers["x-api-key"];
  return typeof raw === "string" ? raw : req.ip;
}

/** Best-effort audit of a rate-limited request as a security event (FR-020). Never throws into the plugin. */
async function auditRateLimited(pool: pg.Pool, secret: string, req: FastifyRequest): Promise<void> {
  const raw = req.headers["x-api-key"];
  if (typeof raw !== "string") return;
  const ctx = await resolveApiKey(pool, raw, secret);
  if (!ctx) return;
  await withTenant(pool, ctx.tenantId, (q) =>
    recordSecurityEvent(q, { actor: "activation-api", action: "activation.rate_limited", target: `${req.method} ${req.url}` }),
  );
}

/** Register the /v1 runtime + /admin registry activation routes. */
export function registerActivationRoutes(app: FastifyInstance, pool: pg.Pool, deps: ActivationRouteDeps): void {
  const { config, signer } = deps;

  // --- Runtime plane (/v1): API key + activate scope + rate limit ------------------------------------
  void app.register(async (scope) => {
    await scope.register(rateLimit, {
      global: false,
      // The plugin THROWS this object, so it must carry `statusCode` for Fastify to answer 429 (not 500).
      errorResponseBuilder: (_req, ctx) => ({
        statusCode: 429,
        error: "Too Many Requests",
        code: "rate_limited",
        message: `rate limit exceeded, retry in ${Math.ceil(ctx.ttl / 1000)}s`,
      }),
      onExceeded: (req) => void auditRateLimited(pool, deps.apiKeySecret, req).catch(() => undefined),
    });
    const rl = { config: { rateLimit: { max: config.rateMax, timeWindow: config.rateWindow, keyGenerator: apiKeyKey } } };

    // Activate a machine (201 new seat / 200 drift or nonce re-use).
    scope.post("/v1/activations", rl, async (req, reply) => {
      if (!requireActivateScope(req, reply)) return reply;
      const tenantId = req.tenant!.tenantId;
      const b = activateSchema.safeParse(req.body);
      if (!b.success) return validation(reply, b.error.issues[0]?.message ?? "invalid activation payload");
      return guard(
        reply,
        async () => {
          const result = await activate(pool, signer, config, tenantId, {
            licenseId: b.data.licenseId,
            licenseKey: b.data.licenseKey,
            signals: b.data.fingerprint.signals,
            nonce: b.data.nonce,
            label: b.data.label ?? null,
          });
          const reply2 = reply.code(result.created ? 201 : 200);
          if (result.created) reply2.header("Location", `/v1/activations/${result.id}`);
          return reply2.send(activationBody(result));
        },
        // FR-014: audit every refused attempt (seat-limit, non-active license, replayed nonce, too-few
        // signals) as a security event — the reason code only, never the fingerprint/nonce.
        (e) => withTenant(pool, tenantId, (q) => recordSecurityEvent(q, { actor: "activation-api", action: "activation.denied", target: e.code })),
      );
    });

    // The app deactivates its own machine (idempotent 204; 404 unknown).
    scope.delete("/v1/activations/:activationId", rl, async (req, reply) => {
      if (!requireActivateScope(req, reply)) return reply;
      const p = activationParams.safeParse(req.params);
      if (!p.success) return validation(reply, "invalid activationId");
      return guard(reply, async () => {
        await deactivate(pool, req.tenant!.tenantId, "activation-api", p.data.activationId);
        return reply.code(204).send();
      });
    });
  });

  // --- Admin plane (/admin): console session + RBAC + CSRF -------------------------------------------
  const viewer = { preHandler: requireRole(pool, "viewer") };
  const admin = { preHandler: requireRole(pool, "admin") };

  app.get("/admin/licenses/:licenseId/activations", viewer, async (req, reply) => {
    const p = licenseParams.safeParse(req.params);
    if (!p.success) return validation(reply, "invalid licenseId");
    return guard(reply, async () => reply.code(200).send(await listActivations(pool, req.admin!.tenantId, p.data.licenseId, LIST_CAP)));
  });

  app.post("/admin/licenses/:licenseId/activations/:activationId/deactivate", admin, async (req, reply) => {
    const p = reclaimParams.safeParse(req.params);
    if (!p.success) return validation(reply, "invalid activation reference");
    return guard(reply, async () => reply.code(200).send(await deactivate(pool, req.admin!.tenantId, req.admin!.userId, p.data.activationId)));
  });
}
