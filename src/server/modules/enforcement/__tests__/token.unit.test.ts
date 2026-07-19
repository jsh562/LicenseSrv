// T009 (FR-002/007/014/017): the short-TTL LIC1 mint. exp = now + renewalWindow (bounded by license
// expiry), iat = the signed serverTime anchor, fp/fpk/sk machine binding preserved, and the claims'
// entitlements OVERRIDDEN with the CURRENT effective entitlements (FR-017). Uses a stub Signer that
// captures the exact `Claims` handed to the E004 signer — no DB, no real crypto.
import { describe, expect, it } from "vitest";

import type { License } from "../../issuance/licenses.js";
import type { Signer } from "../../signing/signer.js";
import type { Claims } from "../../signing/token.js";
import { mintShortLivedToken } from "../token.js";

const NOW = 1_800_000_000;

function license(over: Partial<License> = {}): License {
  return {
    id: "lic-1",
    productId: "prod-1",
    planId: "plan-1",
    customerId: "cust-1",
    status: "active",
    issuedAt: "2026-01-01T00:00:00.000Z",
    expiresAt: null, // perpetual, so exp = now + window exactly
    maxActivations: 5,
    entitlements: { pro: true, seats: 10 },
    keyId: "k1",
    transferCount: 0,
    ...over,
  };
}

/** A stub signer that records the last claims it signed and returns a deterministic token string. */
function stubSigner(): { signer: Signer; last: () => Claims; calls: () => number } {
  let captured: Claims | undefined;
  let n = 0;
  const signer: Signer = {
    sign: (_tenantId: string, claims: Claims): Promise<string> => {
      captured = claims;
      n += 1;
      return Promise.resolve(`LIC1.stub-${claims.issuedAt}-${claims.expiresAt ?? "null"}`);
    },
    ready: () => true,
  };
  return { signer, last: () => captured as Claims, calls: () => n };
}

const RENEWAL = 172_800; // 2 days
const RENEW_AFTER = 86_400; // 1 day

async function mint(over: Partial<Parameters<typeof mintShortLivedToken>[2]> = {}, lic: License = license()) {
  const { signer, last, calls } = stubSigner();
  const result = await mintShortLivedToken(signer, "tenant-1", {
    license: lic,
    signalHashes: ["h1", "h2", "h3"],
    fpMin: 3,
    maxSkewSecs: 300,
    entitlements: { pro: true, seats: 25 },
    renewalWindowSecs: RENEWAL,
    renewAfterSecs: RENEW_AFTER,
    nowUnix: NOW,
    ...over,
  });
  return { result, claims: last(), calls };
}

describe("mintShortLivedToken — short TTL + signed server time (FR-002/014)", () => {
  it("sets exp = now + renewalWindow and iat = the signed serverTime anchor", async () => {
    const { result, claims } = await mint();
    expect(claims.issuedAt).toBe(NOW); // signed server time
    expect(claims.expiresAt).toBe(NOW + RENEWAL); // exp = now + window (perpetual license)
    expect(result.serverTimeUnix).toBe(NOW);
    expect(result.expiresAtUnix).toBe(NOW + RENEWAL);
    expect(result.token).toMatch(/^LIC1\./);
  });

  it("bounds exp by the license expiry (never mints past the license's own exp)", async () => {
    const soonUnix = NOW + 1_000; // license expires before the renewal window elapses
    const lic = license({ expiresAt: new Date(soonUnix * 1000).toISOString() });
    const { result, claims } = await mint({}, lic);
    expect(claims.expiresAt).toBe(soonUnix); // min(licenseExp, now+window)
    expect(result.expiresAtUnix).toBe(soonUnix);
  });

  it("preserves the fp/fpk/sk machine binding so the E001 verifier verifies it unchanged", async () => {
    const { claims } = await mint();
    expect(claims.fingerprint).toEqual(["h1", "h2", "h3"]);
    expect(claims.fpMin).toBe(3);
    expect(claims.maxSkewSecs).toBe(300);
  });
});

describe("mintShortLivedToken — entitlement override (FR-017)", () => {
  it("overrides the claims' entitlements with the CURRENT effective entitlements", async () => {
    const current = { pro: true, seats: 25, beta: true };
    const { claims } = await mint({ entitlements: current }, license({ entitlements: { pro: true, seats: 10 } }));
    expect(claims.entitlements).toEqual(current); // current, NOT the license snapshot {pro,seats:10}
  });
});

describe("mintShortLivedToken — renewAfter (FR-003/007)", () => {
  it("sets renewAfter = now + renewAfterSecs when it precedes exp", async () => {
    const { result } = await mint();
    expect(result.renewAfterUnix).toBe(NOW + RENEW_AFTER);
    expect(result.renewAfterUnix).toBeLessThan(result.expiresAtUnix!);
  });

  it("clamps renewAfter to exp when the cadence would exceed a short license expiry", async () => {
    const soonUnix = NOW + 100;
    const lic = license({ expiresAt: new Date(soonUnix * 1000).toISOString() });
    const { result } = await mint({}, lic);
    expect(result.renewAfterUnix).toBe(soonUnix); // clamped to exp, not now + 86400
  });
});

describe("mintShortLivedToken — signer fault (FR-002)", () => {
  it("propagates a signer failure (mapped to 503 by the caller); no token returned", async () => {
    const failing: Signer = {
      sign: () => Promise.reject(new Error("signer down")),
      ready: () => false,
    };
    await expect(
      mintShortLivedToken(failing, "tenant-1", {
        license: license(),
        signalHashes: ["h1", "h2", "h3"],
        fpMin: 3,
        maxSkewSecs: 300,
        entitlements: { pro: true },
        renewalWindowSecs: RENEWAL,
        renewAfterSecs: RENEW_AFTER,
        nowUnix: NOW,
      }),
    ).rejects.toThrow("signer down");
  });
});
