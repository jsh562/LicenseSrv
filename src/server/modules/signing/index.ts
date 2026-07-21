// Signing module wiring (TR-017): config-driven signer selection + boot-time custody unlock +
// readiness. The default is the offline keystore signer; a KMS/PKCS#11 adapter (P2) slots in behind
// the same interface without any caller change. Custody unlock material (Shamir shares) is injected
// at runtime via the E006 secrets contract — never baked into an image (IP-006).
import type { FastifyInstance } from "fastify";
import type pg from "pg";

import type { AppDeps } from "../../app.js";
import { Custody } from "./custody.js";
import { KeystoreSigner } from "./keystore-signer.js";
import { registerSigningRoutes } from "./routes.js";
import type { Signer } from "./signer.js";

// Aggregate health readiness (E006) composes the signer's readiness via this app decorator; license
// issuance (E008) + air-gap (E010) consume the published Signer via the `signer` decorator (the single
// key-using surface — the private key never crosses the module boundary).
declare module "fastify" {
  interface FastifyInstance {
    signerReady?: () => boolean;
    signer?: Signer;
    /**
     * The unlocked keystore custody (generic AES-256-GCM wrap/unwrap). Published alongside the signer so a
     * later module (E014 billing) can envelope-encrypt a DISTINCT lower-tier secret (the inbound webhook
     * HMAC secret) under the same master-key custody -- no new crypto, no new key custody. The Ed25519
     * signing key never crosses this boundary; only the generic wrap/unwrap capability is exposed.
     */
    custody?: Custody;
  }
}

/** Default rotation overlap window: 30 days (TR-019 — bounded, operator-configurable). */
export const DEFAULT_OVERLAP_SECONDS = 2_592_000;

export interface SigningConfig {
  /** Which signer implementation to use (TR-017). Default: keystore. */
  signer: "keystore" | "kms";
  /** Base64-encoded Shamir custodian shares (E006 secrets) used to unlock the keystore at boot. */
  custodianShares: string[];
  /**
   * The rotation overlap window in seconds (TR-019): how long a superseded key stays trusted before
   * retirement. Operator-configurable and bounded (never open-ended); a demoted key's `valid_until`
   * is set to `now + overlapSeconds` at rotation.
   */
  overlapSeconds: number;
}

export interface SigningModule {
  signer: Signer;
  custody: Custody;
  overlapSeconds: number;
  /** True when the signer can currently sign (custody unlocked / backend reachable). */
  ready(): boolean;
}

/** Read signing config from the environment (E006 secrets contract). */
export function loadSigningConfig(env: NodeJS.ProcessEnv = process.env): SigningConfig {
  const shares = (env.SIGNING_CUSTODIAN_SHARES ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const overlap = Number(env.SIGNING_OVERLAP_SECONDS);
  return {
    signer: env.SIGNING_SIGNER === "kms" ? "kms" : "keystore",
    custodianShares: shares,
    overlapSeconds: Number.isFinite(overlap) && overlap > 0 ? overlap : DEFAULT_OVERLAP_SECONDS,
  };
}

/** Select the signer implementation by config (TR-017). Keystore is the offline default. */
export function createSigner(pool: pg.Pool, config: SigningConfig, custody: Custody): Signer {
  if (config.signer === "kms") {
    // OBJ5 (P2, deferred): the KMS/PKCS#11 adapter implements the same Signer interface and is
    // selected here. Non-blocking for the P1 MVP; the keystore signer serves self-host fully.
    throw new Error("kms signer is not enabled in this build (OBJ5 is P2/deferred)");
  }
  return new KeystoreSigner(pool, custody);
}

/**
 * Build the signing module: create custody and attempt a boot-time unlock from the k-of-n custodian
 * shares (TR-011/TR-012). Below the threshold (or on any failure) custody stays LOCKED and the
 * signer is not ready — fail-closed. The master key lives only in memory; `shutdown` zeroizes it.
 */
export function createSigningModule(pool: pg.Pool, config: SigningConfig): SigningModule {
  const custody = new Custody();
  const shares = config.custodianShares.map((s) => Buffer.from(s, "base64"));
  if (shares.length >= 2) {
    try {
      custody.unlock(shares);
    } catch {
      // Below k / invalid shares -> stay locked (fail-closed). Readiness will report not-ready.
    }
  }
  const signer = createSigner(pool, config, custody);
  return { signer, custody, overlapSeconds: config.overlapSeconds, ready: () => signer.ready() };
}

/**
 * The module's registration seam (ADR-0005). Wires the key-management + keyring REST routes and an
 * internal readiness probe that reflects custody state (T029 — readiness, not liveness).
 */
export function registerSigning(app: FastifyInstance, deps: AppDeps): void {
  const config = loadSigningConfig();
  const module = createSigningModule(deps.pool, config);

  // Readiness (not liveness): custody-locked / backend-down -> not ready. Under /internal/ (no auth).
  app.get("/internal/ready/signing", async (_req, reply) => {
    if (module.ready()) return reply.code(200).send({ status: "ready" });
    return reply.code(503).send({ status: "not-ready", reason: "signer custody locked" });
  });

  // Compose signer readiness into the aggregate /internal/health/ready probe ONLY when a signer is
  // actually configured (custodian shares provided) — a deployment not yet signing must not be held
  // perpetually not-ready by a locked keystore (E006, OR-013: "where a signer is configured").
  if (config.custodianShares.length >= 2) {
    app.decorate("signerReady", () => module.ready());
  }

  // Publish the signer for issuance (E008) + air-gap (E010) — the single key-using surface (project-plan
  // Shared Artifact Surface). Consumers call app.signer.sign(tenantId, claims); the private key never leaks.
  app.decorate("signer", module.signer);
  // Publish the keystore custody so E014 billing can envelope-encrypt the inbound webhook HMAC secret under
  // the same master key (a distinct, lower-tier secret class — never the Ed25519 signing key). Only the
  // generic AES-256-GCM wrap/unwrap capability is shared; the signing key stays behind the Signer boundary.
  app.decorate("custody", module.custody);

  registerSigningRoutes(app, deps.pool, module);
}
