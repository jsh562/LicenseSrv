// T043 (OR-015 / OR-016, SC-008 gate): validate the OBJ5 operator artifacts — the multi-window
// burn-rate SLO alert rules (observability/prometheus/alert-rules.yml), the metrics-unavailability
// dead-man's switch, and the Alertmanager routing/escalation config (observability/alertmanager/config.yml).
//
// (a) If `promtool` is on PATH (CI, NOT locally), run `promtool check rules` (syntactic validity) AND
//     `promtool test rules` against alert-rules.burn-rate.test.yml — proving a SUSTAINED fast+slow burn
//     fires the SEV1 page while a BRIEF sub-threshold blip does NOT (SC-008). `it.skipIf(!promtool)`.
// (b) If `amtool` is on PATH (CI, NOT locally), run `amtool check-config` on the Alertmanager config.
//     `it.skipIf(!amtool)`.
// (c) ALWAYS run dependency-light STRUCTURAL checks (no yaml dep — string/regex over the files): the
//     burn-rate alerts exist for all three SLOs with SEV1/SEV2/SEV3 labels; the up==0 dead-man's switch
//     exists; the Alertmanager config has route + receivers and the 10m/30m escalation cadences.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/** Resolve an artifact path relative to this test file (observability/__tests__/). */
const artifact = (rel: string): string => fileURLToPath(new URL(`../${rel}`, import.meta.url));

const RULES_PATH = artifact("prometheus/alert-rules.yml");
const BURN_RATE_TEST_PATH = artifact("prometheus/alert-rules.burn-rate.test.yml");
const AM_CONFIG_PATH = artifact("alertmanager/config.yml");
const PROM_DIR = fileURLToPath(new URL("../prometheus/", import.meta.url));

/** The burn-rate page (SEV1) alerts that MUST exist for each SLO (the fast-burn page tier). */
const FAST_BURN_ALERTS = [
  "AvailabilityErrorBudgetBurnFast",
  "ActivationErrorBudgetBurnFast",
  "IssuanceLatencyErrorBudgetBurnFast",
];
/** The slow-burn (SEV2) alerts for each SLO. */
const SLOW_BURN_ALERTS = [
  "AvailabilityErrorBudgetBurnSlow",
  "ActivationErrorBudgetBurnSlow",
  "IssuanceLatencyErrorBudgetBurnSlow",
];
/** The ticket-tier (SEV3, no page) alerts for each SLO. */
const TICKET_BURN_ALERTS = [
  "AvailabilityErrorBudgetBurnTicket",
  "ActivationErrorBudgetBurnTicket",
  "IssuanceLatencyErrorBudgetBurnTicket",
];
/** The metrics-unavailability dead-man's-switch alerts (OR-014). */
const METRICS_DEADMAN_ALERTS = ["MetricsTargetDown", "MetricsTargetAbsent"];

/** Detect a CLI tool once at load: available iff `<tool> --version` runs without throwing. */
function toolAvailable(tool: string): boolean {
  try {
    execFileSync(tool, ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const promtoolAvailable = toolAvailable("promtool");
const amtoolAvailable = toolAvailable("amtool");

/**
 * Extract the block of lines belonging to a named alert: from its `- alert: <name>` line up to (but not
 * including) the next `- alert:` line or end of file. Lets us assert per-alert labels without a YAML parser.
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

describe("burn-rate alert rules — promtool (OR-015 / SC-008, CI only)", () => {
  it.skipIf(!promtoolAvailable)("passes `promtool check rules` (exit 0)", () => {
    // execFileSync throws on a non-zero exit, so a successful call IS the assertion.
    execFileSync("promtool", ["check", "rules", RULES_PATH], { stdio: "pipe" });
  });

  it.skipIf(!promtoolAvailable)(
    "passes `promtool test rules` — sustained burn pages, brief blip does not (SC-008)",
    () => {
      execFileSync("promtool", ["test", "rules", BURN_RATE_TEST_PATH], { stdio: "pipe", cwd: PROM_DIR });
    },
  );
});

describe("Alertmanager config — amtool (OR-016, CI only)", () => {
  it.skipIf(!amtoolAvailable)("passes `amtool check-config` (exit 0)", () => {
    execFileSync("amtool", ["check-config", AM_CONFIG_PATH], { stdio: "pipe" });
  });
});

describe("burn-rate alert rules — structural check (OR-015, always runs)", () => {
  it("exists, is non-empty, and is an alerting-rule group structure", () => {
    const yaml = readFileSync(RULES_PATH, "utf8");
    expect(yaml.trim().length).toBeGreaterThan(0);
    expect(yaml).toMatch(/^groups:/m);
    expect(yaml).toMatch(/^\s*-\s*alert:/m);
  });

  it("declares fast-burn PAGE alerts (SEV1, page) for availability, activation and issuance", () => {
    const yaml = readFileSync(RULES_PATH, "utf8");
    for (const name of FAST_BURN_ALERTS) {
      const block = alertBlock(yaml, name);
      expect(block.length).toBeGreaterThan(0);
      expect(block).toMatch(/severity:\s*SEV1/);
      expect(block).toMatch(/page:\s*"true"/);
      expect(block).toMatch(/burn_rate:\s*fast/);
      // Both windows of the fast tier present: the long 1h window AND the short 5m window. The 5m short
      // window is either a literal `[5m]` range (issuance) or the recording-rule 5m SLI series
      // (availability/activation reference `...ratio_rate5m`).
      expect(block).toContain("[1h]");
      expect(block).toMatch(/\[5m\]|ratio_rate5m/);
      // Two-window shape: the tier fires only when BOTH windows breach (the `and`).
      expect(block).toMatch(/\band\b/);
    }
  });

  it("declares slow-burn PAGE alerts (SEV2, page) with the 6h+30m windows", () => {
    const yaml = readFileSync(RULES_PATH, "utf8");
    for (const name of SLOW_BURN_ALERTS) {
      const block = alertBlock(yaml, name);
      expect(block.length).toBeGreaterThan(0);
      expect(block).toMatch(/severity:\s*SEV2/);
      expect(block).toMatch(/page:\s*"true"/);
      expect(block).toContain("[6h]");
      expect(block).toContain("[30m]");
      expect(block).toMatch(/\band\b/);
    }
  });

  it("declares ticket-tier alerts (SEV3, NO page) with the 3d+6h windows", () => {
    const yaml = readFileSync(RULES_PATH, "utf8");
    for (const name of TICKET_BURN_ALERTS) {
      const block = alertBlock(yaml, name);
      expect(block.length).toBeGreaterThan(0);
      expect(block).toMatch(/severity:\s*SEV3/);
      expect(block).toMatch(/page:\s*"false"/);
      expect(block).toContain("[3d]");
      expect(block).toContain("[6h]");
    }
  });

  it("references the recording-rule SLI series for the short-window availability/activation tiers", () => {
    const yaml = readFileSync(RULES_PATH, "utf8");
    expect(yaml).toContain("job:request_availability:ratio_rate5m");
    expect(yaml).toContain("job:activation_success:ratio_rate5m");
  });

  it("declares the metrics-unavailability dead-man's switch (up == 0) — OR-014", () => {
    const yaml = readFileSync(RULES_PATH, "utf8");
    const down = alertBlock(yaml, "MetricsTargetDown");
    expect(down.length).toBeGreaterThan(0);
    expect(down).toMatch(/up\{job="license-api"\}\s*==\s*0/);
    expect(down).toMatch(/severity:\s*SEV2/);
    // At least one dead-man alert references the scrape-target liveness (up), not an SLO burn.
    const joined = METRICS_DEADMAN_ALERTS.map((n) => alertBlock(yaml, n)).join("\n");
    expect(joined).toMatch(/\bup\{job="license-api"\}/);
  });

  it("provides the burn-rate promtool test fixture (used in CI) loading both rule files", () => {
    const test = readFileSync(BURN_RATE_TEST_PATH, "utf8");
    expect(test).toMatch(/rule_files:/);
    expect(test).toContain("recording-rules.yml");
    expect(test).toContain("alert-rules.yml");
    expect(test).toContain("AvailabilityErrorBudgetBurnFast");
    // The fixture must assert BOTH the firing (sustained) and non-firing (blip) cases (SC-008).
    expect(test).toMatch(/exp_alerts:\s*\[\]/); // the blip case: no page fires
  });
});

describe("Alertmanager routing config — structural check (OR-016, always runs)", () => {
  it("exists, is non-empty, and has a top-level route + receivers", () => {
    const yaml = readFileSync(AM_CONFIG_PATH, "utf8");
    expect(yaml.trim().length).toBeGreaterThan(0);
    expect(yaml).toMatch(/^route:/m);
    expect(yaml).toMatch(/^receivers:/m);
    // Child routes carry the severity-based routing.
    expect(yaml).toMatch(/^\s*routes:/m);
  });

  it("routes SEV1 and SEV2 to on-call receivers", () => {
    const yaml = readFileSync(AM_CONFIG_PATH, "utf8");
    expect(yaml).toMatch(/severity\s*=\s*"SEV1"/);
    expect(yaml).toMatch(/severity\s*=\s*"SEV2"/);
    // The referenced receivers are actually declared.
    expect(yaml).toMatch(/name:\s*oncall-sev1/);
    expect(yaml).toMatch(/name:\s*oncall-sev2/);
    expect(yaml).toMatch(/receiver:\s*oncall-sev1/);
    expect(yaml).toMatch(/receiver:\s*oncall-sev2/);
  });

  it("encodes the escalation cadence (SEV1 ~10 min, SEV2 ~30 min) via repeat_interval", () => {
    const yaml = readFileSync(AM_CONFIG_PATH, "utf8");
    expect(yaml).toMatch(/repeat_interval:\s*10m/);
    expect(yaml).toMatch(/repeat_interval:\s*30m/);
    // SEV1 pages immediately (no batching delay on the first page).
    expect(yaml).toMatch(/group_wait:\s*0s/);
  });

  it("uses cloud-agnostic receivers (webhook + email) with no HARD proprietary-SaaS dependency", () => {
    const yaml = readFileSync(AM_CONFIG_PATH, "utf8");
    expect(yaml).toMatch(/webhook_configs:/);
    expect(yaml).toMatch(/email_configs:/);
    // Slack/PagerDuty may appear ONLY as commented optional receivers — never as an active config line.
    for (const line of yaml.split(/\r?\n/)) {
      const trimmed = line.trimStart();
      if (/slack_configs:|pagerduty_configs:|opsgenie_configs:/.test(trimmed)) {
        expect(trimmed.startsWith("#")).toBe(true);
      }
    }
  });
});
