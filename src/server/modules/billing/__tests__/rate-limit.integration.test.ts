// T044 (FR-019, SC-013): the webhook plane is rate-limited at TWO granularities and shed deliveries are
// audited. The per-CONNECTION limit trips BEFORE signature verification (an onRequest hook), and the
// per-SOURCE-IP limit trips BEFORE connection resolution — so a flood of UNKNOWN/invalid {connectionId}
// values that never resolve is still bounded (a 429 for an unknown id proves the limit fired ahead of
// resolution). Over-limit → 429 `rate_limited` + a `Retry-After` header; a shed delivery to a KNOWN
// connection is audited as a security event. Uses the harness with LOW ceilings to exercise the shed path.
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { startBillingHarness, type BillingHarness } from "./harness.js";

let h: BillingHarness;
const MAX_PER_IP = 20;
const MAX_PER_CONNECTION = 3;

beforeAll(async () => {
  h = await startBillingHarness("rate-limit", { rateMaxPerIp: MAX_PER_IP, rateMaxPerConnection: MAX_PER_CONNECTION });
}, 240_000);

afterAll(async () => {
  await h?.stop();
});

/** Poll the audit trail for the connection until `pred` matches or the timeout elapses (best-effort audit). */
async function waitForAudit(
  pred: (r: { actor: string; action: string; after: unknown }) => boolean,
  timeoutMs = 3000,
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const rows = await h.auditFor(h.connectionId);
    if (rows.some(pred)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

describe("webhook rate limiting — two granularities, Retry-After, audited (FR-019, SC-013)", () => {
  it("the per-CONNECTION limit trips (before signature verify) → 429 rate_limited + Retry-After", async () => {
    // Deliver to a KNOWN connection with the signature OMITTED. Under the limit → 401 (signature missing,
    // i.e. the rate-limit onRequest hook let it reach the handler). At the limit → 429 BEFORE verify.
    const statuses: number[] = [];
    let over: Awaited<ReturnType<typeof h.postWebhook>> | undefined;
    for (let i = 0; i < MAX_PER_CONNECTION + 1; i++) {
      const res = await h.postWebhook(h.connectionId, { ping: i }, { signature: null });
      statuses.push(res.statusCode);
      if (res.statusCode === 429) over = res;
    }
    // The first MAX are let through (401 invalid_signature); the next is shed (429).
    expect(statuses.slice(0, MAX_PER_CONNECTION).every((s) => s === 401)).toBe(true);
    expect(statuses[MAX_PER_CONNECTION]).toBe(429);

    expect(over).toBeDefined();
    expect(over!.json().code).toBe("rate_limited");
    expect((over!.json().details as { retryAfterSeconds?: number }).retryAfterSeconds).toBeGreaterThan(0);
    expect(over!.headers["retry-after"]).toBeDefined(); // the provider's backoff signal

    // A shed delivery to a KNOWN connection is audited as a security event (fail-safe, async).
    const audited = await waitForAudit((r) => r.action === "billing.webhook.rate_limited");
    expect(audited).toBe(true);
  });

  it("the per-SOURCE-IP limit trips for UNKNOWN connection ids BEFORE resolution (pre-auth flood guard)", async () => {
    // Each request targets a UNIQUE unknown {connectionId}, so the per-connection limit (keyed by id) never
    // trips — only the shared per-IP limit can. A request that PASSES the limit resolves to 404 (unknown
    // connection); once the per-IP budget is exhausted, an unknown id is shed 429 BEFORE it can 404 — proving
    // the per-IP limit fires ahead of connection resolution.
    const statuses: number[] = [];
    for (let i = 0; i < MAX_PER_IP + 12; i++) {
      const res = await h.postWebhook(randomUUID(), { ping: i }, { signature: null });
      statuses.push(res.statusCode);
    }
    expect(statuses).toContain(404); // some unknown ids passed the limit and resolved to not-found
    expect(statuses).toContain(429); // the per-IP budget was exhausted → unknown ids shed pre-resolution
    // The tail is uniformly shed once the budget is gone.
    expect(statuses[statuses.length - 1]).toBe(429);
  });
});
