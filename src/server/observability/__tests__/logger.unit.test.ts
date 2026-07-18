// T012 (OR-001/003): the single-per-request structured log line. Pure — no DB/testcontainers. Verifies
// the onResponse hook logic emits EXACTLY ONE line per request carrying tenant_id/request_id/product_id/
// outcome, that tenant_id is null on a pre-auth/internal path, and that lines are filterable per tenant.
// Two angles: (1) buildRequestLog shape through a real pino stream; (2) a Fastify `inject` app that
// reproduces the app.ts hook wiring against an in-memory capture stream.
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { describe, expect, it } from "vitest";

import {
  buildRequestLog,
  createLogger,
  outcomeFromStatus,
  REQUEST_LOG_CONTRACT,
} from "../logger.js";
import { enterRequestContext, genReqId, runWithContext, sanitizeClientRequestId } from "../request-context.js";

type Tenant = { tenantId: string; scopes: string[] };
type LogLine = Record<string, unknown>;

/** A pino logger writing parsed JSON lines into `lines` (in-memory capture). */
function captureLogger(lines: LogLine[]) {
  return createLogger(
    { logLevel: "info", logFormat: "json" },
    { write: (s: string) => void lines.push(JSON.parse(s) as LogLine) },
  );
}

/** Minimal FastifyRequest stand-in for the fields buildRequestLog reads. */
function fakeReq(method: string, url: string, routeUrl?: string, tenantId?: string): FastifyRequest {
  return {
    id: "fallback-req-id",
    method,
    url,
    routeOptions: { url: routeUrl },
    tenant: tenantId ? { tenantId, scopes: [] } : undefined,
  } as unknown as FastifyRequest;
}

function fakeReply(statusCode: number): FastifyReply {
  return { statusCode } as unknown as FastifyReply;
}

/** Build a Fastify app reproducing the app.ts onRequest+onResponse observability wiring (T006/T008). */
function makeInjectApp(lines: LogLine[]) {
  const app = Fastify({
    loggerInstance: captureLogger(lines),
    disableRequestLogging: true,
    genReqId: () => genReqId(),
  });
  app.addHook("onRequest", async (req) => {
    const inbound = req.headers["x-correlation-id"] ?? req.headers["x-request-id"];
    enterRequestContext({ requestId: req.id, clientRequestId: sanitizeClientRequestId(inbound) });
  });
  app.addHook("onResponse", async (req, reply) => {
    req.log.info(
      buildRequestLog(req, reply, { durationMs: reply.elapsedTime, outcome: outcomeFromStatus(reply.statusCode) }),
      "request completed",
    );
  });
  // /internal has no tenant (pre-auth style); /v1 routes set req.tenant to simulate authenticated tenants.
  app.get("/internal/probe", async () => ({ ok: true }));
  const setTenant = (tenantId: string) => async (req: FastifyRequest) => {
    (req as unknown as { tenant?: Tenant }).tenant = { tenantId, scopes: [] };
  };
  app.get("/v1/a", { preHandler: setTenant("tenant-a") }, async () => ({ ok: true }));
  app.get("/v1/b", { preHandler: setTenant("tenant-b") }, async () => ({ ok: true }));
  return app;
}

/** Inject then yield to the event loop so the async onResponse hook has flushed its line. */
async function inject(app: ReturnType<typeof makeInjectApp>, url: string): Promise<void> {
  await app.inject({ method: "GET", url });
  await new Promise((resolve) => setImmediate(resolve));
}

const requestLines = (lines: LogLine[]): LogLine[] => lines.filter((l) => l.msg === "request completed");

describe("buildRequestLog (OR-001/003)", () => {
  it("carries the four required fields plus method/route/status/duration", () => {
    const fields = runWithContext({ requestId: "req-1", tenantId: "t-1" }, () =>
      buildRequestLog(fakeReq("POST", "/v1/activations", "/v1/activations", "t-1"), fakeReply(200), {
        durationMs: 12,
      }),
    );
    expect(fields).toMatchObject({
      tenant_id: "t-1",
      request_id: "req-1",
      product_id: null,
      outcome: "success",
      method: "POST",
      route: "/v1/activations",
      status: 200,
      duration_ms: 12,
    });
  });

  it("derives outcome from status (success | client_error | server_error)", () => {
    const at = (status: number) =>
      runWithContext({ requestId: "r" }, () => buildRequestLog(fakeReq("GET", "/v1/x"), fakeReply(status)).outcome);
    expect(at(204)).toBe("success");
    expect(at(401)).toBe("client_error");
    expect(at(500)).toBe("server_error");
  });

  it("records tenant_id null when the tenant is unresolved (pre-auth / internal)", () => {
    const fields = runWithContext({ requestId: "r" }, () =>
      buildRequestLog(fakeReq("GET", "/internal/health"), fakeReply(200)),
    );
    expect(fields.tenant_id).toBeNull();
  });

  it("emits exactly one line per request through the pino stream with all four fields", () => {
    const lines: LogLine[] = [];
    const logger = captureLogger(lines);
    runWithContext({ requestId: "req-9", tenantId: "t-9" }, () => {
      logger.info(buildRequestLog(fakeReq("GET", "/v1/x", "/v1/x", "t-9"), fakeReply(200)), "request completed");
    });
    const emitted = requestLines(lines);
    expect(emitted).toHaveLength(1);
    for (const key of ["tenant_id", "request_id", "product_id", "outcome"]) {
      expect(emitted[0]).toHaveProperty(key);
    }
    expect(emitted[0]).toMatchObject({ tenant_id: "t-9", request_id: "req-9", outcome: "success" });
  });
});

describe("REQUEST_LOG_CONTRACT (OR-003)", () => {
  it("declares tenant_id as a required, nullable, first-class field for per-tenant filtering", () => {
    const tenant = REQUEST_LOG_CONTRACT.find((f) => f.field === "tenant_id");
    expect(tenant).toMatchObject({ required: true, nullable: true });
    for (const field of ["request_id", "product_id", "outcome"]) {
      expect(REQUEST_LOG_CONTRACT.some((f) => f.field === field)).toBe(true);
    }
  });
});

describe("onResponse hook via Fastify inject (OR-001)", () => {
  it("emits exactly one line for an internal (pre-auth) request with tenant_id null", async () => {
    const lines: LogLine[] = [];
    const app = makeInjectApp(lines);
    await inject(app, "/internal/probe");
    await app.close();
    const emitted = requestLines(lines);
    expect(emitted).toHaveLength(1);
    expect(emitted[0].tenant_id).toBeNull();
    expect(emitted[0].route).toBe("/internal/probe");
    expect(emitted[0].outcome).toBe("success");
    expect(typeof emitted[0].request_id).toBe("string");
  });

  it("emits exactly one line per request and makes lines filterable per tenant", async () => {
    const lines: LogLine[] = [];
    const app = makeInjectApp(lines);
    await inject(app, "/v1/a");
    await inject(app, "/v1/a");
    await inject(app, "/v1/b");
    await inject(app, "/internal/probe");
    await app.close();

    const emitted = requestLines(lines);
    expect(emitted).toHaveLength(4); // exactly one per request, no auto request/response pairs

    const forTenant = (t: string) => emitted.filter((l) => l.tenant_id === t);
    expect(forTenant("tenant-a")).toHaveLength(2);
    expect(forTenant("tenant-b")).toHaveLength(1);
    // Filtering by a tenant returns ONLY that tenant's lines.
    expect(forTenant("tenant-a").every((l) => l.route === "/v1/a")).toBe(true);
    expect(forTenant("tenant-b").every((l) => l.route === "/v1/b")).toBe(true);
  });

  it("generates a server-side request_id that is unique per request", async () => {
    const lines: LogLine[] = [];
    const app = makeInjectApp(lines);
    await inject(app, "/v1/a");
    await inject(app, "/v1/a");
    await app.close();
    const ids = requestLines(lines).map((l) => l.request_id);
    expect(new Set(ids).size).toBe(2);
  });
});
