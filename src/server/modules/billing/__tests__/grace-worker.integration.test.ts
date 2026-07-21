// T028 [US3] (FR-008/009/013): the TIME-driven grace worker + recovery. When a grace window elapses with no
// recovering payment, the worker drives the linked license `active → suspended` via the E008 service (even
// with no further webhook), advances the overlay to `canceled`, clears grace, and audits with a SYNTHETIC
// system actor + subscription id (NO provider event id). A successful payment DURING grace, or FROM the
// auto-suspended state, reinstates the license via E008 and clears grace (recovery is always allowed from
// suspended — only revoked is terminal).
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { canceledEvent, createdEvent, paymentFailedEvent, renewalEvent, startBillingHarness, type BillingHarness } from "./harness.js";

let h: BillingHarness;

beforeAll(async () => {
  h = await startBillingHarness("worker");
}, 240_000);

afterAll(async () => {
  await h?.stop();
});

describe("grace-expiry worker + recovery (US3, FR-008/009)", () => {
  it("auto-suspends via E008 when grace elapses, and audits with a synthetic actor + subscription id (no event id)", async () => {
    const ext = "sub_worker_suspend";
    const t0 = Math.floor(Date.now() / 1000);
    await h.postWebhook(h.connectionId, createdEvent(h.eventId(), ext));
    await h.postWebhook(h.connectionId, canceledEvent(h.eventId(), ext, { occurred: t0 + 10 }));

    const sub = await h.getSubscription(ext);
    expect(sub!.billingState).toBe("grace");
    // Before the window elapses the license is still active (time-driven, not webhook-driven).
    expect((await h.getLicense(sub!.licenseId))?.status).toBe("active");

    // Elapse the window and run exactly one worker sweep.
    await h.expireGraceNow(sub!.id);
    await h.runGraceWorker();

    const suspended = await h.getSubscription(ext);
    expect(suspended!.billingState).toBe("canceled");
    expect(suspended!.graceExpiresAt).toBeNull();
    expect((await h.getLicense(sub!.licenseId))?.status).toBe("suspended"); // E008 suspend applied

    // FR-013: audited with the synthetic worker actor + the subscription id, and NO provider event id.
    const audits = await h.auditFor(sub!.licenseId);
    const auto = audits.find((a) => a.action === "billing.auto_suspended");
    expect(auto?.actor).toBe("billing-grace-worker");
    expect((auto?.after as { subscriptionId?: string })?.subscriptionId).toBe(sub!.id);
    expect((auto?.after as { providerEventId?: string })?.providerEventId).toBeUndefined();
  });

  it("reinstates a billing-suspended license on a later successful payment and clears grace (FR-009)", async () => {
    const ext = "sub_worker_recover";
    const t0 = Math.floor(Date.now() / 1000);
    await h.postWebhook(h.connectionId, createdEvent(h.eventId(), ext));
    await h.postWebhook(h.connectionId, canceledEvent(h.eventId(), ext, { occurred: t0 + 10 }));
    const sub = await h.getSubscription(ext);
    await h.expireGraceNow(sub!.id);
    await h.runGraceWorker();
    expect((await h.getLicense(sub!.licenseId))?.status).toBe("suspended");

    // A later successful payment recovers from suspended.
    const res = await h.postWebhook(h.connectionId, renewalEvent(h.eventId(), ext, { occurred: t0 + 100 }));
    expect(res.json()).toEqual({ received: true, outcome: "applied" });

    const recovered = await h.getSubscription(ext);
    expect(recovered!.billingState).toBe("active");
    expect(recovered!.graceExpiresAt).toBeNull();
    expect((await h.getLicense(sub!.licenseId))?.status).toBe("active"); // reinstated via E008

    const audits = await h.auditFor(sub!.licenseId);
    expect(audits.find((a) => a.action === "license.reinstated")).toBeDefined();
  });

  it("recovers from grace on a payment DURING the window (never suspended), clearing grace", async () => {
    const ext = "sub_worker_ingrace";
    const t0 = Math.floor(Date.now() / 1000);
    await h.postWebhook(h.connectionId, createdEvent(h.eventId(), ext));
    await h.postWebhook(h.connectionId, paymentFailedEvent(h.eventId(), ext, { occurred: t0 + 10 }));
    expect((await h.getSubscription(ext))!.billingState).toBe("past_due");

    // Payment arrives before grace elapses — recover without ever suspending.
    await h.postWebhook(h.connectionId, renewalEvent(h.eventId(), ext, { occurred: t0 + 20 }));
    const sub = await h.getSubscription(ext);
    expect(sub!.billingState).toBe("active");
    expect(sub!.graceExpiresAt).toBeNull();
    expect((await h.getLicense(sub!.licenseId))?.status).toBe("active"); // never suspended
  });
});
