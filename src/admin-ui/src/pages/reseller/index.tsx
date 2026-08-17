// Reseller & white-label tenancy console (E018; FR-001..FR-017). One shell view fronting the four reseller
// surfaces across the three admin planes: OPERATOR reseller lifecycle (onboard / list / quota / suspend /
// reinstate / offboard / move), RESELLER sub-tenant management (list + provision under the hard quota), the
// per-field white-label BRANDING editor (reseller defaults + locks, and this tenant's own overrides), and
// domain / email-sender VERIFICATION (initiate -> verify -> activate). A sub-nav switches sub-views (local
// state, no router — mirrors the console Shell). Every mutation is admin-only client-side (RequireRole) and the
// server enforces plane + RBAC + double-submit CSRF fail-closed regardless of what the SPA shows. No secret or
// signing key is ever shown (presentation-only, Principle I).
import { useState } from "react";

import type { Role } from "../../api";
import { Branding } from "./Branding";
import { Domains } from "./Domains";
import { Resellers } from "./Resellers";
import { SubTenants } from "./SubTenants";

type SubView = "resellers" | "sub-tenants" | "branding" | "domains";

const TABS: { id: SubView; label: string }[] = [
  { id: "resellers", label: "Resellers" },
  { id: "sub-tenants", label: "Sub-tenants" },
  { id: "branding", label: "Branding" },
  { id: "domains", label: "Domains" },
];

const TAB_BASE = "-mb-px border-b-2 px-3 py-2 text-sm font-medium transition-colors";
const TAB_ON = "border-primary text-primary";
const TAB_OFF = "border-transparent text-fg-muted hover:border-border hover:text-fg";

export function Reseller({ sessionRole }: { sessionRole: Role }): JSX.Element {
  const [view, setView] = useState<SubView>("resellers");

  return (
    <section aria-label="Reseller" className="space-y-4">
      <nav aria-label="Reseller sections" className="flex gap-1 border-b border-border">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            aria-current={view === t.id}
            onClick={() => setView(t.id)}
            className={`${TAB_BASE} ${view === t.id ? TAB_ON : TAB_OFF}`}
          >
            {t.label}
          </button>
        ))}
      </nav>
      {view === "resellers" && <Resellers sessionRole={sessionRole} />}
      {view === "sub-tenants" && <SubTenants sessionRole={sessionRole} />}
      {view === "branding" && <Branding sessionRole={sessionRole} />}
      {view === "domains" && <Domains sessionRole={sessionRole} />}
    </section>
  );
}
