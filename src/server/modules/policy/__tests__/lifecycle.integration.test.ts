// T040 [US5] (FR-011/012, SC-008): the versioned, auditable rule lifecycle over the real /admin/policy surface
// (Fastify inject + Testcontainers Postgres) + the issuance-path `evaluate` seam. Proves the US5 guarantees:
//   - IMMUTABLE VERSIONING: a PATCH edit creates a NEW version (v2) and the prior version (v1) is retained
//     (FR-011, SC-008);
//   - PREVIEW (report-only): a `preview` rule is decided INDEPENDENTLY of the enforced active set — it LOGS a
//     would-be decision but NEVER displaces or alters the enforced outcome (FR-012, SC-008);
//   - LIFECYCLE GUARD: a syntactically valid status transition the lifecycle does not permit from the current
//     head state (a no-op same-status, or re-activating a disabled version) → `409 invalid_state_transition`
//     with NO state change.
// Mirrors the E016/E007 admin-session + testcontainers harness.
import { randomUUID } from "node:crypto";
import path from "node:path";

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApp } from "../../../app.js";
import { hmacKey } from "../../../db/hash.js";
import { makePool, privileged, withTenant } from "../../../db/client.js";
import { runMigrations } from "../../../db/migrate.js";
import { provisionTenant } from "../../../db/repository.js";
import { hashPassword } from "../../admin/password.js";

const MIGRATIONS_DIR = path.resolve(process.cwd(), "migrations");
const GUC = "current_setting('app.current_tenant')::uuid";
const SECRET = "policy-lifecycle-secret";
const FIXED_TS = 1_700_000_000_000;

let container: StartedPostgreSqlContainer;
let pool: pg.Pool;
let app: FastifyInstance;

const tenantA = randomUUID();
let entitlementA: string;

async function seedUser(tenantId: string, email: string, role: string): Promise<void> {
  const id = randomUUID();
  await privileged(pool, async (q) => {
    await q(
      `INSERT INTO app_user (id, tenant_id, email_hash, password_hash, status) VALUES ($1, $2, $3, $4, 'active')`,
      [id, tenantId, hmacKey(email.toLowerCase(), SECRET), hashPassword("pw-" + email)],
    );
    await q(`INSERT INTO role (id, tenant_id, user_id, role) VALUES ($1, $2, $3, $4)`, [randomUUID(), tenantId, id, role]);
  });
}

async function seedEntitlement(tenantId: string, key: string, ruleMax: number): Promise<string> {
  return withTenant(pool, tenantId, async (q) => {
    const id = randomUUID();
    await q(
      `INSERT INTO entitlement (id, tenant_id, key, name, type, rule_max, rule_eligible)
       VALUES ($1, ${GUC}, $2, 'API', 'integer_limit', $3, false)`,
      [id, key, ruleMax],
    );
    return id;
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

function authed(method: "GET" | "POST" | "PATCH", url: string, auth: { session: string; csrf: string }, payload?: unknown, withCsrf = true) {
  const headers: Record<string, string> = {};
  if (withCsrf) headers["x-csrf-token"] = auth.csrf;
  return app.inject({ method, url, cookies: { admin_session: auth.session, admin_csrf: auth.csrf }, headers, payload: payload as never });
}

/** Author a rule targeting api_calls with an adjust_limit effect; status defaults to `preview` when omitted. */
async function authorRule(
  auth: { session: string; csrf: string },
  entId: string,
  value: number,
  status?: "active" | "preview" | "disabled",
  priority = 100,
): Promise<string> {
  const res = await authed("POST", "/admin/policy/rules", auth, {
    targetEntitlementId: entId,
    priority,
    ...(status ? { status } : {}),
    condition: { "==": [1, 1] }, // always matches (deterministic)
    effect: { kind: "adjust_limit", target: "api_calls", value },
  });
  if (res.statusCode !== 201) throw new Error(`author rule failed: ${res.statusCode} ${res.body}`);
  return res.json().ruleKey as string;
}

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine").start();
  pool = makePool(container.getConnectionUri(), 8);
  await runMigrations(pool, MIGRATIONS_DIR);
  await provisionTenant(pool, { id: tenantA, slug: "acme-lifecycle" });
  await seedUser(tenantA, "admin@acme.test", "admin");
  entitlementA = await seedEntitlement(tenantA, "api_calls", 50_000);
  app = createApp({ pool, apiKeySecret: SECRET });
  await app.ready();
}, 240_000);

afterAll(async () => {
  await app?.close();
  await pool?.end();
  await container?.stop();
});

describe("policy rule lifecycle — versioning + preview + status guard (integration) — SC-008", () => {
  it("a PATCH edit creates a NEW immutable version and the prior version is retained (FR-011)", async () => {
    const admin = await loginAs("acme-lifecycle", "admin@acme.test");
    const ruleKey = await authorRule(admin, entitlementA, 40_000, "active");

    const edited = await authed("PATCH", `/admin/policy/rules/${ruleKey}`, admin, {
      priority: 100,
      condition: { "==": [1, 1] },
      effect: { kind: "adjust_limit", target: "api_calls", value: 45_000 },
    });
    expect(edited.statusCode).toBe(200);
    expect(edited.json().version).toBe(2);

    // The prior version (v1) is retained immutably; the head is v2 with the new content.
    const detail = await authed("GET", `/admin/policy/rules/${ruleKey}`, admin);
    expect(detail.json().latestVersion).toBe(2);
    const versions = detail.json().versions as Array<{ version: number; effect: { value: number } }>;
    expect(versions.map((v) => v.version)).toEqual([2, 1]);
    expect(versions.find((v) => v.version === 1)!.effect.value).toBe(40_000); // v1 content unchanged
    expect(versions.find((v) => v.version === 2)!.effect.value).toBe(45_000);
  });

  it("a PREVIEW rule logs a would-be decision but does NOT change the enforced outcome (FR-012, SC-008)", async () => {
    const admin = await loginAs("acme-lifecycle", "admin@acme.test");
    const previewEnt = await seedEntitlement(tenantA, "preview_calls", 50_000);
    // An ACTIVE rule (enforced) and a PREVIEW rule (report-only) on the SAME entitlement, distinct rule_keys.
    await authorRule(admin, previewEnt, 40_000, "active", 100); // enforced -> 40000
    await authorRule(admin, previewEnt, 45_000, "preview", 200); // preview would-be -> 45000 (higher priority)

    // Drive the issuance-path seam directly (fixed injected clock) with the target entitlement.
    const r = await app.policy!.evaluate({
      tenantId: tenantA,
      licenseId: randomUUID(),
      mode: "enforced",
      decisionTimestamp: FIXED_TS,
      entitlements: [{ key: "preview_calls", type: "integer_limit", value: 100 }],
    });

    // ENFORCED decision is the ACTIVE rule's value — the preview rule NEVER displaces it (even at higher priority).
    expect(r.decisions.preview_calls).toBe(40_000);

    const enforced = r.evaluations.find((e) => e.mode === "enforced");
    const preview = r.evaluations.find((e) => e.mode === "preview");
    expect(enforced?.decision).toBe(40_000);
    expect(enforced?.firedRule).not.toBeNull();
    // The PREVIEW branch is decided INDEPENDENTLY: its would-be decision is logged report-only (45000), and it is
    // NOT written into the enforced decisions map.
    expect(preview?.decision).toBe(45_000);
    expect(preview?.firedRule).not.toBeNull();
    expect(preview?.enforced).toBe(true); // a preview rule fired its would-be effect (report-only)
  });

  it("an impermissible status transition → 409 invalid_state_transition with NO state change", async () => {
    const admin = await loginAs("acme-lifecycle", "admin@acme.test");
    const guardEnt = await seedEntitlement(tenantA, "guard_calls", 50_000);
    const ruleKey = await authorRule(admin, guardEnt, 40_000, "active");

    // A no-op same-status transition (active -> active) is refused.
    const noop = await authed("POST", `/admin/policy/rules/${ruleKey}/status`, admin, { status: "active" });
    expect(noop.statusCode).toBe(409);
    expect(noop.json().code).toBe("invalid_state_transition");
    expect(noop.json().details).toMatchObject({ from: "active", to: "active" });

    // active -> disabled is permitted.
    const disable = await authed("POST", `/admin/policy/rules/${ruleKey}/status`, admin, { status: "disabled" });
    expect(disable.statusCode).toBe(200);
    expect(disable.json().status).toBe("disabled");

    // disabled -> active is NOT permitted (a disabled version is re-staged via preview, never re-activated) → 409.
    const reactivate = await authed("POST", `/admin/policy/rules/${ruleKey}/status`, admin, { status: "active" });
    expect(reactivate.statusCode).toBe(409);
    expect(reactivate.json().code).toBe("invalid_state_transition");

    // No state changed on the refused transition — the head is still disabled.
    const stillDisabled = await withTenant(pool, tenantA, async (q) => {
      const res = await q("SELECT status FROM policy_rule WHERE rule_key = $1 ORDER BY version DESC LIMIT 1", [ruleKey]);
      return (res.rows[0] as { status: string }).status;
    });
    expect(stillDisabled).toBe("disabled");

    // A malformed status VALUE is a 400 validation_error (distinct from the 409 lifecycle refusal).
    const bad = await authed("POST", `/admin/policy/rules/${ruleKey}/status`, admin, { status: "bogus" });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().code).toBe("validation_error");
  });

  it("an unknown / cross-tenant ruleKey status transition resolves to 404 (never leaks)", async () => {
    const admin = await loginAs("acme-lifecycle", "admin@acme.test");
    const res = await authed("POST", `/admin/policy/rules/${randomUUID()}/status`, admin, { status: "active" });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe("not_found");
  });
});
