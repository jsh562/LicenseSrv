// T045 [Polish] (Principle I/III; PII/secrecy invariants): NO key material — the signing seed, a custodian
// Shamir share, a private key byte, or the api-key secret — appears in ANY enforcement response. The
// validate/heartbeat `shortLivedToken` is a PUBLIC E001 `LIC1` artifact (verifies OFFLINE against the public
// keyring); the CRL `signature` is a PUBLIC detached Ed25519 signature; error bodies carry only
// `{code,message,details?}` and never a secret. The known master secret (the harness seed `Buffer.alloc(32,7)`),
// its live custodian shares, and the api-key secret are scanned for in every response body (hex/base64/
// base64url forms) and in the token's decoded transport bytes. Real Postgres via Testcontainers + real signer.
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadEnforcementConfig } from "../config.js";
import { startCrlWorker } from "../crl-worker.js";
import { SECRET, startHarness, type EnforcementHarness } from "./harness.js";

const config = loadEnforcementConfig();

let h: EnforcementHarness;
let activationId: string;
let act2Id: string;
let fp: string[];
/** Every distinct byte-encoding of a KNOWN secret that must never surface in a response. */
let forbidden: string[];
/** The reconstructed master signing secret bytes (must never appear inside a token's transport bytes). */
const masterSeed = Buffer.alloc(32, 7);

const b64urlDecode = (s: string): Buffer => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");

/** All the string encodings a raw secret buffer could plausibly be leaked as. */
function encodings(buf: Buffer): string[] {
  return [buf.toString("hex"), buf.toString("base64"), buf.toString("base64url")];
}

beforeAll(async () => {
  h = await startHarness("secret-leakage");
  const lic = await h.issueLicense();
  fp = h.sigs("sl1", "sl2", "sl3", "sl4", "sl5");
  activationId = (await h.activateMachine(lic.id, fp)).activationId;
  act2Id = (await h.activateMachine(lic.id, h.sigs("sm1", "sm2", "sm3", "sm4", "sm5"))).activationId;

  // Publish a CRL so the CRL response bodies are covered by the scan.
  const revoked = await h.issueLicense();
  await h.revokeLicense(revoked.id);
  const worker = startCrlWorker(h.pool, h.signer(), config, { immediate: false });
  try {
    await worker.runOnce();
  } finally {
    worker.stop();
  }

  // The KNOWN secrets: the master signing seed, the LIVE custodian Shamir shares, and the api-key secret.
  const shareStrings = (process.env.SIGNING_CUSTODIAN_SHARES ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const shareForms = shareStrings.flatMap((s) => [s, ...encodings(Buffer.from(s, "base64"))]);
  forbidden = [...encodings(masterSeed), ...shareForms, SECRET].filter((s) => s.length >= 16);
}, 240_000);

afterAll(async () => {
  await h?.stop();
});

/** Collect the raw body strings of a broad set of enforcement responses (success + every error path). */
async function collectResponseBodies(): Promise<{ label: string; body: string }[]> {
  const out: { label: string; body: string }[] = [];
  out.push({ label: "validate-valid", body: (await h.validate(h.validateKey, { activationId, nonce: h.nonce() })).body });
  out.push({ label: "heartbeat-valid", body: (await h.heartbeat(h.validateKey, { activationId, nonce: h.nonce() })).body });
  out.push({ label: "crl-json", body: (await h.crlGet(h.validateKey, { productId: h.productId })).body });
  out.push({ label: "crl-file", body: (await h.crlGet(h.validateKey, { productId: h.productId, format: "file" })).body });
  // Every error path body, too — error bodies must carry no secret.
  out.push({ label: "err-401", body: (await h.validate(null, { activationId, nonce: h.nonce() })).body });
  out.push({ label: "err-403", body: (await h.validate(h.activateKey, { activationId, nonce: h.nonce() })).body });
  out.push({ label: "err-404", body: (await h.validate(h.validateKey, { activationId: randomUUID(), nonce: h.nonce() })).body });
  const forgeNonce = h.nonce();
  await h.validate(h.validateKey, { activationId, nonce: forgeNonce });
  out.push({ label: "err-409", body: (await h.validate(h.validateKey, { activationId: act2Id, nonce: forgeNonce })).body });
  out.push({ label: "err-400", body: (await h.validate(h.validateKey, { nonce: "too-short" })).body });
  return out;
}

describe("no key-material / secret leakage in enforcement responses (Principle I/III)", () => {
  it("no signing seed / custodian share / api-key secret appears in ANY enforcement response body", async () => {
    expect(forbidden.length).toBeGreaterThan(0); // guard: the secret set was actually assembled
    const bodies = await collectResponseBodies();
    for (const { label, body } of bodies) {
      for (const secret of forbidden) {
        expect(body, `secret leaked in ${label} response`).not.toContain(secret);
      }
    }
  });

  it("the short-lived token is a PUBLIC LIC1 artifact — verifies offline, and its bytes carry no private seed", async () => {
    const body = (await h.validate(h.validateKey, { activationId, nonce: h.nonce() })).json() as { verdict: string; shortLivedToken: string };
    expect(body.verdict).toBe("valid");
    // A public, offline-verifiable artifact (verified against the PUBLIC key only).
    expect(body.shortLivedToken.startsWith("LIC1.")).toBe(true);
    expect(await h.verifyOffline(body.shortLivedToken, fp)).toBe(0);
    // The decoded transport (claims + detached signature) never contains the raw master secret bytes.
    const transport = b64urlDecode(body.shortLivedToken.slice("LIC1.".length));
    expect(transport.includes(masterSeed)).toBe(false);
  });

  it("the CRL signature is a PUBLIC detached signature (base64url) — no key material", async () => {
    const crl = (await h.crlGet(h.validateKey, { productId: h.productId })).json() as {
      signature: string;
      keyId: string;
      revokedIds: unknown;
    };
    // A detached Ed25519 signature is a public artifact: base64url text, not key bytes.
    expect(crl.signature).toMatch(/^[A-Za-z0-9_-]+$/);
    // The signature bytes are a 64-byte Ed25519 signature (never a 32-byte private/seed key).
    expect(b64urlDecode(crl.signature).length).toBe(64);
    expect(crl.keyId).toMatch(/^k-[0-9a-f]+$/); // opaque public key id (e.g. "k-<hex>"), never key material
    for (const secret of forbidden) expect(crl.signature).not.toContain(secret);
  });

  it("enforcement error bodies carry ONLY {code, message, details?} — no secret fields", async () => {
    // The enforcement error model is {code,message,details?} (403 scope, 404 not-found, 409 replay). (The
    // app-level missing-key 401 uses the framework's {error} shape and is covered by the broad no-secret scan.)
    const forge = h.nonce();
    await h.validate(h.validateKey, { activationId, nonce: forge });
    const errBodies = [
      (await h.validate(h.activateKey, { activationId, nonce: h.nonce() })).json(), // 403 forbidden
      (await h.validate(h.validateKey, { activationId: randomUUID(), nonce: h.nonce() })).json(), // 404 not-found
      (await h.validate(h.validateKey, { activationId: act2Id, nonce: forge })).json(), // 409 nonce_replayed
    ] as Record<string, unknown>[];
    for (const e of errBodies) {
      expect(Object.keys(e).every((k) => ["code", "message", "details"].includes(k))).toBe(true);
      expect(typeof e.code).toBe("string");
    }
  });
});
