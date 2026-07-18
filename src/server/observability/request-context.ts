// Per-request context carrier (OR-002, AD-002). A process-wide AsyncLocalStorage holds the
// request-scoped correlation fields so any downstream code (logger, metrics, tracing) can read
// them without threading them through every call. The authoritative `request_id` is ALWAYS
// server-generated (`genReqId`); an inbound correlation header is accepted only as a
// non-authoritative, sanitized tag (`clientRequestId`) — never trusted as the id itself.
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

/** The correlation fields carried for the lifetime of a single request. */
export interface RequestContext {
  /** Server-generated, authoritative request id (Fastify `req.id`, from `genReqId`). */
  requestId: string;
  /** Sanitized inbound correlation header, if any — a tag only, never authoritative. */
  clientRequestId?: string;
  /** Resolved tenant, once auth has run; absent on unauthenticated / pre-auth paths. */
  tenantId?: string;
}

/** Max length for an accepted inbound correlation tag (defensive bound against log flooding). */
const MAX_CLIENT_REQUEST_ID_LEN = 128;

const storage = new AsyncLocalStorage<RequestContext>();

/**
 * Generate a fresh, authoritative `request_id`. Server-generated on every request so a client can
 * never dictate or collide the id (trust boundary, OR-002 / AD-002).
 */
export function genReqId(): string {
  return randomUUID();
}

/**
 * Sanitize an inbound correlation header (`x-correlation-id` / `x-request-id`) into a safe tag, or
 * `undefined` when it carries nothing usable. Keeps printable ASCII only (strips control/newline
 * chars to prevent log injection), trims surrounding whitespace, and caps length at 128 chars.
 */
export function sanitizeClientRequestId(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  // Drop everything outside printable ASCII (0x20-0x7E): control chars, newlines, and non-ASCII.
  const cleaned = raw.replace(/[^\x20-\x7E]/g, "").trim();
  if (cleaned.length === 0) return undefined;
  return cleaned.slice(0, MAX_CLIENT_REQUEST_ID_LEN);
}

/** The active request context for the current async execution, or `undefined` outside a request. */
export function getRequestContext(): RequestContext | undefined {
  return storage.getStore();
}

/**
 * Run `fn` with `ctx` as the active request context. Use when a fresh async scope wraps the whole
 * unit of work (e.g. a worker/canary); Fastify hooks use `enterRequestContext` instead.
 */
export function runWithContext<T>(ctx: RequestContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

/**
 * Establish `ctx` as the active request context for the remainder of the current async execution.
 * Intended for a Fastify `onRequest` hook, where there is no wrapping callback to `run` inside —
 * the store then propagates through the hook chain and route handler for this request.
 */
export function enterRequestContext(ctx: RequestContext): void {
  storage.enterWith(ctx);
}

/**
 * Record the resolved tenant on the active request context once auth has run (OR-011). The context object
 * is established at `onRequest` (before auth) without a tenant; the auth preHandler calls this after it
 * resolves `req.tenant`, so downstream code — notably the `withTenant()` isolation assertion — can compare
 * the authenticated tenant against the tenant GUC. No-op outside a request scope (nothing to annotate).
 */
export function setContextTenant(tenantId: string): void {
  const ctx = storage.getStore();
  if (ctx) ctx.tenantId = tenantId;
}
