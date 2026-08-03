// T042 [COMPLETES FR-019] (SC-013): the hard secrecy boundary of the usage surface. NONE of the following ever
// survives into a RESPONSE body, a LOG line (captured in-memory pino, like billing/lease), or an AUDIT entry:
//   • a secret / API key / signing key (the reporting `usage.ingest` API key is the canary secret),
//   • card / PAN data (embedded in a client-supplied `source` + dimension value — client data the surface must
//     never echo back or log),
//   • PII beyond license / entitlement / dimension references (an email canary embedded the same way).
// The query response carries ONLY aggregate values + license/entitlement references (never a stored dimension
// VALUE, never a secret), and the ingest summary + audit carry ONLY counts. The dimension ALLOW-LIST is enforced
// server-side (a non-scalar / oversized / disallowed-key dimension is a per-event `validation_error`, so PII
// cannot leak into free-form dimensions, SC-013). Uses the real Testcontainers harness with in-memory LOG CAPTURE.
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { withTenant } from "../../../db/client.js";
import { rollupSweep } from "../rollup-worker.js";
import { startHarness, type UsageHarness } from "./harness.js";

// Distinctive canary tokens (long, unambiguous — cannot collide with UUID / timestamp / base64-hash noise).
const PAN = "4111111111111111"; // classic test PAN — must never appear in a response/log/audit
const PII_EMAIL = "john.doe.CANARY@secret.example"; // PII beyond a ref — must never surface
const CVV = "CVVCANARY737";
const HOUR_MS = 3_600_000;

let h: UsageHarness;
/** All response bodies produced by the exercised operations (JSON strings), scanned for canaries. */
const responseBodies: string[] = [];
/** The batch-ingest summary (positive-shape assertions). */
let summary: Record<string, unknown> = {};
/** The admin query result (positive-shape assertions). */
let queryResult: Record<string, unknown> = {};

/** Every secret / card / PII canary that MUST be absent from any response, log line, or audit entry. */
function canaries(): string[] {
  return [PAN, PII_EMAIL, CVV, h.usageKey];
}

function recentHour(hoursAgo: number): Date {
  const h0 = Math.floor(Date.now() / HOUR_MS) * HOUR_MS;
  return new Date(h0 - hoursAgo * HOUR_MS);
}

beforeAll(async () => {
  h = await startHarness("secret-leak", { captureLogs: true });

  const ent = await h.createMeteredEntitlement({ aggregation: "sum", allowance: 10 });
  const at = recentHour(1);

  // 1) Ingest a VALID batch whose client-supplied fields are STUFFED with card / PII canaries (a PAN + CVV in
  //    the `source`, a PAN + PII email in dimension VALUES). These flow into raw storage but must NEVER echo
  //    back in the summary, appear in the ingest audit (counts only), or reach a log line.
  const good = {
    licenseId: h.chainA.licenseId,
    entitlementId: ent,
    source: `pos-terminal_${PAN}_${CVV}`,
    eventId: h.eventId(),
    eventTime: at.toISOString(),
    quantity: 100, // > allowance 10 → also drives an over-quota crossing audit (counts/ids only)
    dimensions: { region: `eu_${PAN}`, note: PII_EMAIL },
  };
  const sRes = await h.ingest(h.usageKey, { events: [good] });
  if (sRes.statusCode !== 200) throw new Error(`ingest failed: ${sRes.statusCode} ${sRes.body}`);
  responseBodies.push(sRes.body);
  summary = sRes.json() as Record<string, unknown>;

  // 2) Roll up (drives the durable aggregate + the over-quota crossing audit — a synthetic-actor entry).
  await rollupSweep(h.pool, { since: new Date(0), bucketSeconds: 3600 });

  // 3) Admin query (viewer + admin raw) — the reproducible aggregate projection; only refs + values, no dims.
  //    Exercise all three bucket groupings (hour/day/period) so no grouping path can echo a stored dimension.
  const win = { from: recentHour(24).toISOString(), to: new Date().toISOString() };
  responseBodies.push((await h.getUsage(h.authViewer, h.chainA.licenseId, { ...win, bucket: "hour" })).body);
  responseBodies.push((await h.getUsage(h.authViewer, h.chainA.licenseId, { ...win, bucket: "day" })).body);
  responseBodies.push((await h.getUsage(h.authViewer, h.chainA.licenseId, { ...win, bucket: "period" })).body);
  // raw=true WITH a bucket breakdown — the true-signed-net per-bucket projection (still refs + values only).
  responseBodies.push((await h.getUsage(h.authAdmin, h.chainA.licenseId, { ...win, raw: "true", bucket: "hour" })).body);
  const adminRes = await h.getUsage(h.authAdmin, h.chainA.licenseId, { ...win, raw: "true" });
  responseBodies.push(adminRes.body);
  queryResult = adminRes.json() as Record<string, unknown>;
}, 240_000);

afterAll(async () => {
  await h?.stop();
});

describe("usage secret leakage — no API key / card-PAN / PII in any response, log, or audit (FR-019, SC-013)", () => {
  it("no canary appears in ANY response body; the summary + query carry only counts / refs / aggregate values", () => {
    for (const body of responseBodies) {
      for (const secret of canaries()) expect(body).not.toContain(secret);
    }

    // Positive shape: the ingest summary is counts only (no echoed payload).
    expect(summary).toMatchObject({ accepted: 1, duplicate: 0, rejected: [] });

    // Positive shape: the query result exposes only refs + aggregate values (never a stored dimension VALUE).
    const ents = queryResult.entitlements as Record<string, unknown>[];
    expect(ents.length).toBeGreaterThanOrEqual(1);
    expect(ents[0]).toMatchObject({ value: 100, aggregation: "sum", overQuota: true });
    expect(Object.keys(ents[0]!).sort()).toEqual(["aggregation", "allowance", "entitlementId", "overQuota", "unit", "value"]);
  });

  it("no canary reaches the append-only audit log (ingest batch, over-quota crossing, rollup — counts/ids only)", async () => {
    const auditScan = await withTenant(h.pool, h.tenantA, (q) => q("SELECT to_jsonb(audit_log) AS row FROM audit_log"));
    const auditJson = JSON.stringify(auditScan.rows);
    for (const secret of canaries()) expect(auditJson).not.toContain(secret);
  });

  it("no canary reaches a log line (in-memory pino capture); the x-api-key is never logged in the clear", async () => {
    // Emit a known marker through the app logger — pino writes it synchronously into the capture stream, proving
    // capture is wired (independent of async request-log flush timing).
    h.app.log.info({ probe: "usage-secret-leakage-capture-marker" }, "log capture probe");
    await new Promise((r) => setImmediate(r)); // let any pending async request-log lines flush into the buffer

    const logs = h.logs();
    expect(logs).toContain("usage-secret-leakage-capture-marker"); // sanity: capture is actually wired
    for (const secret of canaries()) expect(logs).not.toContain(secret);
  });

  it("the dimension ALLOW-LIST is enforced server-side — a non-scalar / oversized / disallowed dimension is refused", async () => {
    const ent = await h.createMeteredEntitlement({ aggregation: "sum" });
    const base = {
      licenseId: h.chainA.licenseId,
      entitlementId: ent,
      source: "s1",
      eventTime: recentHour(1).toISOString(),
      quantity: 1,
    };

    // A nested-object dimension VALUE is not a scalar → per-event validation_error (PII cannot smuggle in nested).
    const nested = await h.ingest(h.usageKey, { events: [{ ...base, eventId: h.eventId(), dimensions: { profile: { email: PII_EMAIL } } }] });
    expect(nested.statusCode).toBe(200);
    let body = nested.json() as { accepted: number; rejected: { code: string; message: string }[] };
    expect(body.accepted).toBe(0);
    expect(body.rejected[0]!.code).toBe("validation_error");
    // The rejection message names only the KEY, never the smuggled PII VALUE.
    expect(body.rejected[0]!.message).not.toContain(PII_EMAIL);

    // An oversized string dimension value (> the 256-char cap) is refused too.
    const oversized = await h.ingest(h.usageKey, { events: [{ ...base, eventId: h.eventId(), dimensions: { blob: "x".repeat(300) } }] });
    body = oversized.json() as { accepted: number; rejected: { code: string; message: string }[] };
    expect(body.accepted).toBe(0);
    expect(body.rejected[0]!.code).toBe("validation_error");

    // A disallowed key shape (not a bounded slug) is refused.
    const badKey = await h.ingest(h.usageKey, { events: [{ ...base, eventId: h.eventId(), dimensions: { "not a key!": "v" } }] });
    body = badKey.json() as { accepted: number; rejected: { code: string }[] };
    expect(body.accepted).toBe(0);
    expect(body.rejected[0]!.code).toBe("validation_error");
  });
});
