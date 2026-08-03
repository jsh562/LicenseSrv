// Shared Testcontainers harness for the E016 usage-ingest integration suites (US1: T014/T015/T016). Spins a
// Postgres 16 container, runs migrations 0000-0012, provisions two tenants + admin users, seeds a
// product/plan/customer/license chain per tenant, and mints scoped runtime API keys (a `usage.ingest`-scoped
// key for A and B, plus a NO-scope key for the 403 fail-closed check). Exposes helpers to author a metered
// entitlement directly (SUM/COUNT/UNIQUE_COUNT, optional allowance, archived) — the catalog authoring surface
// is US3, out of US1 scope — a non-metered (boolean) entitlement, mutate license lifecycle, drive POST
// /v1/usage via `inject`, and read back raw usage_event rows + audit entries. NOT a test file (no describe/it),
// so vitest never runs it standalone and coverage ignores __tests__.
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

const MIGRATIONS_DIR = path.resolve(process.cwd(), "migrations");
export const SECRET = "usage-secret";
const GUC = "current_setting('app.current_tenant')::uuid";

export interface Auth {
  session: string;
  csrf: string;
}

/** Options for {@link UsageHarness.createMeteredEntitlement}. */
export interface MeteredOpts {
  aggregation?: "sum" | "count" | "unique_count";
  unit?: string;
  allowance?: number | null;
  status?: "active" | "archived";
}

/** A seeded license/entitlement chain within a tenant. */
export interface SeededChain {
  productId: string;
  planId: string;
  customerId: string;
  licenseId: string;
}

export interface UsageHarness {
  container: StartedPostgreSqlContainer;
  pool: pg.Pool;
  app: FastifyInstance;
  tenantA: string;
  tenantB: string;
  chainA: SeededChain;
  chainB: SeededChain;
  /** Runtime API key (tenant A) WITH the `usage.ingest` scope. */
  usageKey: string;
  /** Runtime API key (tenant B) WITH the `usage.ingest` scope — for cross-tenant isolation. */
  usageKeyB: string;
  /** Runtime API key (tenant A) WITHOUT the `usage.ingest` scope (→ 403 on the ingest route). */
  noScopeKey: string;
  /** Console session (tenant A) for an ADMIN user — reads the true signed net via `raw=true` (US2). */
  authAdmin: Auth;
  /** Console session (tenant A) for a VIEWER user — floored display only; a `raw=true` request is refused. */
  authViewer: Auth;
  /** Console session (tenant B) for an ADMIN user — a cross-tenant caller (isolation → 404, T041). */
  authAdminB: Auth;
  /** GET /admin/licenses/:licenseId/usage with the given session + query params (US2 query route). */
  getUsage: (auth: Auth, licenseId: string, query?: Record<string, string>) => Promise<LightMyRequestResponse>;
  /** Author a metered entitlement in tenant A (direct SQL; catalog authoring is US3). Returns its id. */
  createMeteredEntitlement: (opts?: MeteredOpts) => Promise<string>;
  /** Author a metered entitlement in a given tenant. */
  createMeteredEntitlementIn: (tenantId: string, opts?: MeteredOpts) => Promise<string>;
  /** Author a non-metered (boolean) entitlement in tenant A. Returns its id. */
  createBooleanEntitlement: () => Promise<string>;
  /** Set a license's lifecycle status (tenant A). */
  setLicenseStatus: (licenseId: string, status: "active" | "suspended" | "revoked") => Promise<void>;
  /** Set a license's expiry (tenant A) — a Unix-seconds instant, or null to clear it. */
  expireLicense: (licenseId: string, whenUnix: number | null) => Promise<void>;
  /** POST /v1/usage with the given API key (or none) and body. */
  ingest: (apiKey: string | null, body: unknown) => Promise<LightMyRequestResponse>;
  /** Count raw usage_event rows for a (license, entitlement) in tenant A. */
  countEvents: (licenseId: string, entitlementId: string) => Promise<number>;
  /** SUM of signed quantities of raw usage_event rows for a (license, entitlement) in tenant A. */
  sumQuantity: (licenseId: string, entitlementId: string) => Promise<number>;
  /** Audit rows (tenant A) for an action, newest first. */
  auditRows: (action: string) => Promise<{ actor: string; after: unknown; securityEvent: boolean }[]>;
  /** All security-event audit rows (tenant A), newest first — for the rate-limit-shed assertions (T040). */
  securityEvents: () => Promise<{ actor: string; action: string; target: string | null }[]>;
  /** The captured structured-log buffer (only when `captureLogs` was set), joined as one string (T042). */
  logs: () => string;
  eventId: () => string;
  stop: () => Promise<void>;
}

/** Optional harness knobs. `rateMax` sets the per-key / per-IP rate ceiling (defaults very high). */
export interface UsageHarnessOptions {
  /** Per-API-key ingest AND per-source-IP admin-query rate ceiling; defaults to a very high value. */
  rateMax?: number;
  /** Capture the app's structured logs into an in-memory buffer (secret-leakage assertions, T042); default false. */
  captureLogs?: boolean;
}

/** Spin the full usage harness (container + migrations 0000-0012 + seeded chains + scoped keys). */
export async function startHarness(slugSuffix: string, opts: UsageHarnessOptions = {}): Promise<UsageHarness> {
  const prevRate = process.env.USAGE_INGEST_RATE_MAX;
  // Set the per-key ingest ceiling BEFORE the app boots (the usage config is read at registerUsage time). The
  // functional tests default to a very high ceiling so they (incl. the parallel concurrent-dedupe race) never
  // trip the limit; the rate-limit tests pass a LOW `rateMax` so a modest burst sheds 429.
  process.env.USAGE_INGEST_RATE_MAX = String(opts.rateMax ?? 1_000_000);

  const tenantA = randomUUID();
  const tenantB = randomUUID();

  const container = await new PostgreSqlContainer("postgres:16-alpine").start();
  const pool = makePool(container.getConnectionUri(), 16);
  await runMigrations(pool, MIGRATIONS_DIR);
  await provisionTenant(pool, { id: tenantA, slug: `acme-${slugSuffix}` });
  await provisionTenant(pool, { id: tenantB, slug: `other-${slugSuffix}` });
  await seedUser(pool, tenantA, "admin@acme.test", "admin");
  await seedUser(pool, tenantA, "viewer@acme.test", "viewer");
  await seedUser(pool, tenantB, "admin@other.test", "admin");

  // Optional in-memory log capture: build the app's pino logger over a buffer so a test can assert that no API
  // key / secret / card-PAN / PII EVER reaches a log line (FR-019/SC-013). Otherwise the app uses its default.
  const captured: string[] = [];
  const loggerInstance = opts.captureLogs
    ? createLogger({ logLevel: "info", logFormat: "json" }, { write: (s: string) => captured.push(s) })
    : undefined;

  const app = createApp({ pool, apiKeySecret: SECRET, loggerInstance });
  await app.ready();

  const chainA = await seedChain(pool, tenantA);
  const chainB = await seedChain(pool, tenantB);

  const authA = await loginAs(app, `acme-${slugSuffix}`, "admin@acme.test");
  const authViewer = await loginAs(app, `acme-${slugSuffix}`, "viewer@acme.test");
  const authB = await loginAs(app, `other-${slugSuffix}`, "admin@other.test");
  const usageKey = (await authed(app, "POST", "/admin/api-keys", authA, { scopes: ["usage.ingest"] })).json().secret as string;
  const noScopeKey = (await authed(app, "POST", "/admin/api-keys", authA, { scopes: ["validate"] })).json().secret as string;
  const usageKeyB = (await authed(app, "POST", "/admin/api-keys", authB, { scopes: ["usage.ingest"] })).json().secret as string;

  let seq = 0;
  const eventId = (): string => `${randomUUID().replace(/-/g, "")}${(seq++).toString(16)}`;

  const createMeteredEntitlementIn = (tenantId: string, opts: MeteredOpts = {}): Promise<string> =>
    withTenant(pool, tenantId, async (q) => {
      const id = randomUUID();
      await q(
        `INSERT INTO entitlement (id, tenant_id, key, name, type, aggregation, unit, allowance, status)
         VALUES ($1, ${GUC}, $2, 'Metered', 'metered', $3, $4, $5, $6)`,
        [
          id,
          `meter-${id.slice(0, 8)}`,
          opts.aggregation ?? "sum",
          opts.unit ?? "gb",
          opts.allowance ?? null,
          opts.status ?? "active",
        ],
      );
      return id;
    });

  const createMeteredEntitlement = (opts?: MeteredOpts): Promise<string> => createMeteredEntitlementIn(tenantA, opts);

  const createBooleanEntitlement = (): Promise<string> =>
    withTenant(pool, tenantA, async (q) => {
      const id = randomUUID();
      await q(`INSERT INTO entitlement (id, tenant_id, key, name, type) VALUES ($1, ${GUC}, $2, 'Bool', 'boolean')`, [
        id,
        `bool-${id.slice(0, 8)}`,
      ]);
      return id;
    });

  const setLicenseStatus = (licenseId: string, status: "active" | "suspended" | "revoked"): Promise<void> =>
    withTenant(pool, tenantA, async (q) => {
      await q("UPDATE license SET status = $2, updated_at = now() WHERE id = $1", [licenseId, status]);
    });

  const expireLicense = (licenseId: string, whenUnix: number | null): Promise<void> =>
    withTenant(pool, tenantA, async (q) => {
      await q(
        "UPDATE license SET expires_at = CASE WHEN $2::double precision IS NULL THEN NULL ELSE to_timestamp($2) END, updated_at = now() WHERE id = $1",
        [licenseId, whenUnix],
      );
    });

  const ingest = (apiKey: string | null, body: unknown): Promise<LightMyRequestResponse> => {
    const headers: Record<string, string> = {};
    if (apiKey) headers["x-api-key"] = apiKey;
    return app.inject({ method: "POST", url: "/v1/usage", headers, payload: body as never });
  };

  const getUsage = (auth: Auth, licenseId: string, query: Record<string, string> = {}): Promise<LightMyRequestResponse> => {
    const p = new URLSearchParams(query).toString();
    return app.inject({
      method: "GET",
      url: `/admin/licenses/${licenseId}/usage${p ? `?${p}` : ""}`,
      cookies: { admin_session: auth.session, admin_csrf: auth.csrf },
      headers: { "x-csrf-token": auth.csrf },
    });
  };

  const countEvents = (licenseId: string, entitlementId: string): Promise<number> =>
    withTenant(pool, tenantA, async (q) => {
      const r = await q("SELECT count(*)::int AS n FROM usage_event WHERE license_id = $1 AND entitlement_id = $2", [licenseId, entitlementId]);
      return (r.rows[0] as { n: number }).n;
    });

  const sumQuantity = (licenseId: string, entitlementId: string): Promise<number> =>
    withTenant(pool, tenantA, async (q) => {
      const r = await q(
        "SELECT COALESCE(sum(quantity), 0)::float8 AS s FROM usage_event WHERE license_id = $1 AND entitlement_id = $2",
        [licenseId, entitlementId],
      );
      return Number((r.rows[0] as { s: number }).s);
    });

  const auditRows = (action: string): Promise<{ actor: string; after: unknown; securityEvent: boolean }[]> =>
    withTenant(pool, tenantA, async (q) => {
      const r = await q("SELECT actor, after, security_event FROM audit_log WHERE action = $1 ORDER BY ts DESC, id DESC", [action]);
      return (r.rows as { actor: string; after: unknown; security_event: boolean }[]).map((x) => ({
        actor: x.actor,
        after: x.after,
        securityEvent: x.security_event,
      }));
    });

  const securityEvents = (): Promise<{ actor: string; action: string; target: string | null }[]> =>
    withTenant(pool, tenantA, async (q) => {
      const r = await q("SELECT actor, action, target FROM audit_log WHERE security_event = true ORDER BY ts DESC, id DESC", []);
      return (r.rows as { actor: string; action: string; target: string | null }[]).map((x) => ({ actor: x.actor, action: x.action, target: x.target }));
    });

  const logs = (): string => captured.join("");

  const stop = async (): Promise<void> => {
    if (prevRate === undefined) delete process.env.USAGE_INGEST_RATE_MAX;
    else process.env.USAGE_INGEST_RATE_MAX = prevRate;
    await app.close();
    await pool.end();
    await container.stop();
  };

  return {
    container, pool, app, tenantA, tenantB, chainA, chainB,
    usageKey, usageKeyB, noScopeKey,
    authAdmin: authA, authViewer, authAdminB: authB, getUsage,
    createMeteredEntitlement, createMeteredEntitlementIn, createBooleanEntitlement,
    setLicenseStatus, expireLicense, ingest, countEvents, sumQuantity, auditRows, securityEvents, logs, eventId, stop,
  };
}

/** Seed a product/plan/customer/license chain for a tenant (license starts `active`, no expiry). */
async function seedChain(pool: pg.Pool, tenantId: string): Promise<SeededChain> {
  return withTenant(pool, tenantId, async (q) => {
    const productId = randomUUID();
    const planId = randomUUID();
    const customerId = randomUUID();
    const licenseId = randomUUID();
    await q(`INSERT INTO product (id, tenant_id, key, name) VALUES ($1, ${GUC}, $2, 'P')`, [productId, `prod-${productId.slice(0, 8)}`]);
    await q(`INSERT INTO plan (id, tenant_id, product_id, key, name) VALUES ($1, ${GUC}, $2, $3, 'Plan')`, [planId, productId, `plan-${planId.slice(0, 8)}`]);
    await q(`INSERT INTO customer (id, tenant_id, ref) VALUES ($1, ${GUC}, $2)`, [customerId, `cust-${customerId.slice(0, 8)}`]);
    await q(
      `INSERT INTO license (id, tenant_id, product_id, plan_id, customer_id, max_activations, entitlements, token_version, nonce, license_token, status)
       VALUES ($1, ${GUC}, $2, $3, $4, 5, '{"pro":true}'::jsonb, 1, $5, $6, 'active')`,
      [licenseId, productId, planId, customerId, `lnonce-${licenseId.slice(0, 8)}`, `LIC1.${licenseId.slice(0, 8)}`],
    );
    return { productId, planId, customerId, licenseId };
  });
}

async function seedUser(pool: pg.Pool, tenantId: string, email: string, role: string): Promise<void> {
  const id = randomUUID();
  await privileged(pool, async (q) => {
    await q(`INSERT INTO app_user (id, tenant_id, email_hash, password_hash, status) VALUES ($1, $2, $3, $4, 'active')`, [
      id,
      tenantId,
      hmacKey(email.toLowerCase(), SECRET),
      hashPassword("pw-" + email),
    ]);
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
