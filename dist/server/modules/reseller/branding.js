import { privileged, withTenant } from "../../db/client.js";
/** The ordered, canonical set of the 8 branding fields (contract `BrandingFieldName`). The resolver walks EXACTLY these. */
export const BRANDING_FIELD_NAMES = [
    "logoUrl",
    "primaryColor",
    "secondaryColor",
    "productName",
    "supportUrl",
    "helpUrl",
    "emailSenderAddress",
    "customDomain",
];
/**
 * The fields backed by an `active` `domain_binding` — they take effect ONLY when verified+activated (FR-013).
 * They have NO platform default (a platform can't default someone's custom domain/email sender).
 */
export const BINDING_BACKED_FIELDS = ["emailSenderAddress", "customDomain"];
const BRANDING_FIELD_SET = new Set(BRANDING_FIELD_NAMES);
/** A branding field name ↔ `branding_profile` column mapping (camelCase wire ↔ snake_case column). */
const FIELD_TO_COLUMN = {
    logoUrl: "logo_ref",
    primaryColor: "color_primary",
    secondaryColor: "color_secondary",
    productName: "product_name",
    supportUrl: "support_url",
    helpUrl: "help_url",
    emailSenderAddress: "email_sender",
    customDomain: "custom_domain",
};
/** True when `name` is one of the 8 contract branding fields. Trust signals are structurally NEVER members (FR-008). */
export function isBrandingFieldName(name) {
    return BRANDING_FIELD_SET.has(name);
}
/**
 * TRUST-SIGNAL EXCLUSION guard (FR-008, HINT-004, T026). No trust signal (revocation / tamper / signing
 * identity / audit / legal — the config `trustSignals` set) is ever a white-labelable branding field, so no
 * `branding_profile` value can spoof one. Returns true when the branding field set and the trust-signal set are
 * DISJOINT (the enforced invariant). Pure; a deployment-time / unit assertion.
 */
export function trustSignalsExcludedFromBranding(trustSignals) {
    return trustSignals.every((s) => !BRANDING_FIELD_SET.has(s));
}
/** Treat an absent/empty string as "not set" so an empty platform default never masks a real fallback. */
function nonEmpty(v) {
    return typeof v === "string" && v.trim() !== "";
}
/** The platform-default value for a field, or null. The two binding-backed fields are NEVER platform-defaulted. */
function platformValue(platform, field) {
    switch (field) {
        case "logoUrl":
            return platform.logoUrl || null;
        case "primaryColor":
            return platform.primaryColor || null;
        case "secondaryColor":
            return platform.secondaryColor || null;
        case "productName":
            return platform.productName || null;
        case "supportUrl":
            return platform.supportUrl || null;
        case "helpUrl":
            return platform.helpUrl || null;
        case "emailSenderAddress":
        case "customDomain":
            return null; // binding-backed — never a platform default (FR-013)
    }
}
/**
 * Resolve ONE branding field by precedence (AD-004, FR-007, STF-001/002). NOT locked: sub-tenant override →
 * reseller default → platform default. LOCKED (reseller): the sub-tenant layer is SKIPPED (reseller default →
 * platform default) and the field is marked `locked`. A binding-backed field with no active binding resolves to
 * `null` (FR-013). TRUST SIGNALS ARE NEVER CONSULTED — this function only ever reads the 8 branding layers (FR-008).
 */
function resolveField(field, input) {
    const locked = (input.reseller?.lockedFields ?? []).includes(field);
    const bindingBacked = BINDING_BACKED_FIELDS.includes(field);
    const activeBound = input.activeBoundFields ? new Set(input.activeBoundFields) : new Set();
    const candidates = [];
    // A reseller-LOCKED field ignores any sub-tenant override — the reseller value is authoritative (STF-001/002).
    if (!locked) {
        const ov = input.subTenant?.fields[field];
        if (nonEmpty(ov))
            candidates.push({ source: "sub_tenant", value: ov });
    }
    const rv = input.reseller?.fields[field];
    if (nonEmpty(rv))
        candidates.push({ source: "reseller", value: rv });
    if (!bindingBacked) {
        const pv = platformValue(input.platform, field);
        if (nonEmpty(pv))
            candidates.push({ source: "platform", value: pv });
    }
    let chosen = candidates[0];
    // A binding-backed field takes effect ONLY when a matching binding is active (FR-013); else it falls through.
    if (bindingBacked && chosen && !activeBound.has(field)) {
        chosen = undefined;
    }
    return {
        field,
        value: chosen?.value ?? null,
        source: chosen?.source ?? "platform",
        locked,
    };
}
/**
 * The PER-FIELD precedence resolver (FR-007, [COMPLETES FR-007] via routes T027). Resolves each of the 8
 * branding fields INDEPENDENTLY (sub-tenant override → reseller default → platform default), with a reseller
 * `locked` field authoritative over any sub-tenant override (STF-001/002), and `emailSenderAddress`/
 * `customDomain` effective only when backed by an active `domain_binding` (FR-013). It NEVER sources a trust
 * signal from a branding layer — its domain is EXACTLY {@link BRANDING_FIELD_NAMES} (FR-008, HINT-004). Pure; no
 * I/O. The returned order is the canonical {@link BRANDING_FIELD_NAMES} order (stable, testable).
 *
 * US4 (move) re-resolves against the DESTINATION reseller layer; US5 (verify) supplies `activeBoundFields`.
 */
export function resolveBranding(input) {
    return BRANDING_FIELD_NAMES.map((field) => resolveField(field, input));
}
const BRANDING_COLUMNS = "tenant_id, logo_ref, color_primary, color_secondary, product_name, support_url, help_url, email_sender, custom_domain, locked_fields, updated_at";
/** Project a `branding_profile` row to a {@link BrandingProfile} — only SET fields carry a value; locks filtered to the allow-list. */
function mapProfile(row) {
    const fields = {};
    if (nonEmpty(row.logo_ref))
        fields.logoUrl = row.logo_ref;
    if (nonEmpty(row.color_primary))
        fields.primaryColor = row.color_primary;
    if (nonEmpty(row.color_secondary))
        fields.secondaryColor = row.color_secondary;
    if (nonEmpty(row.product_name))
        fields.productName = row.product_name;
    if (nonEmpty(row.support_url))
        fields.supportUrl = row.support_url;
    if (nonEmpty(row.help_url))
        fields.helpUrl = row.help_url;
    if (nonEmpty(row.email_sender))
        fields.emailSenderAddress = row.email_sender;
    if (nonEmpty(row.custom_domain))
        fields.customDomain = row.custom_domain;
    const locked = Array.isArray(row.locked_fields)
        ? row.locked_fields.filter((n) => typeof n === "string" && isBrandingFieldName(n))
        : [];
    return { tenantId: row.tenant_id, fields, lockedFields: locked, updatedAt: row.updated_at };
}
/** The value list for a branding upsert, ordered to match {@link BRANDING_FIELD_NAMES} → columns; omitted → NULL. */
function fieldValues(fields) {
    return BRANDING_FIELD_NAMES.map((f) => fields[f] ?? null);
}
/**
 * The `branding_profile` data-access repository (T024). Stateless; one shared instance. Splits reads/writes
 * across the two isolation-safe seams:
 *   * A tenant's OWN profile — read/written under its OWN `app.current_tenant` (forced RLS; WITH CHECK guarantees
 *     the row is the acting tenant's own).
 *   * The RESELLER-DEFAULT layer for a sub-tenant — read on the audited `privileged` seam via the server-derived
 *     `parent_reseller_id` (a sub-tenant cannot read its reseller's row under RLS; AD-002, HINT-001). This is a
 *     DOWNWARD, hierarchy-safe read: the value + lock SET are applied, but the reseller's identity is never
 *     surfaced downward (FR-014, T028).
 */
export class BrandingRepo {
    pool;
    constructor(pool) {
        this.pool = pool;
    }
    /** Read the calling tenant's OWN branding profile (own scope; forced RLS). Null when it has none yet. */
    async getProfile(tenantId) {
        return withTenant(this.pool, tenantId, async (q) => {
            const r = await q(`SELECT ${BRANDING_COLUMNS} FROM branding_profile
          WHERE tenant_id = current_setting('app.current_tenant')::uuid`);
            return r.rowCount ? mapProfile(r.rows[0]) : null;
        });
    }
    /**
     * Read a SPECIFIC tenant's branding profile on the audited `privileged` seam — used to fetch a sub-tenant's
     * RESELLER-DEFAULT layer via the server-derived `parent_reseller_id` link (a sub-tenant cannot read it under
     * RLS). Downward-only + hierarchy-safe: callers apply the value/lock set but NEVER disclose the reseller
     * identity (FR-014, AD-002, HINT-001). NOT reachable from a client-supplied id — the caller derives it.
     */
    async getProfilePrivileged(tenantId) {
        return privileged(this.pool, async (q) => {
            const r = await q(`SELECT ${BRANDING_COLUMNS} FROM branding_profile WHERE tenant_id = $1`, [tenantId]);
            return r.rowCount ? mapProfile(r.rows[0]) : null;
        });
    }
    /**
     * Upsert the calling tenant's OWN branding profile (own scope; forced RLS WITH CHECK). REPLACE semantics: a
     * field OMITTED from `fields` is stored NULL (falls back per precedence at read). `lockedFields` is the
     * reseller lock set (a sub-tenant passes `[]`). The `tenant_id` is taken from the GUC (never a bound param),
     * so the row can only ever be the acting tenant's own. Returns the stored {@link BrandingProfile}.
     */
    async setProfile(tenantId, input) {
        const locked = JSON.stringify([...new Set(input.lockedFields ?? [])]);
        return withTenant(this.pool, tenantId, async (q) => {
            const r = await q(`INSERT INTO branding_profile
           (tenant_id, logo_ref, color_primary, color_secondary, product_name, support_url, help_url,
            email_sender, custom_domain, locked_fields, updated_at)
         VALUES (current_setting('app.current_tenant')::uuid, $1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, now())
         ON CONFLICT (tenant_id) DO UPDATE SET
           logo_ref = EXCLUDED.logo_ref,
           color_primary = EXCLUDED.color_primary,
           color_secondary = EXCLUDED.color_secondary,
           product_name = EXCLUDED.product_name,
           support_url = EXCLUDED.support_url,
           help_url = EXCLUDED.help_url,
           email_sender = EXCLUDED.email_sender,
           custom_domain = EXCLUDED.custom_domain,
           locked_fields = EXCLUDED.locked_fields,
           updated_at = now()
         RETURNING ${BRANDING_COLUMNS}`, [...fieldValues(input.fields), locked]);
            return mapProfile(r.rows[0]);
        });
    }
}
