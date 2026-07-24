// [Foundational] (FR-011/012/020/023/026): derivation + predicate + overage-math unit tests. Exercises the
// scope→holder-key salted-hash derivation (session/machine/user — deterministic, salt-sensitive, scope-
// separated, raw reference never recoverable, machine folds the fingerprint), the pure generation-fence /
// live predicate that mirrors the renew SQL guard (INV-3), and the overage math (effective cap / over-base /
// admission). Pure unit tests — no DB.
import { describe, expect, it } from "vitest";

import { canAdmit, effectiveCap, isOverageSeat } from "../config.js";
import { deriveHolderKey, HolderKeyError, holderKeyToString } from "../holder-key.js";
import { passesRenewFence } from "../lease-repo.js";

const SALT = "server-held-tenant-salt";

describe("deriveHolderKey (FR-020/023/026)", () => {
  it("is deterministic for the same params + salt", () => {
    const a = deriveHolderKey({ scope: "session", reference: "instance-1" }, SALT);
    const b = deriveHolderKey({ scope: "session", reference: "instance-1" }, SALT);
    expect(a.equals(b)).toBe(true);
    expect(a.length).toBe(32); // SHA-256 digest
  });

  it("is salt-sensitive — a rotated salt yields a different holder key (INV-8)", () => {
    const a = deriveHolderKey({ scope: "session", reference: "instance-1" }, SALT);
    const b = deriveHolderKey({ scope: "session", reference: "instance-1" }, "rotated-salt");
    expect(a.equals(b)).toBe(false);
  });

  it("domain-separates scopes — the SAME reference under a different scope differs", () => {
    const session = deriveHolderKey({ scope: "session", reference: "alice" }, SALT);
    const user = deriveHolderKey({ scope: "user", reference: "alice" }, SALT);
    expect(session.equals(user)).toBe(false);
  });

  it("machine scope folds the fingerprint (order-independent, de-duplicated) so one machine shares a seat", () => {
    const a = deriveHolderKey({ scope: "machine", reference: "host", signals: ["s3", "s1", "s2"] }, SALT);
    const b = deriveHolderKey({ scope: "machine", reference: "host", signals: ["s1", "s2", "s3", "s3"] }, SALT);
    expect(a.equals(b)).toBe(true);
  });

  it("never leaks the raw reference — it is not recoverable from the pseudonymous wire string (SC-015)", () => {
    const raw = "instance-3f2504e0-secret-ref";
    const key = holderKeyToString(deriveHolderKey({ scope: "session", reference: raw }, SALT));
    expect(key).not.toContain(raw);
    expect(key).not.toContain("secret-ref");
    expect(key).toMatch(/^[A-Za-z0-9_-]+$/); // base64url, no raw bytes
  });

  it("throws a 400-mappable HolderKeyError when a machine-scope fingerprint is missing (FR-023)", () => {
    try {
      deriveHolderKey({ scope: "machine", reference: "host", signals: [] }, SALT);
      throw new Error("expected a throw");
    } catch (e) {
      expect(e).toBeInstanceOf(HolderKeyError);
      expect((e as HolderKeyError).field).toBe("fingerprint");
    }
  });

  it("throws when a session/user holder reference is empty", () => {
    expect(() => deriveHolderKey({ scope: "session", reference: "" }, SALT)).toThrow(HolderKeyError);
    expect(() => deriveHolderKey({ scope: "user", reference: "" }, SALT)).toThrow(HolderKeyError);
  });
});

describe("passesRenewFence (FR-011 generation fence + live predicate, INV-3)", () => {
  const now = new Date("2026-07-24T12:00:00.000Z");
  const future = new Date(now.getTime() + 60_000).toISOString();
  const past = new Date(now.getTime() - 60_000).toISOString();

  it("passes a live, unexpired lease at the matching generation", () => {
    expect(passesRenewFence({ status: "live", expiresAt: future, generation: 4 }, now, 4)).toBe(true);
  });

  it("passes when no expected generation is supplied (generation ignored)", () => {
    expect(passesRenewFence({ status: "live", expiresAt: future, generation: 9 }, now)).toBe(true);
  });

  it("rejects a reclaimed / released lease (terminal — never revived)", () => {
    expect(passesRenewFence({ status: "reclaimed", expiresAt: future, generation: 4 }, now, 4)).toBe(false);
    expect(passesRenewFence({ status: "released", expiresAt: future, generation: 4 }, now, 4)).toBe(false);
  });

  it("rejects an expired lease even while still 'live'", () => {
    expect(passesRenewFence({ status: "live", expiresAt: past, generation: 4 }, now, 4)).toBe(false);
  });

  it("rejects a stale generation (a late renew that lost the fence race)", () => {
    expect(passesRenewFence({ status: "live", expiresAt: future, generation: 4 }, now, 3)).toBe(false);
  });
});

describe("overage math (FR-012/013)", () => {
  it("effectiveCap = base + allowance", () => {
    expect(effectiveCap(5, 0)).toBe(5);
    expect(effectiveCap(5, 2)).toBe(7);
  });

  it("isOverageSeat flags a NEW seat only once the base cap is filled", () => {
    expect(isOverageSeat(4, 5)).toBe(false); // 5th seat is within base
    expect(isOverageSeat(5, 5)).toBe(true); // 6th seat is over base
    expect(isOverageSeat(6, 5)).toBe(true);
  });

  it("canAdmit is true below the effective cap, false at/above it", () => {
    // hard cap 5: admit while used<5
    expect(canAdmit(4, 5, 0)).toBe(true);
    expect(canAdmit(5, 5, 0)).toBe(false);
    // soft cap 5 + allowance 1 = 6: the 6th seat (used=5) still admits, the 7th (used=6) refuses
    expect(canAdmit(5, 5, 1)).toBe(true);
    expect(canAdmit(6, 5, 1)).toBe(false);
  });
});
