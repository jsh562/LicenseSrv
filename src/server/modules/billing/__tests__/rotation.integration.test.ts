// T035 [US5] (FR-022): the signing-secret rotation transition window. After rotate-secret BOTH the new
// (current) AND the old (previous) secret verify inbound webhooks during the bounded window; once the window
// closes the superseded previous secret is DROPPED (a webhook signed with the old secret then fails 401).
// The secret is never returned by the rotate response (SC-014). Uses the real Testcontainers + admin-session
// harness; webhook verification acceptance is proven by a 200 ack vs a 401 invalid_signature.
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { privileged } from "../../../db/client.js";
import { createdEvent, SIGNING_SECRET, startBillingHarness, type BillingHarness } from "./harness.js";

let h: BillingHarness;
const OLD = SIGNING_SECRET;
const NEW = "whsec_rotated_new_secret_ZxCvBnMqWeRtY1234567890";

beforeAll(async () => {
  h = await startBillingHarness("rotation");
}, 240_000);

afterAll(async () => {
  await h?.stop();
});

describe("secret rotation transition window (US5, FR-022)", () => {
  it("rotate-secret: BOTH the new (current) and old (previous) secret verify during the window; neither is returned", async () => {
    const res = await h.admin("POST", `/admin/billing/connections/${h.connectionId}/rotate-secret`, { signingSecret: NEW });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.secretRotatedAt).not.toBeNull();
    // Neither the new nor the old secret is ever returned.
    expect(body).not.toHaveProperty("signingSecret");
    expect(JSON.stringify(body)).not.toContain(NEW);
    expect(JSON.stringify(body)).not.toContain(OLD);

    // A webhook signed with the NEW (current) secret verifies (200 ack, not 401).
    const rNew = await h.postWebhook(h.connectionId, createdEvent(h.eventId(), "sub_rot_new"), { secret: NEW });
    expect(rNew.statusCode).toBe(200);
    // A webhook signed with the OLD (previous) secret ALSO verifies during the transition window (200).
    const rOld = await h.postWebhook(h.connectionId, createdEvent(h.eventId(), "sub_rot_old"), { secret: OLD });
    expect(rOld.statusCode).toBe(200);
    // Control: an unrelated secret never verifies.
    const rBad = await h.postWebhook(h.connectionId, createdEvent(h.eventId(), "sub_rot_bad"), { secret: "whsec_unrelated_wrong_secret_0000" });
    expect(rBad.statusCode).toBe(401);
    expect(rBad.json().code).toBe("invalid_signature");
  });

  it("after the window closes, the superseded previous secret is dropped (old → 401, new still 200)", async () => {
    // Force the rotation timestamp well beyond the (default ~24h) transition window.
    await privileged(h.pool, (q) =>
      q("UPDATE billing_connection SET secret_rotated_at = now() - interval '30 days' WHERE id = $1", [h.connectionId]),
    );

    // The NEW (current) secret still verifies.
    const rNew = await h.postWebhook(h.connectionId, createdEvent(h.eventId(), "sub_rot_after_new"), { secret: NEW });
    expect(rNew.statusCode).toBe(200);
    // The OLD (previous) secret is no longer accepted — the superseded secret was dropped.
    const rOld = await h.postWebhook(h.connectionId, createdEvent(h.eventId(), "sub_rot_after_old"), { secret: OLD });
    expect(rOld.statusCode).toBe(401);
    expect(rOld.json().code).toBe("invalid_signature");
  });

  it("rotate-secret requires admin + CSRF (RBAC/CSRF enforced)", async () => {
    expect(
      (await h.viewer("POST", `/admin/billing/connections/${h.connectionId}/rotate-secret`, { signingSecret: NEW })).statusCode,
    ).toBe(403);
    expect(
      (await h.adminNoCsrf("POST", `/admin/billing/connections/${h.connectionId}/rotate-secret`, { signingSecret: NEW })).statusCode,
    ).toBe(403);
  });
});
