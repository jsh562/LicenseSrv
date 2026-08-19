// The centerpiece of the LicenseSrv licensing demo: verify an issued license FULLY OFFLINE.
// No network call to check the signature, no crypto in JS — the one Rust core (compiled to WASM) does
// the work. We only fetch the PUBLIC keyring once (out-of-band), then verify + gate a feature locally.
//
// Reads ./.out/{env.json,tokens.json}. Run: node examples/license-demo/verify.mjs
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import pkg from "../../src/bindings/wasm/pkg/licensesrv.js";

const { Keyring, verify, abiVersion } = pkg;

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, ".out");
const env = JSON.parse(readFileSync(resolve(OUT, "env.json"), "utf8"));
const { productId, goodToken, expiringToken, expiresAtUnix } = JSON.parse(readFileSync(resolve(OUT, "tokens.json"), "utf8"));

const OK = 0;
const BAD_SIGNATURE = 5;
const EXPIRED = 6;

/** Flip a character inside the signature region so the Ed25519 check fails (BadSignature). */
function tamper(token) {
  const dot = token.indexOf(".");
  const body = token.slice(dot + 1);
  const i = body.length - 6; // within the trailing 64-byte signature
  const c = body[i] === "A" ? "B" : "A";
  return token.slice(0, dot + 1) + body.slice(0, i) + c + body.slice(i + 1);
}

async function main() {
  console.log(`\nLicenseSrv offline-verify demo  (core ABI v${abiVersion()})\n`);

  // 1) Fetch the PUBLIC keyring (JWKS) once — the only network call. A real client caches this.
  const res = await fetch(`${env.baseUrl}/v1/products/${productId}/keyring`, {
    headers: { "x-api-key": env.validateApiKey },
  });
  if (!res.ok) throw new Error(`keyring fetch -> HTTP ${res.status}: ${await res.text()}`);
  const jwks = await res.json();
  const keys = jwks.keys ?? [];
  if (keys.length === 0) throw new Error("keyring is empty — was a signing key provisioned?");

  // 2) Build the trusted keyring: base64url-decode each JWKS `x` into 32 raw Ed25519 bytes.
  const keyring = new Keyring();
  for (const k of keys) {
    const bytes = new Uint8Array(Buffer.from(k.x, "base64url"));
    const code = keyring.add(k.kid, bytes);
    if (code !== 0) throw new Error(`trust key ${k.kid} failed: reason ${code}`);
  }
  console.log(`trusted ${keys.length} public key(s) from the keyring: ${keys.map((k) => k.kid).join(", ")}\n`);

  const now = Math.floor(Date.now() / 1000);
  let failures = 0;
  const check = (label, cond) => {
    console.log(`  ${cond ? "✓" : "✗"} ${label}`);
    if (!cond) failures++;
  };

  // 3) GOOD token — verify offline, gate the feature.
  console.log("① valid license (offline verify):");
  const good = verify(keyring, goodToken, now);
  check(`reason code === OK(0)  [got ${good.code}]`, good.code === OK);
  check(`entitlement 'pro' unlocked  [has('pro')=${good.has("pro")}]`, good.code === OK && good.has("pro"));
  check(`entitlement 'seats' limit === 5  [limit('seats')=${good.limit("seats")}]`, good.limit("seats") === 5);
  if (good.code === OK && good.has("pro")) {
    console.log(`     → Pro features: ENABLED · seat limit: ${good.limit("seats")} · next anchor: ${good.nextAnchor}`);
  }

  // 4) TAMPERED token — the signature check must reject it.
  console.log("\n② tampered license (one byte flipped in the signature):");
  const bad = verify(keyring, tamper(goodToken), now);
  check(`reason code === BadSignature(5)  [got ${bad.code}]`, bad.code === BAD_SIGNATURE);
  check(`feature stays LOCKED  [has('pro')=${bad.has("pro")}]`, !bad.has("pro"));

  // 5) EXPIRED token — expiry is enforced LOCALLY against the supplied clock. The token was valid at
  //    mint; we verify it as if the clock is 1h past its expiry.
  console.log("\n③ expired license (checked 1h past its expiry):");
  const exp = verify(keyring, expiringToken, expiresAtUnix + 3600);
  check(`reason code === Expired(6)  [got ${exp.code}]`, exp.code === EXPIRED);
  check(`feature stays LOCKED  [has('pro')=${exp.has("pro")}]`, !exp.has("pro"));

  console.log(
    failures === 0
      ? "\n✅ Licensing works end to end: the server-issued license verifies offline, and tampered/expired licenses are rejected — all without a network signature check.\n"
      : `\n❌ ${failures} check(s) failed.\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("verify failed:", e.message ?? e);
  process.exit(1);
});
