// T031 (OR-012, SC-005): the tenant-isolation integration test against REAL Postgres + RLS via
// @testcontainers/postgresql. Reuses the module integration pattern (testcontainer + runMigrations +
// provisionTenant; RLS roles/policies from migration 0002). Asserts the P1 security invariant end-to-end:
//   A. a genuine cross-tenant attempt is BLOCKED by RLS AND raises the isolation signal (counter);
//   B. same-tenant traffic (>=100 requests + a canary cadence) raises NO signal/page (no false positives);
//   C. a healthy canary probe (RLS blocks) raises no page and refreshes the dead-man's switch;
//   D. a canary probe EXECUTION failure trips the dead-man's switch, NOT the isolation page;
//   E. a canary-observed breach pages via the isolation counter (while the probe still counts as alive).
import { randomUUID } from "node:crypto";
import path from "node:path";

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import type { Counter, Gauge } from "prom-client";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { makePool, withTenant } from "../../db/client.js";
import { runMigrations } from "../../db/migrate.js";
import { provisionTenant } from "../../db/repository.js";
import {
  type CanaryProbe,
  getCanaryLastSuccessGauge,
  getCanaryUpGauge,
  makeCrossTenantProbe,
  startCanary,
} from "../canary.js";
import {
  getIsolationViolationCounter,
  type SecurityEventLogger,
  setSecurityLogger,
} from "../isolation-assertion.js";
import { runWithContext } from "../request-context.js";

const MIGRATIONS_DIR = path.resolve(process.cwd(), "migrations");
const TENANT_A = randomUUID();
const TENANT_B = randomUUID();
// A large interval so the cadence timer never fires during the test — we drive probes via runOnce().
const NO_AUTO_TICK = 3_600_000;

let container: StartedPostgreSqlContainer;
let pool: pg.Pool;
const securityEvents: Array<Record<string, unknown>> = [];

/** Read the labelless isolation-violation counter's current value. */
async function counterValue(c: Counter = getIsolationViolationCounter()): Promise<number> {
  const m = await c.get();
  return m.values[0]?.value ?? 0;
}

/** Read a labelless gauge's current value. */
async function gaugeValue(g: Gauge): Promise<number> {
  const m = await g.get();
  return m.values[0]?.value ?? 0;
}

/** Run `fn` as if inside a request authenticated as `tenantId` (sets the ALS request context). */
function asAuthenticatedTenant<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
  return runWithContext({ requestId: randomUUID(), tenantId }, fn);
}

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine").start();
  pool = makePool(container.getConnectionUri(), 8);
  await runMigrations(pool, MIGRATIONS_DIR);
  await provisionTenant(pool, { id: TENANT_A, slug: "iso-a" });
  await provisionTenant(pool, { id: TENANT_B, slug: "iso-b" });
  // Capture the security-event stream so assertions can inspect it (and stdout stays quiet).
  const capturing: SecurityEventLogger = {
    error(obj: object): void {
      securityEvents.push(obj as Record<string, unknown>);
    },
  };
  setSecurityLogger(capturing);
}, 180_000);

afterAll(async () => {
  setSecurityLogger(undefined);
  await pool?.end();
  await container?.stop();
});

describe("tenant isolation end-to-end (integration, real Postgres + RLS)", () => {
  it("A: a cross-tenant attempt is BLOCKED by RLS AND raises the isolation signal (SC-005)", async () => {
    const before = await counterValue();
    const eventsBefore = securityEvents.length;

    // A request authenticated as tenant A whose transaction is (erroneously) scoped to tenant B — the exact
    // tenant-confusion the assertion catches at the withTenant() choke point.
    await asAuthenticatedTenant(TENANT_A, () =>
      withTenant(pool, TENANT_B, async (q) => {
        await q("SELECT 1", []);
      }),
    );

    // The signal was raised (counter += 1) and the security event carries the OR-011 fields.
    expect(await counterValue()).toBe(before + 1);
    expect(securityEvents.length).toBe(eventsBefore + 1);
    expect(securityEvents[securityEvents.length - 1]).toMatchObject({
      event: "tenant_isolation_violation",
      security_event: true,
      authenticated_tenant: TENANT_A,
      attempted_tenant: TENANT_B,
      source: "assertion",
      outcome: "blocked",
    });

    // RLS is the authoritative block: scoped to A, tenant B's own row is invisible (0 rows → "blocked").
    const probe = makeCrossTenantProbe({ pool, scopedTenant: TENANT_A, targetTenant: TENANT_B });
    expect((await probe()).outcome).toBe("blocked");
  });

  it("B: same-tenant traffic (>=100 requests + a canary cadence) raises NO signal/page (OR-012 no-FP window)", async () => {
    const before = await counterValue();
    const eventsBefore = securityEvents.length;

    // >= 100 same-tenant requests through the real withTenant() choke point.
    for (let i = 0; i < 100; i++) {
      await asAuthenticatedTenant(TENANT_A, () =>
        withTenant(pool, TENANT_A, async (q) => {
          await q("SELECT count(*)::int AS n FROM tenant", []);
        }),
      );
    }
    // Plus one full healthy canary cadence (probe blocks, as it should).
    const canary = startCanary({
      probe: makeCrossTenantProbe({ pool, scopedTenant: TENANT_A, targetTenant: TENANT_B }),
      immediate: false,
      intervalMs: NO_AUTO_TICK,
    });
    await canary.runOnce();
    canary.stop();

    expect(await counterValue()).toBe(before); // no increment across all same-tenant traffic
    expect(securityEvents.length).toBe(eventsBefore); // no security event
  });

  it("C: a healthy canary probe raises no page and refreshes the dead-man's switch (SC-005)", async () => {
    const before = await counterValue();
    const canary = startCanary({
      probe: makeCrossTenantProbe({ pool, scopedTenant: TENANT_A, targetTenant: TENANT_B }),
      immediate: false,
      intervalMs: NO_AUTO_TICK,
    });
    await canary.runOnce();
    canary.stop();

    expect(await gaugeValue(getCanaryUpGauge())).toBe(1); // probe executed to completion
    expect(await gaugeValue(getCanaryLastSuccessGauge())).toBeGreaterThan(0); // dead-man fresh
    expect(await counterValue()).toBe(before); // blocked probe → no page
  });

  it("D: a canary probe EXECUTION failure trips the dead-man's switch, NOT the isolation page (OR-012)", async () => {
    const before = await counterValue();
    const failing: CanaryProbe = async () => {
      throw new Error("probe transport error");
    };
    const canary = startCanary({ probe: failing, immediate: false, intervalMs: NO_AUTO_TICK });
    await canary.runOnce();
    canary.stop();

    expect(await gaugeValue(getCanaryUpGauge())).toBe(0); // dead-man's switch tripped
    expect(await counterValue()).toBe(before); // isolation page NOT fired by an execution failure
  });

  it("E: a canary-observed breach pages via the isolation counter while the probe still counts as alive", async () => {
    const before = await counterValue();
    const eventsBefore = securityEvents.length;
    // A probe that OBSERVES a leak (cross-tenant NOT blocked) — resolves "breach", never rejects.
    const breachProbe: CanaryProbe = async () => ({
      outcome: "breach",
      scopedTenant: TENANT_A,
      targetTenant: TENANT_B,
    });
    const canary = startCanary({ probe: breachProbe, immediate: false, intervalMs: NO_AUTO_TICK });
    await canary.runOnce();
    canary.stop();

    expect(await counterValue()).toBe(before + 1); // breach pages via the isolation counter
    expect(await gaugeValue(getCanaryUpGauge())).toBe(1); // the probe still ran to completion
    expect(securityEvents[securityEvents.length - 1]).toMatchObject({
      event: "tenant_isolation_violation",
      source: "canary",
      outcome: "not_blocked",
    });
    expect(securityEvents.length).toBe(eventsBefore + 1);
  });
});
