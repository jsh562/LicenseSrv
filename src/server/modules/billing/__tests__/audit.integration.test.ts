// T046 [COMPLETES FR-013] (SC-008): every billing-driven license mutation is auditable to its triggering
// source in the append-only `audit_log`. A WEBHOOK-driven mutation (provision / renew / grace / revoke) is
// attributed to the synthetic webhook actor and carries the triggering `provider_event_id`; a TIME-driven
// grace auto-suspend AND a reconciliation-driven correction each carry a SYNTHETIC SYSTEM actor + the
// affected subscription id and NO provider event id (the trigger is the clock / the reconcile job, not a
// webhook). Uses the real Testcontainers + real-signer harness. Asserts against audit_log (append-only).
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { WEBHOOK_ACTOR, RECONCILE_ACTOR } from "../lifecycle.js";
import { GRACE_WORKER_ACTOR } from "../grace-worker.js";
import { reconcile, type AuthoritativeSubscription } from "../reconcile-worker.js";
import { canceledEvent, createdEvent, startBillingHarness, type BillingHarness } from "./harness.js";

let h: BillingHarness;
/** A stable clock base; each event's occurredAt is offset so the recency guard always advances. */
const BASE = Math.floor(Date.now() / 1000);

beforeAll(async () => {
  h = await startBillingHarness("audit");
}, 240_000);

afterAll(async () => {
  await h?.stop();
});

/** The `after` payload of an audit row (parsed JSONB). */
type AuditAfter = { providerEventId?: string; subscriptionId?: string; reconcileJobId?: string } & Record<string, unknown>;

describe("billing audit attribution — event id vs synthetic system source (FR-013, SC-008)", () => {
  it("a WEBHOOK-driven mutation is audited with the triggering provider_event_id", async () => {
    const evId = h.eventId();
    const res = await h.postWebhook(h.connectionId, createdEvent(evId, "sub_audit_web"));
    expect(res.statusCode).toBe(200);
    expect(res.json().outcome).toBe("applied");

    const sub = await h.getSubscription("sub_audit_web");
    expect(sub).not.toBeNull();
    const rows = await h.auditFor(sub!.licenseId);
    const provisioned = rows.find((r) => r.action === "billing.provisioned");
    expect(provisioned).toBeDefined();
    expect(provisioned!.actor).toBe(WEBHOOK_ACTOR);
    const after = provisioned!.after as AuditAfter;
    expect(after.providerEventId).toBe(evId); // attributed to the triggering webhook event
    expect(after.subscriptionId).toBe(sub!.id);
  });

  it("a TIME-driven grace auto-suspend is audited with a synthetic system actor + subscription id and NO event id", async () => {
    // Provision, then cancel → grace (a strictly newer occurredAt so the recency guard applies it).
    await h.postWebhook(h.connectionId, createdEvent(h.eventId(), "sub_audit_grace"));
    const sub = await h.getSubscription("sub_audit_grace");
    expect(sub).not.toBeNull();
    const cancel = await h.postWebhook(h.connectionId, canceledEvent(h.eventId(), "sub_audit_grace", { occurred: BASE + 500 }));
    expect(cancel.json().outcome).toBe("applied");

    // The grace window elapses → the TIME-driven worker suspends the license.
    await h.expireGraceNow(sub!.id);
    await h.runGraceWorker();

    const lic = await h.getLicense(sub!.licenseId);
    expect(lic!.status).toBe("suspended");

    const rows = await h.auditFor(sub!.licenseId);
    const autoSuspended = rows.find((r) => r.action === "billing.auto_suspended");
    expect(autoSuspended).toBeDefined();
    expect(autoSuspended!.actor).toBe(GRACE_WORKER_ACTOR); // synthetic system actor, not a human/webhook
    const after = autoSuspended!.after as AuditAfter;
    expect(after.subscriptionId).toBe(sub!.id);
    expect(after.providerEventId).toBeUndefined(); // no provider event id — the trigger is the clock
  });

  it("a RECONCILIATION correction is audited with a synthetic system actor + subscription id + job id and NO event id", async () => {
    // Provision an active subscription, then reconcile against a provider snapshot that says 'canceled'.
    await h.postWebhook(h.connectionId, createdEvent(h.eventId(), "sub_audit_recon"));
    const sub = await h.getSubscription("sub_audit_recon");
    expect(sub).not.toBeNull();

    const authoritative: AuthoritativeSubscription = { status: "canceled", occurredAt: BASE + 1000 };
    const stubFetch = async (): Promise<AuthoritativeSubscription> => authoritative;
    const result = await reconcile(
      h.billingDeps(),
      stubFetch,
      { tenantId: h.tenantA, subscriptionId: sub!.id },
      { jobId: "job-audit-recon", nowUnix: BASE + 1000 },
    );
    expect(result.corrected).toBe(1);

    const corrected = await h.getSubscriptionRow(sub!.id);
    expect(corrected!.billingState).toBe("grace"); // provider-authoritative cancel → grace overlay

    const rows = await h.auditFor(sub!.licenseId);
    const graceStarted = rows.find((r) => r.action === "billing.grace_started");
    expect(graceStarted).toBeDefined();
    expect(graceStarted!.actor).toBe(RECONCILE_ACTOR); // synthetic reconcile-worker actor
    const after = graceStarted!.after as AuditAfter;
    expect(after.subscriptionId).toBe(sub!.id);
    expect(after.reconcileJobId).toBe("job-audit-recon");
    expect(after.providerEventId).toBeUndefined(); // no provider event id — a reconciliation-driven correction
  });
});
