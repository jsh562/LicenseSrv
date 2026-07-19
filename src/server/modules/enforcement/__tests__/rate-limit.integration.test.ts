// T041 [Polish] (FR-021; SC-013): @fastify/rate-limit is active on ALL THREE enforcement routes — validate,
// heartbeat, AND revocation-list — per API key, refusing an over-limit request `429` + `rate_limited` with a
// `Retry-After` header, and auditing the limit-exceeded event (`enforcement.rate_limited`, security_event).
// Mirrors the E009 activation rate-limit expectation. Each route has its own per-key limiter, so exhausting
// one does not affect another; the low ceiling is set on a dedicated harness app instance. Real Postgres via
// Testcontainers + the real E004 signer.
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { privileged } from "../../../db/client.js";
import { startHarness, type EnforcementHarness } from "./harness.js";

const RATE_MAX = 3; // low ceiling for THIS app instance so the limiter trips deterministically

let h: EnforcementHarness;
let activationId: string;

beforeAll(async () => {
  h = await startHarness("rate-limit", { rateMax: RATE_MAX });
  const lic = await h.issueLicense();
  const act = await h.activateMachine(lic.id, h.sigs("rl1", "rl2", "rl3", "rl4", "rl5"));
  activationId = act.activationId;
}, 240_000);

afterAll(async () => {
  await h?.stop();
});

/** Fire `n` requests sequentially and return their status codes. */
async function fireN(n: number, call: () => Promise<{ statusCode: number }>): Promise<number[]> {
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push((await call()).statusCode);
  return out;
}

const rateLimitedEvents = (): Promise<number> =>
  privileged(h.pool, async (q) => {
    const r = await q(
      `SELECT count(*)::int AS n FROM audit_log WHERE tenant_id = $1 AND action = 'enforcement.rate_limited'`,
      [h.tenantA],
    );
    return (r.rows[0] as { n: number }).n;
  });

describe("enforcement rate limiting on all three routes (integration, real Postgres)", () => {
  it("US1: POST /v1/validate over the ceiling → 429 rate_limited + Retry-After, audited (FR-021/SC-013)", async () => {
    // The first RATE_MAX succeed (200 valid); the next request is refused before it reaches the handler.
    const statuses = await fireN(RATE_MAX + 1, () => h.validate(h.validateKey, { activationId, nonce: h.nonce() }));
    expect(statuses.slice(0, RATE_MAX).every((s) => s === 200)).toBe(true);

    const limited = await h.validate(h.validateKey, { activationId, nonce: h.nonce() });
    expect(limited.statusCode).toBe(429);
    expect((limited.json() as { code: string }).code).toBe("rate_limited");
    expect(limited.headers["retry-after"]).toBeDefined();

    // onExceeded audits fire-and-forget; poll briefly for the security event (FR-019/FR-021).
    let events = 0;
    for (let i = 0; i < 20 && events < 1; i++) {
      events = await rateLimitedEvents();
      if (events < 1) await new Promise((r) => setTimeout(r, 50));
    }
    expect(events).toBeGreaterThanOrEqual(1);
  });

  it("US3: POST /v1/heartbeat is independently rate-limited → 429 rate_limited (FR-021)", async () => {
    // A fresh per-route counter: drive it over the ceiling and assert the final beat is refused.
    const statuses = await fireN(RATE_MAX + 2, () => h.heartbeat(h.validateKey, { activationId, nonce: h.nonce() }));
    expect(statuses).toContain(429);
    const limited = await h.heartbeat(h.validateKey, { activationId, nonce: h.nonce() });
    expect(limited.statusCode).toBe(429);
    expect((limited.json() as { code: string }).code).toBe("rate_limited");
  });

  it("US4: GET /v1/revocation-list is rate-limited → 429 rate_limited (FR-021)", async () => {
    // The limiter runs before the handler, so this trips even with no CRL published (a 404 otherwise).
    const query = { productId: h.productId };
    const statuses = await fireN(RATE_MAX + 2, () => h.crlGet(h.validateKey, query));
    expect(statuses).toContain(429);
    const limited = await h.crlGet(h.validateKey, query);
    expect(limited.statusCode).toBe(429);
    expect((limited.json() as { code: string }).code).toBe("rate_limited");
  });
});
