// Snapshot the demo assets the browser app loads offline: fetch the product's public keyring once and
// bundle it with the already-issued tokens + ids from examples/license-demo/.out/ (produced by
// `npm run demo`). Writes examples/license-demo-app/public/demo-bundle.json.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = resolve(ROOT, "examples/license-demo/.out");

let env, tokens;
try {
  env = JSON.parse(readFileSync(resolve(OUT, "env.json"), "utf8"));
  tokens = JSON.parse(readFileSync(resolve(OUT, "tokens.json"), "utf8"));
} catch {
  console.error("Missing examples/license-demo/.out/{env.json,tokens.json}. Run `npm run demo` first.");
  process.exit(1);
}
if (!tokens.planId || !tokens.customerId) {
  console.error("tokens.json lacks planId/customerId — re-run `node examples/license-demo/issue-demo.mjs`.");
  process.exit(1);
}

const res = await fetch(`${env.baseUrl}/v1/products/${tokens.productId}/keyring`, {
  headers: { "x-api-key": env.validateApiKey },
});
if (!res.ok) {
  console.error(`Keyring fetch failed (HTTP ${res.status}). Is the stack up?`);
  process.exit(1);
}
const keyring = await res.json();

const dest = resolve(ROOT, "examples/license-demo-app/public");
mkdirSync(dest, { recursive: true });
writeFileSync(
  resolve(dest, "demo-bundle.json"),
  JSON.stringify(
    {
      keyring,
      goodToken: tokens.goodToken,
      expiringToken: tokens.expiringToken,
      expiresAtUnix: tokens.expiresAtUnix,
      planId: tokens.planId,
      customerId: tokens.customerId,
    },
    null,
    2,
  ),
);
console.log(`✓ wrote examples/license-demo-app/public/demo-bundle.json (${keyring.keys?.length ?? 0} key(s))`);
