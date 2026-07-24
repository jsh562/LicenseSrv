// T016 [US1] (FR-003; SC-002): the RACE-SAFE concurrency cap. For a license with C free seats — C measured
// against the EFFECTIVE cap (max_concurrent + concurrency_overage) — exactly C of N GENUINELY concurrent
// acquisitions succeed and the live-lease count NEVER exceeds the effective cap. The guard is the per-license
// pg_advisory_xact_lock count+insert in LeaseRepo.acquire (AD-001); a naive `WHERE live_count < cap` would
// over-allocate. Fired both as parallel pool clients (the acquire service) AND as parallel HTTP requests
// against the real bound app, so the race is exercised end to end.
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { acquireLease, type AcquireResult } from "../acquire.js";
import { LeaseError } from "../index.js";
import { startHarness, type LeaseHarness } from "./harness.js";

let h: LeaseHarness;

beforeAll(async () => {
  h = await startHarness("concurrency-race");
}, 240_000);

afterAll(async () => {
  await h?.stop();
});

describe("lease concurrency race (integration, real Postgres)", () => {
  it("SC-002: N genuinely-concurrent acquires for C free seats → exactly C succeed (parallel pool clients)", async () => {
    const cap = 3;
    const n = 12;
    const lic = await h.issueFloating({ maxConcurrent: cap });

    // Fire N acquires IN PARALLEL, each a distinct holder + single-use token, against the SAME license.
    const attempts = Array.from({ length: n }, () =>
      acquireLease(h.deps(), h.tenantA, { licenseId: lic.licenseId, holderReference: h.holderRef(), acquireToken: h.nonce() }),
    );
    const settled = await Promise.allSettled(attempts);

    const created = settled.filter((s): s is PromiseFulfilledResult<AcquireResult> => s.status === "fulfilled" && s.value.created);
    const refused = settled.filter(
      (s): s is PromiseRejectedResult => s.status === "rejected" && s.reason instanceof LeaseError && (s.reason as LeaseError).code === "seat_capacity_exhausted",
    );

    expect(created).toHaveLength(cap);
    expect(refused).toHaveLength(n - cap);
    // The authoritative live count NEVER exceeds the effective cap.
    expect(await h.countLive(lic.licenseId)).toBe(cap);
  });

  it("SC-002: exactly-C-of-N holds against the EFFECTIVE cap (max_concurrent + overage)", async () => {
    const maxConcurrent = 2;
    const overage = 2;
    const effective = maxConcurrent + overage; // 4
    const n = 15;
    const lic = await h.issueFloating({ maxConcurrent, overage });

    const attempts = Array.from({ length: n }, () =>
      acquireLease(h.deps(), h.tenantA, { licenseId: lic.licenseId, holderReference: h.holderRef(), acquireToken: h.nonce() }),
    );
    const settled = await Promise.allSettled(attempts);
    const created = settled.filter((s) => s.status === "fulfilled" && (s as PromiseFulfilledResult<AcquireResult>).value.created);

    expect(created).toHaveLength(effective);
    expect(await h.countLive(lic.licenseId)).toBe(effective);
  });

  it("SC-002: parallel HTTP acquires against the real bound app never exceed the cap", async () => {
    const cap = 3;
    const n = 10;
    const lic = await h.issueFloating({ maxConcurrent: cap });

    const responses = await Promise.all(
      Array.from({ length: n }, () => h.acquire(h.leaseKey, { licenseId: lic.licenseId, holderReference: h.holderRef(), acquireToken: h.nonce() })),
    );
    const ok = responses.filter((r) => r.statusCode === 201);
    const refused = responses.filter((r) => r.statusCode === 409);

    expect(ok).toHaveLength(cap);
    expect(refused).toHaveLength(n - cap);
    expect(refused.every((r) => (r.json() as { code: string }).code === "seat_capacity_exhausted")).toBe(true);
    expect(await h.countLive(lic.licenseId)).toBe(cap);
  });
});
