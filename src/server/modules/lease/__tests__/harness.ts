// Shared Testcontainers + real-signer harness for the E015 lease integration suites (US1/US2/US3). Mirrors the
// activation/enforcement/billing harness: spins a Postgres 16 container, runs migrations 0000-0011, provisions
// two tenants + admin users, unlocks the REAL E004 keystore signer from Shamir shares, provisions a product
// signing key, and seeds a product/customer + scoped runtime API keys (a `lease`-scoped key for A and B, plus
// a NO-`lease`-scope key for the 401/403 fail-closed checks). Exposes helpers to issue a FLOATING license
// (create a plan with concurrency config → issue → snapshot the cap/scope/overage/timings onto the license,
// since E007 plan-authoring of `max_concurrent` is out of E015 scope), mutate license state, backdate a lease
// for reclaim, read a lease row / live count, build a LeaseDeps for direct service calls (with a swappable
// signer/activationRead), and drive the /v1 routes via `inject`. NOT a test file, so vitest never runs it
// standalone and coverage ignores __tests__.
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
import { getEffectivePlanDefinition } from "../../catalog/effective.js";
import { Custody, shamirSplit } from "../../signing/custody.js";
import { provisionKey } from "../../signing/registry.js";
import type { Signer } from "../../signing/signer.js";
import { loadLeaseConfig } from "../config.js";
import { defaultActivationRead, type ActivationRead, type LeaseDeps } from "../index.js";
import { LeaseRepo } from "../lease-repo.js";

const MIGRATIONS_DIR = path.resolve(process.cwd(), "migrations");
export const SECRET = "lease-secret";

interface Auth {
  session: string;
  csrf: string;
}

/** Options for {@link LeaseHarness.issueFloating}. `maxConcurrent: null` ⇒ a NON-floating (unentitled) license. */
export interface FloatingOpts {
  maxConcurrent?: number | null;
  scope?: "session" | "machine" | "user";
  overage?: number;
  requireActivation?: boolean;
  signedHandle?: boolean;
  heartbeatSeconds?: number;
  ttlSeconds?: number;
  graceSeconds?: number;
  sweepSeconds?: number;
  policyOnRevoke?: "reclaim" | "timer";
  policyOnSuspend?: "reclaim" | "timer";
  policyOnExpire?: "reclaim" | "timer";
}

export interface IssuedFloating {
  licenseId: string;
  licenseKey: string;
  planId: string;
}

export interface LeaseRowView {
  id: string;
  status: "live" | "released" | "reclaimed";
  expiresAt: string;
  lastRenewedAt: string;
  generation: number;
  holderKey: string;
  overage: boolean;
  handleKeyId: string | null;
}

export interface DepsOverrides {
  signer?: Signer;
  activationRead?: ActivationRead;
}

export interface LeaseHarness {
  container: StartedPostgreSqlContainer;
  pool: pg.Pool;
  app: FastifyInstance;
  tenantA: string;
  tenantB: string;
  productId: string;
  customerId: string;
  /** Runtime API key (tenant A) WITH the `lease` scope. */
  leaseKey: string;
  /** Runtime API key (tenant B) WITH the `lease` scope — for cross-tenant isolation. */
  leaseKeyB: string;
  /** Runtime API key (tenant A) WITHOUT the `lease` scope (→ 403 on every lease route). */
  noScopeKey: string;
  /** The real E004 signer decorated on the app. */
  signer: () => Signer;
  /** Build a LeaseDeps for direct service calls, optionally swapping the signer / activationRead. */
  deps: (overrides?: DepsOverrides) => LeaseDeps;
  issueFloating: (opts?: FloatingOpts) => Promise<IssuedFloating>;
  setLicenseStatus: (licenseId: string, status: "active" | "suspended" | "revoked") => Promise<void>;
  expireLicense: (licenseId: string, whenUnix: number | null) => Promise<void>;
  /** Backdate a lease's `expires_at` so it is past TTL + grace for the sweeper (default 3600s in the past). */
  expireLease: (leaseId: string, secondsInPast?: number) => Promise<void>;
  leaseRow: (leaseId: string) => Promise<LeaseRowView | null>;
  countLive: (licenseId: string) => Promise<number>;
  /** Insert a real node-lock activation row (for the FR-025 "activated-devices-only" gating path). */
  createActivation: (licenseId: string, opts?: { status?: "active" | "deactivated" }) => Promise<string>;
  acquire: (apiKey: string | null, body: unknown) => Promise<LightMyRequestResponse>;
  renew: (apiKey: string | null, leaseId: string) => Promise<LightMyRequestResponse>;
  release: (apiKey: string | null, leaseId: string) => Promise<LightMyRequestResponse>;
  /** Tenant-A ADMIN console request (session cookie + CSRF header) — the admin lease plane (US5). */
  admin: (method: AdminMethod, url: string, payload?: unknown) => Promise<LightMyRequestResponse>;
  /** Tenant-A admin request WITHOUT the CSRF header (proves double-submit CSRF is enforced fail-closed). */
  adminNoCsrf: (method: AdminMethod, url: string, payload?: unknown) => Promise<LightMyRequestResponse>;
  /** Tenant-A VIEWER console request (session + CSRF) — a non-admin, to prove RBAC (admin-only → 403). */
  viewer: (method: AdminMethod, url: string, payload?: unknown) => Promise<LightMyRequestResponse>;
  /** Tenant-B ADMIN console request (session + CSRF) — a cross-tenant caller (isolation → 404). */
  adminB: (method: AdminMethod, url: string, payload?: unknown) => Promise<LightMyRequestResponse>;
  /** UNAUTHENTICATED console request (no session cookie) — to prove auth is required (→ 401). */
  unauth: (method: AdminMethod, url: string, payload?: unknown) => Promise<LightMyRequestResponse>;
  /** Bulk-insert `count` recently-ended (reclaimed) leases for the registry truncation test (fast, one INSERT). */
  seedEndedLeases: (licenseId: string, count: number, noncePrefix: string) => Promise<void>;
  /** The audit rows (tenant A) for an action + target, newest first (actor/after/securityEvent). */
  auditRows: (action: string, target: string) => Promise<{ actor: string; after: unknown; securityEvent: boolean }[]>;
  /** All security-event audit rows (tenant A), newest first — for the viewer/CSRF force-release denials. */
  securityEvents: () => Promise<{ actor: string; action: string; target: string | null }[]>;
  nonce: () => string;
  holderRef: () => string;
  /** The captured structured-log buffer (only when `captureLogs` was set), joined as one string (T040). */
  logs: () => string;
  /** The effective server-held holder-key salt in use (a secret that MUST never leak — SC-023/T040). */
  holderKeySalt: string;
  stop: () => Promise<void>;
}

/** The HTTP methods the admin console plane uses. */
export type AdminMethod = "GET" | "POST" | "PATCH" | "DELETE";

/** Optional harness knobs. `rateMax` sets the per-key runtime rate ceiling (defaults very high). */
export interface HarnessOptions {
  rateMax?: number;
  /** Capture the app's structured logs into an in-memory buffer (secret-leakage assertions, T040); default false. */
  captureLogs?: boolean;
  /** Override the server-held holder-key salt (FR-026/SC-023) — a distinctive canary for the leakage scan. */
  holderKeySalt?: string;
}

const repo = new LeaseRepo();

/** Spin the full lease harness (container + migrations 0000-0011 + real signer + seeded catalog). */
export async function startHarness(slugSuffix: string, opts: HarnessOptions = {}): Promise<LeaseHarness> {
  const prevShares = process.env.SIGNING_CUSTODIAN_SHARES;
  const prevRate = process.env.LEASE_RATE_MAX;
  const prevSalt = process.env.LEASE_HOLDER_KEY_SALT;
  const shares = shamirSplit(Buffer.alloc(32, 7), 3, 2).slice(0, 2);
  process.env.SIGNING_CUSTODIAN_SHARES = shares.map((s) => s.toString("base64")).join(",");
  // The lease config is read at registerLease time (createApp below), so set the ceiling + salt BEFORE the
  // app boots (the salt is the server-held FR-026 secret; a distinctive value lets a leakage scan detect it).
  process.env.LEASE_RATE_MAX = String(opts.rateMax ?? 100_000);
  const holderKeySalt = opts.holderKeySalt ?? loadLeaseConfig().holderKeySalt;
  if (opts.holderKeySalt !== undefined) process.env.LEASE_HOLDER_KEY_SALT = opts.holderKeySalt;

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

  // Optional in-memory log capture: build the app's pino logger over a buffer so a test can assert that no
  // signing key / holder reference / handle secret / raw hardware id / card datum EVER reaches a log line (SC-015).
  const captured: string[] = [];
  const loggerInstance = opts.captureLogs
    ? createLogger({ logLevel: "info", logFormat: "json" }, { write: (s: string) => captured.push(s) })
    : undefined;

  const app = createApp({ pool, apiKeySecret: SECRET, loggerInstance });
  await app.ready();

  const authA = await loginAs(app, `acme-${slugSuffix}`, "admin@acme.test");
  const productId = (await authed(app, "POST", "/admin/catalog/products", authA, { key: "keyed", name: "Keyed" })).json().id as string;
  const custody = new Custody();
  custody.unlock(shares);
  await provisionKey(pool, tenantA, productId, custody, "test-setup");
  const customerId = (await authed(app, "POST", "/admin/customers", authA, { ref: "cust-1" })).json().id as string;
  const leaseKey = (await authed(app, "POST", "/admin/api-keys", authA, { scopes: ["lease"] })).json().secret as string;
  const noScopeKey = (await authed(app, "POST", "/admin/api-keys", authA, { scopes: ["validate"] })).json().secret as string;

  const viewerA = await loginAs(app, `acme-${slugSuffix}`, "viewer@acme.test");
  const authB = await loginAs(app, `other-${slugSuffix}`, "admin@other.test");
  const leaseKeyB = (await authed(app, "POST", "/admin/api-keys", authB, { scopes: ["lease"] })).json().secret as string;

  let nonceSeq = 0;
  const nonce = (): string => `${randomUUID().replace(/-/g, "")}${(nonceSeq++).toString(16)}`;
  let holderSeq = 0;
  const holderRef = (): string => `instance-${randomUUID()}-${(holderSeq++).toString(16)}`;

  const signer = (): Signer => {
    const s = (app as FastifyInstance & { signer?: Signer }).signer;
    if (!s) throw new Error("harness: app.signer is not configured");
    return s;
  };

  const deps = (overrides: DepsOverrides = {}): LeaseDeps => ({
    pool,
    signer: overrides.signer ?? signer(),
    effective: getEffectivePlanDefinition,
    activationRead: overrides.activationRead ?? defaultActivationRead,
    repo: new LeaseRepo(),
    config: loadLeaseConfig(),
  });

  const issueFloating = async (o: FloatingOpts = {}): Promise<IssuedFloating> => {
    const maxConcurrent = o.maxConcurrent === undefined ? 5 : o.maxConcurrent;
    const scope = o.scope ?? "session";
    const overage = o.overage ?? 0;
    const requireActivation = o.requireActivation ?? false;
    const signedHandle = o.signedHandle ?? true;
    const hb = o.heartbeatSeconds ?? 600;
    const ttl = o.ttlSeconds ?? Math.max(1800, 3 * hb);
    const grace = o.graceSeconds ?? 300;
    const sweep = o.sweepSeconds ?? 60;
    const polRevoke = o.policyOnRevoke ?? "reclaim";
    const polSuspend = o.policyOnSuspend ?? "timer";
    const polExpire = o.policyOnExpire ?? "timer";

    const planId = (
      await authed(app, "POST", `/admin/catalog/products/${productId}/plans`, authA, {
        key: `pl-${randomUUID().slice(0, 8)}`,
        name: "Floating",
        maxActivations: 5,
      })
    ).json().id as string;

    await withTenant(pool, tenantA, (q) =>
      q(
        `UPDATE plan SET max_concurrent = $2, concurrency_scope = $3, concurrency_overage = $4,
            concurrency_require_activation = $5, lease_signed_handle = $6,
            lease_heartbeat_seconds = $7, lease_ttl_seconds = $8, lease_grace_seconds = $9, lease_sweep_seconds = $10,
            lease_policy_on_revoke = $11, lease_policy_on_suspend = $12, lease_policy_on_expire = $13
          WHERE id = $1`,
        [planId, maxConcurrent, scope, overage, requireActivation, signedHandle, hb, ttl, grace, sweep, polRevoke, polSuspend, polExpire],
      ),
    );

    const lic = (await authed(app, "POST", "/admin/licenses", authA, { planId, customerId })).json() as { id: string; licenseKey: string };

    await withTenant(pool, tenantA, (q) =>
      q(
        `UPDATE license SET max_concurrent = $2, concurrency_scope = $3, concurrency_overage = $4,
            lease_heartbeat_seconds = $5, lease_ttl_seconds = $6, lease_grace_seconds = $7, lease_sweep_seconds = $8,
            lease_policy_on_revoke = $9, lease_policy_on_suspend = $10, lease_policy_on_expire = $11
          WHERE id = $1`,
        [lic.id, maxConcurrent, scope, overage, hb, ttl, grace, sweep, polRevoke, polSuspend, polExpire],
      ),
    );

    return { licenseId: lic.id, licenseKey: lic.licenseKey, planId };
  };

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

  const expireLease = (leaseId: string, secondsInPast = 3_600): Promise<void> =>
    withTenant(pool, tenantA, async (q) => {
      await q(
        "UPDATE lease SET expires_at = now() - make_interval(secs => $2), last_renewed_at = now() - make_interval(secs => $2), updated_at = now() WHERE id = $1 AND status = 'live'",
        [leaseId, secondsInPast],
      );
    });

  const leaseRow = (leaseId: string): Promise<LeaseRowView | null> =>
    withTenant(pool, tenantA, async (q) => {
      const r = await q(
        "SELECT id, status, expires_at, last_renewed_at, generation, holder_key, overage, handle_key_id FROM lease WHERE id = $1",
        [leaseId],
      );
      if (!r.rowCount) return null;
      const row = r.rows[0] as {
        id: string;
        status: "live" | "released" | "reclaimed";
        expires_at: Date;
        last_renewed_at: Date;
        generation: string;
        holder_key: Buffer;
        overage: boolean;
        handle_key_id: string | null;
      };
      return {
        id: row.id,
        status: row.status,
        expiresAt: row.expires_at.toISOString(),
        lastRenewedAt: row.last_renewed_at.toISOString(),
        generation: Number(row.generation),
        holderKey: row.holder_key.toString("base64"),
        overage: row.overage,
        handleKeyId: row.handle_key_id,
      };
    });

  const countLive = (licenseId: string): Promise<number> =>
    withTenant(pool, tenantA, (q) => repo.countLive(q, licenseId));

  const createActivation = (licenseId: string, o: { status?: "active" | "deactivated" } = {}): Promise<string> =>
    withTenant(pool, tenantA, async (q) => {
      const id = randomUUID();
      await q(
        `INSERT INTO activation (id, tenant_id, license_id, machine_id, signal_hashes, fp_min, nonce, status)
         VALUES ($1, current_setting('app.current_tenant')::uuid, $2, $3, $4, 1, $5, $6)`,
        [id, licenseId, `machine-${id.slice(0, 8)}`, [`sig-${id.slice(0, 8)}`], `act-nonce-${id}`, o.status ?? "active"],
      );
      return id;
    });

  const inject = (method: "POST", url: string, apiKey: string | null, body?: unknown): Promise<LightMyRequestResponse> => {
    const headers: Record<string, string> = {};
    if (apiKey) headers["x-api-key"] = apiKey;
    return app.inject({ method, url, headers, payload: body as never });
  };
  const acquire = (apiKey: string | null, body: unknown): Promise<LightMyRequestResponse> => inject("POST", "/v1/leases", apiKey, body);
  const renew = (apiKey: string | null, leaseId: string): Promise<LightMyRequestResponse> => inject("POST", `/v1/leases/${leaseId}/renew`, apiKey, {});
  const release = (apiKey: string | null, leaseId: string): Promise<LightMyRequestResponse> => inject("POST", `/v1/leases/${leaseId}/release`, apiKey, {});

  // A session-authenticated console request (session cookie + optional CSRF header) — the admin lease plane
  // the registry (GET, viewer) + force-release (POST, admin + CSRF) routes gate on (US5).
  const sessionRequest = (
    method: AdminMethod,
    url: string,
    auth: Auth | null,
    payload?: unknown,
    o: { csrf?: boolean } = {},
  ): Promise<LightMyRequestResponse> => {
    const cookies: Record<string, string> = {};
    const headers: Record<string, string> = {};
    if (auth) {
      cookies.admin_session = auth.session;
      cookies.admin_csrf = auth.csrf;
      if (o.csrf !== false) headers["x-csrf-token"] = auth.csrf;
    }
    return app.inject({ method, url, cookies, headers, payload: payload as never });
  };
  const admin = (m: AdminMethod, u: string, p?: unknown): Promise<LightMyRequestResponse> => sessionRequest(m, u, authA, p);
  const adminNoCsrf = (m: AdminMethod, u: string, p?: unknown): Promise<LightMyRequestResponse> => sessionRequest(m, u, authA, p, { csrf: false });
  const viewer = (m: AdminMethod, u: string, p?: unknown): Promise<LightMyRequestResponse> => sessionRequest(m, u, viewerA, p);
  const adminB = (m: AdminMethod, u: string, p?: unknown): Promise<LightMyRequestResponse> => sessionRequest(m, u, authB, p);
  const unauth = (m: AdminMethod, u: string, p?: unknown): Promise<LightMyRequestResponse> => sessionRequest(m, u, null, p);

  const seedEndedLeases = (licenseId: string, count: number, noncePrefix: string): Promise<void> =>
    withTenant(pool, tenantA, async (q) => {
      await q(
        `INSERT INTO lease (id, tenant_id, license_id, holder_key, concurrency_scope, status, expires_at, nonce, ended_at)
         SELECT gen_random_uuid(), current_setting('app.current_tenant')::uuid, $1, decode(md5(g::text), 'hex'),
                'session', 'reclaimed', now() - make_interval(secs => 60), $3 || g::text, now() - make_interval(secs => 30)
           FROM generate_series(1, $2) g`,
        [licenseId, count, noncePrefix],
      );
    });

  const auditRows = (action: string, target: string): Promise<{ actor: string; after: unknown; securityEvent: boolean }[]> =>
    withTenant(pool, tenantA, async (q) => {
      const r = await q("SELECT actor, after, security_event FROM audit_log WHERE action = $1 AND target = $2 ORDER BY ts DESC, id DESC", [action, target]);
      return (r.rows as { actor: string; after: unknown; security_event: boolean }[]).map((x) => ({ actor: x.actor, after: x.after, securityEvent: x.security_event }));
    });

  const securityEvents = (): Promise<{ actor: string; action: string; target: string | null }[]> =>
    withTenant(pool, tenantA, async (q) => {
      const r = await q("SELECT actor, action, target FROM audit_log WHERE security_event = true ORDER BY ts DESC, id DESC", []);
      return (r.rows as { actor: string; action: string; target: string | null }[]).map((x) => ({ actor: x.actor, action: x.action, target: x.target }));
    });

  const logs = (): string => captured.join("");

  const stop = async (): Promise<void> => {
    if (prevShares === undefined) delete process.env.SIGNING_CUSTODIAN_SHARES;
    else process.env.SIGNING_CUSTODIAN_SHARES = prevShares;
    if (prevRate === undefined) delete process.env.LEASE_RATE_MAX;
    else process.env.LEASE_RATE_MAX = prevRate;
    if (prevSalt === undefined) delete process.env.LEASE_HOLDER_KEY_SALT;
    else process.env.LEASE_HOLDER_KEY_SALT = prevSalt;
    await app.close();
    await pool.end();
    await container.stop();
  };

  return {
    container, pool, app, tenantA, tenantB, productId, customerId,
    leaseKey, leaseKeyB, noScopeKey,
    signer, deps, issueFloating, setLicenseStatus, expireLicense, expireLease, leaseRow, countLive, createActivation,
    acquire, renew, release,
    admin, adminNoCsrf, viewer, adminB, unauth, seedEndedLeases, auditRows, securityEvents,
    nonce, holderRef, logs, holderKeySalt, stop,
  };
}

async function seedUser(pool: pg.Pool, tenantId: string, email: string, role: string): Promise<void> {
  const id = randomUUID();
  await privileged(pool, async (q) => {
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
