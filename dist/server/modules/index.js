import { registerActivation } from "./activation/index.js";
import { registerAdmin } from "./admin/index.js";
import { registerBilling } from "./billing/index.js";
import { registerCatalog } from "./catalog/index.js";
import { registerEnforcement } from "./enforcement/index.js";
import { registerIssuance } from "./issuance/index.js";
import { registerSigning } from "./signing/index.js";
const MODULES = [
    registerSigning, // E004 — signing service & key custody (publishes app.signer for E008/E010)
    registerAdmin, // E005 — tenant administration & audit (human session console)
    registerCatalog, // E007 — no-code licensing catalog (products/plans/entitlements)
    registerIssuance, // E008 — license issuance & lifecycle (consumes app.signer + catalog effective read model)
    registerActivation, // E009 — machine activation & seats (consumes app.signer + E008 license snapshot)
    registerEnforcement, // E013 — online enforcement & revocation (short-TTL LIC1 renewal + signed CRL fallback)
    registerBilling, // E014 — billing-driven entitlement automation (webhook -> E008 lifecycle; grace overlay)
];
export function registerModules(app, deps) {
    for (const register of MODULES)
        register(app, deps);
}
