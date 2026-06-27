import { readFileSync } from "node:fs";
import path from "node:path";

import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

import { authorize } from "../auth/rbac.js";
import { hashEquals, hmacKey, saltedHash } from "../db/hash.js";

describe("hashing (TR-012)", () => {
  it("hmacKey is deterministic and keyed by the secret", () => {
    expect(hmacKey("raw", "s1")).toBe(hmacKey("raw", "s1"));
    expect(hmacKey("raw", "s1")).not.toBe(hmacKey("raw", "s2"));
    expect(hmacKey("raw", "s1")).not.toBe("raw");
  });

  it("saltedHash differs by salt and never returns plaintext", () => {
    expect(saltedHash("a@b.com", "salt1")).not.toBe(saltedHash("a@b.com", "salt2"));
    expect(saltedHash("a@b.com", "salt1")).not.toContain("a@b.com");
  });

  it("hashEquals is a length-aware constant-time compare", () => {
    expect(hashEquals("abc", "abc")).toBe(true);
    expect(hashEquals("abc", "abd")).toBe(false);
    expect(hashEquals("abc", "abcd")).toBe(false);
  });
});

describe("rbac fail-closed (TR-013/TR-016)", () => {
  const policy = { minRole: "admin", requiredScope: "admin" } as const;

  it("allows only when role AND scope both satisfy", () => {
    expect(authorize({ role: "owner", scopes: ["admin"] }, policy).allowed).toBe(true);
    expect(authorize({ role: "admin", scopes: ["admin"] }, policy).allowed).toBe(true);
  });

  it("denies on insufficient role", () => {
    const d = authorize({ role: "viewer", scopes: ["admin"] }, policy);
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe("insufficient-role");
  });

  it("denies on insufficient scope (even with a high role)", () => {
    const d = authorize({ role: "owner", scopes: ["validate"] }, policy);
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe("insufficient-scope");
  });
});

describe("module-boundary enforcement (TR-010)", () => {
  it("the eslint config declares the cross-module import restriction", () => {
    const cfg = readFileSync(path.resolve(process.cwd(), "eslint.config.js"), "utf8");
    expect(cfg).toContain("no-restricted-imports");
    expect(cfg).toMatch(/modules\/\*\/internal/);
  });

  it("eslint actually blocks a cross-module internal import (build-failing)", async () => {
    const eslint = new ESLint();
    const results = await eslint.lintText(
      `import { x } from "../modules/catalog/internal/secret.js";\nexport const y = x;\n`,
      { filePath: path.resolve(process.cwd(), "src/server/probe.ts") },
    );
    const ruleIds = results.flatMap((r) => r.messages.map((m) => m.ruleId));
    expect(ruleIds).toContain("no-restricted-imports");
  });
});

