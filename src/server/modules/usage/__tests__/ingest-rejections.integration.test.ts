// T016 [US1] (FR-006/021; SC-003/018): per-event rejection reasons + the DETERMINISTIC FR-021 precedence. A
// batch is processed per-event-idempotently (a bad event never fails the batch): an event referencing an
// unknown/cross-tenant license or entitlement → `not_found`; a non-metered entitlement → `not_metered`; an
// archived entitlement → `archived`; a license not in an active state (suspended/revoked/expired) →
// `license_inactive` (SC-018). The precedence is asserted directly: not_found > not_metered > archived >
// license_inactive > stale_event/future_event > validation_error — so an event matching MULTIPLE gates reports
// the single highest-severity reason. None of these accrue anything.
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { startHarness, type UsageHarness } from "./harness.js";

let h: UsageHarness;

beforeAll(async () => {
  h = await startHarness("reject");
}, 240_000);

afterAll(async () => {
  await h?.stop();
});

/** A structurally-valid event; `over` swaps in the field(s) under test. */
function makeEvent(entitlementId: string, over: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    licenseId: h.chainA.licenseId,
    entitlementId,
    source: "node-1",
    eventId: h.eventId(),
    eventTime: new Date(Date.now() - 3_600_000).toISOString(),
    quantity: 100,
    ...over,
  };
}

/** Ingest a single event and return its per-event rejection code (or null if it accrued/deduped). */
async function rejectionOf(event: Record<string, unknown>): Promise<string | null> {
  const res = await h.ingest(h.usageKey, { events: [event] });
  expect([200, 202]).toContain(res.statusCode);
  const body = res.json() as { rejected: { index: number; code: string }[] };
  return body.rejected[0]?.code ?? null;
}

describe("POST /v1/usage — per-event rejections (US1, T016)", () => {
  it("rejects an unknown license/entitlement with `not_found` and accrues nothing (SC-003)", async () => {
    const ent = await h.createMeteredEntitlement({ aggregation: "sum" });
    expect(await rejectionOf(makeEvent(ent, { licenseId: randomUUID() }))).toBe("not_found");
    expect(await rejectionOf(makeEvent(randomUUID()))).toBe("not_found");
    expect(await h.countEvents(h.chainA.licenseId, ent)).toBe(0);
  });

  it("rejects a cross-tenant license/entitlement reference with `not_found` (SC-003/012)", async () => {
    const entA = await h.createMeteredEntitlement({ aggregation: "sum" });
    const entB = await h.createMeteredEntitlementIn(h.tenantB, { aggregation: "sum" });
    // Tenant B's license is invisible under tenant A's RLS → not_found.
    expect(await rejectionOf(makeEvent(entA, { licenseId: h.chainB.licenseId }))).toBe("not_found");
    // Tenant B's entitlement is invisible under tenant A's RLS → not_found.
    expect(await rejectionOf(makeEvent(entB))).toBe("not_found");
  });

  it("rejects a non-metered entitlement with `not_metered`", async () => {
    const boolEnt = await h.createBooleanEntitlement();
    expect(await rejectionOf(makeEvent(boolEnt))).toBe("not_metered");
  });

  it("rejects an archived entitlement with `archived`", async () => {
    const archived = await h.createMeteredEntitlement({ aggregation: "sum", status: "archived" });
    expect(await rejectionOf(makeEvent(archived))).toBe("archived");
  });

  it("rejects a suspended / revoked / expired license with `license_inactive` (SC-018)", async () => {
    const ent = await h.createMeteredEntitlement({ aggregation: "sum" });

    await h.setLicenseStatus(h.chainA.licenseId, "suspended");
    expect(await rejectionOf(makeEvent(ent))).toBe("license_inactive");

    await h.setLicenseStatus(h.chainA.licenseId, "revoked");
    expect(await rejectionOf(makeEvent(ent))).toBe("license_inactive");

    // Back to active but expired in the past → still inactive.
    await h.setLicenseStatus(h.chainA.licenseId, "active");
    await h.expireLicense(h.chainA.licenseId, Math.floor(Date.now() / 1000) - 3_600);
    expect(await rejectionOf(makeEvent(ent))).toBe("license_inactive");

    // Restore for the precedence cases below.
    await h.expireLicense(h.chainA.licenseId, null);
    await h.setLicenseStatus(h.chainA.licenseId, "active");
    expect(await h.countEvents(h.chainA.licenseId, ent)).toBe(0);
  });

  describe("FR-021 precedence — the single highest-severity reason wins", () => {
    it("not_found beats license_inactive (unknown entitlement on a suspended license)", async () => {
      await h.setLicenseStatus(h.chainA.licenseId, "suspended");
      try {
        expect(await rejectionOf(makeEvent(randomUUID()))).toBe("not_found");
      } finally {
        await h.setLicenseStatus(h.chainA.licenseId, "active");
      }
    });

    it("not_metered beats license_inactive (boolean entitlement on a suspended license)", async () => {
      const boolEnt = await h.createBooleanEntitlement();
      await h.setLicenseStatus(h.chainA.licenseId, "suspended");
      try {
        expect(await rejectionOf(makeEvent(boolEnt))).toBe("not_metered");
      } finally {
        await h.setLicenseStatus(h.chainA.licenseId, "active");
      }
    });

    it("archived beats license_inactive (archived entitlement on a suspended license)", async () => {
      const archived = await h.createMeteredEntitlement({ aggregation: "sum", status: "archived" });
      await h.setLicenseStatus(h.chainA.licenseId, "suspended");
      try {
        expect(await rejectionOf(makeEvent(archived))).toBe("archived");
      } finally {
        await h.setLicenseStatus(h.chainA.licenseId, "active");
      }
    });

    it("license_inactive beats stale_event (a too-old event on a suspended license)", async () => {
      const ent = await h.createMeteredEntitlement({ aggregation: "sum" });
      const stale = new Date(Date.now() - 40 * 24 * 3_600_000).toISOString(); // ~40d > 35d retention
      await h.setLicenseStatus(h.chainA.licenseId, "suspended");
      try {
        expect(await rejectionOf(makeEvent(ent, { eventTime: stale }))).toBe("license_inactive");
      } finally {
        await h.setLicenseStatus(h.chainA.licenseId, "active");
      }
    });

    it("stale_event / future_event beat validation_error (bad dimensions but out-of-skew time)", async () => {
      const ent = await h.createMeteredEntitlement({ aggregation: "sum" });
      const badDims = { nested: { pii: "x" } }; // violates the scalar-only allow-list → validation_error
      const stale = new Date(Date.now() - 40 * 24 * 3_600_000).toISOString();
      const future = new Date(Date.now() + 24 * 3_600_000).toISOString(); // +1d > 5m skew
      expect(await rejectionOf(makeEvent(ent, { eventTime: stale, dimensions: badDims }))).toBe("stale_event");
      expect(await rejectionOf(makeEvent(ent, { eventTime: future, dimensions: badDims }))).toBe("future_event");
    });

    it("reports validation_error for a malformed quantity once all higher gates pass (COUNT non-integer)", async () => {
      const ent = await h.createMeteredEntitlement({ aggregation: "count" });
      expect(await rejectionOf(makeEvent(ent, { quantity: 1.5 }))).toBe("validation_error");
    });
  });
});
