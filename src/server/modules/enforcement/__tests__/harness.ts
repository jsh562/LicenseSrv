// Shared Testcontainers + real-signer harness for the US1 enforcement integration suites (T015/T016/T017).
// Reuses the E008 issuance + E009 activation harness: spins a Postgres 16 container, runs migrations
// 0000-0009, provisions two tenants, unlocks the REAL E004 keystore signer from Shamir shares, provisions a
// product signing key, and seeds a product/plan/customer + validate/activate API keys. Exposes helpers to
// issue a license, activate a machine (→ an activation with signal hashes), POST /v1/validate, and verify a
// minted short-lived token OFFLINE against the E001 WASM verifier core. NOT a test file (no `.test`/`.spec`
// suffix), so vitest never runs it standalone and coverage ignores __tests__.
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import type { FastifyInstance, InjectOptions } from "fastify";
import type { LightMyRequestResponse } from "fastify";
import type pg from "pg";

import { createApp } from "../../../app.js";
import { makePool, privileged, withTenant } from "../../../db/client.js";
import { hmacKey } from "../../../db/hash.js";
import { runMigrations } from "../../../db/migrate.js";
import { provisionTenant } from "../../../db/repository.js";
import { hashPassword } from "../../admin/password.js";
import { Custody, shamirSplit } from "../../signing/custody.js";
import { listKeys, provisionKey } from "../../signing/registry.js";
import type { Signer } from "../../signing/signer.js";

const require = createRequire(import.meta.url);
const core = require("../../../../bindings/wasm/pkg/licensesrv.js") as {
  Keyring: new () => { add(k: string, p: Uint8Array): number; free(): void };
  verify: (
    kr: unknown,
    token: string,
    now: number,
    anchor: number | null,
    fingerprint: string[] | null,
  ) => { code: number; has(key: string): boolean; limit(key: string): number | undefined; free(): void };
};
const b64urlDecode = (s: string): Buffer => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");

const MIGRATIONS_DIR = path.resolve(process.cwd(), "migrations");
export const SECRET = "enforcement-secret";

interface Auth {
  session: string;
  csrf: string;
}

export interface EnforcementHarness {
  container: StartedPostgreSqlContainer;
  pool: pg.Pool;
  app: FastifyInstance;
  tenantA: string;
  tenantB: string;
  productId: string;
  planId: string;
  /** maxActivations 5 (same as productId's plan). */
  customerId: string;
  /** API key (tenant A) WITH the `validate` scope. */
  validateKey: string;
  /** API key (tenant A) WITH the `activate` scope but WITHOUT `validate` (→ 403 on validate). */
  activateKey: string;
  /** API key (tenant B) WITH the `validate` scope — for the cross-tenant isolation test. */
  validateKeyB: string;
  issueLicense: (planId?: string) => Promise<{ id: string; licenseKey: string }>;
  activateMachine: (licenseId: string, signals: string[]) => Promise<{ activationId: string; machineBoundKey: string }>;
  validate: (apiKey: string | null, body: unknown) => Promise<LightMyRequestResponse>;
  /** POST /v1/heartbeat (US3) — the SAME auth/scope/body/response as `validate`. */
  heartbeat: (apiKey: string | null, body: unknown) => Promise<LightMyRequestResponse>;
  verifyOffline: (token: string, fingerprint: string[]) => Promise<number>;
  /**
   * Verify a token OFFLINE via the E001 WASM core AND read back the requested entitlement claims (FR-017):
   * `code` (0 = accepted), `bool[key]` for boolean entitlements, `int[key]` for integer-limit entitlements.
   */
  verifyEntitlements: (
    token: string,
    fingerprint: string[],
    keys: { bool?: string[]; int?: string[] },
  ) => Promise<{ code: number; bool: Record<string, boolean>; int: Record<string, number | undefined> }>;
  anchorOf: (activationId: string) => Promise<number | null>;
  /** The activation's online-anchor + offline-credential columns (US5 non-regression / staleness checks). */
  activationRow: (
    activationId: string,
  ) => Promise<{ status: string; lastCheckinAt: string | null; lastAnchorAt: string | null; machineBoundToken: string } | null>;
  /** Force a license's `expires_at` (unix seconds, or null to clear) — for the expired-verdict paths. */
  setLicenseExpiry: (licenseId: string, whenUnix: number | null) => Promise<void>;
  /** Revoke a license (status→'revoked') — projected into the CRL revoked-license set (US4). */
  revokeLicense: (licenseId: string) => Promise<void>;
  /** Deactivate an activation (status→'deactivated') — projected into the CRL revoked-activation set (US4). */
  deactivateActivation: (activationId: string) => Promise<void>;
  /** The (tenant A) product's ACTIVE signing key: raw 32-byte public key — used to verify a CRL signature. */
  productPublicKey: () => Promise<Buffer>;
  /** GET /v1/revocation-list (US4) with query params + optional extra headers (e.g. If-None-Match). */
  crlGet: (apiKey: string | null, query: Record<string, string>, headers?: Record<string, string>) => Promise<LightMyRequestResponse>;
  /** The real E004 signer decorated on the app (for direct generateCrl calls in the CRL integration suites). */
  signer: () => Signer;
  nonce: () => string;
  sigs: (...ids: string[]) => string[];
  stop: () => Promise<void>;
}

/** Optional knobs for the harness. `rateMax` sets the per-key rate-limit ceiling (defaults very high). */
export interface HarnessOptions {
  /** ENFORCEMENT_RATE_MAX for this app instance; default 100000 so functional suites never trip the limiter. */
  rateMax?: number;
  /**
   * Fastify `forceCloseConnections` passthrough. Only the perf suite (which binds a REAL loopback listener
   * for autocannon) sets `true`, so `app.close()` force-destroys keep-alive sockets and teardown returns
   * promptly. Omitted (undefined) for every other suite → Fastify's default is unchanged.
   */
  forceCloseConnections?: boolean | "idle";
  /**
   * Optional teardown budget (ms) for the pg pool drain in {@link EnforcementHarness.stop}. Only the perf
   * suite sets it: its autocannon real-socket load can occasionally leave a pool client stuck mid-query, and
   * `pool.end()` would then wait indefinitely and blow the test hook budget. When set, `stop()` caps the
   * drain at this budget and ALWAYS proceeds to stop the container. Omitted (undefined) for every other
   * suite → `pool.end()` is awaited UNBOUNDED exactly as before (no behavior change).
   */
  teardownTimeoutMs?: number;
}

/** Spin the full US1 enforcement harness (container + migrations + real signer + seeded catalog). */
export async function startHarness(slugSuffix: string, opts: HarnessOptions = {}): Promise<EnforcementHarness> {
  const prevShares = process.env.SIGNING_CUSTODIAN_SHARES;
  const prevRate = process.env.ENFORCEMENT_RATE_MAX;
  const shares = shamirSplit(Buffer.alloc(32, 7), 3, 2).slice(0, 2);
  process.env.SIGNING_CUSTODIAN_SHARES = shares.map((s) => s.toString("base64")).join(",");
  // The enforcement config is read at createApp time, so set the ceiling BEFORE the app is built below.
  process.env.ENFORCEMENT_RATE_MAX = String(opts.rateMax ?? 100_000);

  const tenantA = randomUUID();
  const tenantB = randomUUID();

  const container = await new PostgreSqlContainer("postgres:16-alpine").start();
  const pool = makePool(container.getConnectionUri(), 12);
  if (opts.teardownTimeoutMs && opts.teardownTimeoutMs > 0) {
    // Perf suite only: its bounded teardown can stop the Postgres container while pg sockets are still open
    // (an abandoned drain, or a client left stuck mid-query by the abrupt autocannon real-socket load).
    // Backend termination (FATAL 57P01) then emits 'error' on those clients; a CHECKED-OUT client has no
    // pool error listener, so Node would surface it as an UNCAUGHT exception and redden the run. Attach
    // no-op 'error' handlers (the pool, and every client as it connects) so these BENIGN teardown-time
    // socket errors are swallowed. Other suites drain cleanly before stopping the container, never opt in,
    // and are unaffected.
    pool.on("error", () => undefined);
    pool.on("connect", (client) => client.on("error", () => undefined));
  }
  await runMigrations(pool, MIGRATIONS_DIR);
  await provisionTenant(pool, { id: tenantA, slug: `acme-${slugSuffix}` });
  await provisionTenant(pool, { id: tenantB, slug: `other-${slugSuffix}` });
  await seedUser(pool, tenantA, "admin@acme.test", "admin");
  await seedUser(pool, tenantB, "admin@other.test", "admin");

  const app = createApp({ pool, apiKeySecret: SECRET, forceCloseConnections: opts.forceCloseConnections });
  await app.ready();

  const authA = await loginAs(app, `acme-${slugSuffix}`, "admin@acme.test");
  const productId = (await authed(app, "POST", "/admin/catalog/products", authA, { key: "keyed", name: "Keyed" })).json().id as string;
  const custody = new Custody();
  custody.unlock(shares);
  await provisionKey(pool, tenantA, productId, custody, "test-setup");
  const planId = (await authed(app, "POST", `/admin/catalog/products/${productId}/plans`, authA, { key: "pro", name: "Pro", maxActivations: 5 })).json().id as string;
  const customerId = (await authed(app, "POST", "/admin/customers", authA, { ref: "cust-1" })).json().id as string;
  const validateKey = (await authed(app, "POST", "/admin/api-keys", authA, { scopes: ["validate"] })).json().secret as string;
  const activateKey = (await authed(app, "POST", "/admin/api-keys", authA, { scopes: ["activate"] })).json().secret as string;

  const authB = await loginAs(app, `other-${slugSuffix}`, "admin@other.test");
  const validateKeyB = (await authed(app, "POST", "/admin/api-keys", authB, { scopes: ["validate"] })).json().secret as string;

  let nonceSeq = 0;
  const nonce = (): string => `${randomUUID().replace(/-/g, "")}${randomUUID().replace(/-/g, "")}${(nonceSeq++).toString(16)}`;
  const sigs = (...ids: string[]): string[] => ids.map((s) => `sighash-${s}`);

  const issueLicense = async (plan: string = planId): Promise<{ id: string; licenseKey: string }> => {
    const r = await authed(app, "POST", "/admin/licenses", authA, { planId: plan, customerId });
    if (r.statusCode !== 201) throw new Error(`issue failed: ${r.statusCode} ${r.body}`);
    return r.json();
  };

  const activateMachine = async (licenseId: string, signals: string[]): Promise<{ activationId: string; machineBoundKey: string }> => {
    const r = await app.inject({ method: "POST", url: "/v1/activations", headers: { "x-api-key": activateKey }, payload: { licenseId, fingerprint: { signals }, nonce: nonce() } as never });
    if (r.statusCode !== 201) throw new Error(`activate failed: ${r.statusCode} ${r.body}`);
    const body = r.json() as { id: string; machineBoundKey: string };
    return { activationId: body.id, machineBoundKey: body.machineBoundKey };
  };

  const post = (url: string, apiKey: string | null, body: unknown): Promise<LightMyRequestResponse> => {
    const headers: Record<string, string> = {};
    if (apiKey) headers["x-api-key"] = apiKey;
    const opts: InjectOptions = { method: "POST", url, headers, payload: body as never };
    return app.inject(opts);
  };
  const validate = (apiKey: string | null, body: unknown): Promise<LightMyRequestResponse> => post("/v1/validate", apiKey, body);
  const heartbeat = (apiKey: string | null, body: unknown): Promise<LightMyRequestResponse> => post("/v1/heartbeat", apiKey, body);

  const verifyOffline = async (token: string, fingerprint: string[]): Promise<number> => {
    const keys = await listKeys(pool, tenantA, productId);
    const active = keys.find((k) => k.status === "active")!;
    const kr = new core.Keyring();
    kr.add(active.keyId, b64urlDecode(active.publicKey));
    const r = core.verify(kr, token, Math.floor(Date.now() / 1000), null, fingerprint);
    const code = r.code;
    r.free();
    kr.free();
    return code;
  };

  const verifyEntitlements = async (
    token: string,
    fingerprint: string[],
    keys: { bool?: string[]; int?: string[] },
  ): Promise<{ code: number; bool: Record<string, boolean>; int: Record<string, number | undefined> }> => {
    const active = (await listKeys(pool, tenantA, productId)).find((k) => k.status === "active")!;
    const kr = new core.Keyring();
    kr.add(active.keyId, b64urlDecode(active.publicKey));
    const r = core.verify(kr, token, Math.floor(Date.now() / 1000), null, fingerprint);
    const bool: Record<string, boolean> = {};
    const int: Record<string, number | undefined> = {};
    for (const k of keys.bool ?? []) bool[k] = r.has(k);
    for (const k of keys.int ?? []) int[k] = r.limit(k);
    const code = r.code;
    r.free();
    kr.free();
    return { code, bool, int };
  };

  const anchorOf = (activationId: string): Promise<number | null> =>
    withTenant(pool, tenantA, async (q) => {
      const r = await q("SELECT extract(epoch FROM last_anchor_at)::bigint AS a FROM activation WHERE id = $1", [activationId]);
      const a = (r.rows[0] as { a: string | null } | undefined)?.a;
      return a == null ? null : Number(a);
    });

  const activationRow = (
    activationId: string,
  ): Promise<{ status: string; lastCheckinAt: string | null; lastAnchorAt: string | null; machineBoundToken: string } | null> =>
    withTenant(pool, tenantA, async (q) => {
      const r = await q(
        "SELECT status, last_checkin_at, last_anchor_at, machine_bound_token FROM activation WHERE id = $1",
        [activationId],
      );
      const row = r.rows[0] as
        | { status: string; last_checkin_at: Date | null; last_anchor_at: Date | null; machine_bound_token: string }
        | undefined;
      if (!row) return null;
      return {
        status: row.status,
        lastCheckinAt: row.last_checkin_at ? row.last_checkin_at.toISOString() : null,
        lastAnchorAt: row.last_anchor_at ? row.last_anchor_at.toISOString() : null,
        machineBoundToken: row.machine_bound_token,
      };
    });

  const setLicenseExpiry = (licenseId: string, whenUnix: number | null): Promise<void> =>
    withTenant(pool, tenantA, async (q) => {
      await q(
        "UPDATE license SET expires_at = CASE WHEN $2::double precision IS NULL THEN NULL ELSE to_timestamp($2) END, updated_at = now() WHERE id = $1",
        [licenseId, whenUnix],
      );
    });

  const revokeLicense = (licenseId: string): Promise<void> =>
    withTenant(pool, tenantA, async (q) => {
      await q("UPDATE license SET status = 'revoked', updated_at = now() WHERE id = $1", [licenseId]);
    });

  const deactivateActivation = (activationId: string): Promise<void> =>
    withTenant(pool, tenantA, async (q) => {
      await q("UPDATE activation SET status = 'deactivated', deactivated_at = now(), updated_at = now() WHERE id = $1", [activationId]);
    });

  const productPublicKey = async (): Promise<Buffer> => {
    const active = (await listKeys(pool, tenantA, productId)).find((k) => k.status === "active")!;
    return b64urlDecode(active.publicKey);
  };

  const crlGet = (
    apiKey: string | null,
    query: Record<string, string>,
    headers: Record<string, string> = {},
  ): Promise<LightMyRequestResponse> => {
    const qs = new URLSearchParams(query).toString();
    const hdrs: Record<string, string> = { ...headers };
    if (apiKey) hdrs["x-api-key"] = apiKey;
    return app.inject({ method: "GET", url: `/v1/revocation-list?${qs}`, headers: hdrs });
  };

  const signer = (): Signer => {
    const s = (app as FastifyInstance & { signer?: Signer }).signer;
    if (!s) throw new Error("harness: app.signer is not configured");
    return s;
  };

  const stop = async (): Promise<void> => {
    if (prevShares === undefined) delete process.env.SIGNING_CUSTODIAN_SHARES;
    else process.env.SIGNING_CUSTODIAN_SHARES = prevShares;
    if (prevRate === undefined) delete process.env.ENFORCEMENT_RATE_MAX;
    else process.env.ENFORCEMENT_RATE_MAX = prevRate;
    await app.close();
    // Drain the pg pool. Normally this completes in milliseconds. The perf suite (which sets
    // `teardownTimeoutMs`) drives a REAL loopback listener under autocannon load that can leave a pool client
    // stuck mid-query at an abrupt teardown; there an unbounded `pool.end()` would wait indefinitely and blow
    // the test hook budget. When a budget is set we cap the drain and ALWAYS proceed to stop the container so
    // teardown is prompt and deterministic. A late settle of the abandoned drain is swallowed so it never
    // surfaces as an unhandled rejection. Every other suite passes no budget → `pool.end()` is awaited
    // unbounded exactly as before.
    const budgetMs = opts.teardownTimeoutMs;
    if (budgetMs && budgetMs > 0) {
      const drain = pool.end();
      drain.catch(() => undefined); // swallow a late rejection of an abandoned (timed-out) drain
      let timer: ReturnType<typeof setTimeout> | undefined;
      const budget = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, budgetMs);
        timer.unref?.();
      });
      await Promise.race([drain.then(() => undefined, () => undefined), budget]);
      if (timer) clearTimeout(timer);
    } else {
      await pool.end();
    }
    await container.stop();
  };

  return {
    container, pool, app, tenantA, tenantB, productId, planId, customerId,
    validateKey, activateKey, validateKeyB,
    issueLicense, activateMachine, validate, heartbeat, verifyOffline, verifyEntitlements,
    anchorOf, activationRow, setLicenseExpiry, revokeLicense, deactivateActivation,
    productPublicKey, crlGet, signer, nonce, sigs, stop,
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
