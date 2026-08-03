// Component tests (T028, FR-011/013/014; SC-004/017/019): the Usage metering view renders a license's
// per-entitlement aggregate + over-quota flag against a mocked usageApi; an admin can toggle the true-signed-net
// (raw) read while a viewer cannot (RequireRole hides it); an unknown license surfaces an inline 404 message;
// and the Shell nav reaches the Usage tab. The api module is mocked (real types + ApiError kept).
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { UsageQueryResult } from "../../../api";
import { Shell } from "../../../components/Shell";
import { Usage } from "../Usage";

vi.mock("../../../api", async (orig) => {
  const actual = await orig<typeof import("../../../api")>();
  return {
    ...actual,
    usageApi: { getUsage: vi.fn() },
    adminApi: { logout: vi.fn(), listUsers: vi.fn().mockResolvedValue([]), listApiKeys: vi.fn().mockResolvedValue([]), listAudit: vi.fn().mockResolvedValue({ entries: [], nextCursor: null }) },
  };
});

// eslint-disable-next-line import/first
import { usageApi } from "../../../api";

const api = vi.mocked(usageApi);

const result: UsageQueryResult = {
  licenseId: "lic-1",
  window: { from: "2026-07-26T00:00:00Z", to: "2026-08-02T00:00:00Z", bucket: null },
  raw: false,
  truncated: false,
  entitlements: [
    { entitlementId: "ent-sum", aggregation: "sum", unit: "gb", value: 11000, allowance: 10000, overQuota: true },
    { entitlementId: "ent-count", aggregation: "count", unit: "api-call", value: 42, allowance: null, overQuota: false },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  api.getUsage.mockResolvedValue(result);
});
afterEach(cleanup);

async function loadUsage(): Promise<void> {
  await userEvent.type(screen.getByLabelText("License id"), "lic-1");
  await userEvent.click(screen.getByRole("button", { name: /load usage/i }));
}

describe("Usage (US2)", () => {
  it("loads a license's per-entitlement aggregate with the over-quota flag", async () => {
    render(<Usage sessionRole="admin" />);
    await loadUsage();
    await screen.findByText("ent-sum");
    expect(api.getUsage).toHaveBeenCalledWith("lic-1", expect.objectContaining({ raw: false }));
    const sumRow = screen.getByText("ent-sum").closest("tr")!;
    expect(within(sumRow).getByText("11000")).toBeInTheDocument();
    expect(within(sumRow).getByText("over quota")).toBeInTheDocument();
    expect(screen.getByText("ent-count")).toBeInTheDocument();
  });

  it("lets an admin toggle the true signed net (raw=true)", async () => {
    render(<Usage sessionRole="admin" />);
    await loadUsage();
    await screen.findByText("ent-sum");
    api.getUsage.mockResolvedValueOnce({ ...result, raw: true, entitlements: [{ entitlementId: "ent-sum", aggregation: "sum", unit: "gb", value: -200, allowance: 10000, overQuota: false }] });
    await userEvent.click(screen.getByLabelText("Show true signed net"));
    await waitFor(() => expect(api.getUsage).toHaveBeenLastCalledWith("lic-1", expect.objectContaining({ raw: true })));
    expect(await screen.findByText("-200")).toBeInTheDocument();
  });

  it("hides the true-signed-net toggle from a viewer", async () => {
    render(<Usage sessionRole="viewer" />);
    await loadUsage();
    await screen.findByText("ent-sum");
    expect(screen.queryByLabelText("Show true signed net")).toBeNull();
  });

  it("surfaces an inline 404 message for an unknown license", async () => {
    const { ApiError } = await vi.importActual<typeof import("../../../api")>("../../../api");
    api.getUsage.mockRejectedValue(new ApiError(404, "not_found", "no"));
    render(<Usage sessionRole="admin" />);
    await loadUsage();
    expect(await screen.findByRole("alert")).toHaveTextContent(/no such license/i);
  });

  it("shows an empty-window notice when there is no usage", async () => {
    api.getUsage.mockResolvedValue({ ...result, entitlements: [] });
    render(<Usage sessionRole="admin" />);
    await loadUsage();
    expect(await screen.findByText(/no usage in this window/i)).toBeInTheDocument();
  });
});

describe("Shell nav → Usage (FR-011)", () => {
  it("reaches the Usage metering view from the shell nav", async () => {
    render(<Shell who={{ userId: "u1", tenantId: "t1", role: "admin" }} onSignedOut={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "Usage" }));
    expect(await screen.findByRole("region", { name: "Usage" })).toBeInTheDocument();
    expect(screen.getByLabelText("License id")).toBeInTheDocument();
  });
});
