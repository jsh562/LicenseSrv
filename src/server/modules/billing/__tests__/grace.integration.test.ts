// T027 [US3] (FR-007): a cancellation or payment-failure moves the linked subscription into a bounded grace
// window (`billing_state` → grace / past_due, `grace_expires_at` set from the resolved per-plan grace) while
// the LICENSE STAYS ACTIVE (usable) — NO immediate suspend. Auto-suspend is the TIME-driven worker's job
// (T028), not the webhook's.
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { canceledEvent, createdEvent, paymentFailedEvent, startBillingHarness, type BillingHarness } from "./harness.js";

let h: BillingHarness;
const DEFAULT_GRACE_SECONDS = 1_209_600; // ~14 days (the deployment default the connection inherits)

beforeAll(async () => {
  h = await startBillingHarness("grace");
}, 240_000);

afterAll(async () => {
  await h?.stop();
});

describe("cancel / payment-failure → grace overlay, license stays active (US3, FR-007)", () => {
  it("a cancellation → billing_state=grace, grace_expires_at set, license STILL active (no suspend)", async () => {
    const ext = "sub_grace_cancel";
    const t0 = Math.floor(Date.now() / 1000);
    await h.postWebhook(h.connectionId, createdEvent(h.eventId(), ext));

    const res = await h.postWebhook(h.connectionId, canceledEvent(h.eventId(), ext, { occurred: t0 + 10 }));
    expect(res.json()).toEqual({ received: true, outcome: "applied" });

    const sub = await h.getSubscription(ext);
    expect(sub!.billingState).toBe("grace");
    expect(sub!.graceExpiresAt).not.toBeNull();
    // grace_expires_at ≈ now + the resolved (~14d) grace window.
    const graceUnix = Math.floor(new Date(sub!.graceExpiresAt!).getTime() / 1000);
    expect(graceUnix).toBeGreaterThan(t0 + DEFAULT_GRACE_SECONDS - 3_600);
    expect(graceUnix).toBeLessThan(t0 + DEFAULT_GRACE_SECONDS + 3_600);

    // The license stays ACTIVE (usable) — grace is an overlay, not a suspend.
    const lic = await h.getLicense(sub!.licenseId);
    expect(lic?.status).toBe("active");
    // No auto-suspend audit was written on the webhook path.
    const audits = await h.auditFor(sub!.licenseId);
    expect(audits.find((a) => a.action === "billing.auto_suspended")).toBeUndefined();
    expect(audits.find((a) => a.action === "license.suspended")).toBeUndefined();
    expect(audits.find((a) => a.action === "billing.grace_started")).toBeDefined();
  });

  it("a payment-failure → billing_state=past_due, grace_expires_at set, license STILL active", async () => {
    const ext = "sub_grace_pastdue";
    const t0 = Math.floor(Date.now() / 1000);
    await h.postWebhook(h.connectionId, createdEvent(h.eventId(), ext));

    const res = await h.postWebhook(h.connectionId, paymentFailedEvent(h.eventId(), ext, { occurred: t0 + 10 }));
    expect(res.json()).toEqual({ received: true, outcome: "applied" });

    const sub = await h.getSubscription(ext);
    expect(sub!.billingState).toBe("past_due");
    expect(sub!.graceExpiresAt).not.toBeNull();

    const lic = await h.getLicense(sub!.licenseId);
    expect(lic?.status).toBe("active"); // usable during dunning
  });
});
