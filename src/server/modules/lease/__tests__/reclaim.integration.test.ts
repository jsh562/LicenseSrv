// T026 [US3] (FR-010/018; SC-007/008): the fail-open reclaim sweeper. A lease whose TTL + grace has elapsed
// with no renewal is reclaimed (oldest-expired-first, bounded per run) so its seat returns to the pool and a
// new acquire succeeds with no operator action (SC-007); the reclamation is attributed to a SYNTHETIC worker
// actor + the lease/license id (FR-018). A sweep is idempotent across runs, drains a lapsed set larger than one
// batch deterministically, and is FAIL-OPEN — a sweep fault never throws and never blocks the live acquire/
// renew/release surface (SC-008). Real Postgres + the real E004 signer.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";

import { privileged } from "../../../db/client.js";
import { RECLAIM_ACTOR, reclaimSweep, startReclaimWorker } from "../reclaim-worker.js";
import { startHarness, type LeaseHarness } from "./harness.js";

let h: LeaseHarness;

beforeAll(async () => {
  h = await startHarness("reclaim");
}, 240_000);

afterAll(async () => {
  await h?.stop();
});

async function acquireId(licenseId: string): Promise<string> {
  const res = await h.acquire(h.leaseKey, { licenseId, holderReference: h.holderRef(), acquireToken: h.nonce() });
  if (res.statusCode !== 201) throw new Error(`acquire failed: ${res.statusCode} ${res.body}`);
  return (res.json() as { id: string }).id;
}

const reclaimAudits = (leaseId: string): Promise<{ actor: string; after: { reason: string } }[]> =>
  privileged(h.pool, async (q) => {
    const r = await q("SELECT actor, after FROM audit_log WHERE action = 'lease.reclaimed' AND target = $1", [leaseId]);
    return r.rows as { actor: string; after: { reason: string } }[];
  });

describe("lease reclaim sweeper (integration, real Postgres + real signer)", () => {
  it("SC-007: a TTL+grace-lapsed lease is reclaimed so a new acquire succeeds, attributed to the worker actor", async () => {
    const lic = await h.issueFloating({ maxConcurrent: 1 });
    const leaseId = await acquireId(lic.licenseId);

    // At capacity: a new acquire is refused while the (stale) lease still holds the seat.
    const blocked = await h.acquire(h.leaseKey, { licenseId: lic.licenseId, holderReference: h.holderRef(), acquireToken: h.nonce() });
    expect(blocked.statusCode).toBe(409);

    // The machine stopped heartbeating: its lease lapses past TTL + grace.
    await h.expireLease(leaseId);
    const swept = await reclaimSweep(h.pool);
    expect(swept.reclaimed).toBeGreaterThanOrEqual(1);
    expect((await h.leaseRow(leaseId))?.status).toBe("reclaimed");
    expect(await h.countLive(lic.licenseId)).toBe(0);

    // The reclamation is audited to the synthetic worker actor + the lease id (FR-018).
    const audits = await reclaimAudits(leaseId);
    expect(audits.length).toBe(1);
    expect(audits[0]!.actor).toBe(RECLAIM_ACTOR);
    expect(audits[0]!.after.reason).toBe("ttl_grace");

    // The seat is free again with no operator action.
    const fresh = await h.acquire(h.leaseKey, { licenseId: lic.licenseId, holderReference: h.holderRef(), acquireToken: h.nonce() });
    expect(fresh.statusCode).toBe(201);
  });

  it("FR-010: the sweep is bounded (oldest-expired-first) and drains a large lapsed set across runs, idempotently", async () => {
    const lic = await h.issueFloating({ maxConcurrent: 5 });
    const older = await acquireId(lic.licenseId);
    const newer = await acquireId(lic.licenseId);
    await h.expireLease(older, 7_200); // more stale
    await h.expireLease(newer, 3_600); // less stale (still past grace)
    expect(await h.countLive(lic.licenseId)).toBe(2);

    // maxBatch 1 → reclaims exactly the OLDEST-expired first.
    const run1 = await reclaimSweep(h.pool, { maxBatch: 1 });
    expect(run1.reclaimed).toBe(1);
    expect((await h.leaseRow(older))?.status).toBe("reclaimed");
    expect((await h.leaseRow(newer))?.status).toBe("live");

    // The next run drains the remainder; a further run is a no-op (idempotent).
    const run2 = await reclaimSweep(h.pool, { maxBatch: 5 });
    expect(run2.reclaimed).toBe(1);
    expect((await h.leaseRow(newer))?.status).toBe("reclaimed");
    const run3 = await reclaimSweep(h.pool, { maxBatch: 5 });
    expect(run3.reclaimed).toBe(0);
  });

  it("SC-008: the sweep is FAIL-OPEN — a sweep fault never throws and never blocks the live surface", async () => {
    const errors: unknown[] = [];
    // A broken pool whose connect always rejects — the enumeration step faults.
    const brokenPool = { connect: () => Promise.reject(new Error("pool down")) } as unknown as pg.Pool;
    await expect(reclaimSweep(brokenPool, { onError: (e) => errors.push(e) })).resolves.toEqual({ reclaimed: 0 });
    expect(errors.length).toBeGreaterThanOrEqual(1);

    // The live acquire/renew/release surface (the real pool) is entirely unaffected by the sweep fault.
    const lic = await h.issueFloating({ maxConcurrent: 2 });
    const a = await h.acquire(h.leaseKey, { licenseId: lic.licenseId, holderReference: h.holderRef(), acquireToken: h.nonce() });
    expect(a.statusCode).toBe(201);
    const leaseId = (a.json() as { id: string }).id;
    expect((await h.renew(h.leaseKey, leaseId)).statusCode).toBe(200);
    expect((await h.release(h.leaseKey, leaseId)).statusCode).toBe(200);
  });

  it("FR-010: the time-driven worker runs a bounded sweep on start + runOnce (idempotent) and stops cleanly", async () => {
    const lic = await h.issueFloating({ maxConcurrent: 1 });
    const leaseId = await acquireId(lic.licenseId);
    await h.expireLease(leaseId);

    // immediate:false → no sweep until runOnce; a manual runOnce reclaims; a second runOnce is a no-op (idempotent).
    const worker = startReclaimWorker(h.pool, { immediate: false, intervalMs: 3_600_000 });
    try {
      expect((await h.leaseRow(leaseId))?.status).toBe("live"); // not swept yet
      await worker.runOnce();
      expect((await h.leaseRow(leaseId))?.status).toBe("reclaimed");
      await worker.runOnce(); // nothing left to reclaim
    } finally {
      worker.stop();
    }

    // immediate:true (default) → a sweep fires (async) on start; a second expired lease is reclaimed with no action.
    const leaseId2 = await acquireId(lic.licenseId);
    await h.expireLease(leaseId2);
    const started = startReclaimWorker(h.pool, { intervalMs: 3_600_000 });
    try {
      const deadline = Date.now() + 3_000;
      while (Date.now() < deadline && (await h.leaseRow(leaseId2))?.status === "live") {
        await new Promise((r) => setTimeout(r, 50));
      }
      expect((await h.leaseRow(leaseId2))?.status).toBe("reclaimed");
    } finally {
      started.stop();
    }
  });

  it("SC-008: fail-open even when a per-tenant sweep AND the logger fault — nothing throws, onError still fires", async () => {
    const lic = await h.issueFloating({ maxConcurrent: 1 });
    const leaseId = await acquireId(lic.licenseId);
    await h.expireLease(leaseId); // the tenant now has a DUE lease, so it is enumerated for the per-tenant sweep

    const errors: unknown[] = [];
    // A logger whose warn() itself throws — the best-effort logging must swallow that fault, and `maxBatch: -1`
    // makes the per-tenant sweep query fail (LIMIT -1), so the per-tenant catch fires. Neither fault escapes.
    const throwingLogger = {
      warn: (): void => {
        throw new Error("log sink down");
      },
    };
    await expect(
      reclaimSweep(h.pool, { maxBatch: -1, logger: throwingLogger, onError: (e) => errors.push(e) }),
    ).resolves.toEqual({ reclaimed: 0 });
    expect(errors.length).toBeGreaterThanOrEqual(1);
    // The live surface is unaffected — the faulted sweep reclaimed nothing, the lease is still live.
    expect((await h.leaseRow(leaseId))?.status).toBe("live");
  });
});
