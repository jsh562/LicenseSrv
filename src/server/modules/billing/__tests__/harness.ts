// Shared Testcontainers + real-signer + HMAC harness for the US1/US2/US3 billing integration suites
// (T019/T020/T023/T024/T027/T028). Reuses the issuance/activation harness pattern: spins a Postgres 16
// container, runs migrations 0000-0010, provisions two tenants, unlocks the REAL E004 keystore signer from
// Shamir shares, provisions a product signing key, seeds a product + plan, and creates a `billing_connection`
// with a KNOWN inbound-HMAC secret + plan map (via the real ConnectionRepo + E004 custody). Exposes helpers
// to sign + POST a webhook against the built app, drive the grace worker, and read back subscription/license/
// ledger/audit state. NOT a test file (no `.test`/`.spec` suffix), so vitest never runs it standalone.
import crypto from "node:crypto";
import { randomUUID } from "node:crypto";
import path from "node:path";

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import type pg from "pg";

import { createApp } from "../../../app.js";
import { makePool, privileged, withTenant } from "../../../db/client.js";
import { hmacKey } from "../../../db/hash.js";
import { runMigrations } from "../../../db/migrate.js";
import { provisionTenant } from "../../../db/repository.js";
import { createLogger } from "../../../observability/logger.js";
import { hashPassword } from "../../admin/password.js";
import { Custody, shamirSplit } from "../../signing/custody.js";
import { provisionKey } from "../../signing/registry.js";
import type { Signer } from "../../signing/signer.js";
import { loadBillingConfig } from "../config.js";
import { ConnectionRepo } from "../connection-repo.js";
import { startGraceWorker } from "../grace-worker.js";
import type { BillingDeps, SecretCustody } from "../index.js";
import { listEvents } from "../ledger-repo.js";
import { getSubscriptionById, resolveSubscriptionByExternalId, type SubscriptionRecord } from "../subscription-repo.js";

const MIGRATIONS_DIR = path.resolve(process.cwd(), "migrations");
export const SECRET = "billing-secret";
/** The connection's KNOWN inbound-HMAC signing secret — the tests sign webhooks with it. */
export const SIGNING_SECRET = "whsec_test_9f8Xk2QpL0rNvT7bYc4mHs6Jd1WuA3eZoG5iRfB2xKQ";
/** The provider plan/price key mapped to the seeded catalog plan (drives provisioning). */
export const PLAN_KEY = "price_pro_monthly";

interface Auth {
  session: string;
  csrf: string;
}

export interface LicenseSnapshot {
  status: string;
  expiresAt: string | null;
  entitlements: Record<string, boolean | number>;
  maxActivations: number;
}

export interface WebhookOptions {
  /** Override the signing secret (else {@link SIGNING_SECRET}). */
  secret?: string;
  /** Override the signed timestamp (epoch seconds); default now. */
  tsUnix?: number;
  /** Override the signature header name; default `stripe-signature`. */
  headerName?: string;
  /** Provide the signature header value verbatim, or `null` to OMIT it (missing-signature case). */
  signature?: string | null;
  /** Corrupt the signature (valid shape, wrong hmac) — for the invalid-signature case. */
  tamper?: boolean;
}

/** Optional harness overrides: rate-limit ceilings (functional suites keep them out of the way) + log capture. */
export interface StartHarnessOpts {
  /** Per-source-IP webhook rate ceiling (default 100000 — effectively unlimited for functional suites). */
  rateMaxPerIp?: number;
  /** Per-connection webhook rate ceiling (default 100000). */
  rateMaxPerConnection?: number;
  /** Capture the app's structured logs into an in-memory buffer (secret-leakage assertions); default false. */
  captureLogs?: boolean;
}

export interface BillingHarness {
  container: StartedPostgreSqlContainer;
  pool: pg.Pool;
  app: FastifyInstance;
  tenantA: string;
  tenantB: string;
  productId: string;
  planId: string;
  /** The `billing_connection` id (tenant A) the provider POSTs to — the webhook `{connectionId}`. */
  connectionId: string;
  /** Sign + POST a webhook to the given connection; returns the raw HTTP response. */
  postWebhook: (connectionId: string, body: unknown, opts?: WebhookOptions) => Promise<LightMyRequestResponse>;
  /** Resolve a subscription by its provider external id (tenant A), or null. */
  getSubscription: (externalId: string) => Promise<SubscriptionRecord | null>;
  /** Re-read a subscription by id (tenant A), or null. */
  getSubscriptionRow: (id: string) => Promise<SubscriptionRecord | null>;
  /** Read a license's status + term + snapshot (tenant A), or null. */
  getLicense: (licenseId: string) => Promise<LicenseSnapshot | null>;
  /** Count ledger rows for a provider event id (tenant A). */
  countEventRows: (providerEventId: string) => Promise<number>;
  /** List the tenant-A ledger (newest first). */
  events: () => Promise<Awaited<ReturnType<typeof listEvents>>>;
  /** The audit_log rows targeting `target` (tenant A), newest first. */
  auditFor: (target: string) => Promise<{ actor: string; action: string; after: unknown }[]>;
  /** Force a subscription's grace window into the past (tenant A) so the worker suspends it next sweep. */
  expireGraceNow: (subscriptionId: string) => Promise<void>;
  /** Run exactly one grace-expiry worker sweep (deterministic; no cadence). */
  runGraceWorker: () => Promise<void>;
  /** A fresh unique provider event id. */
  eventId: () => string;
  /** The composed billing seam (BillingDeps) published on the app — for direct reconcile() calls with a stub. */
  billingDeps: () => BillingDeps;
  /** Tenant-A ADMIN request (session + CSRF). Mirrors the E008 admin plane. */
  admin: (method: AdminMethod, url: string, payload?: unknown) => Promise<LightMyRequestResponse>;
  /** Tenant-A admin request WITHOUT the CSRF header (to prove CSRF is enforced on mutations). */
  adminNoCsrf: (method: AdminMethod, url: string, payload?: unknown) => Promise<LightMyRequestResponse>;
  /** Tenant-A VIEWER request (session + CSRF) — a non-admin, to prove RBAC (admin-only → 403). */
  viewer: (method: AdminMethod, url: string, payload?: unknown) => Promise<LightMyRequestResponse>;
  /** Tenant-B admin request (session + CSRF) — a cross-tenant caller (isolation → 404). */
  adminB: (method: AdminMethod, url: string, payload?: unknown) => Promise<LightMyRequestResponse>;
  /** An UNAUTHENTICATED request (no session cookie) — to prove auth is required (→ 401). */
  unauth: (method: AdminMethod, url: string, payload?: unknown) => Promise<LightMyRequestResponse>;
  /** The captured structured-log buffer (only when `captureLogs` was set), joined as one string. */
  logs: () => string;
  stop: () => Promise<void>;
}

type AdminMethod = "GET" | "POST" | "PATCH" | "DELETE";

/** Compute the Stripe-style signature header `t=<ts>,v1=<hmac>` over `${ts}.${rawBody}` under `secret`. */
export function signBody(secret: string, rawBody: string, tsUnix: number): string {
  const h = crypto.createHmac("sha256", secret);
  h.update(`${tsUnix}.`);
  h.update(Buffer.from(rawBody, "utf8"));
  return `t=${tsUnix},v1=${h.digest("hex")}`;
}

/** Spin the full billing harness (container + migrations + real signer + seeded catalog + connection). */
export async function startBillingHarness(slugSuffix: string, opts: StartHarnessOpts = {}): Promise<BillingHarness> {
  const prevShares = process.env.SIGNING_CUSTODIAN_SHARES;
  const prevRateConn = process.env.BILLING_WEBHOOK_RATE_MAX_PER_CONNECTION;
  const prevRateIp = process.env.BILLING_WEBHOOK_RATE_MAX_PER_IP;
  const shares = shamirSplit(Buffer.alloc(32, 7), 3, 2).slice(0, 2);
  process.env.SIGNING_CUSTODIAN_SHARES = shares.map((s) => s.toString("base64")).join(",");
  // Keep the rate limits out of the way for functional suites (idempotency loops, perf sweeps, etc.) unless a
  // suite explicitly drives a LOW ceiling to exercise the 429 shed path (rate-limit.integration.test).
  process.env.BILLING_WEBHOOK_RATE_MAX_PER_CONNECTION = String(opts.rateMaxPerConnection ?? 100000);
  process.env.BILLING_WEBHOOK_RATE_MAX_PER_IP = String(opts.rateMaxPerIp ?? 100000);

  const tenantA = randomUUID();
  const tenantB = randomUUID();

  const container = await new PostgreSqlContainer("postgres:16-alpine").start();
  const pool = makePool(container.getConnectionUri(), 12);
  await runMigrations(pool, MIGRATIONS_DIR);
  await provisionTenant(pool, { id: tenantA, slug: `acme-${slugSuffix}` });
  await provisionTenant(pool, { id: tenantB, slug: `other-${slugSuffix}` });
  await seedUser(pool, tenantA, "admin@acme.test", "admin");
  await seedUser(pool, tenantA, "viewer@acme.test", "viewer");
  await seedUser(pool, tenantB, "admin@other.test", "admin");

  // Optional in-memory log capture: build the app's pino logger over a buffer so a test can assert that the
  // signing secret / card data NEVER reaches a log line (FR-018/022). Every structured line is appended.
  const captured: string[] = [];
  const loggerInstance = opts.captureLogs
    ? createLogger({ logLevel: "info", logFormat: "json" }, { write: (s: string) => captured.push(s) })
    : undefined;

  const app = createApp({ pool, apiKeySecret: SECRET, loggerInstance });
  await app.ready();

  const authA = await loginAs(app, `acme-${slugSuffix}`, "admin@acme.test");
  const viewerA = await loginAs(app, `acme-${slugSuffix}`, "viewer@acme.test");
  const authBAdmin = await loginAs(app, `other-${slugSuffix}`, "admin@other.test");
  const productId = (await authed(app, "POST", "/admin/catalog/products", authA, { key: "keyed", name: "Keyed" })).json().id as string;
  const custody = (app as FastifyInstance & { custody?: Custody }).custody!;
  await provisionKey(pool, tenantA, productId, custody, "test-setup");
  const planId = (await authed(app, "POST", `/admin/catalog/products/${productId}/plans`, authA, { key: "pro", name: "Pro", maxActivations: 5 })).json().id as string;

  // Create the tenant-A billing connection (KNOWN secret, plan map) via the REAL repo + E004 custody.
  const repo = new ConnectionRepo(pool, custody as SecretCustody, loadBillingConfig());
  const connection = await repo.create(tenantA, "test-setup", {
    provider: "stripe",
    signingSecret: SIGNING_SECRET,
    planMap: { [PLAN_KEY]: { productId, planId } },
  });
  const connectionId = connection.id;

  let seq = 0;
  const eventId = (): string => `evt_${randomUUID().replace(/-/g, "")}${(seq++).toString(16)}`;

  const postWebhook = (id: string, body: unknown, opts: WebhookOptions = {}): Promise<LightMyRequestResponse> => {
    const rawBody = typeof body === "string" ? body : JSON.stringify(body);
    const tsUnix = opts.tsUnix ?? Math.floor(Date.now() / 1000);
    const secret = opts.secret ?? SIGNING_SECRET;
    const headerName = opts.headerName ?? "stripe-signature";
    let signature: string | null;
    if (opts.signature !== undefined) signature = opts.signature;
    else if (opts.tamper) signature = signBody(secret, rawBody + "x", tsUnix); // valid shape, wrong hmac
    else signature = signBody(secret, rawBody, tsUnix);
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (signature !== null) headers[headerName] = signature;
    return app.inject({ method: "POST", url: `/v1/billing/webhooks/${id}`, headers, payload: rawBody });
  };

  const getSubscription = (externalId: string): Promise<SubscriptionRecord | null> =>
    withTenant(pool, tenantA, (q) => resolveSubscriptionByExternalId(q, "stripe", externalId));

  const getSubscriptionRow = (id: string): Promise<SubscriptionRecord | null> =>
    withTenant(pool, tenantA, (q) => getSubscriptionById(q, id));

  const getLicense = (licenseId: string): Promise<LicenseSnapshot | null> =>
    withTenant(pool, tenantA, async (q) => {
      const r = await q("SELECT status, expires_at, entitlements, max_activations FROM license WHERE id = $1", [licenseId]);
      if (!r.rowCount) return null;
      const row = r.rows[0] as { status: string; expires_at: Date | null; entitlements: Record<string, boolean | number>; max_activations: number };
      return {
        status: row.status,
        expiresAt: row.expires_at ? row.expires_at.toISOString() : null,
        entitlements: row.entitlements,
        maxActivations: row.max_activations,
      };
    });

  const countEventRows = (providerEventId: string): Promise<number> =>
    withTenant(pool, tenantA, async (q) => {
      const r = await q("SELECT count(*)::int AS n FROM billing_event WHERE provider_event_id = $1", [providerEventId]);
      return (r.rows[0] as { n: number }).n;
    });

  const events = (): Promise<Awaited<ReturnType<typeof listEvents>>> =>
    withTenant(pool, tenantA, (q) => listEvents(q, { cap: 100 }));

  const auditFor = (target: string): Promise<{ actor: string; action: string; after: unknown }[]> =>
    withTenant(pool, tenantA, async (q) => {
      const r = await q("SELECT actor, action, after FROM audit_log WHERE target = $1 ORDER BY ts DESC, id DESC", [target]);
      return (r.rows as { actor: string; action: string; after: unknown }[]).map((x) => ({ actor: x.actor, action: x.action, after: x.after }));
    });

  const expireGraceNow = (subscriptionId: string): Promise<void> =>
    withTenant(pool, tenantA, async (q) => {
      await q("UPDATE subscription SET grace_expires_at = now() - interval '1 hour', updated_at = now() WHERE id = $1", [subscriptionId]);
    });

  const runGraceWorker = async (): Promise<void> => {
    const worker = startGraceWorker(pool, { immediate: false });
    try {
      await worker.runOnce();
    } finally {
      worker.stop();
    }
  };

  const billingDeps = (): BillingDeps => {
    const deps = (app as FastifyInstance & { billing?: BillingDeps }).billing;
    if (!deps) throw new Error("billing seam not registered on the app");
    return deps;
  };

  // A session-authenticated admin/console request (session cookie + optional CSRF header). Mirrors the E008
  // admin plane the connection/reconcile routes gate on.
  const sessionRequest = (
    method: AdminMethod,
    url: string,
    auth: Auth | null,
    payload?: unknown,
    opts: { csrf?: boolean } = {},
  ): Promise<LightMyRequestResponse> => {
    const cookies: Record<string, string> = {};
    const headers: Record<string, string> = {};
    if (auth) {
      cookies.admin_session = auth.session;
      cookies.admin_csrf = auth.csrf;
      if (opts.csrf !== false) headers["x-csrf-token"] = auth.csrf;
    }
    return app.inject({ method, url, cookies, headers, payload: payload as never });
  };

  const admin = (m: AdminMethod, u: string, p?: unknown): Promise<LightMyRequestResponse> => sessionRequest(m, u, authA, p);
  const adminNoCsrf = (m: AdminMethod, u: string, p?: unknown): Promise<LightMyRequestResponse> =>
    sessionRequest(m, u, authA, p, { csrf: false });
  const viewer = (m: AdminMethod, u: string, p?: unknown): Promise<LightMyRequestResponse> => sessionRequest(m, u, viewerA, p);
  const adminB = (m: AdminMethod, u: string, p?: unknown): Promise<LightMyRequestResponse> => sessionRequest(m, u, authBAdmin, p);
  const unauth = (m: AdminMethod, u: string, p?: unknown): Promise<LightMyRequestResponse> => sessionRequest(m, u, null, p);

  const logs = (): string => captured.join("");

  const restoreEnv = (key: string, prev: string | undefined): void => {
    if (prev === undefined) delete process.env[key];
    else process.env[key] = prev;
  };

  const stop = async (): Promise<void> => {
    restoreEnv("SIGNING_CUSTODIAN_SHARES", prevShares);
    restoreEnv("BILLING_WEBHOOK_RATE_MAX_PER_CONNECTION", prevRateConn);
    restoreEnv("BILLING_WEBHOOK_RATE_MAX_PER_IP", prevRateIp);
    await app.close();
    await pool.end();
    await container.stop();
  };

  return {
    container, pool, app, tenantA, tenantB, productId, planId,
    connectionId,
    postWebhook, getSubscription, getSubscriptionRow, getLicense, countEventRows, events, auditFor,
    expireGraceNow, runGraceWorker, eventId,
    billingDeps, admin, adminNoCsrf, viewer, adminB, unauth, logs,
    stop,
  };
}

/** A Stripe-style subscription-created event envelope (drives provisioning). */
export function createdEvent(id: string, externalSubscriptionId: string, opts: { planKey?: string; customer?: string; periodEnd?: number } = {}): Record<string, unknown> {
  return {
    id,
    type: "customer.subscription.created",
    created: Math.floor(Date.now() / 1000),
    data: {
      object: {
        id: externalSubscriptionId,
        object: "subscription",
        status: "active",
        customer: opts.customer ?? "cus_test",
        plan: { id: opts.planKey ?? PLAN_KEY },
        ...(opts.periodEnd != null ? { current_period_end: opts.periodEnd } : {}),
      },
    },
  };
}

/** A Stripe-style invoice.paid (renewal) event for an existing subscription. */
export function renewalEvent(id: string, externalSubscriptionId: string, opts: { periodEnd?: number; occurred?: number } = {}): Record<string, unknown> {
  return {
    id,
    type: "invoice.paid",
    created: opts.occurred ?? Math.floor(Date.now() / 1000),
    data: {
      object: {
        id: `in_${id}`,
        object: "invoice",
        subscription: externalSubscriptionId,
        status: "paid",
        ...(opts.periodEnd != null ? { current_period_end: opts.periodEnd } : {}),
      },
    },
  };
}

/** A Stripe-style subscription.deleted (cancellation) event. */
export function canceledEvent(id: string, externalSubscriptionId: string, opts: { occurred?: number } = {}): Record<string, unknown> {
  return {
    id,
    type: "customer.subscription.deleted",
    created: opts.occurred ?? Math.floor(Date.now() / 1000),
    data: { object: { id: externalSubscriptionId, object: "subscription", status: "canceled", plan: { id: PLAN_KEY } } },
  };
}

/**
 * A Stripe-style refund / chargeback event (`charge.refunded` | `charge.dispute.created`) → the terminal
 * `subscription.refunded` canonical type (→ E008 revoke). The charge object carries the `subscription`
 * reference the adapter resolves the link from (a pseudonymous id, never card/PAN data).
 */
export function refundEvent(
  id: string,
  externalSubscriptionId: string,
  opts: { occurred?: number; dispute?: boolean } = {},
): Record<string, unknown> {
  return {
    id,
    type: opts.dispute ? "charge.dispute.created" : "charge.refunded",
    created: opts.occurred ?? Math.floor(Date.now() / 1000),
    data: {
      object: {
        id: `ch_${id}`,
        object: "charge",
        subscription: externalSubscriptionId,
        status: "refunded",
      },
    },
  };
}

/** A Stripe-style invoice.payment_failed event. */
export function paymentFailedEvent(id: string, externalSubscriptionId: string, opts: { occurred?: number } = {}): Record<string, unknown> {
  return {
    id,
    type: "invoice.payment_failed",
    created: opts.occurred ?? Math.floor(Date.now() / 1000),
    data: { object: { id: `in_${id}`, object: "invoice", subscription: externalSubscriptionId, status: "open" } },
  };
}

async function seedUser(pool: pg.Pool, tenantId: string, email: string, role: string): Promise<void> {
  const id = randomUUID();
  await privileged(pool, async (q) => {
    // Ignore a duplicate seed (the harness seeds tenant B users twice defensively).
    const exists = await q("SELECT 1 FROM app_user WHERE tenant_id = $1 AND email_hash = $2", [tenantId, hmacKey(email.toLowerCase(), SECRET)]);
    if (exists.rowCount) return;
    await q(`INSERT INTO app_user (id, tenant_id, email_hash, password_hash, status) VALUES ($1, $2, $3, $4, 'active')`, [id, tenantId, hmacKey(email.toLowerCase(), SECRET), hashPassword("pw-" + email)]);
    await q(`INSERT INTO role (id, tenant_id, user_id, role) VALUES ($1, $2, $3, $4)`, [randomUUID(), tenantId, id, role]);
  });
}

async function loginAs(app: FastifyInstance, slug: string, email: string): Promise<Auth> {
  const res = await app.inject({ method: "POST", url: "/admin/auth/login", payload: { tenantSlug: slug, email, password: "pw-" + email } });
  if (res.statusCode !== 200) throw new Error(`login failed: ${res.statusCode} ${res.body}`);
  return { session: res.cookies.find((c) => c.name === "admin_session")!.value, csrf: res.cookies.find((c) => c.name === "admin_csrf")!.value };
}

function authed(app: FastifyInstance, method: "GET" | "POST" | "DELETE", url: string, auth: Auth, payload?: unknown): Promise<LightMyRequestResponse> {
  return app.inject({ method, url, cookies: { admin_session: auth.session, admin_csrf: auth.csrf }, headers: { "x-csrf-token": auth.csrf }, payload: payload as never });
}
