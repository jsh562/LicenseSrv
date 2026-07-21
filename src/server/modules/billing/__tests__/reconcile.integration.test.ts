// T039 [US6] (FR-017): reconciliation & missed-event recovery. A license drifts (active locally while the
// provider reports canceled — a MISSED webhook); running reconcile with a STUBBED provider-fetch returning
// the provider's authoritative state corrects the subscription/license (→ grace, then → suspended once the
// grace worker runs — per policy), recency-guarded, with a synthetic-actor audit (SC-009). Also exercises the
// async `POST /admin/billing/reconcile` (202 {jobId}) admin route. There is NO live provider — the fetch is
// injected. Uses the real Testcontainers + admin-session harness.
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { canceledEvent, createdEvent, startBillingHarness, type BillingHarness } from "./harness.js";
import { RECONCILE_ACTOR } from "../lifecycle.js";
import { reconcile, type ProviderFetch } from "../reconcile-worker.js";

let h: BillingHarness;

beforeAll(async () => {
  h = await startBillingHarness("reconcile");
}, 240_000);

afterAll(async () => {
  await h?.stop();
});

describe("reconciliation self-heal against the authoritative provider state (US6, FR-017)", () => {
  it("corrects a drifted subscription: active locally, provider reports canceled (missed webhook) → grace", async () => {
    const ext = "sub_reconcile_cancel";
    const t0 = Math.floor(Date.now() / 1000);
    await h.postWebhook(h.connectionId, createdEvent(h.eventId(), ext));
    const sub = await h.getSubscription(ext);
    expect(sub!.billingState).toBe("active");
    expect((await h.getLicense(sub!.licenseId))?.status).toBe("active");

    // The provider's AUTHORITATIVE state says canceled — a webhook we never received.
    const stub: ProviderFetch = async () => ({ status: "canceled", occurredAt: t0 + 1000 });
    const result = await reconcile(h.billingDeps(), stub, { tenantId: h.tenantA, subscriptionId: sub!.id }, { jobId: "job-cancel" });
    expect(result.examined).toBe(1);
    expect(result.corrected).toBe(1);

    // Corrected to the grace overlay per policy (billing_state=grace, grace_expires_at set); license still usable.
    const corrected = await h.getSubscription(ext);
    expect(corrected!.billingState).toBe("grace");
    expect(corrected!.graceExpiresAt).not.toBeNull();

    // FR-013: audited with a SYNTHETIC system actor + the subscription id + the reconcile job id, NO event id.
    const audits = await h.auditFor(sub!.licenseId);
    const corr = audits.find((a) => a.actor === RECONCILE_ACTOR);
    expect(corr).toBeDefined();
    expect((corr!.after as { subscriptionId?: string }).subscriptionId).toBe(sub!.id);
    expect((corr!.after as { reconcileJobId?: string }).reconcileJobId).toBe("job-cancel");
    expect((corr!.after as { providerEventId?: string }).providerEventId).toBeUndefined();

    // Then the TIME-driven grace worker auto-suspends it once the window elapses (→ suspended per policy).
    await h.expireGraceNow(corrected!.id);
    await h.runGraceWorker();
    expect((await h.getLicense(sub!.licenseId))?.status).toBe("suspended");
  });

  it("corrects a drifted subscription: provider reports refunded → the license is revoked (terminal)", async () => {
    const ext = "sub_reconcile_refund";
    const t0 = Math.floor(Date.now() / 1000);
    await h.postWebhook(h.connectionId, createdEvent(h.eventId(), ext));
    const sub = await h.getSubscription(ext);

    const stub: ProviderFetch = async () => ({ status: "refunded", occurredAt: t0 + 1000 });
    const result = await reconcile(h.billingDeps(), stub, { tenantId: h.tenantA, subscriptionId: sub!.id }, { jobId: "job-refund" });
    expect(result.corrected).toBe(1);

    expect((await h.getSubscription(ext))!.billingState).toBe("refunded");
    expect((await h.getLicense(sub!.licenseId))?.status).toBe("revoked");
  });

  it("is a no-op when the provider state matches local (no drift → no correction, no audit)", async () => {
    const ext = "sub_reconcile_match";
    await h.postWebhook(h.connectionId, createdEvent(h.eventId(), ext));
    const sub = await h.getSubscription(ext);

    const stub: ProviderFetch = async () => ({ status: "active" });
    const result = await reconcile(h.billingDeps(), stub, { tenantId: h.tenantA, subscriptionId: sub!.id }, { jobId: "job-match" });
    expect(result.examined).toBe(1);
    expect(result.corrected).toBe(0);

    expect((await h.getSubscription(ext))!.billingState).toBe("active");
    const audits = await h.auditFor(sub!.licenseId);
    expect(audits.find((a) => a.actor === RECONCILE_ACTOR)).toBeUndefined();
  });

  it("ignores an authoritative snapshot no newer than the last applied event (recency guard, FR-016)", async () => {
    const ext = "sub_reconcile_stale";
    const t0 = Math.floor(Date.now() / 1000);
    await h.postWebhook(h.connectionId, createdEvent(h.eventId(), ext));
    // A newer real cancel advances the recency anchor to t0+500.
    await h.postWebhook(h.connectionId, canceledEvent(h.eventId(), ext, { occurred: t0 + 500 }));
    const sub = await h.getSubscription(ext);
    expect(sub!.billingState).toBe("grace");

    // The provider reports "active" but with an OLDER occurred_at → the recency guard ignores it (no recover).
    const stub: ProviderFetch = async () => ({ status: "active", occurredAt: t0 + 10 });
    const result = await reconcile(h.billingDeps(), stub, { tenantId: h.tenantA, subscriptionId: sub!.id }, { jobId: "job-stale" });
    expect(result.corrected).toBe(0);
    expect((await h.getSubscription(ext))!.billingState).toBe("grace"); // newer state not regressed
  });

  it("POST /admin/billing/reconcile → 202 {jobId, status, scope}; RBAC + CSRF + scope 404", async () => {
    const res = await h.admin("POST", "/admin/billing/reconcile", {});
    expect(res.statusCode).toBe(202);
    const body = res.json();
    expect(body.status).toBe("accepted");
    expect(body.scope).toBe("tenant");
    expect(typeof body.jobId).toBe("string");

    // A viewer cannot trigger reconciliation; a mutation without CSRF is rejected.
    expect((await h.viewer("POST", "/admin/billing/reconcile", {})).statusCode).toBe(403);
    expect((await h.adminNoCsrf("POST", "/admin/billing/reconcile", {})).statusCode).toBe(403);

    // An unknown subscription scope → 404 (RLS-scoped existence check).
    const nf = await h.admin("POST", "/admin/billing/reconcile", { subscriptionId: "00000000-0000-0000-0000-000000000000" });
    expect(nf.statusCode).toBe(404);
  });
});
