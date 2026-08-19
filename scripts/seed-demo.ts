// Dev-only demo seeder. Ensures tenant `acme` + an owner admin exist (idempotent — reuses them if
// seed-dev already ran), then mints TWO runtime API keys: one `admin`-scope (needed to provision a
// product signing key over the /v1 plane) and one `validate`-scope (used to read the public keyring).
// Writes examples/license-demo/.out/env.json so issue-demo.mjs / verify.mjs pick everything up without
// fragile stdout parsing. Reuses the same helpers + hashing the running server uses.
//
//   DATABASE_URL='postgres://licensesrv:<pw>@localhost:15432/licensesrv' \
//   API_KEY_SECRET="$(cat secrets/api_key_secret)" \
//   npx tsx scripts/seed-demo.ts
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { makePool, privileged, withTenant } from "../src/server/db/client.js";
import { hmacKey } from "../src/server/db/hash.js";
import { provisionTenant, createApiKey } from "../src/server/db/repository.js";
import { hashPassword } from "../src/server/modules/admin/password.js";

const DATABASE_URL = process.env.DATABASE_URL;
const API_KEY_SECRET = process.env.API_KEY_SECRET;
if (!DATABASE_URL) throw new Error("DATABASE_URL is required");
if (!API_KEY_SECRET) throw new Error("API_KEY_SECRET is required");

const BASE_URL = process.env.BASE_URL ?? "http://localhost:8080";
const TENANT_SLUG = "acme";
const ADMIN_EMAIL = "admin@acme.test";
const ADMIN_PASSWORD = "password123!";
const OUT_DIR = resolve(process.cwd(), "examples", "license-demo", ".out");

function newRawKey(): string {
  return `lsk_${randomBytes(24).toString("hex")}`;
}

async function main(): Promise<void> {
  const pool = makePool(DATABASE_URL!, 4);
  try {
    // 1) Ensure the tenant exists (reuse if seed-dev created it).
    const existing = await privileged(pool, async (q) => {
      const r = await q("SELECT id FROM tenant WHERE slug = $1 AND deleted_at IS NULL", [TENANT_SLUG]);
      return r.rowCount ? (r.rows[0] as { id: string }).id : null;
    });
    let tenantId = existing;
    if (!tenantId) {
      tenantId = randomUUID();
      await provisionTenant(pool, { id: tenantId, slug: TENANT_SLUG, name: "Acme" });
    }

    // 2) Ensure the owner admin exists (email_hash + scrypt password + owner role).
    const emailHash = hmacKey(ADMIN_EMAIL.trim().toLowerCase(), API_KEY_SECRET!);
    const userId = await withTenant(pool, tenantId, async (q) => {
      const found = await q("SELECT id FROM app_user WHERE email_hash = $1", [emailHash]);
      if (found.rowCount) return (found.rows[0] as { id: string }).id;
      const id = randomUUID();
      await q(
        `INSERT INTO app_user (id, tenant_id, email_hash, password_hash, status)
         VALUES ($1, current_setting('app.current_tenant')::uuid, $2, $3, 'active')`,
        [id, emailHash, hashPassword(ADMIN_PASSWORD)],
      );
      await q(
        `INSERT INTO role (id, tenant_id, user_id, role)
         VALUES ($1, current_setting('app.current_tenant')::uuid, $2, 'owner')`,
        [randomUUID(), id],
      );
      return id;
    });

    // 3) Mint an admin-scope key (provision signing keys) and a validate-scope key (read keyring).
    const adminApiKey = newRawKey();
    const validateApiKey = newRawKey();
    await createApiKey(
      pool,
      tenantId,
      { id: randomUUID(), keyHash: hmacKey(adminApiKey, API_KEY_SECRET!), scopes: ["admin"], createdBy: userId },
      "seed-demo",
    );
    await createApiKey(
      pool,
      tenantId,
      { id: randomUUID(), keyHash: hmacKey(validateApiKey, API_KEY_SECRET!), scopes: ["validate"], createdBy: userId },
      "seed-demo",
    );

    // 4) Persist demo config for the follow-on scripts.
    mkdirSync(OUT_DIR, { recursive: true });
    const env = {
      baseUrl: BASE_URL,
      tenantSlug: TENANT_SLUG,
      adminEmail: ADMIN_EMAIL,
      adminPassword: ADMIN_PASSWORD,
      adminApiKey,
      validateApiKey,
    };
    writeFileSync(resolve(OUT_DIR, "env.json"), JSON.stringify(env, null, 2), { mode: 0o600 });

    // eslint-disable-next-line no-console
    console.log(
      [
        "",
        "✓ Demo seed ready.",
        `  tenant slug     : ${TENANT_SLUG}`,
        `  admin login     : ${ADMIN_EMAIL} / ${ADMIN_PASSWORD} (owner)`,
        `  admin API key   : ${adminApiKey}   (scope: admin — provisions signing keys)`,
        `  validate API key: ${validateApiKey}   (scope: validate — reads keyring)`,
        `  wrote           : ${resolve(OUT_DIR, "env.json")}`,
        "",
        "Next: node examples/license-demo/issue-demo.mjs",
        "",
      ].join("\n"),
    );
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error("seed-demo failed:", e);
  process.exit(1);
});
