// T017 [US1] (FR-018): runtime auth + tenant isolation on POST /v1/validate. A missing API key → 401; a
// resolvable key WITHOUT the `validate` scope → 403 forbidden; a cross-tenant activationId (tenant B's key
// against tenant A's activation) resolves to 404 activation_not_found under RLS — never 403, so an
// out-of-tenant id is indistinguishable from a non-existent one. Real Postgres via Testcontainers.
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { startHarness, type EnforcementHarness } from "./harness.js";

let h: EnforcementHarness;
let activationA: string;

beforeAll(async () => {
  h = await startHarness("auth");
  const lic = await h.issueLicense();
  const act = await h.activateMachine(lic.id, h.sigs("a1", "a2", "a3", "a4", "a5"));
  activationA = act.activationId;
}, 240_000);

afterAll(async () => {
  await h?.stop();
});

describe("validate runtime auth + tenant isolation (integration, real Postgres)", () => {
  it("US1: a missing API key → 401 (FR-018 fail-closed)", async () => {
    const res = await h.validate(null, { activationId: activationA, nonce: h.nonce() });
    expect(res.statusCode).toBe(401);
  });

  it("US1: a key WITHOUT the validate scope → 403 forbidden (FR-018)", async () => {
    // activateKey carries `activate`, not `validate`.
    const res = await h.validate(h.activateKey, { activationId: activationA, nonce: h.nonce() });
    expect(res.statusCode).toBe(403);
    expect((res.json() as { code: string }).code).toBe("forbidden");
  });

  it("US1: a cross-tenant activationId → 404 activation_not_found (FR-018 — not 403)", async () => {
    // Tenant B's validate key cannot resolve tenant A's activation (RLS hides the row).
    const res = await h.validate(h.validateKeyB, { activationId: activationA, nonce: h.nonce() });
    expect(res.statusCode).toBe(404);
    expect((res.json() as { code: string }).code).toBe("activation_not_found");
  });

  it("US1: an unknown activationId (own tenant) → 404 activation_not_found", async () => {
    const res = await h.validate(h.validateKey, { activationId: randomUUID(), nonce: h.nonce() });
    expect(res.statusCode).toBe(404);
    expect((res.json() as { code: string }).code).toBe("activation_not_found");
  });

  it("US1: a malformed body (nonce too short / no identity) → 400 validation_error", async () => {
    const shortNonce = await h.validate(h.validateKey, { activationId: activationA, nonce: "too-short" });
    expect(shortNonce.statusCode).toBe(400);
    expect((shortNonce.json() as { code: string }).code).toBe("validation_error");

    const noIdentity = await h.validate(h.validateKey, { nonce: h.nonce() });
    expect(noIdentity.statusCode).toBe(400);
    expect((noIdentity.json() as { code: string }).code).toBe("validation_error");
  });
});
