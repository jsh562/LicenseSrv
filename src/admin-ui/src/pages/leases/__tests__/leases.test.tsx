// Component tests (T036, FR-015/016; SC-010): the Concurrency/Leases registry view renders a license's leases
// + used-vs-cap summary against a mocked leaseApi; an admin can force-release a live lease; a viewer cannot
// (RequireRole hides the action); an unknown license surfaces an inline 404 message. Also covers the Shell nav
// reaching the Leases tab. The api module is mocked (real types kept).
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { LeaseRegistry } from "../../../api";
import { Shell } from "../../../components/Shell";
import { Leases } from "../Leases";

vi.mock("../../../api", async (orig) => {
  const actual = await orig<typeof import("../../../api")>();
  return {
    ...actual,
    leaseApi: { listLeases: vi.fn(), forceRelease: vi.fn() },
    adminApi: { logout: vi.fn(), listUsers: vi.fn().mockResolvedValue([]), listApiKeys: vi.fn().mockResolvedValue([]), listAudit: vi.fn().mockResolvedValue({ entries: [], nextCursor: null }) },
  };
});

// eslint-disable-next-line import/first
import { leaseApi } from "../../../api";

const api = vi.mocked(leaseApi);

const registry: LeaseRegistry = {
  concurrencyUsed: 2,
  maxConcurrent: 5,
  overageAllowance: 0,
  scope: "session",
  truncated: false,
  leases: [
    { id: "lease-1", holderKey: "Zk9Xp2QrL0", scope: "session", status: "live", acquiredAt: "2026-07-01T09:00:00Z", lastRenewedAt: "2026-07-01T09:10:00Z", expiresAt: "2026-07-01T09:40:00Z" },
    { id: "lease-2", holderKey: "Ql8Wo1PqK9", scope: "session", status: "reclaimed", acquiredAt: "2026-07-01T06:00:00Z", lastRenewedAt: "2026-07-01T06:10:00Z", expiresAt: "2026-07-01T06:40:00Z" },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  api.listLeases.mockResolvedValue(registry);
});
afterEach(cleanup);

async function loadRegistry(): Promise<void> {
  await userEvent.type(screen.getByLabelText("License id"), "lic-1");
  await userEvent.click(screen.getByRole("button", { name: /load leases/i }));
}

describe("Leases (US5)", () => {
  it("loads a license's leases with the used-vs-cap summary and pseudonymous holder keys", async () => {
    render(<Leases sessionRole="admin" />);
    await loadRegistry();
    await screen.findByText("Zk9Xp2QrL0");
    expect(api.listLeases).toHaveBeenCalledWith("lic-1");
    expect(screen.getByText(/Concurrency used 2 \/ 5/)).toBeInTheDocument();
    expect(screen.getByText("Ql8Wo1PqK9")).toBeInTheDocument();
  });

  it("lets an admin force-release a live lease and refreshes", async () => {
    api.forceRelease.mockResolvedValue({ id: "lease-1", status: "reclaimed" });
    render(<Leases sessionRole="admin" />);
    await loadRegistry();
    const row = (await screen.findByText("Zk9Xp2QrL0")).closest("tr")!;
    await userEvent.click(within(row).getByRole("button", { name: /force-release/i }));
    await waitFor(() => expect(api.forceRelease).toHaveBeenCalledWith("lease-1"));
    expect(api.listLeases).toHaveBeenCalledTimes(2); // reloaded after the mutation
  });

  it("does NOT show force-release for an already-ended lease", async () => {
    render(<Leases sessionRole="admin" />);
    await loadRegistry();
    const reclaimedRow = (await screen.findByText("Ql8Wo1PqK9")).closest("tr")!;
    expect(within(reclaimedRow).queryByRole("button", { name: /force-release/i })).toBeNull();
  });

  it("hides force-release from a viewer", async () => {
    render(<Leases sessionRole="viewer" />);
    await loadRegistry();
    await screen.findByText("Zk9Xp2QrL0");
    expect(screen.queryByRole("button", { name: /force-release/i })).toBeNull();
  });

  it("surfaces an inline 404 message for an unknown license", async () => {
    const { ApiError } = await vi.importActual<typeof import("../../../api")>("../../../api");
    api.listLeases.mockRejectedValue(new ApiError(404, "not_found", "no"));
    render(<Leases sessionRole="admin" />);
    await loadRegistry();
    expect(await screen.findByRole("alert")).toHaveTextContent(/no such license/i);
  });

  it("surfaces an error when force-release fails", async () => {
    const { ApiError } = await vi.importActual<typeof import("../../../api")>("../../../api");
    api.forceRelease.mockRejectedValue(new ApiError(403, "forbidden", "no"));
    render(<Leases sessionRole="admin" />);
    await loadRegistry();
    const row = (await screen.findByText("Zk9Xp2QrL0")).closest("tr")!;
    await userEvent.click(within(row).getByRole("button", { name: /force-release/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/could not force-release/i);
  });
});

describe("Shell nav → Leases (FR-015)", () => {
  it("reaches the Concurrency/Leases view from the shell nav", async () => {
    render(<Shell who={{ userId: "u1", tenantId: "t1", role: "admin" }} onSignedOut={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "Leases" }));
    expect(await screen.findByRole("region", { name: "Leases" })).toBeInTheDocument();
    expect(screen.getByLabelText("License id")).toBeInTheDocument();
  });
});
