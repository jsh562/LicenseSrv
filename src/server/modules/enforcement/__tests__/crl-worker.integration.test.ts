// T035 [US4] (FR-009/019): the CRL publication worker regenerates a signed CRL for a (tenant, product) when
// the revoked set CHANGES, audits the publication (`crl.published`), does NOT republish when nothing changed,
// and is FAIL-OPEN (a missing signer is a no-op, never a throw). Real Postgres via Testcontainers + the real
// E004 signer; the worker is driven deterministically via `runOnce()` (immediate:false, no cadence wait).
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { withTenant } from "../../../db/client.js";
import { loadEnforcementConfig } from "../config.js";
import { getLatestCrl } from "../crl.js";
import { startCrlWorker } from "../crl-worker.js";
import { startHarness, type EnforcementHarness } from "./harness.js";

const config = loadEnforcementConfig();

let h: EnforcementHarness;

const latestVersion = (): Promise<number | null> =>
  withTenant(h.pool, h.tenantA, async (q) => {
    const rec = await getLatestCrl(q, h.tenantA, h.productId);
    return rec?.version ?? null;
  });

const publishedAuditCount = (): Promise<number> =>
  withTenant(h.pool, h.tenantA, async (q) => {
    const r = await q("SELECT count(*)::int AS n FROM audit_log WHERE action = 'crl.published' AND target = $1", [h.productId]);
    return (r.rows[0] as { n: number }).n;
  });

beforeAll(async () => {
  h = await startHarness("crl-worker");
}, 240_000);

afterAll(async () => {
  await h?.stop();
});

describe("CRL worker (integration, real Postgres + real signer)", () => {
  it("US4: publishes a signed CRL when a license is revoked, and audits it (FR-009/019)", async () => {
    const lic = await h.issueLicense();
    await h.revokeLicense(lic.id);
    expect(await latestVersion()).toBeNull(); // no CRL yet

    const worker = startCrlWorker(h.pool, h.signer(), config, { immediate: false });
    try {
      await worker.runOnce();
    } finally {
      worker.stop();
    }

    const v1 = await latestVersion();
    expect(v1).not.toBeNull();
    expect(await publishedAuditCount()).toBe(1);

    const rec = await withTenant(h.pool, h.tenantA, (q) => getLatestCrl(q, h.tenantA, h.productId));
    expect(rec?.revokedIds.licenses).toContain(lic.id);
  });

  it("US4: does NOT republish when the revoked set is unchanged and next_update has not elapsed", async () => {
    const before = await latestVersion();
    const worker = startCrlWorker(h.pool, h.signer(), config, { immediate: false });
    try {
      await worker.runOnce();
    } finally {
      worker.stop();
    }
    expect(await latestVersion()).toBe(before); // no new version — the set did not change
  });

  it("US4: republishes with an advanced version when the revoked set changes (FR-009)", async () => {
    const before = (await latestVersion())!;
    const lic = await h.issueLicense();
    await h.revokeLicense(lic.id);

    const worker = startCrlWorker(h.pool, h.signer(), config, { immediate: false });
    try {
      await worker.runOnce();
    } finally {
      worker.stop();
    }

    const after = (await latestVersion())!;
    expect(after).toBe(before + 1);
    const rec = await withTenant(h.pool, h.tenantA, (q) => getLatestCrl(q, h.tenantA, h.productId));
    expect(rec?.revokedIds.licenses).toContain(lic.id);
  });

  it("US4: fail-open — a missing signer is a no-op, never a throw", async () => {
    const errors: unknown[] = [];
    const worker = startCrlWorker(h.pool, undefined, config, { immediate: false, onError: (e) => errors.push(e) });
    try {
      await expect(worker.runOnce()).resolves.toBeUndefined();
    } finally {
      worker.stop();
    }
    expect(errors).toHaveLength(0); // a no-signer worker simply publishes nothing
  });
});
