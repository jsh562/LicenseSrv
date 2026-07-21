// T023 [US2] (FR-005/012/013): subscription-created → a license is PROVISIONED via the E008 issuance path
// and linked 1:1 to the subscription per the connection plan map; the mutation is audited with the triggering
// provider event id. An unmapped provider plan dead-letters (never silently dropped). A repeat create for an
// already-linked subscription idempotently reuses the existing license (no second license).
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { withTenant } from "../../../db/client.js";
import { type BillingHarness, createdEvent, startBillingHarness } from "./harness.js";

let h: BillingHarness;

beforeAll(async () => {
  h = await startBillingHarness("provision");
}, 240_000);

afterAll(async () => {
  await h?.stop();
});

describe("subscription-created → provision + 1:1 link (US2, FR-005/012)", () => {
  it("provisions a signed E008 license linked 1:1 to the subscription per the plan map, audited with the event id", async () => {
    const ext = "sub_prov_ok";
    const evt = createdEvent(h.eventId(), ext);
    const eventId = evt.id as string;

    const res = await h.postWebhook(h.connectionId, evt);
    expect(res.json()).toEqual({ received: true, outcome: "applied" });

    const sub = await h.getSubscription(ext);
    expect(sub).not.toBeNull();
    expect(sub!.billingState).toBe("active");
    expect(sub!.licenseId).toBeTruthy();

    // The license is a real E008-issued, SIGNED license: active, under the MAPPED plan, with a LIC1 token.
    const lic = await withTenant(h.pool, h.tenantA, async (q) => {
      const r = await q("SELECT status, plan_id, license_token FROM license WHERE id = $1", [sub!.licenseId]);
      return r.rows[0] as { status: string; plan_id: string; license_token: string } | undefined;
    });
    expect(lic?.status).toBe("active");
    expect(lic?.plan_id).toBe(h.planId);
    expect(lic?.license_token.startsWith("LIC1")).toBe(true);

    // FR-013/SC-008: the billing provision is audited carrying the triggering provider event id.
    const audits = await h.auditFor(sub!.licenseId);
    const provisioned = audits.find((a) => a.action === "billing.provisioned");
    expect(provisioned?.actor).toBe("billing-webhook");
    expect((provisioned?.after as { providerEventId?: string })?.providerEventId).toBe(eventId);
  });

  it("dead-letters a subscription-created event whose plan is unmapped (never silently dropped, FR-020)", async () => {
    const ext = "sub_prov_unmapped";
    const evt = createdEvent(h.eventId(), ext, { planKey: "price_not_in_map" });
    const eventId = evt.id as string;

    const res = await h.postWebhook(h.connectionId, evt);
    expect(res.json()).toEqual({ received: true, outcome: "deadletter" });

    expect(await h.getSubscription(ext)).toBeNull();
    const rows = await h.events();
    const dl = rows.find((r) => r.providerEventId === eventId);
    expect(dl?.outcome).toBe("deadletter");
    expect(dl?.reason).toBe("unmapped_event");
  });

  it("idempotently reuses the existing license on a repeat create for the same subscription (no 2nd license)", async () => {
    const ext = "sub_prov_reuse";
    // An ISOLATED provider customer so the per-customer license count is unambiguous.
    await h.postWebhook(h.connectionId, createdEvent(h.eventId(), ext, { customer: "cus_reuse" }));
    const first = await h.getSubscription(ext);
    expect(first).not.toBeNull();

    // A DISTINCT create event id for the SAME external subscription → reuse the existing 1:1 link.
    const res = await h.postWebhook(h.connectionId, createdEvent(h.eventId(), ext, { customer: "cus_reuse" }));
    expect(res.json()).toEqual({ received: true, outcome: "applied" });

    const again = await h.getSubscription(ext);
    expect(again!.id).toBe(first!.id);
    expect(again!.licenseId).toBe(first!.licenseId); // license set ONCE — never re-pointed

    // No SECOND license was issued for that pseudonymous customer (the create reused the existing link).
    const licenseCount = await withTenant(h.pool, h.tenantA, async (q) => {
      const r = await q(
        "SELECT count(*)::int AS n FROM license WHERE customer_id = (SELECT id FROM customer WHERE ref = $1)",
        ["billing:stripe:cus_reuse"],
      );
      return (r.rows[0] as { n: number }).n;
    });
    expect(licenseCount).toBe(1);
  });
});
