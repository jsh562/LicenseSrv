// Billing view tests: renders the connections table, and the admin actions (connect / reconcile /
// rotate / toggle) call the API. `../../../api` is mocked (real types + ApiError kept).
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { BillingConnection } from "../../../api";
import { Billing } from "../Billing";

vi.mock("../../../api", async (orig) => {
  const actual = await orig<typeof import("../../../api")>();
  return {
    ...actual,
    billingApi: {
      listConnections: vi.fn(),
      createConnection: vi.fn(),
      rotateSecret: vi.fn(),
      updateConnection: vi.fn(),
      reconcile: vi.fn(),
    },
  };
});

import { billingApi } from "../../../api";
const api = vi.mocked(billingApi);

const CONN: BillingConnection = {
  id: "c1",
  provider: "stripe",
  status: "active",
  defaultGraceSeconds: 1209600,
  planMap: {},
  secretRotatedAt: null,
} as BillingConnection;

beforeEach(() => {
  vi.clearAllMocks();
  api.listConnections.mockResolvedValue([CONN]);
  api.createConnection.mockResolvedValue(CONN);
  api.rotateSecret.mockResolvedValue(undefined as never);
  api.updateConnection.mockResolvedValue(CONN);
  api.reconcile.mockResolvedValue({ jobId: "job-1" } as never);
});
afterEach(cleanup);

describe("Billing view", () => {
  it("lists connections and connects a provider", async () => {
    render(<Billing sessionRole="owner" />);
    expect(await screen.findByRole("region", { name: "Billing" })).toBeInTheDocument();
    // The row's "Rotate secret" button only renders once a connection is listed.
    expect(await screen.findByRole("button", { name: "Rotate secret" })).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText("Signing secret"), "whsec_x");
    await userEvent.click(screen.getByRole("button", { name: "Connect provider" }));
    await waitFor(() => expect(api.createConnection).toHaveBeenCalled());
  });

  it("reconciles, rotates the secret, and toggles status", async () => {
    vi.spyOn(window, "prompt").mockReturnValue("whsec_new");
    render(<Billing sessionRole="owner" />);
    await screen.findByRole("button", { name: "Rotate secret" });

    await userEvent.click(screen.getByRole("button", { name: "Reconcile now" }));
    await waitFor(() => expect(api.reconcile).toHaveBeenCalled());

    await userEvent.click(screen.getByRole("button", { name: "Rotate secret" }));
    await waitFor(() => expect(api.rotateSecret).toHaveBeenCalledWith("c1", "whsec_new"));

    await userEvent.click(screen.getByRole("button", { name: "Disable" }));
    await waitFor(() => expect(api.updateConnection).toHaveBeenCalledWith("c1", { status: "disabled" }));
  });
});
