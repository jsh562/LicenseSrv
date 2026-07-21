// T047 [COMPLETES FR-014] (SC-011): every billing operation is tenant-scoped. Tenant B's session cannot
// read or mutate tenant A's connection / subscription / events (a cross-tenant reference resolves to 404,
// never 403), and a webhook delivered to tenant B's connection can never touch tenant A's subscription (RLS
// confines effects to the tenant that owns the resolving {connectionId}). The forced-RLS guarantee is
// re-asserted directly: with the tenant GUC UNSET, all three billing tables yield 0 rows despite data being
// present. Uses the real Testcontainers + admin-session harness.
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { withTenant } from "../../../db/client.js";
import { ConnectionRepo } from "../connection-repo.js";
import { createdEvent, renewalEvent, startBillingHarness, type BillingHarness } from "./harness.js";

let h: BillingHarness;
let tenantBConnId: string;
let subAId: string;
const TENANT_B_SECRET = "whsec_tenantB_isolation_secret_1234567890";
const BASE = Math.floor(Date.now() / 1000);

beforeAll(async () => {
  h = await startBillingHarness("isolation");
  // A tenant-A managed subscription (the cross-tenant target).
  await h.postWebhook(h.connectionId, createdEvent(h.eventId(), "sub_iso_A"));
  const subA = await h.getSubscription("sub_iso_A");
  subAId = subA!.id;
  // Tenant B gets its OWN stripe connection (distinct secret, empty plan map) — so a webhook can be delivered
  // to tenant B while referencing tenant A's external subscription id, to prove the effect cannot cross.
  const deps = h.billingDeps();
  const repoB = new ConnectionRepo(h.pool, deps.custody, deps.config);
  const connB = await repoB.create(h.tenantB, "test-setup", { provider: "stripe", signingSecret: TENANT_B_SECRET });
  tenantBConnId = connB.id;
}, 240_000);

afterAll(async () => {
  await h?.stop();
});

describe("multi-tenant isolation — cross-tenant → 404; forced RLS (FR-014, SC-011)", () => {
  it("forced RLS: an UNSET tenant GUC yields 0 rows on all three billing tables (despite data present)", async () => {
    const client = await h.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE licensesrv_app"); // the non-owner app role — RLS is FORCED
      // No `app.current_tenant` GUC is set → the tenant_isolation policy matches nothing.
      for (const table of ["billing_connection", "subscription", "billing_event"]) {
        const r = await client.query(`SELECT count(*)::int AS n FROM ${table}`);
        expect((r.rows[0] as { n: number }).n).toBe(0);
      }
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  });

  it("tenant B cannot read or mutate tenant A's connection (cross-tenant → 404, list excludes it)", async () => {
    const patch = await h.adminB("PATCH", `/admin/billing/connections/${h.connectionId}`, { status: "disabled" });
    expect(patch.statusCode).toBe(404);

    const list = await h.adminB("GET", "/admin/billing/connections");
    expect(list.statusCode).toBe(200);
    const ids = (list.json().connections as Array<{ id: string }>).map((c) => c.id);
    expect(ids).not.toContain(h.connectionId); // tenant A's connection is invisible to tenant B
    expect(ids).toContain(tenantBConnId); // but tenant B sees its own
  });

  it("tenant B's registry reads never surface tenant A's subscriptions or events", async () => {
    const subs = await h.adminB("GET", "/admin/billing/subscriptions");
    expect(subs.statusCode).toBe(200);
    const subRows = subs.json().subscriptions as Array<{ id: string; externalSubscriptionId: string }>;
    expect(subRows.some((s) => s.id === subAId)).toBe(false);
    expect(subRows.some((s) => s.externalSubscriptionId === "sub_iso_A")).toBe(false);

    const events = await h.adminB("GET", "/admin/billing/events");
    expect(events.statusCode).toBe(200);
    const evRows = events.json().events as Array<{ subscriptionId: string | null }>;
    expect(evRows.some((e) => e.subscriptionId === subAId)).toBe(false); // tenant A's sub never appears
  });

  it("tenant B cannot scope a reconcile at tenant A's subscription (cross-tenant → 404)", async () => {
    const res = await h.adminB("POST", "/admin/billing/reconcile", { subscriptionId: subAId });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe("not_found");
  });

  it("a webhook to tenant B's connection cannot mutate tenant A's subscription (RLS confines the effect)", async () => {
    const before = await h.getSubscription("sub_iso_A");
    expect(before!.billingState).toBe("active");

    // A validly-signed renewal for tenant A's external subscription id, delivered to TENANT B's connection.
    const evId = h.eventId();
    const res = await h.postWebhook(tenantBConnId, renewalEvent(evId, "sub_iso_A", { occurred: BASE + 900 }), {
      secret: TENANT_B_SECRET,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().outcome).toBe("deadletter"); // unmapped IN TENANT B — the sub does not resolve there

    // Tenant A's subscription is untouched, and no ledger row for this event exists in tenant A.
    const after = await h.getSubscription("sub_iso_A");
    expect(after!.billingState).toBe("active");
    expect(after!.lastAppliedEventAt).toBe(before!.lastAppliedEventAt);
    expect(await h.countEventRows(evId)).toBe(0); // the deadletter row is tenant B's, invisible to tenant A

    // Direct RLS check: the event id IS present under tenant B, absent under tenant A.
    const inB = await withTenant(h.pool, h.tenantB, async (q) => {
      const r = await q("SELECT count(*)::int AS n FROM billing_event WHERE provider_event_id = $1", [evId]);
      return (r.rows[0] as { n: number }).n;
    });
    expect(inB).toBe(1);
  });
});
