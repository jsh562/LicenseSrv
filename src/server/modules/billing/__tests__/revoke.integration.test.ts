// T032 [US4] (FR-010): a refund / chargeback event drives the linked license to the TERMINAL E008 `revoked`
// status (billing_state → refunded), and a LATER event for that subscription is an idempotent no-op that
// does NOT resurrect the revoked license (revoked is terminal — never resurrected, SC-006). Uses the real
// Testcontainers + E004-signer harness; the webhook is signed with the connection's HMAC secret.
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { canceledEvent, createdEvent, refundEvent, renewalEvent, startBillingHarness, type BillingHarness } from "./harness.js";

let h: BillingHarness;

beforeAll(async () => {
  h = await startBillingHarness("revoke");
}, 240_000);

afterAll(async () => {
  await h?.stop();
});

describe("refund/chargeback → revoke (terminal), not resurrected (US4, FR-010)", () => {
  it("a refund revokes the linked license (terminal), sets billing_state=refunded, and audits with the event id", async () => {
    const ext = "sub_refund";
    const t0 = Math.floor(Date.now() / 1000);
    await h.postWebhook(h.connectionId, createdEvent(h.eventId(), ext));
    const before = await h.getSubscription(ext);
    expect((await h.getLicense(before!.licenseId))?.status).toBe("active");

    const evtId = h.eventId();
    const res = await h.postWebhook(h.connectionId, refundEvent(evtId, ext, { occurred: t0 + 10 }));
    expect(res.json()).toEqual({ received: true, outcome: "applied" });

    const sub = await h.getSubscription(ext);
    expect(sub!.billingState).toBe("refunded");
    expect(sub!.graceExpiresAt).toBeNull();
    // The E008 license is REVOKED — the terminal status, driven (not re-implemented) by E014.
    expect((await h.getLicense(sub!.licenseId))?.status).toBe("revoked");

    // FR-013: audited with the E008 terminal transition + the billing revoke carrying the provider event id.
    const audits = await h.auditFor(sub!.licenseId);
    expect(audits.find((a) => a.action === "license.revoked")).toBeDefined();
    const rev = audits.find((a) => a.action === "billing.revoked");
    expect(rev).toBeDefined();
    expect((rev!.after as { providerEventId?: string }).providerEventId).toBe(evtId);
  });

  it("a LATER (newer) event does NOT resurrect the revoked license (idempotent no-op)", async () => {
    const ext = "sub_refund_then_renew";
    const t0 = Math.floor(Date.now() / 1000);
    await h.postWebhook(h.connectionId, createdEvent(h.eventId(), ext));
    await h.postWebhook(h.connectionId, refundEvent(h.eventId(), ext, { occurred: t0 + 10 }));
    const sub = await h.getSubscription(ext);
    expect((await h.getLicense(sub!.licenseId))?.status).toBe("revoked");

    // A later invoice.paid (renewal) with a NEWER occurred_at passes the recency guard but the terminal
    // license is never reinstated — a no-op, never an error.
    const res = await h.postWebhook(h.connectionId, renewalEvent(h.eventId(), ext, { occurred: t0 + 100 }));
    expect(res.statusCode).toBe(200);
    expect((await h.getSubscription(ext))!.billingState).toBe("refunded");
    expect((await h.getLicense(sub!.licenseId))?.status).toBe("revoked");

    // A later cancel is likewise inert — no grace overlay re-enters a terminal license.
    const cancel = await h.postWebhook(h.connectionId, canceledEvent(h.eventId(), ext, { occurred: t0 + 200 }));
    expect(cancel.statusCode).toBe(200);
    expect((await h.getSubscription(ext))!.billingState).toBe("refunded");
    expect((await h.getLicense(sub!.licenseId))?.status).toBe("revoked");

    // No reinstatement was ever applied to the revoked license.
    const audits = await h.auditFor(sub!.licenseId);
    expect(audits.find((a) => a.action === "license.reinstated")).toBeUndefined();
    expect(audits.find((a) => a.action === "billing.grace_started")).toBeUndefined();
  });

  it("also revokes on a chargeback / dispute event (terminal)", async () => {
    const ext = "sub_dispute";
    const t0 = Math.floor(Date.now() / 1000);
    await h.postWebhook(h.connectionId, createdEvent(h.eventId(), ext));
    const res = await h.postWebhook(h.connectionId, refundEvent(h.eventId(), ext, { dispute: true, occurred: t0 + 10 }));
    expect(res.json()).toEqual({ received: true, outcome: "applied" });
    const sub = await h.getSubscription(ext);
    expect(sub!.billingState).toBe("refunded");
    expect((await h.getLicense(sub!.licenseId))?.status).toBe("revoked");
  });
});
