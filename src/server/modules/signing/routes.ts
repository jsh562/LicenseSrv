// The signing key-management + public-keyring REST surface (TR-004/005/007/008/009). There is NO
// /sign endpoint — signing is the in-process Signer. Every route is tenant-scoped via the API-key
// context (app.ts). Mutations require the `admin` scope; reads accept any valid tenant key. Errors
// use the project Error { code, message, details } model. No response ever carries private material.
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type pg from "pg";
import { z } from "zod";

import { withTenant } from "../../db/client.js";
import type { SigningModule } from "./index.js";
import { buildKeyring } from "./keyring.js";
import { listKeys, provisionKey } from "./registry.js";
import { revokeKey, rotateKey } from "./rotation.js";

const ACTOR = "signing-api";
const paramsSchema = z.object({ productId: z.string().uuid() });
const revokeParamsSchema = z.object({ productId: z.string().uuid(), keyId: z.string().min(1) });

interface ApiError {
  code: string;
  message: string;
  details?: unknown;
}
function err(reply: FastifyReply, status: number, code: string, message: string): FastifyReply {
  const body: ApiError = { code, message };
  return reply.code(status).send(body);
}

/** True if the caller holds the `admin` scope (mutations). Sends 403 and returns false otherwise. */
function requireAdmin(req: FastifyRequest, reply: FastifyReply): boolean {
  if (!req.tenant) {
    void err(reply, 401, "unauthorized", "missing tenant context");
    return false;
  }
  if (!req.tenant.scopes.includes("admin")) {
    void err(reply, 403, "forbidden", "the admin scope is required");
    return false;
  }
  return true;
}

function isUniqueViolation(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { code?: string }).code === "23505";
}

export function registerSigningRoutes(
  app: FastifyInstance,
  pool: pg.Pool,
  module: SigningModule,
): void {
  // Provision a new per-product Ed25519 signing key (admin).
  app.post("/v1/products/:productId/signing-keys", async (req, reply) => {
    if (!requireAdmin(req, reply)) return reply;
    const p = paramsSchema.safeParse(req.params);
    if (!p.success) return err(reply, 400, "validation_error", "invalid productId");
    if (!module.ready()) return err(reply, 503, "signer_unavailable", "signer custody is locked");
    const meta = await provisionKey(pool, req.tenant!.tenantId, p.data.productId, module.custody, ACTOR);
    return reply
      .code(201)
      .header("Location", `/v1/products/${p.data.productId}/signing-keys/${meta.keyId}`)
      .send(meta);
  });

  // List a product's keys — public metadata only (viewer+).
  app.get("/v1/products/:productId/signing-keys", async (req, reply) => {
    if (!req.tenant) return err(reply, 401, "unauthorized", "missing tenant context");
    const p = paramsSchema.safeParse(req.params);
    if (!p.success) return err(reply, 400, "validation_error", "invalid productId");
    const keys = await listKeys(pool, req.tenant.tenantId, p.data.productId);
    return reply.code(200).send({ keys });
  });

  // Rotate: activate a new key, keep the prior key trusted in the overlap window (admin).
  app.post("/v1/products/:productId/signing-keys/rotate", async (req, reply) => {
    if (!requireAdmin(req, reply)) return reply;
    const p = paramsSchema.safeParse(req.params);
    if (!p.success) return err(reply, 400, "validation_error", "invalid productId");
    if (!module.ready()) return err(reply, 503, "signer_unavailable", "signer custody is locked");
    try {
      const meta = await rotateKey(
        pool,
        req.tenant!.tenantId,
        p.data.productId,
        module.custody,
        ACTOR,
        module.overlapSeconds,
      );
      return reply.code(200).send(meta);
    } catch (e) {
      if (isUniqueViolation(e)) return err(reply, 409, "rotation_in_flight", "a rotation is already in progress");
      throw e;
    }
  });

  // Revoke a specific key — removed from the keyring, never signed with again (admin).
  app.post("/v1/products/:productId/signing-keys/:keyId/revoke", async (req, reply) => {
    if (!requireAdmin(req, reply)) return reply;
    const p = revokeParamsSchema.safeParse(req.params);
    if (!p.success) return err(reply, 400, "validation_error", "invalid product/key id");
    const tenantId = req.tenant!.tenantId;
    const changed = await revokeKey(pool, tenantId, p.data.productId, p.data.keyId, ACTOR);
    if (changed) {
      return reply.code(200).send({ keyId: p.data.keyId, status: "revoked" });
    }
    // Not changed: distinguish an already-revoked key (409) from an unknown key (404).
    const status = await withTenant(pool, tenantId, async (q) => {
      const r = await q("SELECT status FROM signing_key WHERE product_id = $1 AND key_id = $2", [
        p.data.productId,
        p.data.keyId,
      ]);
      return r.rowCount ? (r.rows[0] as { status: string }).status : null;
    });
    if (status === "revoked") return err(reply, 409, "already_revoked", "key is already revoked");
    return err(reply, 404, "key_not_found", "unknown signing key");
  });

  // Public JWKS keyring for out-of-band verifier pinning (viewer+; public-distribution deployable).
  app.get("/v1/products/:productId/keyring", async (req, reply) => {
    if (!req.tenant) return err(reply, 401, "unauthorized", "missing tenant context");
    const p = paramsSchema.safeParse(req.params);
    if (!p.success) return err(reply, 400, "validation_error", "invalid productId");
    const keyring = await buildKeyring(pool, req.tenant.tenantId, p.data.productId);
    return reply.code(200).type("application/jwk-set+json").send(keyring);
  });
}
