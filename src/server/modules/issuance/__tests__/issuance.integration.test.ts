// Full /admin licensing surface against real Postgres via Fastify inject (US1–US5): issue → signed LIC1
// that verifies offline against the product's key, snapshot immutability, the lifecycle state machine
// (revoke/suspend/reinstate/transfer + invalid transitions + transfer limit), signer-unavailable 503,
// customers + GDPR erasure, RBAC (viewer 403 + security_event), tenant isolation, and audit coverage.
// The signer is unlocked via env custodian shares; a key is provisioned for the "keyed" product.
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import path from "node:path";

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApp } from "../../../app.js";
import { makePool, privileged, withTenant } from "../../../db/client.js";
import { hmacKey } from "../../../db/hash.js";
import { runMigrations } from "../../../db/migrate.js";
import { provisionTenant } from "../../../db/repository.js";
import { hashPassword } from "../../admin/password.js";
import { Custody, shamirSplit } from "../../signing/custody.js";
import { listKeys, provisionKey } from "../../signing/registry.js";

const require = createRequire(import.meta.url);
const core = require("../../../../bindings/wasm/pkg/licensesrv.js") as {
  Keyring: new () => { add(k: string, p: Uint8Array): number; free(): void };
  verify: (kr: unknown, t: string, n: number) => { code: number; has(k: string): boolean; limit(k: string): number | undefined; free(): void };
};
const b64urlDecode = (s: string): Buffer => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");

const MIGRATIONS_DIR = path.resolve(process.cwd(), "migrations");
const SECRET = "issuance-secret";

let container: StartedPostgreSqlContainer;
let pool: pg.Pool;
let app: FastifyInstance;
let prevShares: string | undefined;
let prevLimit: string | undefined;

const tenantA = randomUUID();
const tenantB = randomUUID();

// Catalog + key ids set up in beforeAll.
let keyedProductId: string;
let keyedPlanId: string;
let noKeyPlanId: string;
let boolEntId: string;
let intEntId: string;
let customerId: string;

async function seedUser(tenantId: string, email: string, role: string): Promise<void> {
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

async function loginAs(slug: string, email: string): Promise<{ session: string; csrf: string }> {
  const res = await app.inject({ method: "POST", url: "/admin/auth/login", payload: { tenantSlug: slug, email, password: "pw-" + email } });
  if (res.statusCode !== 200) throw new Error(`login failed: ${res.statusCode} ${res.body}`);
  return {
    session: res.cookies.find((c) => c.name === "admin_session")!.value,
    csrf: res.cookies.find((c) => c.name === "admin_csrf")!.value,
  };
}

function authed(method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", url: string, auth: { session: string; csrf: string }, payload?: unknown, withCsrf = true) {
  const headers: Record<string, string> = {};
  if (withCsrf) headers["x-csrf-token"] = auth.csrf;
  return app.inject({ method, url, cookies: { admin_session: auth.session, admin_csrf: auth.csrf }, headers, payload: payload as never });
}

beforeAll(async () => {
  // Unlock the signer at boot via custodian shares; a low transfer limit exercises the at-limit refusal.
  const shares = shamirSplit(Buffer.alloc(32, 7), 3, 2).slice(0, 2);
  prevShares = process.env.SIGNING_CUSTODIAN_SHARES;
  prevLimit = process.env.LICENSE_TRANSFER_LIMIT;
  process.env.SIGNING_CUSTODIAN_SHARES = shares.map((s) => s.toString("base64")).join(",");
  process.env.LICENSE_TRANSFER_LIMIT = "2";

  container = await new PostgreSqlContainer("postgres:16-alpine").start();
  pool = makePool(container.getConnectionUri(), 8);
  await runMigrations(pool, MIGRATIONS_DIR);
  await provisionTenant(pool, { id: tenantA, slug: "acme" });
  await provisionTenant(pool, { id: tenantB, slug: "other" });
  await seedUser(tenantA, "admin@acme.test", "admin");
  await seedUser(tenantA, "viewer@acme.test", "viewer");
  await seedUser(tenantB, "admin@other.test", "admin");

  app = createApp({ pool, apiKeySecret: SECRET });
  await app.ready();

  const auth = await loginAs("acme", "admin@acme.test");
  // Keyed product (+ provision a signing key) with a plan granting a boolean + an integer entitlement.
  keyedProductId = (await authed("POST", "/admin/catalog/products", auth, { key: "keyed", name: "Keyed" })).json().id;
  const custody = new Custody();
  custody.unlock(shares);
  await provisionKey(pool, tenantA, keyedProductId, custody, "test-setup");

  keyedPlanId = (await authed("POST", `/admin/catalog/products/${keyedProductId}/plans`, auth, { key: "pro", name: "Pro", maxActivations: 5 })).json().id;
  boolEntId = (await authed("POST", "/admin/catalog/entitlements", auth, { key: "export-pdf", name: "Export", type: "boolean" })).json().id;
  intEntId = (await authed("POST", "/admin/catalog/entitlements", auth, { key: "seats", name: "Seats", type: "integer_limit" })).json().id;
  await authed("PUT", `/admin/catalog/plans/${keyedPlanId}/entitlements/${boolEntId}`, auth, { value: true });
  await authed("PUT", `/admin/catalog/plans/${keyedPlanId}/entitlements/${intEntId}`, auth, { value: 42 });

  // A product with NO signing key, for the signer-unavailable path.
  const noKeyProductId = (await authed("POST", "/admin/catalog/products", auth, { key: "nokey", name: "NoKey" })).json().id;
  noKeyPlanId = (await authed("POST", `/admin/catalog/products/${noKeyProductId}/plans`, auth, { key: "nk", name: "NK" })).json().id;

  customerId = (await authed("POST", "/admin/customers", auth, { ref: "cust-1", name: "Acme", email: "ops@acme.test" })).json().id;
}, 240_000);

afterAll(async () => {
  if (prevShares === undefined) delete process.env.SIGNING_CUSTODIAN_SHARES;
  else process.env.SIGNING_CUSTODIAN_SHARES = prevShares;
  if (prevLimit === undefined) delete process.env.LICENSE_TRANSFER_LIMIT;
  else process.env.LICENSE_TRANSFER_LIMIT = prevLimit;
  await app?.close();
  await pool?.end();
  await container?.stop();
});

/** Verify a LIC1 token offline against the keyed product's key via the real core. Entitlement checks are
 * evaluated eagerly (before freeing the wasm result — reading a freed object is a null-pointer fault). */
async function verifyOffline(
  token: string,
  boolKeys: string[] = [],
  intKeys: string[] = [],
): Promise<{ code: number; bools: Record<string, boolean>; limits: Record<string, number | undefined> }> {
  const keys = await listKeys(pool, tenantA, keyedProductId);
  const active = keys.find((k) => k.status === "active")!;
  const kr = new core.Keyring();
  kr.add(active.keyId, b64urlDecode(active.publicKey));
  const r = core.verify(kr, token, Math.floor(Date.now() / 1000));
  const result = {
    code: r.code,
    bools: Object.fromEntries(boolKeys.map((k) => [k, r.has(k)])),
    limits: Object.fromEntries(intKeys.map((k) => [k, r.limit(k)])),
  };
  r.free();
  kr.free();
  return result;
}

async function issue(auth: { session: string; csrf: string }, body: unknown) {
  return authed("POST", "/admin/licenses", auth, body);
}

describe("license issuance & lifecycle (integration, real Postgres)", () => {
  it("US1: issues a signed license that verifies offline and embeds entitlements/seat/expiry (SC-001/002)", async () => {
    const auth = await loginAs("acme", "admin@acme.test");
    const res = await issue(auth, { planId: keyedPlanId, customerId, expiresAt: "2030-01-01T00:00:00Z" });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { id: string; licenseKey: string; maxActivations: number; expiresAt: string; entitlements: Record<string, unknown> };
    expect(body.licenseKey).toMatch(/^LIC1\./);
    expect(body.maxActivations).toBe(5); // snapshot seat limit
    expect(body.entitlements).toEqual({ "export-pdf": true, seats: 42 });

    const v = await verifyOffline(body.licenseKey, ["export-pdf"], ["seats"]);
    expect(v.code).toBe(0); // valid offline
    expect(v.bools["export-pdf"]).toBe(true);
    expect(v.limits["seats"]).toBe(42);
  });

  it("US1: supports a perpetual license (no expiry)", async () => {
    const auth = await loginAs("acme", "admin@acme.test");
    const res = await issue(auth, { planId: keyedPlanId, customerId });
    expect(res.statusCode).toBe(201);
    expect(res.json().expiresAt).toBeNull();
    expect((await verifyOffline(res.json().licenseKey)).code).toBe(0);
  });

  it("US1: refuses issuance under an unavailable signer (no active key) → 503, no license created", async () => {
    const auth = await loginAs("acme", "admin@acme.test");
    const before = (await authed("GET", `/admin/licenses?planId=${noKeyPlanId}`, auth)).json().licenses.length;
    const res = await issue(auth, { planId: noKeyPlanId, customerId });
    expect(res.statusCode).toBe(503);
    expect(res.json().code).toBe("signer_unavailable");
    const after = (await authed("GET", `/admin/licenses?planId=${noKeyPlanId}`, auth)).json().licenses.length;
    expect(after).toBe(before); // nothing inserted
  });

  it("US1: refuses issuance under an archived plan (409) and snapshots immutably (SC-003)", async () => {
    const auth = await loginAs("acme", "admin@acme.test");
    // Issue, then edit the plan's entitlement value — the issued license keeps its snapshot.
    const lic = (await issue(auth, { planId: keyedPlanId, customerId })).json();
    await authed("PUT", `/admin/catalog/plans/${keyedPlanId}/entitlements/${intEntId}`, auth, { value: 999 });
    const after = (await authed("GET", `/admin/licenses/${lic.id}`, auth)).json();
    expect(after.entitlements.seats).toBe(42); // unchanged by the catalog edit
    await authed("PUT", `/admin/catalog/plans/${keyedPlanId}/entitlements/${intEntId}`, auth, { value: 42 }); // restore

    // Archived plan → 409 plan_not_issuable.
    const prod = (await authed("POST", "/admin/catalog/products", auth, { key: "arch", name: "Arch" })).json();
    await provisionKey(pool, tenantA, prod.id, (() => { const c = new Custody(); c.unlock(shamirSplit(Buffer.alloc(32, 7), 3, 2).slice(0, 2)); return c; })(), "t");
    const plan = (await authed("POST", `/admin/catalog/products/${prod.id}/plans`, auth, { key: "ap", name: "AP" })).json();
    await authed("POST", `/admin/catalog/plans/${plan.id}/archive`, auth);
    const res = await issue(auth, { planId: plan.id, customerId });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("plan_not_issuable");
  });

  it("US2: revoke is terminal + idempotent; a revoked license refuses reinstate/transfer", async () => {
    const auth = await loginAs("acme", "admin@acme.test");
    const lic = (await issue(auth, { planId: keyedPlanId, customerId })).json();
    expect((await authed("POST", `/admin/licenses/${lic.id}/revoke`, auth)).json().status).toBe("revoked");
    expect((await authed("POST", `/admin/licenses/${lic.id}/revoke`, auth)).statusCode).toBe(200); // idempotent
    expect((await authed("POST", `/admin/licenses/${lic.id}/reinstate`, auth)).statusCode).toBe(409);
    const t = await authed("POST", `/admin/licenses/${lic.id}/transfer`, auth, { customerId });
    expect(t.statusCode).toBe(409);
    expect(t.json().code).toBe("invalid_transition");
  });

  it("US3: suspend and reinstate; reinstate of a non-suspended license → 409", async () => {
    const auth = await loginAs("acme", "admin@acme.test");
    const lic = (await issue(auth, { planId: keyedPlanId, customerId })).json();
    expect((await authed("POST", `/admin/licenses/${lic.id}/suspend`, auth)).json().status).toBe("suspended");
    expect((await authed("POST", `/admin/licenses/${lic.id}/reinstate`, auth)).json().status).toBe("active");
    expect((await authed("POST", `/admin/licenses/${lic.id}/reinstate`, auth)).statusCode).toBe(409); // not suspended
  });

  it("US4: transfer within the limit; the at-limit transfer is refused (SC-006)", async () => {
    const auth = await loginAs("acme", "admin@acme.test");
    const c2 = (await authed("POST", "/admin/customers", auth, { ref: "c2" })).json().id;
    const c3 = (await authed("POST", "/admin/customers", auth, { ref: "c3" })).json().id;
    const lic = (await issue(auth, { planId: keyedPlanId, customerId })).json();
    expect((await authed("POST", `/admin/licenses/${lic.id}/transfer`, auth, { customerId: c2 })).json().customerId).toBe(c2);
    expect((await authed("POST", `/admin/licenses/${lic.id}/transfer`, auth, { customerId: c3 })).json().transferCount).toBe(2);
    // Limit is 2 → the third transfer is refused.
    const over = await authed("POST", `/admin/licenses/${lic.id}/transfer`, auth, { customerId });
    expect(over.statusCode).toBe(409);
    expect(over.json().code).toBe("transfer_limit_exceeded");
  });

  it("US5: registry list/get/key; a viewer cannot issue (403 + security_event); tenant isolation", async () => {
    const admin = await loginAs("acme", "admin@acme.test");
    const lic = (await issue(admin, { planId: keyedPlanId, customerId })).json();
    expect((await authed("GET", `/admin/licenses/${lic.id}`, admin)).json()).toMatchObject({ status: "active", planId: keyedPlanId });
    expect((await authed("GET", `/admin/licenses/${lic.id}/key`, admin)).json().licenseKey).toMatch(/^LIC1\./);

    const viewer = await loginAs("acme", "viewer@acme.test");
    expect((await authed("GET", "/admin/licenses", viewer)).statusCode).toBe(200); // viewer can read
    const denied = await issue(viewer, { planId: keyedPlanId, customerId });
    expect(denied.statusCode).toBe(403);
    const events = await privileged(pool, async (q) => {
      const r = await q(`SELECT count(*)::int AS n FROM audit_log WHERE tenant_id = $1 AND action = 'authz.denied' AND security_event = true`, [tenantA]);
      return (r.rows[0] as { n: number }).n;
    });
    expect(events).toBeGreaterThanOrEqual(1);

    // Tenant B sees none of tenant A's licenses; a cross-tenant id → 404.
    const b = await loginAs("other", "admin@other.test");
    expect((await authed("GET", "/admin/licenses", b)).json().licenses.length).toBe(0);
    expect((await authed("GET", `/admin/licenses/${lic.id}`, b)).statusCode).toBe(404);
  });

  it("customers: erase hard-deletes a license-free customer and anonymizes a license-holding one (FR-019)", async () => {
    const auth = await loginAs("acme", "admin@acme.test");
    // License-free → hard delete.
    const free = (await authed("POST", "/admin/customers", auth, { ref: "free", name: "Free", email: "free@acme.test" })).json().id;
    expect((await authed("DELETE", `/admin/customers/${free}`, auth)).statusCode).toBe(204);
    expect((await authed("GET", `/admin/customers/${free}`, auth)).statusCode).toBe(404);

    // Holds a license → anonymize (name/email cleared, ref kept, status anonymized).
    const held = (await authed("POST", "/admin/customers", auth, { ref: "held", name: "Held", email: "held@acme.test" })).json().id;
    await issue(auth, { planId: keyedPlanId, customerId: held });
    expect((await authed("DELETE", `/admin/customers/${held}`, auth)).statusCode).toBe(204);
    const after = (await authed("GET", `/admin/customers/${held}`, auth)).json();
    expect(after).toMatchObject({ ref: "held", name: null, email: null, status: "anonymized" });
  });

  it("audit: issuance + lifecycle + customer actions are recorded, with no PII or signing key (FR-014/SC-010)", async () => {
    const { actions, blob } = await withTenant(pool, tenantA, async (q) => {
      const a = await q(`SELECT DISTINCT action FROM audit_log WHERE action LIKE 'license.%' OR action LIKE 'customer.%'`, []);
      // The full serialized audit trail for this tenant — nothing in it may leak PII or key material.
      const b = await q(`SELECT coalesce(string_agg(to_jsonb(audit_log)::text, ' '), '') AS blob FROM audit_log`, []);
      return { actions: (a.rows as { action: string }[]).map((x) => x.action), blob: (b.rows[0] as { blob: string }).blob };
    });
    expect(actions).toEqual(
      expect.arrayContaining(["license.issued", "license.revoked", "license.suspended", "license.transferred", "customer.created", "customer.anonymized"]),
    );
    // FR-014/SC-010: the audit records actor/action/target only — never the erased PII (name/email) nor a signing key.
    expect(blob).not.toContain("held@acme.test");
    expect(blob).not.toContain("free@acme.test");
    expect(blob).not.toContain("BEGIN PRIVATE KEY");
  });

  it("US1: refuses issuance when the plan references an archived entitlement (FR-005)", async () => {
    const auth = await loginAs("acme", "admin@acme.test");
    // A fresh plan under the keyed product, attached to a brand-new entitlement we then archive.
    const plan = (await authed("POST", `/admin/catalog/products/${keyedProductId}/plans`, auth, { key: "arch-ent", name: "ArchEnt" })).json();
    const ent = (await authed("POST", "/admin/catalog/entitlements", auth, { key: "temp-feat", name: "Temp", type: "boolean" })).json();
    await authed("PUT", `/admin/catalog/plans/${plan.id}/entitlements/${ent.id}`, auth, { value: true });
    await authed("POST", `/admin/catalog/entitlements/${ent.id}/archive`, auth);
    const res = await issue(auth, { planId: plan.id, customerId });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("plan_not_issuable");
  });

  it("customers: refuses issuance to an erased (anonymized) customer (FR-019)", async () => {
    const auth = await loginAs("acme", "admin@acme.test");
    const cust = (await authed("POST", "/admin/customers", auth, { ref: "to-erase" })).json().id;
    await issue(auth, { planId: keyedPlanId, customerId: cust }); // holds a license → erase anonymizes (keeps the row)
    expect((await authed("DELETE", `/admin/customers/${cust}`, auth)).statusCode).toBe(204);
    const res = await issue(auth, { planId: keyedPlanId, customerId: cust });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("customer_anonymized");
  });

  it("perf: a single issuance (snapshot + sign + conformance + insert) completes well under 1s (SC-001)", async () => {
    const auth = await loginAs("acme", "admin@acme.test");
    const started = Date.now();
    const res = await issue(auth, { planId: keyedPlanId, customerId });
    expect(res.statusCode).toBe(201);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
