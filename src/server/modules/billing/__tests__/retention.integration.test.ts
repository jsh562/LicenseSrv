// [US1] (FR-021/SC-015): ledger retention prune is ENFORCED and owner-scoped. Inserts `billing_event` rows
// straddling the retention horizon and proves the prune removes ONLY the aged rows while rows inside the
// idempotency/retention floor are RETAINED; that the horizon is clamped strictly above the idempotency floor
// (a still-redeliverable event id is never pruned, FR-003); and that the prune REQUIRES the schema-owner role —
// the RLS-forced `licensesrv_app` app role has SELECT/INSERT-only on the append-only ledger and its DELETE is
// denied. Uses the real Testcontainers billing harness (owns a tenant-A `billing_connection`, so the FK holds).
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { privileged, withTenant } from "../../../db/client.js";
import { IDEMPOTENCY_FLOOR_SECS } from "../config.js";
import { pruneBillingLedger, startBillingRetentionWorker } from "../retention-worker.js";
import { startBillingHarness, type BillingHarness } from "./harness.js";

let h: BillingHarness;

/** epoch seconds now — the prune clock. */
const now = (): number => Math.floor(Date.now() / 1000);

/** A 72h retention horizon (> the 48h idempotency floor). */
const RETENTION_72H = 259_200;

beforeAll(async () => {
  h = await startBillingHarness("retention");
}, 240_000);

afterAll(async () => {
  await h?.stop();
});

/** Owner-level: clear the tenant-A ledger so each case is independent (age-range prune is global). */
async function resetLedger(): Promise<void> {
  await privileged(h.pool, (q) => q("DELETE FROM billing_event WHERE tenant_id = $1", [h.tenantA]));
}

/** Insert one applied `billing_event` for tenant A whose `received_at` (+ `occurred_at`) is `ageSecs` in the past. */
async function insertEvent(ageSecs: number, providerEventId: string): Promise<void> {
  await privileged(h.pool, (q) =>
    q(
      `INSERT INTO billing_event
         (id, tenant_id, provider, provider_event_id, type, subscription_id, occurred_at, received_at, outcome, reason, payload_summary)
       VALUES ($1, $2, 'stripe', $3, 'subscription.renewed', NULL,
               now() - ($4::double precision * interval '1 second'),
               now() - ($4::double precision * interval '1 second'), 'applied', NULL, NULL)`,
      [randomUUID(), h.tenantA, providerEventId, ageSecs],
    ),
  );
}

/** Tenant-A ledger row count (via the RLS app role). */
async function ledgerCount(): Promise<number> {
  return withTenant(h.pool, h.tenantA, async (q) => {
    const r = await q("SELECT count(*)::int AS n FROM billing_event", []);
    return (r.rows[0] as { n: number }).n;
  });
}

/** Is a given provider event id still present in the tenant-A ledger? */
async function hasEvent(providerEventId: string): Promise<boolean> {
  return withTenant(h.pool, h.tenantA, async (q) => {
    const r = await q("SELECT 1 FROM billing_event WHERE provider_event_id = $1", [providerEventId]);
    return Boolean(r.rowCount);
  });
}

describe("billing ledger retention prune (FR-021, SC-015)", () => {
  it("prunes only rows older than the retention horizon; rows inside the floor are retained", async () => {
    await resetLedger();
    const cfg = { ...h.billingDeps().config, ledgerRetentionSecs: RETENTION_72H };
    await insertEvent(4 * 86_400, "evt_aged"); // 96h old — beyond the 72h horizon
    await insertEvent(24 * 3_600, "evt_floor"); // 24h old — inside the 48h idempotency floor
    await insertEvent(0, "evt_fresh");
    expect(await ledgerCount()).toBe(3);

    const { deleted } = await pruneBillingLedger(h.pool, cfg, now());

    expect(deleted).toBe(1); // ONLY the aged row
    expect(await hasEvent("evt_aged")).toBe(false);
    expect(await hasEvent("evt_floor")).toBe(true); // inside the idempotency floor — retained
    expect(await hasEvent("evt_fresh")).toBe(true);
  });

  it("clamps the horizon strictly above the idempotency floor — a live-idempotency-window row is never pruned (FR-003)", async () => {
    await resetLedger();
    // A hostile operator value BELOW the idempotency floor: resolveLedgerRetentionSecs must clamp it to
    // > IDEMPOTENCY_FLOOR_SECS (48h), so a 47h-old (still-redeliverable) row survives while a 10d row is pruned.
    const hostile = { ...h.billingDeps().config, ledgerRetentionSecs: 3_600 };
    expect(hostile.ledgerRetentionSecs).toBeLessThan(IDEMPOTENCY_FLOOR_SECS);
    await insertEvent(47 * 3_600, "evt_in_window"); // 47h old — inside the 48h floor
    await insertEvent(10 * 86_400, "evt_ancient"); // 10d old — safely prunable

    const { deleted } = await pruneBillingLedger(h.pool, hostile, now());

    expect(deleted).toBe(1);
    expect(await hasEvent("evt_in_window")).toBe(true); // clamp protected the redeliverable row
    expect(await hasEvent("evt_ancient")).toBe(false);
  });

  it("requires the schema-owner role — the RLS-forced app role has no DELETE grant on billing_event", async () => {
    await resetLedger();
    await insertEvent(10 * 86_400, "evt_grant");
    // The app role (licensesrv_app) holds SELECT/INSERT only on the append-only ledger — a DELETE is denied.
    await expect(
      withTenant(h.pool, h.tenantA, (q) => q("DELETE FROM billing_event WHERE received_at < now()", [])),
    ).rejects.toThrow();
    expect(await hasEvent("evt_grant")).toBe(true); // the denied app-role DELETE changed nothing

    // The owner prune succeeds where the app role cannot.
    const cfg = { ...h.billingDeps().config, ledgerRetentionSecs: RETENTION_72H };
    const { deleted } = await pruneBillingLedger(h.pool, cfg, now());
    expect(deleted).toBe(1);
    expect(await hasEvent("evt_grant")).toBe(false);
  });

  it("the retention worker sweep prunes aged rows on the owner connection (end-to-end wiring)", async () => {
    await resetLedger();
    await insertEvent(10 * 86_400, "evt_worker_aged");
    await insertEvent(0, "evt_worker_fresh");
    const cfg = { ...h.billingDeps().config, ledgerRetentionSecs: RETENTION_72H };
    const worker = startBillingRetentionWorker(h.pool, cfg, { immediate: false });
    try {
      await worker.runOnce();
    } finally {
      worker.stop();
    }
    expect(await hasEvent("evt_worker_aged")).toBe(false);
    expect(await hasEvent("evt_worker_fresh")).toBe(true);
  });
});
