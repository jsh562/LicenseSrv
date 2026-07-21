// T024 [US2] (FR-006/013): a renewal / invoice-paid event EXTENDS the linked license term (re-reading the
// CURRENT E007 effective entitlements), keeps it ACTIVE, and clears any grace/past-due overlay; the mutation
// is audited with the triggering provider event id. Exercised end-to-end: provision → payment-failure (grace)
// → renewal recovers to active with the term pushed forward.
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type BillingHarness, createdEvent, paymentFailedEvent, renewalEvent, startBillingHarness } from "./harness.js";

let h: BillingHarness;

beforeAll(async () => {
  h = await startBillingHarness("renewal");
}, 240_000);

afterAll(async () => {
  await h?.stop();
});

describe("renewal / invoice-paid → extend + keep active + clear grace (US2, FR-006)", () => {
  it("extends the license term, keeps it active, clears grace, and audits with the event id", async () => {
    const ext = "sub_renew";
    const t0 = Math.floor(Date.now() / 1000);
    const periodEnd1 = t0 + 30 * 86_400;
    const periodEnd2 = t0 + 60 * 86_400;

    // Provision with an initial term.
    await h.postWebhook(h.connectionId, createdEvent(h.eventId(), ext, { periodEnd: periodEnd1 }));
    const sub0 = await h.getSubscription(ext);
    expect(sub0).not.toBeNull();
    const lic0 = await h.getLicense(sub0!.licenseId);
    expect(lic0?.expiresAt).toBe(new Date(periodEnd1 * 1000).toISOString());

    // A payment failure moves it into a past-due grace window (license stays active).
    await h.postWebhook(h.connectionId, paymentFailedEvent(h.eventId(), ext, { occurred: t0 + 10 }));
    const subGrace = await h.getSubscription(ext);
    expect(subGrace!.billingState).toBe("past_due");
    expect(subGrace!.graceExpiresAt).not.toBeNull();

    // The renewal extends the term to the new period end and clears grace.
    const renewal = renewalEvent(h.eventId(), ext, { periodEnd: periodEnd2, occurred: t0 + 20 });
    const renewalId = renewal.id as string;
    const res = await h.postWebhook(h.connectionId, renewal);
    expect(res.json()).toEqual({ received: true, outcome: "applied" });

    const sub1 = await h.getSubscription(ext);
    expect(sub1!.billingState).toBe("active"); // grace cleared
    expect(sub1!.graceExpiresAt).toBeNull();

    const lic1 = await h.getLicense(sub1!.licenseId);
    expect(lic1?.status).toBe("active"); // still usable
    expect(lic1?.expiresAt).toBe(new Date(periodEnd2 * 1000).toISOString()); // term extended forward

    // FR-013: audited with the triggering provider event id.
    const audits = await h.auditFor(sub1!.licenseId);
    const renewed = audits.find((a) => a.action === "billing.renewed");
    expect(renewed?.actor).toBe("billing-webhook");
    expect((renewed?.after as { providerEventId?: string })?.providerEventId).toBe(renewalId);
  });
});
