// Dev-only seeder — creates ONE tenant + an owner admin (password login) + a runtime API key,
// reusing the same helpers and hashing the running server uses. NOT for production (weak demo
// password, inserts an owner directly). Run:
//
//   DATABASE_URL='postgres://licensesrv:<pw>@localhost:5432/licensesrv' \
//   API_KEY_SECRET="$(cat secrets/api_key_secret)" \
//   npx tsx scripts/seed-dev.ts
//
// The DATABASE_URL owner role + API_KEY_SECRET MUST match what the API server runs with, or the
// seeded email/api-key hashes won't line up with login()/resolveApiKey().
import { randomBytes, randomUUID } from "node:crypto";

import { makePool, privileged, withTenant } from "../src/server/db/client.js";
import { hmacKey } from "../src/server/db/hash.js";
import { provisionTenant, createApiKey } from "../src/server/db/repository.js";
import { hashPassword } from "../src/server/modules/admin/password.js";

const DATABASE_URL = process.env.DATABASE_URL;
const API_KEY_SECRET = process.env.API_KEY_SECRET;
if (!DATABASE_URL) throw new Error("DATABASE_URL is required");
if (!API_KEY_SECRET) throw new Error("API_KEY_SECRET is required");

// Demo identities (dev only).
const TENANT_SLUG = "acme";
const TENANT_NAME = "Acme";
const ADMIN_EMAIL = "admin@acme.test";
const ADMIN_PASSWORD = "password123!";

async function main(): Promise<void> {
  const pool = makePool(DATABASE_URL!, 4);
  try {
    const tenantId = randomUUID();
    const userId = randomUUID();
    const roleId = randomUUID();
    const apiKeyId = randomUUID();
    const rawApiKey = `lsk_${randomBytes(24).toString("hex")}`;

    // 1) Tenant (privileged, audited cross-tenant provisioning).
    await provisionTenant(pool, { id: tenantId, slug: TENANT_SLUG, name: TENANT_NAME });

    // 2) Owner admin — createUser() omits password_hash/role, so insert directly under the tenant scope.
    //    Columns per migrations 0000_init.sql + 0005_admin_sessions.sql; email_hash + password_hash
    //    computed exactly as login() expects (email lowercased + hmacKey; scrypt password hash).
    const emailHash = hmacKey(ADMIN_EMAIL.trim().toLowerCase(), API_KEY_SECRET!);
    const passwordHash = hashPassword(ADMIN_PASSWORD);
    await withTenant(pool, tenantId, async (q) => {
      await q(
        `INSERT INTO app_user (id, tenant_id, email_hash, password_hash, status)
         VALUES ($1, current_setting('app.current_tenant')::uuid, $2, $3, 'active')`,
        [userId, emailHash, passwordHash],
      );
      await q(
        `INSERT INTO role (id, tenant_id, user_id, role)
         VALUES ($1, current_setting('app.current_tenant')::uuid, $2, 'owner')`,
        [roleId, userId],
      );
    });

    // 3) Runtime API key (validate scope) — only the HMAC is stored; the raw key is shown once.
    await createApiKey(
      pool,
      tenantId,
      { id: apiKeyId, keyHash: hmacKey(rawApiKey, API_KEY_SECRET!), scopes: ["validate"], createdBy: userId },
      "seed-dev",
    );

    // eslint-disable-next-line no-console
    console.log(
      [
        "",
        "✓ Seeded dev tenant.",
        `  tenant slug : ${TENANT_SLUG}`,
        `  tenant id   : ${tenantId}`,
        `  admin email : ${ADMIN_EMAIL}`,
        `  admin pass  : ${ADMIN_PASSWORD}   (owner role)`,
        `  API key     : ${rawApiKey}   (scope: validate — shown once)`,
        "",
        "Log in:",
        `  curl -sS -c cookies.txt -X POST localhost:8080/admin/auth/login \\`,
        `    -H 'content-type: application/json' \\`,
        `    -d '{"tenantSlug":"${TENANT_SLUG}","email":"${ADMIN_EMAIL}","password":"${ADMIN_PASSWORD}"}'`,
        "",
      ].join("\n"),
    );
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error("seed-dev failed:", e);
  process.exit(1);
});
