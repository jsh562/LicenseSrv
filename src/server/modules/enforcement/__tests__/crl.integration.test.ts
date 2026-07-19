// T031 [US4] (FR-009): revoke a license → run generateCrl → the license id appears in the signed CRL, the
// `version` advances monotonically, `next_update` is set, and the DETACHED signature verifies against the
// product's public key (the E004 keyring). Also proves the domain separation (`LICSRV-CRL-v1`) from LIC1
// tokens and that a tampered CRL no longer verifies. Real Postgres via Testcontainers + the real E004 signer.
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { withTenant } from "../../../db/client.js";
import { verifyDetached } from "../../signing/keystore-signer.js";
import { CRL_SIGNING_DOMAIN } from "../../signing/signer.js";
import { loadEnforcementConfig, resolvePlanWindows } from "../config.js";
import { buildCanonicalCrlBytes, generateCrl, type RevocationListRecord } from "../crl.js";
import { startHarness, type EnforcementHarness } from "./harness.js";

const b64urlToBuf = (s: string): Buffer => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
const windows = resolvePlanWindows(loadEnforcementConfig());

let h: EnforcementHarness;

/** Generate a CRL for tenant A's product inside a single withTenant tx (version computed in-tx, FR-022). */
const gen = (): Promise<RevocationListRecord> =>
  withTenant(h.pool, h.tenantA, (q) => generateCrl(q, h.tenantA, h.productId, h.signer(), windows));

/** Rebuild the canonical signed bytes from a stored record (exactly the fields the signature covers). */
const canonicalOf = (rec: RevocationListRecord): Buffer =>
  buildCanonicalCrlBytes({ version: rec.version, generatedAt: rec.generatedAt, nextUpdate: rec.nextUpdate, revokedIds: rec.revokedIds });

beforeAll(async () => {
  h = await startHarness("crl");
}, 240_000);

afterAll(async () => {
  await h?.stop();
});

describe("CRL generation (integration, real Postgres + real signer)", () => {
  it("US4: revoke → the signed CRL includes the id, version+next_update advance, signature verifies (SC-007)", async () => {
    const lic = await h.issueLicense();
    await h.revokeLicense(lic.id);

    const rec = await gen();
    expect(rec.revokedIds.licenses).toContain(lic.id);
    expect(rec.version).toBeGreaterThanOrEqual(1);

    // next_update = generated_at + the CRL horizon; strictly after generation (data-model CHECK).
    expect(new Date(rec.nextUpdate).getTime()).toBeGreaterThan(new Date(rec.generatedAt).getTime());
    expect(Math.round((Date.parse(rec.nextUpdate) - Date.parse(rec.generatedAt)) / 1000)).toBe(windows.crlNextUpdateSecs);

    // The detached signature VERIFIES against the product's public key (the E004 keyring).
    const pub = await h.productPublicKey();
    expect(verifyDetached(pub, CRL_SIGNING_DOMAIN, canonicalOf(rec), b64urlToBuf(rec.signature))).toBe(true);

    // A tampered CRL (an extra revoked id) must NOT verify under the same signature.
    const tampered = buildCanonicalCrlBytes({
      version: rec.version,
      generatedAt: rec.generatedAt,
      nextUpdate: rec.nextUpdate,
      revokedIds: { licenses: [...rec.revokedIds.licenses, "00000000-0000-4000-8000-000000000000"], activations: rec.revokedIds.activations },
    });
    expect(verifyDetached(pub, CRL_SIGNING_DOMAIN, tampered, b64urlToBuf(rec.signature))).toBe(false);
  });

  it("US4: the signature is domain-separated from LIC1 tokens (a token-domain verify fails, FR-009)", async () => {
    const rec = await gen();
    const pub = await h.productPublicKey();
    expect(verifyDetached(pub, CRL_SIGNING_DOMAIN, canonicalOf(rec), b64urlToBuf(rec.signature))).toBe(true);
    // The SAME bytes + signature MUST NOT verify under the LIC1 token domain — cross-protocol confusion is impossible.
    expect(verifyDetached(pub, "LICSRV-LICENSE-TOKEN-v1", canonicalOf(rec), b64urlToBuf(rec.signature))).toBe(false);
  });

  it("US4: version is strictly monotonic (max+1) across regenerations (FR-022)", async () => {
    const first = await gen();
    const second = await gen();
    expect(second.version).toBe(first.version + 1);
    // The signature of the newer version also verifies (a fresh sign over fresh bytes).
    const pub = await h.productPublicKey();
    expect(verifyDetached(pub, CRL_SIGNING_DOMAIN, canonicalOf(second), b64urlToBuf(second.signature))).toBe(true);
  });

  it("US4: deactivated activations are projected into the CRL (per policy)", async () => {
    const lic = await h.issueLicense();
    const { activationId } = await h.activateMachine(lic.id, h.sigs("d1", "d2", "d3", "d4", "d5"));
    await h.deactivateActivation(activationId);

    const rec = await gen();
    expect(rec.revokedIds.activations).toContain(activationId);
    const pub = await h.productPublicKey();
    expect(verifyDetached(pub, CRL_SIGNING_DOMAIN, canonicalOf(rec), b64urlToBuf(rec.signature))).toBe(true);
  });
});
