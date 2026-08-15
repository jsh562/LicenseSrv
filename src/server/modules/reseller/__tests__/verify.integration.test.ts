// T044 [US5] (FR-013, SC-011): the domain/email-sender verification surface over the real HTTP surface
// (Fastify inject + Testcontainers Postgres) with an INJECTED, deterministic DNS resolver (no real network).
// Asserts:
//   - initiate → verify → activate (pending→verified→active); timestamps set at each step.
//   - verify-before-activate: activating a pending binding is refused 409 not_verified.
//   - verify with an unmet DNS challenge stays pending and returns 409 not_verified.
//   - one-binding-per-host across TWO tenants: the losing verify → 409 binding_conflict; initiating a host
//     already bound to another tenant → 409 binding_conflict (no cross-tenant disclosure).
//   - SC-011: a verified+active domain/email makes the branding field EFFECTIVE (resolved value present).
//   - CSRF/RBAC fail-closed on the mutations.
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
import type { ResellerDeps } from "../index.js";
import { DomainVerifier, type DnsResolver, type DnsRecord } from "../verify.js";

const MIGRATIONS_DIR = path.resolve(process.cwd(), "migrations");
const GUC = "current_setting('app.current_tenant')::uuid";
const SECRET = "reseller-verify-secret";

let container: StartedPostgreSqlContainer;
let pool: pg.Pool;
let app: FastifyInstance;

const resellerR1 = randomUUID();
const resellerR2 = randomUUID();

/** A programmable in-memory DNS resolver — tests "publish" records to make a challenge pass deterministically. */
class ControllableDns implements DnsResolver {
  private readonly txt = new Map<string, string[]>();
  private readonly cname = new Map<string, string[]>();
  publish(records: DnsRecord[]): void {
    for (const r of records) {
      if (r.recordType === "CNAME") this.cname.set(r.name, [r.value]);
      else this.txt.set(r.name, [r.value]);
    }
  }
  reset(): void {
    this.txt.clear();
    this.cname.clear();
  }
  async resolveTxt(name: string): Promise<string[][]> {
    const v = this.txt.get(name);
    if (!v) throw Object.assign(new Error("ENODATA"), { code: "ENODATA" });
    return v.map((s) => [s]);
  }
  async resolveCname(name: string): Promise<string[]> {
    const v = this.cname.get(name);
    if (!v) throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" });
    return v;
  }
}
const dns = new ControllableDns();

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

async function seedReseller(tenantId: string, quota: number): Promise<void> {
  await withTenant(pool, tenantId, (q) => q(`INSERT INTO reseller (tenant_id, status, sub_tenant_quota) VALUES (${GUC}, 'active', $1)`, [quota]));
}

async function loginAs(slug: string, email: string): Promise<{ session: string; csrf: string }> {
  const res = await app.inject({ method: "POST", url: "/admin/auth/login", payload: { tenantSlug: slug, email, password: "pw-" + email } });
  if (res.statusCode !== 200) throw new Error(`login failed: ${res.statusCode} ${res.body}`);
  return {
    session: res.cookies.find((c) => c.name === "admin_session")!.value,
    csrf: res.cookies.find((c) => c.name === "admin_csrf")!.value,
  };
}

function req(
  method: "GET" | "PUT" | "POST",
  url: string,
  auth: { session: string; csrf: string },
  opts: { body?: unknown; csrf?: boolean } = {},
): ReturnType<FastifyInstance["inject"]> {
  const headers: Record<string, string> = {};
  if (opts.csrf !== false) headers["x-csrf-token"] = auth.csrf;
  return app.inject({ method, url, cookies: { admin_session: auth.session, admin_csrf: auth.csrf }, headers, payload: opts.body });
}

interface BindingWire {
  bindingId: string;
  kind: string;
  host: string;
  status: string;
  challenge: DnsRecord[];
  verifiedAt: string | null;
  activatedAt: string | null;
}

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine").start();
  pool = makePool(container.getConnectionUri(), 8);
  await runMigrations(pool, MIGRATIONS_DIR);
  await provisionTenant(pool, { id: resellerR1, slug: "reseller-r1" });
  await provisionTenant(pool, { id: resellerR2, slug: "reseller-r2" });
  await seedReseller(resellerR1, 10);
  await seedReseller(resellerR2, 10);
  await seedUser(resellerR1, "admin@r1.test", "admin");
  await seedUser(resellerR1, "viewer@r1.test", "viewer");
  await seedUser(resellerR2, "admin@r2.test", "admin");
  app = createApp({ pool, apiKeySecret: SECRET });
  await app.ready();
  // INJECT the deterministic DNS resolver (AD-006) — replace the production node:dns verifier on the composed
  // reseller seam so verification is network-free. Routes read `deps.verifier` at call time (same object).
  (app.reseller as ResellerDeps).verifier = new DomainVerifier(pool, dns);
}, 240_000);

afterAll(async () => {
  await app?.close();
  await pool?.end();
  await container?.stop();
});

describe("domain/email verification: initiate → verify → activate (integration)", () => {
  it("initiates a domain binding as pending with a DNS challenge, then verifies then activates", async () => {
    const admin = await loginAs("reseller-r1", "admin@r1.test");
    const host = "licensing.acme.example";

    const init = await req("POST", "/admin/reseller/domains", admin, { body: { kind: "domain", host } });
    expect(init.statusCode).toBe(201);
    const binding = init.json() as BindingWire;
    expect(binding.status).toBe("pending");
    expect(binding.verifiedAt).toBeNull();
    expect(binding.activatedAt).toBeNull();
    expect(binding.challenge.length).toBeGreaterThan(0);

    // Activation before verification is refused 409 not_verified (verify-before-activate, US5-AS1).
    const earlyActivate = await req("POST", `/admin/reseller/domains/${binding.bindingId}/activate`, admin);
    expect(earlyActivate.statusCode).toBe(409);
    expect((earlyActivate.json() as { code: string }).code).toBe("not_verified");

    // Verify with NO DNS published → stays pending, 409 not_verified.
    const unmet = await req("POST", `/admin/reseller/domains/${binding.bindingId}/verify`, admin);
    expect(unmet.statusCode).toBe(409);
    expect((unmet.json() as { code: string }).code).toBe("not_verified");
    const stillPending = await req("GET", `/admin/reseller/domains/${binding.bindingId}`, admin);
    expect((stillPending.json() as BindingWire).status).toBe("pending");

    // Publish the challenge, verify → verified.
    dns.publish(binding.challenge);
    const verified = await req("POST", `/admin/reseller/domains/${binding.bindingId}/verify`, admin);
    expect(verified.statusCode).toBe(200);
    const vb = verified.json() as BindingWire;
    expect(vb.status).toBe("verified");
    expect(vb.verifiedAt).not.toBeNull();
    expect(vb.activatedAt).toBeNull();

    // Activate → active.
    const activated = await req("POST", `/admin/reseller/domains/${binding.bindingId}/activate`, admin);
    expect(activated.statusCode).toBe(200);
    const ab = activated.json() as BindingWire;
    expect(ab.status).toBe("active");
    expect(ab.activatedAt).not.toBeNull();

    // Re-activating is an idempotent no-op (200, still active).
    const again = await req("POST", `/admin/reseller/domains/${binding.bindingId}/activate`, admin);
    expect(again.statusCode).toBe(200);
    expect((again.json() as BindingWire).status).toBe("active");

    // SC-011: the verified+active domain makes the customDomain branding field EFFECTIVE.
    const setBrand = await req("PUT", "/admin/reseller/branding", admin, { body: { fields: { customDomain: host } } });
    expect(setBrand.statusCode).toBe(200);
    const resolved = (setBrand.json() as { resolved: Array<{ field: string; value: string | null; source: string }> }).resolved;
    const cd = resolved.find((r) => r.field === "customDomain")!;
    expect(cd).toMatchObject({ value: host, source: "reseller" });
  });

  it("verifies an email sender via SPF+DKIM/DMARC, then the emailSenderAddress branding field is effective (SC-011)", async () => {
    const admin = await loginAs("reseller-r1", "admin@r1.test");
    const senderDomain = "mail.acme.example";

    const init = await req("POST", "/admin/reseller/domains", admin, { body: { kind: "email_sender", host: senderDomain } });
    expect(init.statusCode).toBe(201);
    const binding = init.json() as BindingWire;
    expect(binding.kind).toBe("email_sender");
    expect(binding.challenge.map((r) => r.purpose).sort()).toEqual(["dkim", "dmarc", "spf"]);

    dns.publish(binding.challenge);
    const verified = await req("POST", `/admin/reseller/domains/${binding.bindingId}/verify`, admin);
    expect(verified.statusCode).toBe(200);
    const activated = await req("POST", `/admin/reseller/domains/${binding.bindingId}/activate`, admin);
    expect(activated.statusCode).toBe(200);

    // emailSenderAddress whose domain matches the active binding is now settable + effective.
    const setBrand = await req("PUT", "/admin/reseller/branding", admin, {
      body: { fields: { emailSenderAddress: `licensing@${senderDomain}` } },
    });
    expect(setBrand.statusCode).toBe(200);
    const resolved = (setBrand.json() as { resolved: Array<{ field: string; value: string | null; source: string }> }).resolved;
    expect(resolved.find((r) => r.field === "emailSenderAddress")).toMatchObject({
      value: `licensing@${senderDomain}`,
      source: "reseller",
    });

    // An UNVERIFIED sender domain is still refused 409 not_verified.
    const bad = await req("PUT", "/admin/reseller/branding", admin, {
      body: { fields: { emailSenderAddress: "licensing@unverified.example" } },
    });
    expect(bad.statusCode).toBe(409);
    expect((bad.json() as { code: string }).code).toBe("not_verified");
  });

  it("enforces one-binding-per-host across two tenants — losing verify → 409 binding_conflict", async () => {
    const a1 = await loginAs("reseller-r1", "admin@r1.test");
    const a2 = await loginAs("reseller-r2", "admin@r2.test");
    const host = "shared.contested.example";

    // Both tenants may hold a PENDING claim on the same host (no squatting lock-out).
    const i1 = await req("POST", "/admin/reseller/domains", a1, { body: { kind: "domain", host } });
    const i2 = await req("POST", "/admin/reseller/domains", a2, { body: { kind: "domain", host } });
    expect(i1.statusCode).toBe(201);
    expect(i2.statusCode).toBe(201);
    const b1 = i1.json() as BindingWire;
    const b2 = i2.json() as BindingWire;

    // t1 publishes + verifies first → wins the host.
    dns.publish(b1.challenge);
    const v1 = await req("POST", `/admin/reseller/domains/${b1.bindingId}/verify`, a1);
    expect(v1.statusCode).toBe(200);

    // t2 (same host) verify now hits the global partial-unique index → 409 binding_conflict, no disclosure.
    dns.publish(b2.challenge);
    const v2 = await req("POST", `/admin/reseller/domains/${b2.bindingId}/verify`, a2);
    expect(v2.statusCode).toBe(409);
    const err = v2.json() as { code: string; details?: { host?: string } };
    expect(err.code).toBe("binding_conflict");

    // t1 activates its winning binding; the host is now firmly t1's.
    const act1 = await req("POST", `/admin/reseller/domains/${b1.bindingId}/activate`, a1);
    expect(act1.statusCode).toBe(200);

    // A FRESH initiate by t2 for the now verified/active host → 409 binding_conflict up front.
    const i2b = await req("POST", "/admin/reseller/domains", a2, { body: { kind: "domain", host } });
    expect(i2b.statusCode).toBe(409);
    expect((i2b.json() as { code: string }).code).toBe("binding_conflict");
  });

  it("lists a tenant's bindings deterministically and returns 404 for an unknown/cross-tenant binding", async () => {
    const a1 = await loginAs("reseller-r1", "admin@r1.test");
    const a2 = await loginAs("reseller-r2", "admin@r2.test");

    const list = await req("GET", "/admin/reseller/domains", a1);
    expect(list.statusCode).toBe(200);
    const bindings = (list.json() as { bindings: BindingWire[] }).bindings;
    expect(bindings.length).toBeGreaterThan(0);
    const hosts = bindings.map((b) => b.host);
    expect([...hosts]).toEqual([...hosts].sort());

    // t2 cannot GET one of t1's bindings — cross-tenant resolves 404 (no disclosure), never 403.
    const someId = bindings[0].bindingId;
    const cross = await req("GET", `/admin/reseller/domains/${someId}`, a2);
    expect(cross.statusCode).toBe(404);

    const unknown = await req("GET", `/admin/reseller/domains/${randomUUID()}`, a1);
    expect(unknown.statusCode).toBe(404);
  });

  it("fails closed on the mutations: no CSRF → 403, and a viewer cannot mutate", async () => {
    const admin = await loginAs("reseller-r1", "admin@r1.test");
    const noCsrf = await req("POST", "/admin/reseller/domains", admin, { body: { kind: "domain", host: "csrf.example" }, csrf: false });
    expect(noCsrf.statusCode).toBe(403);
    const viewer = await loginAs("reseller-r1", "viewer@r1.test");
    const asViewer = await req("POST", "/admin/reseller/domains", viewer, { body: { kind: "domain", host: "viewer.example" } });
    expect(asViewer.statusCode).toBe(403);
  });
});
