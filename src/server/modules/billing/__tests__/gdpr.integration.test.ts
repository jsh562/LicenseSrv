// [US1] (FR-021, SC-015): GDPR erasure covers the E014 billing metadata. `eraseTenantPersonalData` must erase
// the tenant's `billing_connection`, `subscription`, and `billing_event` rows (owner-level, in FK order —
// events → subscriptions → connections — because the append-only ledger + the subscription overlay have no
// app-role DELETE grant), removing the pseudonymous provider references, while ANOTHER tenant's billing rows are
// untouched. Uses the real Testcontainers billing harness: tenant A is fully provisioned via a webhook (real
// license + subscription + applied ledger row); tenant B gets its own connection + a dead-letter ledger row.
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { privileged } from "../../../db/client.js";
import { eraseTenantPersonalData } from "../../../db/gdpr.js";
import { ConnectionRepo } from "../connection-repo.js";
import { createdEvent, startBillingHarness, type BillingHarness } from "./harness.js";

let h: BillingHarness;
let tenantBConnId: string;
const TENANT_B_SECRET = "whsec_tenantB_gdpr_secret_0987654321abcdef";

beforeAll(async () => {
  h = await startBillingHarness("gdpr");

  // Tenant A: a fully provisioned managed subscription (real license + subscription + applied ledger row).
  await h.postWebhook(h.connectionId, createdEvent(h.eventId(), "sub_gdpr_A"));

  // Tenant B: its OWN stripe connection (empty plan map) + a dead-letter ledger row — the untouched control.
  const deps = h.billingDeps();
  const repoB = new ConnectionRepo(h.pool, deps.custody, deps.config);
  const connB = await repoB.create(h.tenantB, "test-setup", { provider: "stripe", signingSecret: TENANT_B_SECRET });
  tenantBConnId = connB.id;
  // An unmapped event to tenant B → a deadletter billing_event (subscription_id NULL) under tenant B.
  await h.postWebhook(tenantBConnId, createdEvent(h.eventId(), "sub_gdpr_B"), { secret: TENANT_B_SECRET });
}, 240_000);

afterAll(async () => {
  await h?.stop();
});

/** Owner-level count of a billing table's rows for one tenant (RLS-bypassing; explicit tenant filter). */
async function countFor(table: "billing_connection" | "subscription" | "billing_event", tenantId: string): Promise<number> {
  return privileged(h.pool, async (q) => {
    const r = await q(`SELECT count(*)::int AS n FROM ${table} WHERE tenant_id = $1`, [tenantId]);
    return (r.rows[0] as { n: number }).n;
  });
}

describe("GDPR erasure of billing metadata (FR-021, SC-015)", () => {
  it("erases the tenant's connection/subscription/event rows while another tenant's rows are untouched", async () => {
    // Preconditions: tenant A has all three; tenant B has its own connection + a ledger row.
    expect(await countFor("billing_connection", h.tenantA)).toBeGreaterThan(0);
    expect(await countFor("subscription", h.tenantA)).toBeGreaterThan(0);
    expect(await countFor("billing_event", h.tenantA)).toBeGreaterThan(0);
    const bConn0 = await countFor("billing_connection", h.tenantB);
    const bEvent0 = await countFor("billing_event", h.tenantB);
    expect(bConn0).toBeGreaterThan(0);
    expect(bEvent0).toBeGreaterThan(0);

    // The harness logged users in (creating admin_session rows referencing app_user); clear them so the tenant
    // can be erased. Session cleanup is orthogonal to the billing-metadata erasure under test (FR-021).
    await privileged(h.pool, (q) => q("DELETE FROM admin_session WHERE tenant_id = $1", [h.tenantA]));

    await eraseTenantPersonalData(h.pool, h.tenantA);

    // Tenant A billing metadata fully erased (FK order events → subscriptions → connections held).
    expect(await countFor("billing_event", h.tenantA)).toBe(0);
    expect(await countFor("subscription", h.tenantA)).toBe(0);
    expect(await countFor("billing_connection", h.tenantA)).toBe(0);

    // Tenant B untouched — isolation preserved.
    expect(await countFor("billing_connection", h.tenantB)).toBe(bConn0);
    expect(await countFor("billing_event", h.tenantB)).toBe(bEvent0);

    // Idempotent: a second erase is a no-op (deletes nothing; never throws).
    await eraseTenantPersonalData(h.pool, h.tenantA);
    expect(await countFor("billing_event", h.tenantA)).toBe(0);
    expect(await countFor("billing_connection", h.tenantB)).toBe(bConn0);
  });
});
