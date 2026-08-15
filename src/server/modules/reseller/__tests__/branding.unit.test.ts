// T021 [US2] (FR-006/007/008): the PER-FIELD branding precedence resolver as a PURE unit (no DB, no HTTP).
// Asserts the load-bearing white-label rules the routes compose (HINT-003/004, STF-001/002/004):
//   - each of the 8 fields resolves INDEPENDENTLY: sub-tenant override → reseller default → platform default.
//   - a reseller-LOCKED field is authoritative — a sub-tenant override for it is IGNORED (STF-001/002).
//   - a locked field carries `locked: true` but NO reseller identity (hierarchy-safe presentation, T028).
//   - TRUST SIGNALS are never sourced from a branding layer — the resolver domain is EXACTLY the 8 fields (FR-008).
//   - `emailSenderAddress`/`customDomain` are effective only when backed by an active binding (FR-013 placeholder).
import { describe, expect, it } from "vitest";

import { loadResellerConfig } from "../config.js";
import {
  BRANDING_FIELD_NAMES,
  type BrandingFieldName,
  type BrandingLayer,
  isBrandingFieldName,
  resolveBranding,
  trustSignalsExcludedFromBranding,
} from "../branding.js";

const config = loadResellerConfig();
const platform = config.platformBranding;

function byField(resolved: ReturnType<typeof resolveBranding>): Map<BrandingFieldName, { value: string | null; source: string; locked: boolean }> {
  return new Map(resolved.map((r) => [r.field, { value: r.value, source: r.source, locked: r.locked }]));
}

describe("branding per-field precedence resolver (unit)", () => {
  it("resolves all 8 branding fields, in canonical order, and never any other field", () => {
    const resolved = resolveBranding({ platform });
    expect(resolved.map((r) => r.field)).toEqual([...BRANDING_FIELD_NAMES]);
    expect(resolved).toHaveLength(8);
  });

  it("falls each field back INDEPENDENTLY: sub-tenant → reseller → platform (SC-004)", () => {
    const reseller: BrandingLayer = {
      fields: { primaryColor: "#0a5", productName: "Acme LM", supportUrl: "https://support.acme.example" },
      lockedFields: [],
    };
    const subTenant: BrandingLayer = { fields: { logoUrl: "https://cdn.nw.example/logo.svg", productName: "Northwind Portal" }, lockedFields: [] };
    const m = byField(resolveBranding({ subTenant, reseller, platform }));
    // sub-tenant override wins where set
    expect(m.get("logoUrl")).toMatchObject({ value: "https://cdn.nw.example/logo.svg", source: "sub_tenant" });
    expect(m.get("productName")).toMatchObject({ value: "Northwind Portal", source: "sub_tenant" });
    // reseller default where the sub-tenant did not override
    expect(m.get("primaryColor")).toMatchObject({ value: "#0a5", source: "reseller" });
    expect(m.get("supportUrl")).toMatchObject({ value: "https://support.acme.example", source: "reseller" });
    // platform default where neither set it (config floor)
    expect(m.get("secondaryColor")).toMatchObject({ value: platform.secondaryColor, source: "platform" });
  });

  it("a reseller-LOCKED field is authoritative — the sub-tenant override is IGNORED (STF-001/002)", () => {
    const reseller: BrandingLayer = { fields: { primaryColor: "#0a5", productName: "Acme LM" }, lockedFields: ["primaryColor", "productName"] };
    const subTenant: BrandingLayer = { fields: { primaryColor: "#f00", productName: "Rogue Rebrand" }, lockedFields: [] };
    const m = byField(resolveBranding({ subTenant, reseller, platform }));
    expect(m.get("primaryColor")).toEqual({ value: "#0a5", source: "reseller", locked: true });
    expect(m.get("productName")).toEqual({ value: "Acme LM", source: "reseller", locked: true });
  });

  it("an UNLOCKED field is overridable even when other fields are locked (per-field independence)", () => {
    const reseller: BrandingLayer = { fields: { primaryColor: "#0a5" }, lockedFields: ["primaryColor"] };
    const subTenant: BrandingLayer = { fields: { logoUrl: "https://cdn.nw.example/logo.svg" }, lockedFields: [] };
    const m = byField(resolveBranding({ subTenant, reseller, platform }));
    expect(m.get("primaryColor")).toMatchObject({ locked: true, source: "reseller" });
    expect(m.get("logoUrl")).toEqual({ value: "https://cdn.nw.example/logo.svg", source: "sub_tenant", locked: false });
  });

  it("a locked field carries `locked:true` but NO reseller identity (hierarchy-safe, T028/STF-004)", () => {
    const reseller: BrandingLayer = { fields: { primaryColor: "#0a5" }, lockedFields: ["primaryColor"] };
    const resolved = resolveBranding({ subTenant: { fields: {}, lockedFields: [] }, reseller, platform });
    const locked = resolved.find((r) => r.field === "primaryColor")!;
    expect(locked.locked).toBe(true);
    // The resolved shape has exactly {field,value,source,locked} — no reseller id / hierarchy leak.
    expect(Object.keys(locked).sort()).toEqual(["field", "locked", "source", "value"]);
  });

  it("TRUST SIGNALS are never branding fields and never appear in the resolved output (FR-008)", () => {
    expect(trustSignalsExcludedFromBranding(config.trustSignals)).toBe(true);
    for (const sig of config.trustSignals) expect(isBrandingFieldName(sig)).toBe(false);
    // Even if a rogue branding layer smuggles a trust-signal key, the resolver never surfaces it.
    const rogue = { fields: { revocation: "spoofed", primaryColor: "#0a5" } as Record<string, string>, lockedFields: [] };
    const resolved = resolveBranding({ reseller: rogue as unknown as BrandingLayer, platform });
    expect(resolved.map((r) => r.field)).not.toContain("revocation");
    expect(resolved.every((r) => isBrandingFieldName(r.field))).toBe(true);
  });

  it("emailSenderAddress/customDomain are inert without an active binding, and take effect with one (FR-013)", () => {
    const reseller: BrandingLayer = { fields: { emailSenderAddress: "lic@acme.example", customDomain: "lic.acme.example" }, lockedFields: [] };
    const off = byField(resolveBranding({ reseller, platform }));
    expect(off.get("emailSenderAddress")).toEqual({ value: null, source: "platform", locked: false });
    expect(off.get("customDomain")).toEqual({ value: null, source: "platform", locked: false });
    const on = byField(resolveBranding({ reseller, platform, activeBoundFields: ["emailSenderAddress", "customDomain"] }));
    expect(on.get("emailSenderAddress")).toMatchObject({ value: "lic@acme.example", source: "reseller" });
    expect(on.get("customDomain")).toMatchObject({ value: "lic.acme.example", source: "reseller" });
  });
});
