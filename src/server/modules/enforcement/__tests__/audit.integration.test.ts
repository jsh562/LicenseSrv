// T042 [Polish] (FR-019; SC-015): validate/heartbeat outcomes and CRL publications are written APPEND-ONLY
// to the E002 audit_log, and denied/revoked renewals are FLAGGED as security events (security_event = true).
// A successful renewal records the monotonic-anchor floor decision (`after.anchorAdvanced`, T040); a revoked
// renewal appends a flagged `enforcement.refused`; a CRL publication appends `crl.published`. Append-only is
// asserted by monotonic row-count growth (no row is mutated or collapsed). Real Postgres via Testcontainers
// + the real E004 signer.
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { withTenant } from "../../../db/client.js";
import { loadEnforcementConfig } from "../config.js";
import { startCrlWorker } from "../crl-worker.js";
import { startHarness, type EnforcementHarness } from "./harness.js";

const config = loadEnforcementConfig();

let h: EnforcementHarness;

interface AuditRow {
  target: string | null;
  security_event: boolean;
  after: { anchorAdvanced?: boolean } | null;
}

const auditRows = (action: string): Promise<AuditRow[]> =>
  withTenant(h.pool, h.tenantA, async (q) => {
    const r = await q(
      `SELECT target, security_event, after FROM audit_log WHERE action = $1 ORDER BY ts`,
      [action],
    );
    return r.rows as AuditRow[];
  });

const countAudit = (action: string): Promise<number> =>
  withTenant(h.pool, h.tenantA, async (q) => {
    const r = await q(`SELECT count(*)::int AS n FROM audit_log WHERE action = $1`, [action]);
    return (r.rows[0] as { n: number }).n;
  });

beforeAll(async () => {
  h = await startHarness("audit");
}, 240_000);

afterAll(async () => {
  await h?.stop();
});

describe("enforcement audit (integration, real Postgres + real signer)", () => {
  it("FR-019: a successful renewal audits enforcement.renewed (non-security) recording the anchor-floor decision (T040)", async () => {
    const lic = await h.issueLicense();
    const fp = h.sigs("au1", "au2", "au3", "au4", "au5");
    const { activationId } = await h.activateMachine(lic.id, fp);

    const ok = await h.validate(h.validateKey, { activationId, nonce: h.nonce() });
    expect(ok.statusCode).toBe(200);

    const renewed = await auditRows("enforcement.renewed");
    expect(renewed.length).toBeGreaterThanOrEqual(1);
    // A renewal is NOT a security event, targets the activation, and records the monotonic-anchor decision.
    expect(renewed.every((r) => r.security_event === false)).toBe(true);
    expect(renewed.some((r) => r.target === activationId)).toBe(true);
    expect(renewed.some((r) => r.after?.anchorAdvanced === true)).toBe(true);
  });

  it("FR-019: a denied/revoked renewal appends a FLAGGED, append-only security event (SC-015)", async () => {
    const lic = await h.issueLicense();
    const fp = h.sigs("av1", "av2", "av3", "av4", "av5");
    const { activationId } = await h.activateMachine(lic.id, fp);
    await h.revokeLicense(lic.id);

    const before = await countAudit("enforcement.refused");
    expect((await h.heartbeat(h.validateKey, { activationId, nonce: h.nonce() })).json()).toMatchObject({ verdict: "revoked" });
    expect((await h.validate(h.validateKey, { activationId, nonce: h.nonce() })).json()).toMatchObject({ verdict: "revoked" });

    const refused = await auditRows("enforcement.refused");
    // Every refusal is flagged security_event = true (FR-019) and carries the specific reason as the target.
    expect(refused.every((r) => r.security_event === true)).toBe(true);
    expect(refused.some((r) => r.target === "revoked")).toBe(true);
    // Append-only: the two refused beats appended two more rows (no row mutated or collapsed).
    expect(await countAudit("enforcement.refused")).toBe(before + 2);
  });

  it("FR-019: a CRL publication appends an append-only crl.published entry (SC-015)", async () => {
    const lic = await h.issueLicense();
    await h.revokeLicense(lic.id); // give the CRL some content to publish

    const before = await countAudit("crl.published");
    const worker = startCrlWorker(h.pool, h.signer(), config, { immediate: false });
    try {
      await worker.runOnce();
    } finally {
      worker.stop();
    }

    const published = await auditRows("crl.published");
    expect(published.length).toBeGreaterThan(0);
    expect(published.some((r) => r.target === h.productId)).toBe(true);
    expect(await countAudit("crl.published")).toBeGreaterThan(before); // appended, never overwritten
  });
});
