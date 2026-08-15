// [Foundational] T005 (FR-003/007/008/012): reseller config resolver unit tests. Exercises
// `loadResellerConfig`'s default + env-override + invalid-fallback branches for every key (the default hard
// sub-tenant quota — 0 allowed; the offboarding grace window; the non-white-labelable trust-signal set; the
// platform-default branding floor) and `parseTrustSignals`. Pure — no DB.
import { describe, expect, it } from "vitest";

import {
  DEFAULT_OFFBOARDING_GRACE_SECS,
  DEFAULT_PLATFORM_BRANDING,
  DEFAULT_SUBTENANT_QUOTA,
  DEFAULT_TRUST_SIGNALS,
  loadResellerConfig,
  parseTrustSignals,
} from "../config.js";

describe("loadResellerConfig (FR-003/007/008/012 defaults)", () => {
  it("returns the documented defaults when the environment is empty", () => {
    expect(loadResellerConfig({})).toEqual({
      defaultSubTenantQuota: DEFAULT_SUBTENANT_QUOTA,
      offboardingGraceSecs: DEFAULT_OFFBOARDING_GRACE_SECS,
      trustSignals: DEFAULT_TRUST_SIGNALS,
      platformBranding: DEFAULT_PLATFORM_BRANDING,
    });
  });

  it("keeps the documented default posture (quota 50, ~30d grace, fixed trust-signal set)", () => {
    expect(DEFAULT_SUBTENANT_QUOTA).toBe(50);
    expect(DEFAULT_OFFBOARDING_GRACE_SECS).toBe(30 * 24 * 3600);
    expect(DEFAULT_TRUST_SIGNALS).toEqual(["revocation", "tamper", "signing_identity", "audit", "legal"]);
  });

  it("honours valid env overrides for every key", () => {
    const cfg = loadResellerConfig({
      RESELLER_DEFAULT_SUBTENANT_QUOTA: "200",
      RESELLER_OFFBOARDING_GRACE_SECS: "86400",
      RESELLER_TRUST_SIGNALS: "revocation, tamper, custom_notice",
      RESELLER_PLATFORM_PRODUCT_NAME: "Acme Licensing",
      RESELLER_PLATFORM_COLOR_PRIMARY: "#000000",
      RESELLER_PLATFORM_COLOR_SECONDARY: "#ffffff",
      RESELLER_PLATFORM_SUPPORT_URL: "https://support.acme.example",
      RESELLER_PLATFORM_HELP_URL: "https://help.acme.example",
      RESELLER_PLATFORM_LOGO_REF: "acme-logo",
    });
    expect(cfg).toEqual({
      defaultSubTenantQuota: 200,
      offboardingGraceSecs: 86_400,
      trustSignals: ["revocation", "tamper", "custom_notice"],
      platformBranding: {
        logoUrl: "acme-logo",
        primaryColor: "#000000",
        secondaryColor: "#ffffff",
        productName: "Acme Licensing",
        supportUrl: "https://support.acme.example",
        helpUrl: "https://help.acme.example",
      },
    });
  });

  it("allows a hard cap of zero sub-tenants (quota 0 is a valid non-negative value)", () => {
    expect(loadResellerConfig({ RESELLER_DEFAULT_SUBTENANT_QUOTA: "0" }).defaultSubTenantQuota).toBe(0);
  });

  it("falls back to defaults for non-positive / negative / non-numeric env values", () => {
    const cfg = loadResellerConfig({
      RESELLER_DEFAULT_SUBTENANT_QUOTA: "-5",
      RESELLER_OFFBOARDING_GRACE_SECS: "0",
      RESELLER_TRUST_SIGNALS: "   ",
      RESELLER_PLATFORM_PRODUCT_NAME: "",
      RESELLER_PLATFORM_COLOR_PRIMARY: "",
    });
    expect(cfg.defaultSubTenantQuota).toBe(DEFAULT_SUBTENANT_QUOTA);
    expect(cfg.offboardingGraceSecs).toBe(DEFAULT_OFFBOARDING_GRACE_SECS);
    // The trust-signal set can never be configured away (FR-008).
    expect(cfg.trustSignals).toEqual(DEFAULT_TRUST_SIGNALS);
    // An empty branding override is treated as unset → the platform floor.
    expect(cfg.platformBranding.productName).toBe(DEFAULT_PLATFORM_BRANDING.productName);
    expect(cfg.platformBranding.primaryColor).toBe(DEFAULT_PLATFORM_BRANDING.primaryColor);
  });

  it("floors a fractional quota / grace window", () => {
    expect(loadResellerConfig({ RESELLER_DEFAULT_SUBTENANT_QUOTA: "12.9" }).defaultSubTenantQuota).toBe(12);
    expect(loadResellerConfig({ RESELLER_OFFBOARDING_GRACE_SECS: "99.9" }).offboardingGraceSecs).toBe(99);
  });
});

describe("parseTrustSignals (FR-008)", () => {
  it("trims, drops empties, and de-duplicates entries", () => {
    expect(parseTrustSignals(" revocation , tamper ,, revocation , legal ")).toEqual([
      "revocation",
      "tamper",
      "legal",
    ]);
  });

  it("falls back to the fixed default set for a missing / empty / all-blank value", () => {
    expect(parseTrustSignals(undefined)).toEqual(DEFAULT_TRUST_SIGNALS);
    expect(parseTrustSignals("")).toEqual(DEFAULT_TRUST_SIGNALS);
    expect(parseTrustSignals(" , , ")).toEqual(DEFAULT_TRUST_SIGNALS);
  });
});
