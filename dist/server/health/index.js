const timeout = (ms) => new Promise((_resolve, reject) => setTimeout(() => reject(new Error("timeout")), ms).unref());
/** True iff `SELECT 1` succeeds within the timeout — the readiness database check. */
async function checkDatabase(pool, timeoutMs) {
    try {
        await Promise.race([pool.query("SELECT 1"), timeout(timeoutMs)]);
        return true;
    }
    catch {
        return false;
    }
}
/** Register the liveness, readiness, and startup probes under /internal/health/. */
export function registerHealth(app, deps) {
    const dbTimeout = deps.dbTimeoutMs ?? 2000;
    // Liveness — never touches a dependency; a DB outage must not restart the container.
    app.get("/internal/health/live", async () => ({ status: "alive" }));
    // Startup — 200 once the listener is bound; 503 while still starting.
    app.get("/internal/health/startup", async (_req, reply) => {
        const started = deps.started ? deps.started() : true;
        return reply.code(started ? 200 : 503).send({ status: started ? "started" : "starting" });
    });
    // Readiness — DB (+ composed signer) health; gates traffic.
    app.get("/internal/health/ready", async (_req, reply) => {
        const checks = [];
        checks.push({ name: "database", status: (await checkDatabase(deps.pool, dbTimeout)) ? "up" : "down" });
        if (deps.signerReady) {
            checks.push({ name: "signer", status: deps.signerReady() ? "up" : "down" });
        }
        const ready = checks.every((c) => c.status === "up");
        return reply.code(ready ? 200 : 503).send({ status: ready ? "ready" : "not-ready", checks });
    });
}
