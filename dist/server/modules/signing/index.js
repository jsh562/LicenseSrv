import { Custody } from "./custody.js";
import { KeystoreSigner } from "./keystore-signer.js";
import { registerSigningRoutes } from "./routes.js";
/** Default rotation overlap window: 30 days (TR-019 — bounded, operator-configurable). */
export const DEFAULT_OVERLAP_SECONDS = 2_592_000;
/** Read signing config from the environment (E006 secrets contract). */
export function loadSigningConfig(env = process.env) {
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
export function createSigner(pool, config, custody) {
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
export function createSigningModule(pool, config) {
    const custody = new Custody();
    const shares = config.custodianShares.map((s) => Buffer.from(s, "base64"));
    if (shares.length >= 2) {
        try {
            custody.unlock(shares);
        }
        catch {
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
export function registerSigning(app, deps) {
    const config = loadSigningConfig();
    const module = createSigningModule(deps.pool, config);
    // Readiness (not liveness): custody-locked / backend-down -> not ready. Under /internal/ (no auth).
    app.get("/internal/ready/signing", async (_req, reply) => {
        if (module.ready())
            return reply.code(200).send({ status: "ready" });
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
    registerSigningRoutes(app, deps.pool, module);
}
