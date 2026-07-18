// T021 (OR-008, SC-006): the metric label-allowlist / cardinality-policy unit test. Pure — no DB, no
// listener. Asserts the BINDING policy from {SAD:ADR-0009}: NO metric on the registry carries a
// `tenant_id` / `request_id` / `license_key` label, the RED allowlist is exactly {route, method,
// outcome}, and the RED duration histogram's buckets include the SLO thresholds 0.12s and 0.3s.
import { describe, expect, it } from "vitest";

import {
  FORBIDDEN_LABEL_NAMES,
  RED_DURATION_BUCKETS,
  RED_LABEL_NAMES,
  recordRed,
  recordSeatContention,
  recordSignerCall,
  recordTamper,
  registry,
  setSignerAvailability,
} from "../metrics.js";

/** Exercise every authored instrument so its labels are actually materialised for inspection. */
function populate(): void {
  recordRed({ route: "/v1/activations", method: "POST", outcome: "success", durationMs: 42 });
  recordRed({ route: "/admin/licenses", method: "POST", outcome: "server_error", durationMs: 310 });
  recordSeatContention();
  recordTamper();
  setSignerAvailability(true);
  recordSignerCall({ outcome: "success", durationMs: 5 });
}

describe("metric label allowlist (OR-008, SC-006)", () => {
  it("exposes NO tenant_id / request_id / license_key label on any metric", async () => {
    populate();
    const metrics = await registry.getMetricsAsJSON();
    const forbidden = new Set<string>(FORBIDDEN_LABEL_NAMES);

    const offenders: string[] = [];
    for (const metric of metrics) {
      for (const value of metric.values ?? []) {
        for (const label of Object.keys(value.labels ?? {})) {
          if (forbidden.has(label)) offenders.push(`${metric.name}{${label}}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("labels every RED series with only the bounded allowlist {route, method, outcome}", async () => {
    populate();
    const allowed = new Set<string>(RED_LABEL_NAMES);
    const metrics = await registry.getMetricsAsJSON();
    const red = metrics.filter((m) => m.name === "http_requests_total" || m.name === "http_request_duration_seconds");
    expect(red.length).toBeGreaterThan(0);

    for (const metric of red) {
      for (const value of metric.values ?? []) {
        for (const label of Object.keys(value.labels ?? {})) {
          // Histograms carry the synthetic `le` bucket label in addition to the allowlist.
          if (label === "le") continue;
          expect(allowed.has(label)).toBe(true);
        }
      }
    }
  });

  it("declares the allowlist as exactly route/method/outcome and disjoint from the forbidden set", () => {
    expect([...RED_LABEL_NAMES]).toEqual(["route", "method", "outcome"]);
    for (const forbidden of FORBIDDEN_LABEL_NAMES) {
      expect((RED_LABEL_NAMES as readonly string[]).includes(forbidden)).toBe(false);
    }
  });
});

describe("RED duration buckets (SC-006)", () => {
  it("includes the SLO threshold buckets 0.12s and 0.3s in the declared bucket set", () => {
    expect([...RED_DURATION_BUCKETS]).toContain(0.12);
    expect([...RED_DURATION_BUCKETS]).toContain(0.3);
  });

  it("materialises le=0.12 and le=0.3 bucket series in the histogram exposition", async () => {
    recordRed({ route: "/v1/activations", method: "POST", outcome: "success", durationMs: 42 });
    const text = await registry.metrics();
    expect(text).toContain('http_request_duration_seconds_bucket');
    expect(text).toContain('le="0.12"');
    expect(text).toContain('le="0.3"');
  });
});
