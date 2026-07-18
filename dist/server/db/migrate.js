import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { resolveDatabaseUrl } from "../config/index.js";
import { makePool } from "./client.js";
/** Stable 64-bit advisory-lock key for migrations (derived from a constant string). */
const MIGRATION_LOCK_KEY = 0x4c534d4947520001n & 0x7fffffffffffffffn;
/**
 * Apply pending SQL migrations from `dir` as a discrete, advisory-locked step (TR-007).
 * A single runner holds the lock; concurrent runners block then no-op. Each migration
 * applies inside its own transaction so a failure leaves no half-applied schema (TR-015),
 * and the session-level advisory lock auto-releases on crash/session end.
 */
export async function runMigrations(pool, dir) {
    const client = await pool.connect();
    const applied = [];
    try {
        await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_KEY.toString()]);
        // Refuse to migrate against an unsupported server (TR-014).
        const ver = await client.query("SHOW server_version_num");
        const num = Number(ver.rows[0].server_version_num);
        if (!Number.isFinite(num) || num < 160004) {
            throw new Error(`PostgreSQL >= 160004 (16.4) required (TR-014); found ${num || "unknown"}`);
        }
        await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
         name text PRIMARY KEY,
         applied_at timestamptz NOT NULL DEFAULT now()
       )`);
        const files = readdirSync(dir)
            .filter((f) => f.endsWith(".sql"))
            .sort();
        for (const file of files) {
            const done = await client.query("SELECT 1 FROM schema_migrations WHERE name = $1", [file]);
            if ((done.rowCount ?? 0) > 0)
                continue;
            const sql = readFileSync(path.join(dir, file), "utf8");
            await client.query("BEGIN");
            try {
                await client.query(sql);
                await client.query("INSERT INTO schema_migrations(name) VALUES ($1)", [file]);
                await client.query("COMMIT");
                applied.push(file);
            }
            catch (err) {
                await client.query("ROLLBACK").catch(() => undefined);
                throw err;
            }
        }
        return applied;
    }
    finally {
        await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY.toString()]).catch(() => undefined);
        client.release();
    }
}
// CLI entrypoint: the image's "migrate" command (`node dist/server/db/migrate.js`) and `npm run migrate`.
// Uses the shared config contract (DATABASE_URL with <VAR>_FILE support); needs no other setting (OR-011).
const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1].replace(/\\/g, "/")}`;
if (isMain) {
    let url;
    try {
        url = resolveDatabaseUrl(process.env);
    }
    catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
    }
    const pool = makePool(url, 1);
    const dir = path.resolve(process.cwd(), "migrations");
    runMigrations(pool, dir)
        .then((applied) => {
        console.log(applied.length ? `Applied: ${applied.join(", ")}` : "Schema up to date.");
        return pool.end();
    })
        .catch((err) => {
        console.error(err);
        process.exit(1);
    });
}
