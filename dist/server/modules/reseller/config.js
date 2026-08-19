// Reseller & white-label deployment-wide configuration + resolver (E018, FR-003/007/008/012; ADR-0015). The
// default hard sub-tenant quota a newly-onboarded reseller receives (FR-003/010), the offboarding grace window
// (the stable anchor `graceEndsAt = offboarding_started_at + this` — FR-012), the non-white-labelable trust-
// signal set the branding resolver ALWAYS sources authoritatively and NEVER from `branding_profile` (FR-008),
// and the platform-default branding values that back the LOWEST precedence tier (sub-tenant override → reseller
// default → platform default — FR-007) are APP CONFIG read LIVE (an operator retunes without a migration).
// SCREAMING_SNAKE env -> camelCase config, mirroring `loadPolicyConfig`/`loadUsageConfig` (deployment-wide
// defaults from the same env keys the central AppConfig reads, `src/server/config/index.ts`). This module
// performs NO cryptography and holds no secret — presentation-only (Principle I).
// Documented defaults (kept in sync with the Zod defaults in src/server/config/index.ts -- both read the same
// SCREAMING_SNAKE env keys). A sane default sub-tenant quota, a ~30d offboarding grace window, the fixed
// non-white-labelable trust-signal set (revocation / tamper / signing-identity / audit / legal), and a neutral
// platform branding floor (product name + colors; support/help/logo empty by default).
export const DEFAULT_SUBTENANT_QUOTA = 50;
export const DEFAULT_OFFBOARDING_GRACE_SECS = 2_592_000; // 30 days
export const DEFAULT_TRUST_SIGNALS = [
    "revocation",
    "tamper",
    "signing_identity",
    "audit",
    "legal",
];
export const DEFAULT_PLATFORM_BRANDING = {
    logoUrl: "",
    primaryColor: "#1f2937",
    secondaryColor: "#3b82f6",
    productName: "License Server",
    supportUrl: "",
    helpUrl: "",
};
/** Coerce a NON-NEGATIVE (>= 0) integer env value; falls back on a missing / negative / non-numeric input (quota may be 0). */
function nonNegIntEnv(raw, dflt) {
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : dflt;
}
/** Coerce a POSITIVE integer env value; falls back on a missing / non-positive / non-numeric input. */
function posIntEnv(raw, dflt) {
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : dflt;
}
/** Resolve a string env value, falling back to `dflt` when missing/empty (an empty override is treated as unset). */
function strEnv(raw, dflt) {
    return raw !== undefined && raw.trim() !== "" ? raw : dflt;
}
/**
 * Parse the comma-separated non-white-labelable trust-signal set (FR-008): trim each entry, drop empties, and
 * de-duplicate. A missing / empty / all-blank value falls back to the documented default set so the trust
 * signals can never be configured away. Order-preserving on the first occurrence.
 */
export function parseTrustSignals(raw) {
    if (raw === undefined)
        return DEFAULT_TRUST_SIGNALS;
    const seen = new Set();
    const out = [];
    for (const part of raw.split(",")) {
        const t = part.trim();
        if (t !== "" && !seen.has(t)) {
            seen.add(t);
            out.push(t);
        }
    }
    return out.length > 0 ? out : DEFAULT_TRUST_SIGNALS;
}
/**
 * Load the reseller config from the environment, falling back to the documented defaults. Reads the same
 * SCREAMING_SNAKE keys as the central AppConfig. The quota is a non-negative-int resolver (0 = a hard cap of
 * zero, allowed), the grace window is a positive-int resolver, the trust-signal set is a comma-separated list
 * that can never be emptied, and the platform branding floor is a set of string resolvers. Pure; no I/O; no
 * secret (this epic performs no cryptography — presentation-only, Principle I).
 */
export function loadResellerConfig(env = process.env) {
    return {
        defaultSubTenantQuota: nonNegIntEnv(env.RESELLER_DEFAULT_SUBTENANT_QUOTA, DEFAULT_SUBTENANT_QUOTA),
        offboardingGraceSecs: posIntEnv(env.RESELLER_OFFBOARDING_GRACE_SECS, DEFAULT_OFFBOARDING_GRACE_SECS),
        trustSignals: parseTrustSignals(env.RESELLER_TRUST_SIGNALS),
        platformBranding: {
            logoUrl: strEnv(env.RESELLER_PLATFORM_LOGO_REF, DEFAULT_PLATFORM_BRANDING.logoUrl),
            primaryColor: strEnv(env.RESELLER_PLATFORM_COLOR_PRIMARY, DEFAULT_PLATFORM_BRANDING.primaryColor),
            secondaryColor: strEnv(env.RESELLER_PLATFORM_COLOR_SECONDARY, DEFAULT_PLATFORM_BRANDING.secondaryColor),
            productName: strEnv(env.RESELLER_PLATFORM_PRODUCT_NAME, DEFAULT_PLATFORM_BRANDING.productName),
            supportUrl: strEnv(env.RESELLER_PLATFORM_SUPPORT_URL, DEFAULT_PLATFORM_BRANDING.supportUrl),
            helpUrl: strEnv(env.RESELLER_PLATFORM_HELP_URL, DEFAULT_PLATFORM_BRANDING.helpUrl),
        },
    };
}
