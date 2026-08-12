// Component tests (E017 T055; FR-001/002/011/013/016). The Policy Rules view authors a guarded rule against a
// mocked policyApi (surfacing the distinct author-time 400 codes inline), lists the tenant's rules, promotes a
// rule's status (surfacing a 409 invalid_state_transition), inspects a rule's immutable version history, and
// dry-runs a rule against a license (rendering the would-be decision + fired rule). Admin-only actions are hidden
// from a viewer by RequireRole, and the Shell nav reaches the Policy tab. The api module is mocked (real types +
// ApiError kept).
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DryRunResult, PolicyRuleDetail, PolicyRuleList } from "../../../api";
import { Shell } from "../../../components/Shell";
import { PolicyRules } from "../PolicyRules";

vi.mock("../../../api", async (orig) => {
  const actual = await orig<typeof import("../../../api")>();
  return {
    ...actual,
    policyApi: {
      listRules: vi.fn(),
      getRule: vi.fn(),
      createRule: vi.fn(),
      editRule: vi.fn(),
      setStatus: vi.fn(),
      dryRun: vi.fn(),
    },
    adminApi: {
      logout: vi.fn(),
      listUsers: vi.fn().mockResolvedValue([]),
      listApiKeys: vi.fn().mockResolvedValue([]),
      listAudit: vi.fn().mockResolvedValue({ entries: [], nextCursor: null }),
    },
  };
});

// eslint-disable-next-line import/first
import { policyApi } from "../../../api";

const api = vi.mocked(policyApi);

const list: PolicyRuleList = {
  truncated: false,
  rules: [
    {
      ruleKey: "rule-1",
      latestVersion: 2,
      targetEntitlementId: "ent-1",
      description: null,
      priority: 100,
      status: "preview",
      effectKind: "adjust_limit",
      updatedAt: "2026-08-12T00:00:00Z",
    },
  ],
};

const detail: PolicyRuleDetail = {
  ruleKey: "rule-1",
  latestVersion: 2,
  status: "preview",
  versions: [
    { ruleKey: "rule-1", version: 2, targetEntitlementId: "ent-1", description: null, priority: 100, status: "preview", condition: { "==": [1, 1] }, effect: { kind: "adjust_limit", value: 50000 }, author: "u1", createdAt: "2026-08-12T00:00:00Z" },
    { ruleKey: "rule-1", version: 1, targetEntitlementId: "ent-1", description: null, priority: 100, status: "disabled", condition: { "==": [1, 1] }, effect: { kind: "adjust_limit", value: 40000 }, author: "u1", createdAt: "2026-08-11T00:00:00Z" },
  ],
};

const dryRun: DryRunResult = {
  mode: "dry_run",
  decisionTimestamp: "2026-08-12T00:00:00Z",
  decision: { targetEntitlementId: "ent-1", target: "api_calls", effectKind: "adjust_limit", baseValue: 10000, resolvedValue: 50000, authoredMaximum: 50000, clamped: false, source: "rule" },
  firedRule: { ruleKey: "rule-1", version: 2 },
  consideredNotApplied: [{ ruleKey: "rule-2", version: 1, reason: "lower_priority" }],
};

beforeEach(() => {
  vi.clearAllMocks();
  api.listRules.mockResolvedValue(list);
  api.getRule.mockResolvedValue(detail);
  api.setStatus.mockResolvedValue({ ...list.rules[0]!, status: "active" });
  api.dryRun.mockResolvedValue(dryRun);
  api.createRule.mockResolvedValue(detail.versions[0]!);
});
afterEach(cleanup);

describe("PolicyRules (US1/US5)", () => {
  it("lists the tenant's rules with status + effect kind", async () => {
    render(<PolicyRules sessionRole="admin" />);
    await screen.findByText("rule-1");
    const row = screen.getByText("rule-1").closest("tr")!;
    expect(within(row).getByText("adjust_limit")).toBeInTheDocument();
    expect(within(row).getByText("preview")).toBeInTheDocument();
  });

  it("authors a rule and surfaces a distinct author-time 400 code inline", async () => {
    const { ApiError } = await vi.importActual<typeof import("../../../api")>("../../../api");
    api.createRule.mockRejectedValueOnce(new ApiError(400, "unsafe_operator", "nope"));
    render(<PolicyRules sessionRole="admin" />);
    await screen.findByText("rule-1");
    await userEvent.type(screen.getByLabelText("Target entitlement id"), "ent-1");
    await userEvent.click(screen.getByRole("button", { name: /validate & save rule/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/disallowed \/ host-access operator/i);
  });

  it("rejects invalid JSON in the condition before calling the API", async () => {
    render(<PolicyRules sessionRole="admin" />);
    await screen.findByText("rule-1");
    await userEvent.type(screen.getByLabelText("Target entitlement id"), "ent-1");
    const cond = screen.getByLabelText("Condition JSON");
    await userEvent.clear(cond);
    await userEvent.type(cond, "not json");
    await userEvent.click(screen.getByRole("button", { name: /validate & save rule/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/condition is not valid json/i);
    expect(api.createRule).not.toHaveBeenCalled();
  });

  it("promotes a rule's status and surfaces a 409 invalid_state_transition", async () => {
    const { ApiError } = await vi.importActual<typeof import("../../../api")>("../../../api");
    render(<PolicyRules sessionRole="admin" />);
    await screen.findByText("rule-1");
    await userEvent.click(screen.getByLabelText("Activate rule-1"));
    await waitFor(() => expect(api.setStatus).toHaveBeenCalledWith("rule-1", "active"));

    api.setStatus.mockRejectedValueOnce(new ApiError(409, "invalid_state_transition", "no"));
    await userEvent.click(screen.getByLabelText("Disable rule-1"));
    expect(await screen.findByRole("alert")).toHaveTextContent(/invalid lifecycle transition/i);
  });

  it("shows a rule's immutable version history", async () => {
    render(<PolicyRules sessionRole="admin" />);
    await screen.findByText("rule-1");
    await userEvent.click(screen.getByRole("button", { name: "History" }));
    const history = await screen.findByRole("region", { name: "Version history" });
    expect(within(history).getAllByText("u1")).toHaveLength(2); // both immutable versions, same author
    // Both immutable versions (2 and 1) are listed.
    expect(within(history).getAllByRole("row")).toHaveLength(3); // header + 2 versions
  });

  it("dry-runs a rule against a license and renders the would-be decision", async () => {
    render(<PolicyRules sessionRole="admin" />);
    await screen.findByText("rule-1");
    await userEvent.type(screen.getByLabelText("Dry-run rule key"), "rule-1");
    await userEvent.type(screen.getByLabelText("Dry-run license id"), "lic-1");
    await userEvent.click(screen.getByRole("button", { name: "Simulate" }));
    const result = await screen.findByRole("region", { name: "Dry-run result" });
    expect(within(result).getByText(/10000 → 50000/)).toBeInTheDocument();
    expect(within(result).getByText(/Fired rule rule-1 v2/)).toBeInTheDocument();
    expect(api.dryRun).toHaveBeenCalledWith("rule-1", { licenseId: "lic-1" });
  });

  it("hides author + status + dry-run controls from a viewer", async () => {
    render(<PolicyRules sessionRole="viewer" />);
    await screen.findByText("rule-1");
    expect(screen.queryByLabelText("Author policy rule")).toBeNull();
    expect(screen.queryByLabelText("Activate rule-1")).toBeNull();
    expect(screen.queryByLabelText("Dry-run policy rule")).toBeNull();
    // A viewer can still read history.
    expect(screen.getByRole("button", { name: "History" })).toBeInTheDocument();
  });
});

describe("Shell nav → Policy (FR-001)", () => {
  it("reaches the Policy Rules view from the shell nav", async () => {
    render(<Shell who={{ userId: "u1", tenantId: "t1", role: "admin" }} onSignedOut={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "Policy" }));
    expect(await screen.findByRole("region", { name: "Policy Rules" })).toBeInTheDocument();
  });
});
