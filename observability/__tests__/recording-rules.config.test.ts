// T023 (OR-010 / OR-019, SC-004 gate): validate the operator config artifacts for OBJ2 — the Prometheus
// recording rules and the Grafana SLO dashboard.
//
// (a) If `promtool` is on PATH (it is in CI, NOT locally), run `promtool check rules` and assert exit 0.
//     `it.skipIf(!promtoolAvailable)` skips it where promtool is absent.
// (b) ALWAYS run a dependency-light STRUCTURAL check (no yaml dep — string/regex over the file; native
//     JSON.parse for the dashboard): the recording-rules YAML exists, is non-empty, and declares the
//     expected `record:` names; the dashboard JSON parses and has a non-empty `panels` array including
//     the validate "pending E013" panel.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/** Resolve an artifact path relative to this test file (observability/__tests__/). */
const artifact = (rel: string): string => fileURLToPath(new URL(`../${rel}`, import.meta.url));

const RULES_PATH = artifact("prometheus/recording-rules.yml");
const DASHBOARD_PATH = artifact("grafana/dashboards/slo-overview.json");

/** The active (uncommented) recording-rule names the dashboards + alerts depend on. */
const EXPECTED_ACTIVE_RECORDS = [
  "job:request_availability:ratio_rate30d",
  "job:request_availability:ratio_rate5m",
  "job:activation_success:ratio_rate30d",
  "job:issuance_latency:p95_5m",
  "job:issuance_latency:p99_5m",
];

/** The validate-latency record names that MUST be present but PENDING (commented) until E013. */
const PENDING_VALIDATE_RECORD = "job:validate_latency:p95_5m";

/** Detect promtool once at load: available iff `promtool --version` runs without throwing. */
const promtoolAvailable = ((): boolean => {
  try {
    execFileSync("promtool", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

describe("recording rules (OR-010/019)", () => {
  it.skipIf(!promtoolAvailable)("passes `promtool check rules` (exit 0)", () => {
    // execFileSync throws on a non-zero exit, so a successful call IS the assertion.
    execFileSync("promtool", ["check", "rules", RULES_PATH], { stdio: "pipe" });
  });

  it("exists, is non-empty, and is a valid recording-rule group structure", () => {
    const yaml = readFileSync(RULES_PATH, "utf8");
    expect(yaml.trim().length).toBeGreaterThan(0);
    expect(yaml).toMatch(/^groups:/m);
    // Recording-rule groups use `record:` entries (recording rules, not alerting `alert:` rules).
    expect(yaml).toMatch(/^\s*-\s*record:/m);
  });

  it("declares every active SLI recording-rule name", () => {
    const yaml = readFileSync(RULES_PATH, "utf8");
    for (const name of EXPECTED_ACTIVE_RECORDS) {
      // An ACTIVE rule line: `- record: <name>` with no leading `#` comment marker on that line.
      const active = new RegExp(`^\\s*-\\s*record:\\s*${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "m");
      expect(active.test(yaml)).toBe(true);
    }
  });

  it("includes the validate-latency SLI as PENDING E013 (present but commented out)", () => {
    const yaml = readFileSync(RULES_PATH, "utf8");
    // The pending record name is present in the file...
    expect(yaml).toContain(PENDING_VALIDATE_RECORD);
    // ...but only on commented lines (every occurrence's line begins with `#`).
    for (const line of yaml.split(/\r?\n/)) {
      if (line.includes(PENDING_VALIDATE_RECORD)) {
        expect(line.trimStart().startsWith("#")).toBe(true);
      }
    }
    expect(yaml.toLowerCase()).toContain("pending e013");
  });
});

describe("Grafana SLO dashboard (OR-009/019)", () => {
  it("parses as JSON and has a non-empty panels array", () => {
    const dashboard = JSON.parse(readFileSync(DASHBOARD_PATH, "utf8")) as { panels?: unknown };
    expect(Array.isArray(dashboard.panels)).toBe(true);
    expect((dashboard.panels as unknown[]).length).toBeGreaterThan(0);
  });

  it("includes SLI panels for availability, activation success and issuance p95", () => {
    const dashboard = JSON.parse(readFileSync(DASHBOARD_PATH, "utf8")) as { panels: Array<Record<string, unknown>> };
    const exprs = dashboard.panels.flatMap((p) =>
      Array.isArray(p.targets) ? (p.targets as Array<{ expr?: string }>).map((t) => t.expr ?? "") : [],
    );
    const joined = exprs.join("\n");
    expect(joined).toContain("job:request_availability:ratio_rate30d");
    expect(joined).toContain("job:activation_success:ratio_rate30d");
    expect(joined).toContain("job:issuance_latency:p95_5m");
  });

  it("includes a validate-latency panel clearly marked pending E013", () => {
    const dashboard = JSON.parse(readFileSync(DASHBOARD_PATH, "utf8")) as { panels: Array<Record<string, unknown>> };
    const pending = dashboard.panels.find((p) => {
      const title = typeof p.title === "string" ? p.title.toLowerCase() : "";
      const content =
        p.options && typeof (p.options as { content?: unknown }).content === "string"
          ? ((p.options as { content: string }).content).toLowerCase()
          : "";
      return (title.includes("pending") && title.includes("e013")) || content.includes("pending e013");
    });
    expect(pending).toBeDefined();
  });
});
