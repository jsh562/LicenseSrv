import { registerActivation } from "./activation/index.js";
import { registerAdmin } from "./admin/index.js";
import { registerBilling } from "./billing/index.js";
import { registerCatalog } from "./catalog/index.js";
import { registerEnforcement } from "./enforcement/index.js";
import { registerIssuance } from "./issuance/index.js";
import { registerLease } from "./lease/index.js";
import { registerPolicy } from "./policy/index.js";
import { registerReseller } from "./reseller/index.js";
import { registerSigning } from "./signing/index.js";
import { registerUsage } from "./usage/index.js";
const MODULES = [
    registerSigning, // E004 — signing service & key custody (publishes app.signer for E008/E010)
    registerAdmin, // E005 — tenant administration & audit (human session console)
    registerCatalog, // E007 — no-code licensing catalog (products/plans/entitlements)
    registerIssuance, // E008 — license issuance & lifecycle (consumes app.signer + catalog effective read model)
    registerActivation, // E009 — machine activation & seats (consumes app.signer + E008 license snapshot)
    registerEnforcement, // E013 — online enforcement & revocation (short-TTL LIC1 renewal + signed CRL fallback)
    registerBilling, // E014 — billing-driven entitlement automation (webhook -> E008 lifecycle; grace overlay)
    registerLease, // E015 — floating & concurrent seats (race-safe lease acquire/renew/release + reclaim sweeper)
    registerUsage, // E016 — usage metering & aggregation (idempotent batch ingest + watermark hourly rollup)
    registerPolicy, // E017 — low-code policy rules (sandboxed author-time-validated + issuance-time bounded effect)
    registerReseller, // E018 — reseller & white-label tenancy (subtree gate + scoped descent + per-field branding)
];
export function registerModules(app, deps) {
    for (const register of MODULES)
        register(app, deps);
}
