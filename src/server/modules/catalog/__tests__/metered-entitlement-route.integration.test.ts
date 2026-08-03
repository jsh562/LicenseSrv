// QC GAP 2 — the metered-entitlement DEFINITION over the HTTP catalog admin surface (E016 FR-008/FR-009,
// US3 "on the existing catalog admin surface"; SC-005/SC-006). The metered create/edit + freeze-on-usage
// logic already lives in entitlements.ts/validation.ts; this locks that an OPERATOR can define + edit a meter
// through the RUNNING system — POST/PATCH /admin/catalog/entitlements behind admin RBAC + CSRF, exactly like
// the existing boolean/integer_limit entitlement routes. Against real Postgres via the shared usage harness
// (seeded license chain + admin session + usage.ingest key + deterministic rollup), it confirms:
//   - SC-005: an operator POSTs a `type: metered` entitlement with { aggregation, unit, allowance? } → 201.
//   - SC-006: PATCHing the aggregation while EMPTY succeeds; once a usage_event exists it is refused 409
//     aggregation_frozen — while the signal-only allowance stays editable.
//   - a gauge/peak aggregation, or a missing unit, is refused 400 at the HTTP edge.
import { randomUUID } from "node:crypto";

import type { LightMyRequestResponse } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { startHarness, type Auth, type UsageHarness } from "../../usage/__tests__/harness.js";

let h: UsageHarness;

beforeAll(async () => {
  h = await startHarness("metered-route");
}, 240_000);

afterAll(async () => {
  await h?.stop();
});

const HOUR_MS = 3_600_000;
function recentHour(hoursAgo: number): Date {
  const h0 = Math.floor(Date.now() / HOUR_MS) * HOUR_MS;
  return new Date(h0 - hoursAgo * HOUR_MS);
}
function key(prefix: string): string {
  return `${prefix}-${randomUUID().slice(0, 8)}`;
}

/** POST/PATCH a catalog route with the admin session cookie + CSRF double-submit (mirrors the harness). */
function send(method: "POST" | "PATCH", url: string, auth: Auth, payload: unknown): Promise<LightMyRequestResponse> {
  return h.app.inject({
    method,
    url,
    cookies: { admin_session: auth.session, admin_csrf: auth.csrf },
    headers: { "x-csrf-token": auth.csrf },
    payload: payload as never,
  });
}

describe("POST /admin/catalog/entitlements — metered definition over HTTP (US3, SC-005)", () => {
  it("creates a metered entitlement with aggregation/unit/allowance via the route (201)", async () => {
    const res = await send("POST", "/admin/catalog/entitlements", h.authAdmin, {
      key: key("route-meter"),
      name: "Route meter",
      type: "metered",
      aggregation: "sum",
      unit: "gb",
      allowance: 500,
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ type: "metered", aggregation: "sum", unit: "gb", allowance: 500, status: "active" });
  });

  it("refuses a gauge/peak aggregation and a missing unit with 400 (counter-only, unit required)", async () => {
    const gauge = await send("POST", "/admin/catalog/entitlements", h.authAdmin, {
      key: key("route-gauge"),
      name: "Gauge",
      type: "metered",
      aggregation: "max",
      unit: "concurrent",
    });
    expect(gauge.statusCode).toBe(400);

    const noUnit = await send("POST", "/admin/catalog/entitlements", h.authAdmin, {
      key: key("route-nounit"),
      name: "No unit",
      type: "metered",
      aggregation: "sum",
    });
    expect(noUnit.statusCode).toBe(400);
    expect(noUnit.json().code).toBe("validation_error");
  });
});

describe("PATCH /admin/catalog/entitlements/:id — freeze-on-usage over HTTP (US3, SC-006)", () => {
  it("edits the aggregation while empty, then refuses it once a usage_event exists (409 aggregation_frozen)", async () => {
    const created = (
      await send("POST", "/admin/catalog/entitlements", h.authAdmin, {
        key: key("route-freeze"),
        name: "Route freeze",
        type: "metered",
        aggregation: "sum",
        unit: "gb",
      })
    ).json();
    const id = created.id as string;

    // No usage yet → editing the aggregation + unit over HTTP succeeds.
    const empty = await send("PATCH", `/admin/catalog/entitlements/${id}`, h.authAdmin, { aggregation: "count", unit: "calls" });
    expect(empty.statusCode).toBe(200);
    expect(empty.json()).toMatchObject({ aggregation: "count", unit: "calls" });

    // Accrue one usage_event against it via the runtime ingest plane.
    const ing = await h.ingest(h.usageKey, {
      events: [
        {
          licenseId: h.chainA.licenseId,
          entitlementId: id,
          source: "node-1",
          eventId: h.eventId(),
          eventTime: recentHour(1).toISOString(),
          quantity: 1,
        },
      ],
    });
    expect(ing.statusCode).toBe(200);
    expect(await h.countEvents(h.chainA.licenseId, id)).toBe(1);

    // Once usage exists the aggregation is FROZEN → 409 aggregation_frozen over HTTP.
    const frozen = await send("PATCH", `/admin/catalog/entitlements/${id}`, h.authAdmin, { aggregation: "sum" });
    expect(frozen.statusCode).toBe(409);
    expect(frozen.json().code).toBe("aggregation_frozen");

    // …but the signal-only allowance stays editable even after usage exists.
    const quota = await send("PATCH", `/admin/catalog/entitlements/${id}`, h.authAdmin, { allowance: 1000 });
    expect(quota.statusCode).toBe(200);
    expect(quota.json()).toMatchObject({ aggregation: "count", unit: "calls", allowance: 1000 });
  });

  it("rejects a metered create from a session lacking CSRF (403)", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: "/admin/catalog/entitlements",
      cookies: { admin_session: h.authAdmin.session, admin_csrf: h.authAdmin.csrf },
      // No x-csrf-token header → the double-submit fails.
      payload: { key: key("route-nocsrf"), name: "No CSRF", type: "metered", aggregation: "sum", unit: "gb" } as never,
    });
    expect(res.statusCode).toBe(403);
  });
});
