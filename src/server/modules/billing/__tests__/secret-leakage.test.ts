// T048 [COMPLETES FR-018] (SC-012/SC-014): the two hard secrecy boundaries.
//   • NO card/PAN data ever survives into the billing-event ledger. A webhook whose RAW payload carries a
//     PAN / CVV / expiry / cardholder name (+ a nested card object) is normalized through the CLOSED
//     allow-list, so the stored `payload_summary` excludes every card field — only allow-listed billing
//     metadata remains. The no-card boundary holds on the reconciliation ingest path too (its authoritative
//     snapshot carries no card surface and writes no ledger row).
//   • The webhook SIGNING SECRET is WRITE-ONLY: it is never returned by any API response (create / list /
//     rotate), never reaches a log line (asserted against the captured app log buffer), and never appears in
//     the `billing_connection_public` view.
// Uses the real Testcontainers + admin-session harness with in-memory LOG CAPTURE.
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { withTenant } from "../../../db/client.js";
import { PAYLOAD_SUMMARY_KEYS } from "../events.js";
import { reconcile, type AuthoritativeSubscription } from "../reconcile-worker.js";
import { PLAN_KEY, SIGNING_SECRET, startBillingHarness, type BillingHarness } from "./harness.js";

let h: BillingHarness;
const BASE = Math.floor(Date.now() / 1000);

// Sentinel card data (test values) that MUST never be stored or logged (FR-018).
// These are DISTINCTIVE canary tokens, not realistic-looking short values: the log buffer is scanned with a
// raw substring search, and a short numeric sentinel (e.g. a 3-digit CVV) collides by chance with digits
// inside framework-generated request-id UUIDs / timestamps / durations in `request completed` log lines,
// making the assertion non-deterministic. Long unambiguous canaries cannot occur inside that random material,
// so the security intent is unchanged (any card value reaching the summary/logs is still caught) while the
// scan is deterministic. Field VALUES are arbitrary here — the summary allow-list is KEY-based.
const PAN = "4111111111111111"; // 16 contiguous digits — cannot appear inside a UUID/timestamp/duration
const CVV = "CVVCANARY737";
const EXPIRY = "EXPCANARY1229";
const CARDHOLDER = "CARDHOLDER_CANARY";

// Write-only signing secrets that MUST never be returned or logged (FR-022).
const LEAK_SECRET = "whsec_leak_write_only_secret_ABCDEF0123456789";
const ROTATED_SECRET = "whsec_leak_rotated_secret_ZYXWVU9876543210";

beforeAll(async () => {
  h = await startBillingHarness("secret-leak", { captureLogs: true });
}, 240_000);

afterAll(async () => {
  await h?.stop();
});

/** A subscription-created event whose payload is stuffed with hostile card data (must all be dropped). */
function cardStuffedEvent(id: string): Record<string, unknown> {
  return {
    id,
    type: "customer.subscription.created",
    created: BASE,
    data: {
      object: {
        id: "sub_card_leak",
        object: "subscription",
        status: "active",
        customer: "cus_card_leak",
        plan: { id: PLAN_KEY },
        // --- hostile card/PAN data: none of this may reach the ledger (FR-018) ---
        pan: PAN,
        card_number: PAN,
        cvv: CVV,
        cvc: CVV,
        exp: EXPIRY,
        exp_month: 12,
        exp_year: 2030,
        cardholder_name: CARDHOLDER,
        card: { number: PAN, cvc: CVV, exp: EXPIRY, name: CARDHOLDER },
      },
    },
  };
}

describe("no card/PAN in the ledger; signing secret never leaks (FR-018/022, SC-012/014)", () => {
  it("a webhook carrying PAN/CVV/expiry/cardholder → the stored payload_summary excludes ALL card data", async () => {
    const evId = h.eventId();
    const res = await h.postWebhook(h.connectionId, cardStuffedEvent(evId));
    expect(res.statusCode).toBe(200);
    expect(res.json().outcome).toBe("applied");

    const events = await h.events();
    const row = events.find((e) => e.providerEventId === evId);
    expect(row).toBeDefined();
    expect(row!.outcome).toBe("applied");

    // Only allow-listed keys survive; no card field is present.
    const summary = (row!.payloadSummary ?? {}) as Record<string, unknown>;
    for (const key of Object.keys(summary)) expect(PAYLOAD_SUMMARY_KEYS).toContain(key);
    const summaryJson = JSON.stringify(summary);
    for (const secret of [PAN, CVV, EXPIRY, CARDHOLDER]) expect(summaryJson).not.toContain(secret);

    // Belt: NO card datum appears ANYWHERE in the tenant's billing_event table (raw scan).
    const scan = await withTenant(h.pool, h.tenantA, (q) => q("SELECT payload_summary FROM billing_event"));
    const ledgerJson = JSON.stringify(scan.rows);
    for (const secret of [PAN, CVV, EXPIRY, CARDHOLDER]) expect(ledgerJson).not.toContain(secret);
  });

  it("the reconciliation ingest path introduces no card data into the ledger", async () => {
    // The authoritative snapshot type carries no card surface; reconcile writes no ledger row. Run a pass and
    // re-scan to prove the ledger stays card-free after BOTH ingest paths (FR-018 applies to reconcile too).
    const sub = await h.getSubscription("sub_card_leak");
    const authoritative: AuthoritativeSubscription = { status: "active", occurredAt: BASE + 1000, periodEndUnix: BASE + 86400 };
    await reconcile(h.billingDeps(), async () => authoritative, { tenantId: h.tenantA, subscriptionId: sub!.id }, { nowUnix: BASE + 1000 });

    const scan = await withTenant(h.pool, h.tenantA, (q) => q("SELECT payload_summary FROM billing_event"));
    const ledgerJson = JSON.stringify(scan.rows);
    for (const secret of [PAN, CVV, EXPIRY, CARDHOLDER]) expect(ledgerJson).not.toContain(secret);
  });

  it("the signing secret is never returned by create / list / rotate, nor by the public view", async () => {
    const create = await h.admin("POST", "/admin/billing/connections", {
      provider: "generic",
      signingSecret: LEAK_SECRET,
      planMap: { gen_leak: { productId: h.productId, planId: h.planId } },
    });
    expect(create.statusCode).toBe(201);
    const connId = create.json().id as string;
    expect(create.json()).not.toHaveProperty("signingSecret");
    expect(JSON.stringify(create.json())).not.toContain(LEAK_SECRET);

    const list = await h.admin("GET", "/admin/billing/connections");
    const listJson = JSON.stringify(list.json());
    expect(listJson).not.toContain(LEAK_SECRET);
    expect(listJson).not.toContain("whsec_"); // no secret material of any connection leaks through the list

    const rotate = await h.admin("POST", `/admin/billing/connections/${connId}/rotate-secret`, { signingSecret: ROTATED_SECRET });
    expect(rotate.statusCode).toBe(200);
    const rotateJson = JSON.stringify(rotate.json());
    expect(rotateJson).not.toContain(ROTATED_SECRET);
    expect(rotateJson).not.toContain(LEAK_SECRET);

    // The billing_connection_public view neither exposes the secret columns nor any secret value.
    const view = await withTenant(h.pool, h.tenantA, (q) => q("SELECT * FROM billing_connection_public"));
    const cols = Object.keys(view.rows[0] as object);
    expect(cols).not.toContain("signing_secret_ref");
    expect(cols).not.toContain("signing_secret_prev");
    const viewJson = JSON.stringify(view.rows);
    for (const secret of [LEAK_SECRET, ROTATED_SECRET, SIGNING_SECRET]) expect(viewJson).not.toContain(secret);
  });

  it("no signing secret (or card datum) ever reaches a log line", async () => {
    // Emit a known marker through the app logger — pino writes it synchronously into the capture stream, so
    // this deterministically proves capture is wired (independent of async request-log flush timing).
    h.app.log.info({ probe: "secret-leakage-capture-marker" }, "log capture probe");
    await new Promise((r) => setImmediate(r)); // let any pending async request-log lines flush into the buffer too

    // Every operation above logged through the captured pino stream. Assert none of the secrets/card data ever
    // appear in the log buffer (the code never logs them; the request log line carries no body/headers).
    const logs = h.logs();
    expect(logs).toContain("secret-leakage-capture-marker"); // sanity: capture is actually wired
    for (const secret of [LEAK_SECRET, ROTATED_SECRET, SIGNING_SECRET, PAN, CVV, EXPIRY, CARDHOLDER]) {
      expect(logs).not.toContain(secret);
    }
  });
});
