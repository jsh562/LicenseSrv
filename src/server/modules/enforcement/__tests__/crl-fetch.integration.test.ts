// T032 [US4] (FR-010): GET /v1/revocation-list serves the signed CRL as JSON by default and the SAME
// canonical bytes as an octet-stream FILE under `?format=file` (air-gap) — so the detached signature
// verifies identically from either form. `ETag`/`Cache-Control`/`Expires` align to `next_update`; a matching
// `If-None-Match` returns `304`; an unknown/cross-tenant `productId` returns `404`. Real Postgres via
// Testcontainers + the real E004 signer; the CRL is generated via `generateCrl`, then fetched over the route.
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { withTenant } from "../../../db/client.js";
import { verifyDetached } from "../../signing/keystore-signer.js";
import { CRL_SIGNING_DOMAIN } from "../../signing/signer.js";
import { loadEnforcementConfig, resolvePlanWindows } from "../config.js";
import { buildCanonicalCrlBytes, generateCrl, type RevocationListRecord } from "../crl.js";
import { startHarness, type EnforcementHarness } from "./harness.js";

const b64urlToBuf = (s: string): Buffer => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
const windows = resolvePlanWindows(loadEnforcementConfig());

interface WireCrl {
  version: number;
  productId: string;
  generatedAt: string;
  nextUpdate: string;
  keyId: string;
  signature: string;
  revokedIds: { licenses: string[]; activations: string[] };
}

/** Verify a fetched CRL body's detached signature against tenant A's product key. */
async function verifyWire(h: EnforcementHarness, body: WireCrl): Promise<boolean> {
  const pub = await h.productPublicKey();
  const bytes = buildCanonicalCrlBytes({ version: body.version, generatedAt: body.generatedAt, nextUpdate: body.nextUpdate, revokedIds: body.revokedIds });
  return verifyDetached(pub, CRL_SIGNING_DOMAIN, bytes, b64urlToBuf(body.signature));
}

let h: EnforcementHarness;
let published: RevocationListRecord;
let revokedLicenseId: string;

beforeAll(async () => {
  h = await startHarness("crl-fetch");
  const lic = await h.issueLicense();
  revokedLicenseId = lic.id;
  await h.revokeLicense(lic.id);
  published = await withTenant(h.pool, h.tenantA, (q) => generateCrl(q, h.tenantA, h.productId, h.signer(), windows));
}, 240_000);

afterAll(async () => {
  await h?.stop();
});

describe("GET /v1/revocation-list (integration, real Postgres + real signer)", () => {
  it("US4: serves the signed CRL as JSON with caching aligned to next_update (SC-007)", async () => {
    const res = await h.crlGet(h.validateKey, { productId: h.productId });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("application/json");

    const body = res.json() as WireCrl;
    expect(body.version).toBe(published.version);
    expect(body.productId).toBe(h.productId);
    expect(body.revokedIds.licenses).toContain(revokedLicenseId);
    expect(await verifyWire(h, body)).toBe(true);

    // ETag carries the version; Cache-Control/Expires align to next_update.
    expect(res.headers.etag).toBe(`"v${published.version}"`);
    expect(String(res.headers["cache-control"])).toMatch(/^public, max-age=\d+$/);
    expect(res.headers.expires).toBe(new Date(published.nextUpdate).toUTCString());
  });

  it("US4: ?format=file returns the SAME canonical bytes as an octet-stream download (air-gap, FR-010)", async () => {
    const jsonRes = await h.crlGet(h.validateKey, { productId: h.productId });
    const fileRes = await h.crlGet(h.validateKey, { productId: h.productId, format: "file" });

    expect(fileRes.statusCode).toBe(200);
    expect(fileRes.headers["content-type"]).toContain("application/octet-stream");
    expect(String(fileRes.headers["content-disposition"])).toContain("attachment");
    expect(String(fileRes.headers["content-disposition"])).toContain(`v${published.version}.crl`);

    // The file body is BYTE-IDENTICAL to the JSON body → the detached signature verifies the same way.
    expect(fileRes.body).toBe(jsonRes.body);
    const parsed = JSON.parse(fileRes.body) as WireCrl;
    expect(await verifyWire(h, parsed)).toBe(true);

    // The file form still carries the caching headers aligned to next_update.
    expect(fileRes.headers.etag).toBe(`"v${published.version}"`);
    expect(fileRes.headers.expires).toBe(new Date(published.nextUpdate).toUTCString());
  });

  it("US4: a matching If-None-Match returns 304 with no body (FR-010)", async () => {
    const etag = `"v${published.version}"`;
    const res = await h.crlGet(h.validateKey, { productId: h.productId }, { "if-none-match": etag });
    expect(res.statusCode).toBe(304);
    expect(res.body).toBe("");
    // The 304 still refreshes the caching headers.
    expect(res.headers.etag).toBe(etag);
  });

  it("US4: a specific ?version selects that version; a non-existent version → 404", async () => {
    const ok = await h.crlGet(h.validateKey, { productId: h.productId, version: String(published.version) });
    expect(ok.statusCode).toBe(200);
    expect((ok.json() as WireCrl).version).toBe(published.version);

    const missing = await h.crlGet(h.validateKey, { productId: h.productId, version: String(published.version + 999) });
    expect(missing.statusCode).toBe(404);
    expect((missing.json() as { code: string }).code).toBe("revocation_list_not_found");
  });

  it("US4: an unknown or cross-tenant productId → 404 (never 403, FR-018)", async () => {
    const unknown = await h.crlGet(h.validateKey, { productId: randomUUID() });
    expect(unknown.statusCode).toBe(404);
    expect((unknown.json() as { code: string }).code).toBe("revocation_list_not_found");

    // Tenant B asks for tenant A's product → resolves to zero rows under RLS → 404 (never discloses it).
    const crossTenant = await h.crlGet(h.validateKeyB, { productId: h.productId });
    expect(crossTenant.statusCode).toBe(404);
  });

  it("US4: the validate scope is required (401 without a key, 403 without the scope)", async () => {
    const noKey = await h.crlGet(null, { productId: h.productId });
    expect(noKey.statusCode).toBe(401);

    const wrongScope = await h.crlGet(h.activateKey, { productId: h.productId });
    expect(wrongScope.statusCode).toBe(403);
    expect((wrongScope.json() as { code: string }).code).toBe("forbidden");
  });
});
