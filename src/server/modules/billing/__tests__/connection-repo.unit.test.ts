// [US1/US5] (FR-015/022): connection-repo secret-resolution unit tests. `resolveSecrets(q, id)` is the internal
// webhook-verify path that UNWRAPS the inbound-HMAC secret(s) into memory — never exposed. Drives it with a stub
// `TxQuery` + stub custody (no DB): not-found → null; current-only (no prev); the previous secret is included
// ONLY while the rotation transition window is open (FR-022) and dropped once it has elapsed; a locked/absent
// custody fails closed (503); an unsupported custody scheme is rejected (500).
import type pg from "pg";
import { describe, expect, it } from "vitest";

import type { TxQuery } from "../../../db/client.js";
import { loadBillingConfig } from "../config.js";
import { ConnectionRepo, KEYSTORE_SCHEME, type ResolvedConnection } from "../connection-repo.js";
import type { SecretCustody } from "../index.js";

/** A stub custody: wrap prefixes `w:`, unwrap strips it — enough to prove the resolver unwrapped the stored blob. */
const custody: SecretCustody = {
  wrap: (plaintext: Buffer) => Buffer.concat([Buffer.from("w:"), plaintext]),
  unwrap: (blob: Buffer) => blob.subarray(2),
};

const config = loadBillingConfig({ BILLING_SECRET_ROTATION_WINDOW_SECS: "86400" }); // 24h window

/** A stub TxQuery returning a single canned row (or no rows). */
function stub(row: Record<string, unknown> | null): TxQuery {
  return () =>
    Promise.resolve({ rows: row ? [row] : [], rowCount: row ? 1 : 0 } as pg.QueryResult);
}

/** A wrapped secret blob, as it would be stored at rest (`w:` + plaintext). */
function wrapped(plaintext: string): Buffer {
  return custody.wrap(Buffer.from(plaintext, "utf8"));
}

function secretRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "conn-uuid",
    provider: "stripe",
    status: "active",
    signing_secret_ref: wrapped("current-secret"),
    signing_secret_prev: null,
    secret_custody_scheme: KEYSTORE_SCHEME,
    secret_rotated_at: null,
    plan_map: {},
    default_grace_seconds: 1_209_600,
    grace_overrides: {},
    ...overrides,
  };
}

function repo(withCustody: SecretCustody | undefined = custody): ConnectionRepo {
  return new ConnectionRepo({} as unknown as pg.Pool, withCustody, config);
}

/** A repo with NO custody (keystore locked/absent) — the fail-closed path. */
function repoNoCustody(): ConnectionRepo {
  return new ConnectionRepo({} as unknown as pg.Pool, undefined, config);
}

describe("ConnectionRepo.resolveSecrets (FR-015/022)", () => {
  it("returns null when the connection id does not resolve", async () => {
    expect(await repo().resolveSecrets(stub(null), "missing")).toBeNull();
  });

  it("unwraps the current secret and omits the previous when none is stored", async () => {
    const resolved = (await repo().resolveSecrets(stub(secretRow()), "conn-uuid")) as ResolvedConnection;
    expect(resolved.secretCurrent.toString("utf8")).toBe("current-secret");
    expect(resolved.secretPrev).toBeNull();
    expect(resolved.provider).toBe("stripe");
  });

  it("includes the previous secret while the rotation window is OPEN", async () => {
    const row = secretRow({
      signing_secret_prev: wrapped("previous-secret"),
      secret_rotated_at: new Date(Date.now() - 3_600_000), // rotated 1h ago; window is 24h
    });
    const resolved = (await repo().resolveSecrets(stub(row), "conn-uuid")) as ResolvedConnection;
    expect(resolved.secretPrev?.toString("utf8")).toBe("previous-secret");
  });

  it("drops the previous secret once the rotation window has ELAPSED", async () => {
    const row = secretRow({
      signing_secret_prev: wrapped("previous-secret"),
      secret_rotated_at: new Date(Date.now() - 48 * 3_600_000), // rotated 48h ago; window is 24h
    });
    const resolved = (await repo().resolveSecrets(stub(row), "conn-uuid")) as ResolvedConnection;
    expect(resolved.secretPrev).toBeNull();
  });

  it("fails closed (503) when custody is locked/absent", async () => {
    await expect(repoNoCustody().resolveSecrets(stub(secretRow()), "conn-uuid")).rejects.toMatchObject({
      code: "secret_custody_unavailable",
      status: 503,
    });
  });

  it("rejects an unsupported custody scheme (500)", async () => {
    const row = secretRow({ secret_custody_scheme: "rot13-lol" });
    await expect(repo().resolveSecrets(stub(row), "conn-uuid")).rejects.toMatchObject({
      code: "unsupported_custody_scheme",
      status: 500,
    });
  });
});
