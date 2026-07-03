import cookie from "@fastify/cookie";
import Fastify, { type FastifyInstance } from "fastify";
import type pg from "pg";

import { resolveApiKey } from "./auth/apikey.js";
import { registerModules } from "./modules/index.js";

export interface AppDeps {
  pool: pg.Pool;
  apiKeySecret: string;
}

declare module "fastify" {
  interface FastifyRequest {
    tenant?: { tenantId: string; scopes: string[] };
  }
}

/**
 * The modular-monolith application skeleton (TR-010). Establishes the tenant-resolution
 * auth context (machine/runtime API key -> tenant + scopes, TR-009) and registers the
 * reserved feature-module seams. Business endpoints are added by the feature epics.
 */
export function createApp(deps: AppDeps): FastifyInstance {
  const app = Fastify({ logger: false });

  // Human admin console (E005) authenticates via session cookies, not the machine X-API-Key.
  void app.register(cookie);

  app.addHook("preHandler", async (req, reply) => {
    if (req.url.startsWith("/internal/")) return; // reserved non-tenant routes (probes etc.)
    if (req.url.startsWith("/admin/")) return; // human session-auth path (E005); guarded by its own module
    const raw = req.headers["x-api-key"];
    if (typeof raw !== "string") {
      await reply.code(401).send({ error: "missing api key" });
      return;
    }
    const ctx = await resolveApiKey(deps.pool, raw, deps.apiKeySecret);
    if (!ctx) {
      await reply.code(401).send({ error: "invalid api key" });
      return;
    }
    req.tenant = ctx;
  });

  registerModules(app, deps);
  return app;
}
