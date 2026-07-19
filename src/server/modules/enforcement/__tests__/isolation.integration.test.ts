// T043 [Polish] (FR-018; SC-014): every online-enforcement operation is tenant-scoped under RLS. Tenant B's
// validate key can neither validate nor heartbeat tenant A's activation, nor fetch tenant A's product CRL — a
// cross-tenant reference resolves to 404 (never 403), so an out-of-tenant id is indistinguishable from a
// non-existent one. The new `checkin` and `revocation_list` rows are tenant-isolated: tenant A's rows are
// INVISIBLE from a tenant-B-scoped transaction (RLS), and an unset tenant GUC yields zero rows. Real Postgres
// via Testcontainers + the real E004 signer.
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { withTenant } from "../../../db/client.js";
import { loadEnforcementConfig } from "../config.js";
import { startCrlWorker } from "../crl-worker.js";
import { startHarness, type EnforcementHarness } from "./harness.js";

const config = loadEnforcementConfig();

let h: EnforcementHarness;
let activationA: string;

beforeAll(async () => {
  h = await startHarness("isolation");

  // Tenant A: a validated activation (writes a checkin row) on an ACTIVE license...
  const active = await h.issueLicense();
  const act = await h.activateMachine(active.id, h.sigs("i1", "i2", "i3", "i4", "i5"));
  activationA = act.activationId;
  expect((await h.validate(h.validateKey, { activationId: activationA, nonce: h.nonce() })).statusCode).toBe(200);

  // ...and a published CRL (writes a revocation_list row) for tenant A's product.
  const revoked = await h.issueLicense();
  await h.revokeLicense(revoked.id);
  const worker = startCrlWorker(h.pool, h.signer(), config, { immediate: false });
  try {
    await worker.runOnce();
  } finally {
    worker.stop();
  }
}, 240_000);

afterAll(async () => {
  await h?.stop();
});

/** Count rows in `table` visible under a tenant-scoped transaction (RLS filters by the tenant GUC). */
const countUnderTenant = (tenantId: string, table: string): Promise<number> =>
  withTenant(h.pool, tenantId, async (q) => {
    const r = await q(`SELECT count(*)::int AS n FROM ${table}`);
    return (r.rows[0] as { n: number }).n;
  });

describe("enforcement tenant isolation (integration, real Postgres + RLS)", () => {
  it("FR-018: tenant B cannot validate tenant A's activation → 404 activation_not_found (never 403)", async () => {
    const res = await h.validate(h.validateKeyB, { activationId: activationA, nonce: h.nonce() });
    expect(res.statusCode).toBe(404);
    expect((res.json() as { code: string }).code).toBe("activation_not_found");
  });

  it("FR-018: tenant B cannot heartbeat tenant A's activation → 404 activation_not_found", async () => {
    const res = await h.heartbeat(h.validateKeyB, { activationId: activationA, nonce: h.nonce() });
    expect(res.statusCode).toBe(404);
    expect((res.json() as { code: string }).code).toBe("activation_not_found");
  });

  it("FR-018: tenant B cannot fetch tenant A's product CRL → 404 revocation_list_not_found", async () => {
    const res = await h.crlGet(h.validateKeyB, { productId: h.productId });
    expect(res.statusCode).toBe(404);
    expect((res.json() as { code: string }).code).toBe("revocation_list_not_found");
  });

  it("FR-018/SC-014: checkin + revocation_list rows are tenant-isolated (tenant B sees none of tenant A's)", async () => {
    // Tenant A can see its own rows...
    expect(await countUnderTenant(h.tenantA, "checkin")).toBeGreaterThanOrEqual(1);
    expect(await countUnderTenant(h.tenantA, "revocation_list")).toBeGreaterThanOrEqual(1);
    // ...but tenant B (which produced no enforcement rows) sees ZERO — RLS confines both new tables.
    expect(await countUnderTenant(h.tenantB, "checkin")).toBe(0);
    expect(await countUnderTenant(h.tenantB, "revocation_list")).toBe(0);
  });

  it("FR-018: with the tenant GUC UNSET, the app role sees zero checkin / revocation_list rows (forced RLS)", async () => {
    // The app role under forced RLS with no app.current_tenant set -> the policy predicate is NULL -> no rows.
    // SET LOCAL requires a transaction block, so drive a raw client through BEGIN ... ROLLBACK.
    const client = await h.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE licensesrv_app");
      const c = await client.query("SELECT count(*)::int AS n FROM checkin");
      const r = await client.query("SELECT count(*)::int AS n FROM revocation_list");
      expect((c.rows[0] as { n: number }).n).toBe(0);
      expect((r.rows[0] as { n: number }).n).toBe(0);
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  });
});
