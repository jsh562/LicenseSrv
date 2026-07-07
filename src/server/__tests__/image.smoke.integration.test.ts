// T022 (OR-008/014): Docker image + compose acceptance smoke. Gated by DOCKER_SMOKE (needs a Docker
// daemon), so the default Testcontainers suite stays fast. Verifies the image builds, runs as non-root,
// bakes in no secret, and that `docker compose up` reaches a healthy API via the gated migration.
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

const RUN = process.env.DOCKER_SMOKE ? describe : describe.skip;
const ROOT = process.cwd();
const IMAGE = "licensesrv-e006-smoke:test";

function docker(args: string[], opts: { timeout?: number } = {}): string {
  return execFileSync("docker", args, { cwd: ROOT, encoding: "utf8", timeout: opts.timeout ?? 600_000 });
}

RUN("container image + compose smoke (DOCKER_SMOKE)", () => {
  beforeAll(() => {
    docker(["build", "-t", IMAGE, "."]);
  }, 900_000);

  afterAll(() => {
    try {
      docker(["image", "rm", "-f", IMAGE]);
    } catch {
      /* best effort */
    }
  });

  it("runs as a non-root user (OR-003)", () => {
    const uid = docker(["run", "--rm", IMAGE, "node", "-e", "process.stdout.write(String(process.getuid()))"]).trim();
    expect(uid).not.toBe("0");
    expect(Number(uid)).toBeGreaterThan(0);
  });

  it("bakes no secret into the image env or history (OR-008)", () => {
    const env = JSON.parse(docker(["image", "inspect", IMAGE, "--format", "{{json .Config.Env}}"])) as string[];
    for (const e of env) {
      expect(e).not.toMatch(/^(API_KEY_SECRET|DATABASE_URL|SIGNING_CUSTODIAN_SHARES)=/);
    }
    const history = docker(["history", "--no-trunc", IMAGE]);
    expect(history).not.toMatch(/api_key_secret|database_url=|custodian/i);
  });

  it("brings up the stack: gated migrate then a healthy API (OR-014/015)", async () => {
    const secretsDir = path.join(ROOT, "secrets");
    mkdirSync(secretsDir, { recursive: true });
    writeFileSync(path.join(secretsDir, "db_password"), "smoke-pw-123");
    writeFileSync(path.join(secretsDir, "database_url"), "postgres://licensesrv:smoke-pw-123@db:5432/licensesrv");
    writeFileSync(path.join(secretsDir, "api_key_secret"), "smoke-api-secret");
    try {
      docker(["compose", "up", "-d", "--build"], { timeout: 900_000 });
      // Poll the mapped API readiness for up to ~120s (db healthy + gated migrate completes + api boot).
      // A 200 proves migrations ran before serving (OR-015) and the DB dependency is up (OR-014).
      let ready = false;
      const deadline = Date.now() + 120_000;
      while (Date.now() < deadline) {
        try {
          const res = await fetch("http://127.0.0.1:8080/internal/health/ready");
          if (res.status === 200) {
            ready = true;
            break;
          }
        } catch {
          /* api not accepting connections yet */
        }
        await new Promise((r) => setTimeout(r, 3000));
      }
      expect(ready).toBe(true);
    } finally {
      try {
        docker(["compose", "down", "-v"], { timeout: 180_000 });
      } finally {
        rmSync(secretsDir, { recursive: true, force: true });
      }
    }
  }, 1_200_000);
});
