import { recordSecurityEvent, writeAudit } from "../../audit/index.js";
import { withTenant } from "../../db/client.js";
import { loadActivationConfig } from "../activation/index.js";
import { getEffectivePlanDefinition } from "../catalog/effective.js";
import { toEntitlementMap } from "../issuance/claims.js";
import { LICENSE_SELECT, mapLicenseRow } from "../issuance/licenses.js";
import { SignerError } from "../signing/signer.js";
import { advanceAnchor, recordCheckin } from "./checkin-repo.js";
import { computeStalenessWindow, resolvePlanWindows, } from "./config.js";
import { evaluateEnforcement } from "./enforce.js";
import { EnforcementError } from "./index.js";
import { mintShortLivedToken } from "./token.js";
const ACTOR = "enforcement-api";
const iso = (unix) => new Date(unix * 1000).toISOString();
/**
 * The signed server-time anchor for this beat, drawn from the DATABASE transaction clock (FR-014). Within a
 * tx PostgreSQL `now()` is constant (transaction_timestamp), so this equals the `checkin.created_at` DEFAULT
 * — the token `iat`, the anchor advance, the wire `serverTime`, and the stored check-in time are ALL the
 * same instant, so an idempotent replay reproduces the ORIGINAL serverTime exactly (not a drifting wall clock).
 */
async function dbNowUnix(q) {
    const r = await q("SELECT extract(epoch FROM now())::double precision AS now");
    return Math.floor(r.rows[0].now);
}
/**
 * Resolve the activation by id (preferred) or by its E009 `machine_bound_token`, tenant-scoped under RLS. A
 * miss (unknown OR cross-tenant) is `404 activation_not_found` (FR-018) — never disclosed as another
 * tenant's row. Distinct from a non-valid VERDICT: a KNOWN activation whose license is revoked/etc. is a
 * `200` verdict, not a `404`.
 */
async function resolveActivation(q, input) {
    const cols = "id, status, license_id, signal_hashes, fp_min";
    let res;
    if (input.activationId) {
        res = await q(`SELECT ${cols} FROM activation WHERE id = $1`, [input.activationId]);
    }
    else if (input.machineBoundKey) {
        res = await q(`SELECT ${cols} FROM activation WHERE machine_bound_token = $1`, [input.machineBoundKey]);
    }
    else {
        throw new EnforcementError("activation_not_found", 404, "no activation identity supplied");
    }
    if (!res.rowCount) {
        throw new EnforcementError("activation_not_found", 404, "no such activation in this tenant", input.activationId ? { activationId: input.activationId } : undefined);
    }
    const r = res.rows[0];
    return { id: r.id, status: r.status, licenseId: r.license_id, signalHashes: r.signal_hashes, fpMin: r.fp_min };
}
/** Read the E008 license snapshot backing this activation (LICENSE_SELECT/mapLicenseRow). */
async function readLicense(q, licenseId) {
    const r = await q(`SELECT ${LICENSE_SELECT} FROM license WHERE id = $1`, [licenseId]);
    if (!r.rowCount)
        throw new EnforcementError("activation_not_found", 404, "no such activation in this tenant");
    return mapLicenseRow(r.rows[0]);
}
/**
 * The `exp`/`renewAfter` a token minted at `serverTimeUnix` carries — mirrors `token.ts` so an idempotent
 * replay reproduces the ORIGINAL token's advertised windows (the stored token's own `exp` is at
 * `originalServerTime + renewalWindow`, bounded by the license expiry).
 */
function validWindows(serverTimeUnix, windows, license) {
    const licExpUnix = license.expiresAt != null ? Math.floor(new Date(license.expiresAt).getTime() / 1000) : null;
    const candidate = serverTimeUnix + windows.renewalWindowSecs;
    const expUnix = licExpUnix != null ? Math.min(licExpUnix, candidate) : candidate;
    const renewAfterUnix = Math.min(serverTimeUnix + windows.renewAfterSecs, expUnix);
    return { expiresAt: iso(expUnix), renewAfter: iso(renewAfterUnix) };
}
/**
 * Validate a license + activation online and, on `valid`, mint the first short-TTL renewal token (FR-001).
 * The US1 entry point — a thin wrapper over the shared `runEnforcement` flow (heartbeat, US3, is the same
 * flow with `kind='heartbeat'`). See `runEnforcement` for the full semantics.
 */
export async function validateOnline(pool, signer, config, tenantId, input) {
    return runEnforcement("validate", pool, signer, config, tenantId, input);
}
/**
 * The SHARED validate/heartbeat enforcement flow (US1 + US3; FR-001/002/003/004/017). Both entry points
 * compose exactly this — a beat is a beat — so the re-check, mint, idempotent replay, and anchor advance
 * are single-sourced here; `kind` only differentiates the successful-renewal audit action (FR-019). One
 * `withTenant` tx: resolve activation → read license → re-read the CURRENT effective entitlements (FR-017) →
 * `evaluateEnforcement`. A refusal records a `refused` check-in + audits the security event and returns the
 * `200` verdict with NO token (AD-001) — the outstanding token lapses within its TTL (bounded staleness,
 * FR-005). A `valid` verdict re-signs the short-TTL LIC1 (a `SignerError` → `503 signer_unavailable`, tx
 * rolled back so no anchor advance), records a `renewed` check-in — an idempotent replay of the SAME
 * nonce+activation returns the ORIGINAL token without advancing the anchor twice (FR-008) — advances the
 * monotonic anchor (FR-014), and audits the renewal. A nonce reused for a DIFFERENT activation throws
 * `409 nonce_replayed` (raised by `recordCheckin`). `stalenessWindow` (FR-013) + `serverTime` are on every
 * result. Re-evaluated every beat with NO sticky state, so reinstating a suspended license resumes renewal
 * on the very next beat (FR-006).
 */
export async function runEnforcement(kind, pool, signer, config, tenantId, input) {
    // The renewal token reuses the E009 machine binding; its clock-skew tolerance is the deploy-wide activation
    // config `sk` (the per-activation fp/fpk come from the activation row), so the E001 verifier behaves as it
    // does for the long-lived credential.
    const maxSkewSecs = loadActivationConfig().maxSkewSecs;
    // FR-019: the successful-renewal audit action distinguishes the two entry points in the append-only log.
    const renewedAction = kind === "heartbeat" ? "enforcement.heartbeat" : "enforcement.renewed";
    return withTenant(pool, tenantId, async (q) => {
        // The signed anchor for this beat = the DB transaction clock, so it matches checkin.created_at exactly.
        const nowUnix = await dbNowUnix(q);
        const serverTime = iso(nowUnix);
        const act = await resolveActivation(q, input);
        const license = await readLicense(q, act.licenseId);
        // FR-017: the CURRENT effective entitlements (E007), re-read this beat, are baked into the renewed token
        // — not the license's stored snapshot. A missing plan falls back to the license snapshot (evaluate below).
        const eff = await getEffectivePlanDefinition(pool, tenantId, license.planId);
        const effectiveEntitlements = eff ? toEntitlementMap(eff.entitlements) : null;
        const windows = resolvePlanWindows(config, { planKey: eff?.planKey ?? null, planId: license.planId });
        const stalenessWindow = computeStalenessWindow(windows);
        const evaluation = evaluateEnforcement(license, { status: act.status }, effectiveEntitlements, nowUnix);
        // AD-001: a refusal is a 200 + verdict, NOT an error. Record it (idempotent) + audit as a security event;
        // no token, no anchor advance (the outstanding token lapses within its TTL, bounded staleness <= TTL).
        if (evaluation.verdict !== "valid") {
            const refused = await recordCheckin(q, {
                activationId: act.id,
                nonce: input.nonce,
                outcome: "refused",
                reason: evaluation.reason,
                renewedToken: null,
            });
            if (!refused.replayed) {
                await recordSecurityEvent(q, {
                    actor: ACTOR,
                    action: "enforcement.refused",
                    target: evaluation.reason ?? evaluation.verdict,
                });
            }
            return { verdict: evaluation.verdict, reason: evaluation.reason, serverTime, stalenessWindow };
        }
        // Valid: re-sign a short-TTL LIC1 (E004 signer). A signer fault → 503 (tx rolls back; no check-in/anchor,
        // client retries within the grace window). The token is a separate public artifact; machine_bound_token
        // is untouched (US5, AD-005).
        if (!signer)
            throw new EnforcementError("signer_unavailable", 503, "no signer is configured");
        let minted;
        try {
            minted = await mintShortLivedToken(signer, tenantId, {
                license,
                signalHashes: act.signalHashes,
                fpMin: act.fpMin,
                maxSkewSecs,
                entitlements: evaluation.entitlements,
                renewalWindowSecs: windows.renewalWindowSecs,
                renewAfterSecs: windows.renewAfterSecs,
                nowUnix,
            });
        }
        catch (e) {
            if (e instanceof SignerError)
                throw new EnforcementError("signer_unavailable", 503, `signer unavailable (${e.failure})`);
            throw e;
        }
        // FR-008 idempotent replay: a retry with the SAME nonce+activation returns the ORIGINAL stored token — no
        // second anchor advance, no re-audit; a nonce reused for a DIFFERENT activation throws 409 nonce_replayed.
        const checkin = await recordCheckin(q, {
            activationId: act.id,
            nonce: input.nonce,
            outcome: "renewed",
            reason: null,
            renewedToken: minted.token,
        });
        if (checkin.replayed) {
            const originalServerTimeUnix = Math.floor(new Date(checkin.createdAt).getTime() / 1000);
            const w = validWindows(originalServerTimeUnix, windows, license);
            return {
                verdict: "valid",
                reason: null,
                shortLivedToken: checkin.renewedToken ?? minted.token,
                serverTime: iso(originalServerTimeUnix),
                renewAfter: w.renewAfter,
                expiresAt: w.expiresAt,
                stalenessWindow,
            };
        }
        // FR-014/015 (US6; AD-006, HINT-005): advance the MONOTONIC last-seen anchor floor to THIS beat's SIGNED
        // server time. The guarded UPDATE is the AUTHORITATIVE floor check (it applies the same rule as the pure
        // `isMonotonicAnchor` predicate) — it advances `last_anchor_at` ONLY when non-decreasing, so the server
        // NEVER lowers the anchor even if a rolled-back client asserts an earlier time. `anchorAdvanced` is the
        // runtime outcome of that floor check; it is recorded in the append-only audit (FR-019) so a beat that
        // did NOT advance the floor (a would-be regression, or a concurrent beat already past this instant) is
        // observable. Clock-tamper resistance is ultimately CLIENT-side; the server supplies signed time + short
        // exp + this floor, and a never-connected rollback is BOUNDED by the offline tolerance, not prevented.
        const anchorAdvanced = await advanceAnchor(q, act.id, minted.serverTimeUnix);
        await writeAudit(q, { actor: ACTOR, action: renewedAction, target: act.id, after: { anchorAdvanced } });
        return {
            verdict: "valid",
            reason: null,
            shortLivedToken: minted.token,
            serverTime,
            renewAfter: iso(minted.renewAfterUnix),
            expiresAt: minted.expiresAtUnix != null ? iso(minted.expiresAtUnix) : undefined,
            stalenessWindow,
        };
    });
}
