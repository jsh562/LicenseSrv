// Component tests (T035, FR-012/SC-009): the Activations registry view renders a license's machines + seat
// summary against a mocked activationApi; an admin can reclaim an active seat; a viewer cannot (RequireRole
// hides the action); the back control navigates. Also covers the Licenses → Activations drill-down. The api
// module is mocked (real types kept).
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Activation, License } from "../../../api";
import { Activations } from "../Activations";
import { Licenses } from "../Licenses";

vi.mock("../../../api", async (orig) => {
  const actual = await orig<typeof import("../../../api")>();
  return {
    ...actual,
    activationApi: { listActivations: vi.fn(), reclaim: vi.fn() },
    licensingApi: {
      listLicenses: vi.fn(),
      listCustomers: vi.fn(),
      getLicenseKey: vi.fn(),
      revokeLicense: vi.fn(),
      suspendLicense: vi.fn(),
      reinstateLicense: vi.fn(),
      transferLicense: vi.fn(),
    },
  };
});

// eslint-disable-next-line import/first
import { activationApi, licensingApi } from "../../../api";

const api = vi.mocked(activationApi);
const lic = vi.mocked(licensingApi);

const license: License = { id: "lic-1", productId: "p", planId: "pl", customerId: "c", status: "active", issuedAt: "", expiresAt: null, maxActivations: 5, entitlements: {}, keyId: null, transferCount: 0 };
const active: Activation = { id: "act-1", machineId: "m-abc", status: "active", activatedAt: "2026-01-01T00:00:00Z", deactivatedAt: null, label: null };
const dead: Activation = { id: "act-2", machineId: "m-xyz", status: "deactivated", activatedAt: "2026-01-01T00:00:00Z", deactivatedAt: "2026-02-01T00:00:00Z", label: "old-laptop" };

beforeEach(() => {
  vi.clearAllMocks();
  api.listActivations.mockResolvedValue({ activations: [active, dead], seatsUsed: 1, seatLimit: 5 });
  lic.listLicenses.mockResolvedValue([license]);
  lic.listCustomers.mockResolvedValue([]);
});
afterEach(cleanup);

describe("Activations (US4)", () => {
  it("lists machines with the seats-used/limit summary", async () => {
    render(<Activations license={license} sessionRole="admin" onBack={vi.fn()} />);
    await screen.findByText("m-abc");
    expect(screen.getByText("Seats used 1 / 5")).toBeInTheDocument();
    expect(screen.getByText("m-xyz")).toBeInTheDocument();
    expect(screen.getByText("old-laptop")).toBeInTheDocument();
  });

  it("lets an admin reclaim an active seat", async () => {
    api.reclaim.mockResolvedValue({ id: "act-1", status: "deactivated" });
    render(<Activations license={license} sessionRole="admin" onBack={vi.fn()} />);
    const row = (await screen.findByText("m-abc")).closest("tr")!;
    await userEvent.click(within(row).getByRole("button", { name: /reclaim seat/i }));
    await waitFor(() => expect(api.reclaim).toHaveBeenCalledWith("lic-1", "act-1"));
  });

  it("surfaces an inline error when a reclaim fails", async () => {
    const { ApiError } = await vi.importActual<typeof import("../../../api")>("../../../api");
    api.reclaim.mockRejectedValue(new ApiError(403, "forbidden", "no"));
    render(<Activations license={license} sessionRole="admin" onBack={vi.fn()} />);
    const row = (await screen.findByText("m-abc")).closest("tr")!;
    await userEvent.click(within(row).getByRole("button", { name: /reclaim seat/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/could not reclaim/i);
  });

  it("hides reclaim from a viewer", async () => {
    render(<Activations license={license} sessionRole="viewer" onBack={vi.fn()} />);
    await screen.findByText("m-abc");
    expect(screen.queryByRole("button", { name: /reclaim seat/i })).toBeNull();
  });

  it("navigates back to the licenses list", async () => {
    const onBack = vi.fn();
    render(<Activations license={license} sessionRole="admin" onBack={onBack} />);
    await screen.findByText("m-abc");
    await userEvent.click(screen.getByRole("button", { name: /licenses/i }));
    expect(onBack).toHaveBeenCalled();
  });
});

describe("Licenses → Activations drill-down (US4)", () => {
  it("opens a license's activations from the registry and returns", async () => {
    render(<Licenses sessionRole="admin" />);
    const row = (await screen.findByText("lic-1")).closest("tr")!;
    await userEvent.click(within(row).getByRole("button", { name: "Activations" }));
    expect(await screen.findByRole("region", { name: "Activations" })).toBeInTheDocument();
    expect(await screen.findByText("Seats used 1 / 5")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /← Licenses/ }));
    expect(await screen.findByRole("region", { name: "Licenses" })).toBeInTheDocument();
  });
});
