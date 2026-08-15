// T023 [US2] (FR-008/014, SC-006/012): hierarchy-safe lock presentation + trust-signal authority, over the real
// HTTP surface (Fastify inject + Testcontainers). Asserts:
//   - a reseller-LOCKED field is surfaced to a sub-tenant as non-editable ("set by your provider") via
//     `lockedFields` + `locked:true`, WITHOUT disclosing that a managing reseller exists (FR-014, SC-012, STF-004).
//   - NO reseller identity (id / slug / name / parent link) ever appears in the sub-tenant's branding response.
//   - TRUST SIGNALS are never white-labelable: a trust-signal field name is rejected as an unknown branding
//     field (400), and never appears in any resolved branding (FR-008, SC-006).
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
import { BRANDING_FIELD_NAMES } from "../branding.js";
import { loadResellerConfig } from "../config.js";

const MIGRATIONS_DIR = path.resolve(process.cwd(), "migrations");
const GUC = "current_setting('app.current_tenant')::uuid";
const SECRET = "reseller-branding-hierarchy-secret";
const config = loadResellerConfig();

let container: StartedPostgreSqlContainer;
let pool: pg.Pool;
let app: FastifyInstance;

const resellerR = randomUUID();
const subA = randomUUID();

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

function req(method: "GET" | "PUT", url: string, auth: { session: string; csrf: string }, body?: unknown): ReturnType<FastifyInstance["inject"]> {
  return app.inject({ method, url, cookies: { admin_session: auth.session, admin_csrf: auth.csrf }, headers: { "x-csrf-token": auth.csrf }, payload: body });
}

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine").start();
  pool = makePool(container.getConnectionUri(), 8);
  await runMigrations(pool, MIGRATIONS_DIR);
  await provisionTenant(pool, { id: resellerR, slug: "reseller-r", name: "Acme Partners" });
  await provisionTenant(pool, { id: subA, slug: "sub-a", name: "Northwind Ltd" });
  await privileged(pool, (q) => q("UPDATE tenant SET parent_reseller_id = $1 WHERE id = $2", [resellerR, subA]));
  await withTenant(pool, resellerR, (q) => q(`INSERT INTO reseller (tenant_id, status, sub_tenant_quota) VALUES (${GUC}, 'active', 10)`));
  await seedUser(resellerR, "admin@r.test", "admin");
  await seedUser(subA, "admin@a.test", "admin");
  app = createApp({ pool, apiKeySecret: SECRET });
  await app.ready();
  // The reseller locks primaryColor + productName.
  const admin = await loginAs("reseller-r", "admin@r.test");
  await req("PUT", "/admin/reseller/branding", admin, {
    fields: { primaryColor: "#0a5", productName: "Acme LM", supportUrl: "https://support.acme.example" },
    locked: ["primaryColor", "productName"],
  });
}, 240_000);

afterAll(async () => {
  await app?.close();
  await pool?.end();
  await container?.stop();
});

describe("hierarchy-safe lock presentation + trust-signal authority (integration)", () => {
  it("a locked field is shown non-editable ('set by your provider') WITHOUT revealing the reseller (SC-012)", async () => {
    const sub = await loginAs("sub-a", "admin@a.test");
    const get = await req("GET", "/admin/branding", sub);
    expect(get.statusCode).toBe(200);
    const body = get.json() as { overrides: Record<string, string>; lockedFields: string[]; resolved: Array<Record<string, unknown>> };
    // Locked fields are surfaced (so the editor renders them non-editable) …
    expect(body.lockedFields.sort()).toEqual(["primaryColor", "productName"]);
    const locked = body.resolved.find((r) => r.field === "primaryColor")!;
    expect(locked.locked).toBe(true);
    // … but the RESELLER identity is NEVER disclosed: no reseller id/slug/name anywhere in the payload.
    const raw = JSON.stringify(body);
    expect(raw).not.toContain(resellerR);
    expect(raw).not.toContain("reseller-r");
    expect(raw).not.toContain("Acme Partners");
    expect(raw.toLowerCase()).not.toContain("resellerid");
    expect(raw).not.toContain("parentReseller");
    // Each resolved entry carries only the presentation shape — no hierarchy field.
    for (const r of body.resolved) expect(Object.keys(r).sort()).toEqual(["field", "locked", "source", "value"]);
  });

  it("trust signals are never a branding field: a trust-signal-named field is rejected 400 (FR-008)", async () => {
    const admin = await loginAs("reseller-r", "admin@r.test");
    for (const sig of config.trustSignals) {
      const put = await req("PUT", "/admin/reseller/branding", admin, { fields: { [sig]: "spoofed" } });
      expect(put.statusCode).toBe(400);
      expect((put.json() as { code: string }).code).toBe("validation_error");
    }
  });

  it("no trust signal ever appears in a resolved branding response (SC-006)", async () => {
    const sub = await loginAs("sub-a", "admin@a.test");
    const get = await req("GET", "/admin/branding", sub);
    const body = get.json() as { resolved: Array<{ field: string }> };
    const fields = new Set(body.resolved.map((r) => r.field));
    for (const sig of config.trustSignals) expect(fields.has(sig)).toBe(false);
    // The resolved set is EXACTLY the 8 branding fields — nothing else can be white-labeled.
    expect([...fields].sort()).toEqual([...BRANDING_FIELD_NAMES].sort());
  });
});
