// T034 [US5] (FR-015): the operator connection-config admin plane. An admin creates a billing connection
// (the signing secret is WRITE-ONLY — accepted on create, NEVER returned by any response or the secret-
// excluding view); GET lists via the `billing_connection_public` view; a cross-tenant connection id → 404
// (RLS isolation); RBAC (admin-only, a viewer → 403) + CSRF (a mutation without the token → 403) are
// enforced (the E008 admin pattern). Uses the real Testcontainers + admin-session harness.
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { startBillingHarness, type BillingHarness } from "./harness.js";

let h: BillingHarness;
const GEN_SECRET = "whsec_generic_write_only_supersecret_ABC123";

beforeAll(async () => {
  h = await startBillingHarness("connections");
}, 240_000);

afterAll(async () => {
  await h?.stop();
});

describe("operator connection config — secret write-only, RBAC + CSRF (US5, FR-015)", () => {
  let createdId: string;

  it("creates a connection; the write-only secret is NEVER returned by the response", async () => {
    const res = await h.admin("POST", "/admin/billing/connections", {
      provider: "generic",
      signingSecret: GEN_SECRET,
      planMap: { gen_pro: { productId: h.productId, planId: h.planId } },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    createdId = body.id;
    expect(body.provider).toBe("generic");
    expect(body.secretCustodyScheme).toBe("keystore-aes256gcm-v1");
    // The secret appears NOWHERE in the response (no field, no substring).
    expect(body).not.toHaveProperty("signingSecret");
    expect(body).not.toHaveProperty("signing_secret_ref");
    expect(JSON.stringify(body)).not.toContain(GEN_SECRET);
    // The connection id is the webhook {connectionId}; the Location header points at it.
    expect(res.headers.location).toBe(`/admin/billing/connections/${createdId}`);
  });

  it("GET lists connections via the secret-excluding view — the secret is never present", async () => {
    const res = await h.admin("GET", "/admin/billing/connections");
    expect(res.statusCode).toBe(200);
    const rows = res.json().connections as Array<Record<string, unknown>>;
    const created = rows.find((c) => c.id === createdId);
    expect(created).toBeDefined();
    expect(JSON.stringify(rows)).not.toContain(GEN_SECRET);
    expect(JSON.stringify(rows)).not.toContain("whsec_");
    for (const c of rows) expect(c).not.toHaveProperty("signingSecret");
  });

  it("rejects a planMap that references an unknown catalog plan (409 invalid_plan_map)", async () => {
    const res = await h.admin("POST", "/admin/billing/connections", {
      provider: "paddle",
      signingSecret: "whsec_paddle_write_only_secret_XYZ789",
      planMap: { p1: { productId: h.productId, planId: "00000000-0000-0000-0000-000000000000" } },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("invalid_plan_map");
    expect((res.json().details as { reason?: string }).reason).toBe("unknown_plan");
  });

  it("a duplicate connection for the same provider → 409 duplicate_connection", async () => {
    // The harness already created a `stripe` connection for tenant A.
    const res = await h.admin("POST", "/admin/billing/connections", {
      provider: "stripe",
      signingSecret: "whsec_second_stripe_secret_0000000000",
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("duplicate_connection");
  });

  it("a cross-tenant connection id → 404 (RLS isolation)", async () => {
    // Tenant B admin cannot see or mutate tenant A's connection.
    const res = await h.adminB("PATCH", `/admin/billing/connections/${h.connectionId}`, { status: "disabled" });
    expect(res.statusCode).toBe(404);
    // And tenant B's connection list does not include tenant A's connection.
    const list = await h.adminB("GET", "/admin/billing/connections");
    const ids = (list.json().connections as Array<{ id: string }>).map((c) => c.id);
    expect(ids).not.toContain(h.connectionId);
  });

  it("RBAC: a non-admin (viewer) → 403; unauthenticated → 401", async () => {
    expect((await h.viewer("GET", "/admin/billing/connections")).statusCode).toBe(403);
    expect(
      (await h.viewer("POST", "/admin/billing/connections", { provider: "generic", signingSecret: "whsec_viewer_00000000" })).statusCode,
    ).toBe(403);
    expect((await h.unauth("GET", "/admin/billing/connections")).statusCode).toBe(401);
  });

  it("CSRF: a mutation without the double-submit token → 403", async () => {
    const res = await h.adminNoCsrf("POST", "/admin/billing/connections", {
      provider: "generic",
      signingSecret: "whsec_missing_csrf_secret_00000000",
    });
    expect(res.statusCode).toBe(403);
  });

  it("PATCH updates the plan map / grace policy and never returns the secret", async () => {
    const res = await h.admin("PATCH", `/admin/billing/connections/${createdId}`, { defaultGraceSeconds: 604800 });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.defaultGraceSeconds).toBe(604800);
    expect(body).not.toHaveProperty("signingSecret");
    expect(JSON.stringify(body)).not.toContain("whsec_");
  });
});
