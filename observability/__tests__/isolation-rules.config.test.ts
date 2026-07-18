// T032 (OR-012) [COMPLETES OR-012]: validate the tenant-isolation alerting artifact
// (observability/prometheus/alert-rules.yml) and its promtool unit tests.
//
// (a) If `promtool` is on PATH (CI, NOT locally), run `promtool check rules` (syntactic validity) AND
//     `promtool test rules` against alert-rules.test.yml (asserts the isolation page fires on a synthetic
//     violation series and the dead-man's switch fires on a canary-down series). `it.skipIf(!promtool)`
//     skips these where promtool is absent.
// (b) ALWAYS run a dependency-light STRUCTURAL check (no yaml dep — string/regex over the file): the
//     alert-rules.yml exists; declares the isolation-page alert with NO `for:` window and severity SEV1;
//     and declares the canary dead-man's-switch alert(s) at a LOWER severity (SEV2, not the page).
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/** Resolve an artifact path relative to this test file (observability/__tests__/). */
const artifact = (rel: string): string => fileURLToPath(new URL(`../${rel}`, import.meta.url));

const RULES_PATH = artifact("prometheus/alert-rules.yml");
const RULES_TEST_PATH = artifact("prometheus/alert-rules.test.yml");

const ISOLATION_PAGE_ALERT = "TenantIsolationViolation";
const CANARY_DEADMAN_ALERTS = ["TenantIsolationCanaryDown", "TenantIsolationCanaryAbsent"];

/** Detect promtool once at load: available iff `promtool --version` runs without throwing. */
const promtoolAvailable = ((): boolean => {
  try {
    execFileSync("promtool", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

/**
 * Extract the block of lines belonging to a named alert: from its `- alert: <name>` line up to (but not
 * including) the next `- alert:` line or end of file. Lets us assert per-alert properties (e.g. that the
 * isolation page has no `for:`) without a YAML parser.
 */
function alertBlock(yaml: string, alertName: string): string {
  const lines = yaml.split(/\r?\n/);
  const start = lines.findIndex((l) => new RegExp(`^\\s*-\\s*alert:\\s*${alertName}\\s*$`).test(l));
  if (start < 0) return "";
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s*-\s*alert:\s*/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

describe("tenant-isolation alert rules — promtool (OR-012, CI only)", () => {
  it.skipIf(!promtoolAvailable)("passes `promtool check rules` (exit 0)", () => {
    // execFileSync throws on a non-zero exit, so a successful call IS the assertion.
    execFileSync("promtool", ["check", "rules", RULES_PATH], { stdio: "pipe" });
  });

  it.skipIf(!promtoolAvailable)("passes `promtool test rules` — page fires on a synthetic violation series", () => {
    execFileSync("promtool", ["test", "rules", RULES_TEST_PATH], { stdio: "pipe", cwd: fileURLToPath(new URL("../prometheus/", import.meta.url)) });
  });
});

describe("tenant-isolation alert rules — structural check (OR-012, always runs)", () => {
  it("exists, is non-empty, and is an alerting-rule group structure", () => {
    const yaml = readFileSync(RULES_PATH, "utf8");
    expect(yaml.trim().length).toBeGreaterThan(0);
    expect(yaml).toMatch(/^groups:/m);
    expect(yaml).toMatch(/^\s*-\s*alert:/m); // alerting rules (not `record:`)
  });

  it("declares the isolation-page alert on tenant_isolation_violation_total with SEV1 and NO `for:` window", () => {
    const yaml = readFileSync(RULES_PATH, "utf8");
    const block = alertBlock(yaml, ISOLATION_PAGE_ALERT);
    expect(block.length).toBeGreaterThan(0);
    // Fires on the isolation-violation counter.
    expect(block).toContain("tenant_isolation_violation_total");
    // SEV1 page — the hard-invariant severity (OR-016).
    expect(block).toMatch(/severity:\s*SEV1/);
    // "Immediate": NO burn-rate/`for:` window on the isolation page (OR-012) — fires on first evaluation.
    expect(block).not.toMatch(/^\s*for:\s*/m);
  });

  it("declares a canary dead-man's-switch alert at a LOWER severity (SEV2), distinct from the page", () => {
    const yaml = readFileSync(RULES_PATH, "utf8");
    const present = CANARY_DEADMAN_ALERTS.filter((name) => alertBlock(yaml, name).length > 0);
    expect(present.length).toBeGreaterThan(0); // at least one dead-man's-switch alert exists

    for (const name of present) {
      const block = alertBlock(yaml, name);
      expect(block).toMatch(/severity:\s*SEV2/); // operational, NOT the SEV1 isolation page
      expect(block).not.toMatch(/severity:\s*SEV1/);
    }
    // The dead-man references the canary liveness signal, not the breach counter.
    const joined = present.map((n) => alertBlock(yaml, n)).join("\n");
    expect(joined).toMatch(/canary_up|canary_last_success_timestamp_seconds/);
  });

  it("provides a promtool test file asserting the page fires (used in CI)", () => {
    const test = readFileSync(RULES_TEST_PATH, "utf8");
    expect(test).toMatch(/rule_files:/);
    expect(test).toContain("alert-rules.yml");
    expect(test).toContain(ISOLATION_PAGE_ALERT);
    expect(test).toContain("tenant_isolation_violation_total");
  });
});
