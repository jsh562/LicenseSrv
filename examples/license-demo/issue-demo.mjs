// Part of the LicenseSrv licensing demo. Drives the REAL HTTP surface end to end:
//   admin login -> create product -> provision its signing key (/v1) -> create plan + entitlements
//   -> set plan values -> create customer -> issue a GOOD license and an EXPIRED one.
// Writes the resulting LIC1 tokens + productId to ./.out/tokens.json for verify.mjs to check offline.
//
// Reads ./.out/env.json (written by scripts/seed-demo.ts). Run: node examples/license-demo/issue-demo.mjs
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, ".out");
const env = JSON.parse(readFileSync(resolve(OUT, "env.json"), "utf8"));
const BASE = env.baseUrl;
const rnd = randomBytes(3).toString("hex");

/** Parse Set-Cookie headers into a { name: value } map (Node 22 fetch: getSetCookie()). */
function cookiesFrom(res, jar) {
  for (const line of res.headers.getSetCookie?.() ?? []) {
    const [pair] = line.split(";");
    const i = pair.indexOf("=");
    if (i > 0) jar[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
  }
  return jar;
}
const cookieHeader = (jar) => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; ");

async function must(res, what) {
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`${what} -> HTTP ${res.status}: ${body}`);
  }
  return res.status === 204 ? {} : res.json();
}
const pickId = (o) => o.id ?? o.product?.id ?? o.plan?.id ?? o.entitlement?.id ?? o.customer?.id;

async function main() {
  const jar = {};

  // 1) Admin login -> session + CSRF cookies.
  const login = await fetch(`${BASE}/admin/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tenantSlug: env.tenantSlug, email: env.adminEmail, password: env.adminPassword }),
  });
  await must(login, "login");
  cookiesFrom(login, jar);
  const csrf = jar["admin_csrf"];
  if (!csrf) throw new Error("no admin_csrf cookie after login");

  // Helper for session-authenticated mutations (double-submit CSRF).
  const admin = (path, method, body) =>
    fetch(`${BASE}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        cookie: cookieHeader(jar),
        "x-csrf-token": csrf,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  // 2) Product (unique key per run).
  const product = await must(await admin("/admin/catalog/products", "POST", { key: `app-${rnd}`, name: "Demo App" }), "create product");
  const productId = pickId(product);
  console.log(`product ${productId}`);

  // 3) Provision the product signing key over /v1 (admin API key). MUST match the product above.
  await must(
    await fetch(`${BASE}/v1/products/${productId}/signing-keys`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": env.adminApiKey },
      body: JSON.stringify({}),
    }),
    "provision signing key",
  );
  console.log("signing key provisioned");

  // 4) Plan under the product.
  const plan = await must(
    await admin(`/admin/catalog/products/${productId}/plans`, "POST", { key: `pro-${rnd}`, name: "Pro", maxActivations: 5 }),
    "create plan",
  );
  const planId = pickId(plan);

  // 5) Entitlements 'pro' (boolean) + 'seats' (integer_limit) — global per tenant, createOrGet.
  async function entitlement(key, name, type) {
    const res = await admin("/admin/catalog/entitlements", "POST", { key, name, type });
    if (res.status === 409) {
      const list = await must(await admin("/admin/catalog/entitlements", "GET"), "list entitlements");
      const arr = Array.isArray(list) ? list : (list.entitlements ?? list.items ?? []);
      const found = arr.find((e) => e.key === key);
      if (!found) throw new Error(`entitlement ${key} 409 but not found on list`);
      return found.id;
    }
    return pickId(await must(res, `create entitlement ${key}`));
  }
  const entPro = await entitlement("pro", "Pro Features", "boolean");
  const entSeats = await entitlement("seats", "Seats", "integer_limit");

  // 6) Attach plan values.
  await must(await admin(`/admin/catalog/plans/${planId}/entitlements/${entPro}`, "PUT", { value: true }), "set pro value");
  await must(await admin(`/admin/catalog/plans/${planId}/entitlements/${entSeats}`, "PUT", { value: 5 }), "set seats value");
  console.log("plan + entitlements set (pro=true, seats=5)");

  // 7) Customer.
  const customer = await must(await admin("/admin/customers", "POST", { ref: `cust-${rnd}`, name: "Demo Co" }), "create customer");
  const customerId = pickId(customer);

  // 8) Issue a GOOD (perpetual) license and a short-lived one. The server's mint-time conformance
  //    check refuses to sign an ALREADY-expired token, so we issue a near-future expiry (valid at mint)
  //    and let verify.mjs check it against a clock past that expiry — proving offline expiry enforcement.
  const expiresAtUnix = Math.floor(Date.now() / 1000) + 300; // +5 min
  const good = await must(await admin("/admin/licenses", "POST", { planId, customerId }), "issue good license");
  const expiring = await must(
    await admin("/admin/licenses", "POST", { planId, customerId, expiresAt: new Date(expiresAtUnix * 1000).toISOString() }),
    "issue expiring license",
  );
  const goodToken = good.licenseKey ?? good.license?.licenseKey;
  const expiringToken = expiring.licenseKey ?? expiring.license?.licenseKey;
  if (!goodToken?.startsWith("LIC1.")) throw new Error(`unexpected token: ${JSON.stringify(good).slice(0, 200)}`);

  mkdirSync(OUT, { recursive: true });
  writeFileSync(resolve(OUT, "tokens.json"), JSON.stringify({ productId, goodToken, expiringToken, expiresAtUnix }, null, 2));

  console.log("\n✓ Issued licenses:");
  console.log(`  good     : ${goodToken.slice(0, 32)}…  (perpetual, pro=true seats=5)`);
  console.log(`  expiring : ${expiringToken.slice(0, 32)}…  (expires in 5 min — verified past-expiry in the demo)`);
  console.log(`  wrote    : ${resolve(OUT, "tokens.json")}`);
  console.log("\nNext: node examples/license-demo/verify.mjs\n");
}

main().catch((e) => {
  console.error("issue-demo failed:", e.message ?? e);
  process.exit(1);
});
