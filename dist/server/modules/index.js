import { registerActivation } from "./activation/index.js";
import { registerAdmin } from "./admin/index.js";
import { registerCatalog } from "./catalog/index.js";
import { registerIssuance } from "./issuance/index.js";
import { registerSigning } from "./signing/index.js";
const MODULES = [
    registerSigning, // E004 — signing service & key custody (publishes app.signer for E008/E010)
    registerAdmin, // E005 — tenant administration & audit (human session console)
    registerCatalog, // E007 — no-code licensing catalog (products/plans/entitlements)
    registerIssuance, // E008 — license issuance & lifecycle (consumes app.signer + catalog effective read model)
    registerActivation, // E009 — machine activation & seats (consumes app.signer + E008 license snapshot)
];
export function registerModules(app, deps) {
    for (const register of MODULES)
        register(app, deps);
}
