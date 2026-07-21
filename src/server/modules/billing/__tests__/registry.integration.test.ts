// T045 [COMPLETES FR-020] (FR-012/020): the operator registry reads. `GET /admin/billing/subscriptions`
// lists managed subscriptions (billing_state / grace / linked license + status) and `GET /admin/billing/
// events` lists the append-only ledger incl. the dead-letter queue — both viewer-readable, deterministically
// ordered, filterable (billingState/provider/licenseId; outcome/subscriptionId/provider), and never
// exposing card/PAN data or the signing secret. Uses the real Testcontainers + admin-session harness.
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { canceledEvent, createdEvent, renewalEvent, startBillingHarness, type BillingHarness } from "./harness.js";

let h: BillingHarness;
const BASE = Math.floor(Date.now() / 1000);
let activeLicenseId: string;
let activeSubId: string;

beforeAll(async () => {
  h = await startBillingHarness("registry");
  // An ACTIVE managed subscription (+ a renewal, so the ledger has >1 applied row for it).
  await h.postWebhook(h.connectionId, createdEvent(h.eventId(), "reg_active"));
  await h.postWebhook(h.connectionId, renewalEvent(h.eventId(), "reg_active", { occurred: BASE + 100 }));
  const active = await h.getSubscription("reg_active");
  activeSubId = active!.id;
  activeLicenseId = active!.licenseId;
  // A GRACE subscription (created, then canceled → grace overlay).
  await h.postWebhook(h.connectionId, createdEvent(h.eventId(), "reg_grace"));
  await h.postWebhook(h.connectionId, canceledEvent(h.eventId(), "reg_grace", { occurred: BASE + 200 }));
  // An UNMAPPED renewal → a dead-letter ledger row (subscriptionId null).
  await h.postWebhook(h.connectionId, renewalEvent(h.eventId(), "reg_unmapped_sub", { occurred: BASE + 300 }));
}, 240_000);

afterAll(async () => {
  await h?.stop();
});

describe("GET /admin/billing/subscriptions — managed subscriptions (FR-012)", () => {
  it("lists all managed subscriptions with the linked license status; not truncated", async () => {
    const res = await h.admin("GET", "/admin/billing/subscriptions");
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.truncated).toBeUndefined(); // well under the 1000 cap
    const subs = body.subscriptions as Array<{ externalSubscriptionId: string; licenseStatus: string; billingState: string }>;
    const active = subs.find((s) => s.externalSubscriptionId === "reg_active");
    const grace = subs.find((s) => s.externalSubscriptionId === "reg_grace");
    expect(active).toBeDefined();
    expect(active!.licenseStatus).toBe("active");
    expect(grace!.billingState).toBe("grace");
  });

  it("filters by billingState, provider, and licenseId (AND)", async () => {
    const byState = await h.admin("GET", "/admin/billing/subscriptions?billingState=grace");
    expect(byState.statusCode).toBe(200);
    const graceRows = byState.json().subscriptions as Array<{ billingState: string }>;
    expect(graceRows.length).toBeGreaterThan(0);
    expect(graceRows.every((s) => s.billingState === "grace")).toBe(true);

    const byProvider = await h.admin("GET", "/admin/billing/subscriptions?provider=stripe");
    expect((byProvider.json().subscriptions as unknown[]).length).toBeGreaterThanOrEqual(2);

    const byLicense = await h.admin("GET", `/admin/billing/subscriptions?licenseId=${activeLicenseId}`);
    const licRows = byLicense.json().subscriptions as Array<{ licenseId: string }>;
    expect(licRows).toHaveLength(1);
    expect(licRows[0]!.licenseId).toBe(activeLicenseId);

    // A valid enum with no matches → an empty, well-formed list.
    const empty = await h.admin("GET", "/admin/billing/subscriptions?provider=paddle");
    expect(empty.statusCode).toBe(200);
    expect(empty.json().subscriptions).toHaveLength(0);
  });

  it("rejects a bad filter value (400 validation_error)", async () => {
    const res = await h.admin("GET", "/admin/billing/subscriptions?billingState=bogus");
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("validation_error");
  });

  it("viewer may read; unauthenticated → 401", async () => {
    expect((await h.viewer("GET", "/admin/billing/subscriptions")).statusCode).toBe(200);
    expect((await h.unauth("GET", "/admin/billing/subscriptions")).statusCode).toBe(401);
  });
});

describe("GET /admin/billing/events — the ledger + dead-letter view (FR-013/020)", () => {
  it("lists the ledger newest-first and surfaces the dead-letter queue via ?outcome=deadletter", async () => {
    const all = await h.admin("GET", "/admin/billing/events");
    expect(all.statusCode).toBe(200);
    expect(all.json().truncated).toBeUndefined();
    const events = all.json().events as Array<{ receivedAt: string; outcome: string }>;
    expect(events.length).toBeGreaterThanOrEqual(3);
    // Deterministic newest-first order (receivedAt DESC).
    for (let i = 1; i < events.length; i++) {
      expect(events[i - 1]!.receivedAt >= events[i]!.receivedAt).toBe(true);
    }

    const deadletter = await h.admin("GET", "/admin/billing/events?outcome=deadletter");
    const dlRows = deadletter.json().events as Array<{ outcome: string; subscriptionId: string | null; reason: string | null }>;
    expect(dlRows.length).toBeGreaterThan(0);
    expect(dlRows.every((e) => e.outcome === "deadletter")).toBe(true);
    expect(dlRows.some((e) => e.subscriptionId === null && e.reason === "unmapped_event")).toBe(true);
  });

  it("filters by outcome, subscriptionId, and provider", async () => {
    const applied = await h.admin("GET", "/admin/billing/events?outcome=applied");
    expect((applied.json().events as Array<{ outcome: string }>).every((e) => e.outcome === "applied")).toBe(true);

    const bySub = await h.admin("GET", `/admin/billing/events?subscriptionId=${activeSubId}`);
    const subRows = bySub.json().events as Array<{ subscriptionId: string | null }>;
    expect(subRows.length).toBeGreaterThan(0);
    expect(subRows.every((e) => e.subscriptionId === activeSubId)).toBe(true);

    const byProvider = await h.admin("GET", "/admin/billing/events?provider=stripe");
    expect((byProvider.json().events as unknown[]).length).toBeGreaterThanOrEqual(3);
  });

  it("rejects a bad outcome filter (400) and enforces viewer/unauth RBAC", async () => {
    expect((await h.admin("GET", "/admin/billing/events?outcome=duplicate")).statusCode).toBe(400); // not a stored outcome
    expect((await h.viewer("GET", "/admin/billing/events")).statusCode).toBe(200);
    expect((await h.unauth("GET", "/admin/billing/events")).statusCode).toBe(401);
  });
});
