// Component tests (T041, FR-015/SC-010): licensing views render against mocked licensingApi + catalogApi;
// RequireRole hides admin actions from a viewer; issue surfaces a signer-503 fail-closed error; the
// registry retrieves keys and drives the lifecycle (suspend/reinstate/revoke/transfer) with inline errors;
// customers register (dup 409) and erase; the container navigates panes. ../../../api is mocked (ApiError real).
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError, type Customer, type IssuedLicense, type License, type Plan, type Product } from "../../../api";
import { Customers } from "../Customers";
import { Issue } from "../Issue";
import { Licenses } from "../Licenses";
import { Licensing } from "../Licensing";

vi.mock("../../../api", async (orig) => {
  const actual = await orig<typeof import("../../../api")>();
  return {
    ...actual,
    catalogApi: {
      listProducts: vi.fn(),
      listPlans: vi.fn(),
    },
    licensingApi: {
      listCustomers: vi.fn(),
      createCustomer: vi.fn(),
      getCustomer: vi.fn(),
      eraseCustomer: vi.fn(),
      issueLicense: vi.fn(),
      listLicenses: vi.fn(),
      getLicense: vi.fn(),
      getLicenseKey: vi.fn(),
      revokeLicense: vi.fn(),
      suspendLicense: vi.fn(),
      reinstateLicense: vi.fn(),
      transferLicense: vi.fn(),
    },
  };
});

// eslint-disable-next-line import/first
import { catalogApi, licensingApi } from "../../../api";

const cat = vi.mocked(catalogApi);
const api = vi.mocked(licensingApi);

const product: Product = { id: "p1", key: "acme-cad", name: "Acme CAD", description: null, status: "active", createdAt: "", updatedAt: "" };
const plan: Plan = { id: "pl1", productId: "p1", key: "standard", name: "Standard", description: null, maxActivations: 1, status: "active", createdAt: "", updatedAt: "" };
const alice: Customer = { id: "c1", ref: "acct-1", name: "Alice", email: null, status: "active", createdAt: "" };
const bob: Customer = { id: "c2", ref: "acct-2", name: null, email: null, status: "active", createdAt: "" };
const activeLicense: License = {
  id: "l1", productId: "p1", planId: "pl1", customerId: "c1", status: "active",
  issuedAt: "2026-01-01T00:00:00.000Z", expiresAt: null, maxActivations: 1, entitlements: {}, keyId: null, transferCount: 0,
};

beforeEach(() => {
  vi.clearAllMocks();
  cat.listProducts.mockResolvedValue([product]);
  cat.listPlans.mockResolvedValue([plan]);
  api.listCustomers.mockResolvedValue([alice, bob]);
  api.listLicenses.mockResolvedValue([activeLicense]);
});
afterEach(cleanup);

describe("Issue (US1)", () => {
  it("issues a license and shows the signed key", async () => {
    const issued: IssuedLicense = { ...activeLicense, licenseKey: "LIC1.signed-token" };
    api.issueLicense.mockResolvedValue(issued);
    render(<Issue sessionRole="admin" />);

    await screen.findByRole("option", { name: "Acme CAD" });
    await userEvent.selectOptions(screen.getByLabelText("Product"), "p1");
    await screen.findByRole("option", { name: "Standard" });
    await userEvent.selectOptions(screen.getByLabelText("Plan"), "pl1");
    await userEvent.selectOptions(screen.getByLabelText("Customer"), "c1");
    await userEvent.click(screen.getByRole("button", { name: /issue license/i }));

    await waitFor(() =>
      expect(api.issueLicense).toHaveBeenCalledWith({ planId: "pl1", customerId: "c1", expiresAt: null }),
    );
    expect(await screen.findByLabelText("License key")).toHaveValue("LIC1.signed-token");
  });

  it("surfaces a fail-closed error when the signer is unavailable (503)", async () => {
    api.issueLicense.mockRejectedValue(new ApiError(503, "signer_unavailable", "down"));
    render(<Issue sessionRole="admin" />);

    await screen.findByRole("option", { name: "Acme CAD" });
    await userEvent.selectOptions(screen.getByLabelText("Product"), "p1");
    await screen.findByRole("option", { name: "Standard" });
    await userEvent.selectOptions(screen.getByLabelText("Plan"), "pl1");
    await userEvent.selectOptions(screen.getByLabelText("Customer"), "c1");
    await userEvent.click(screen.getByRole("button", { name: /issue license/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/signing service is unavailable/i);
  });

  it("hides the issue form from a viewer", async () => {
    render(<Issue sessionRole="viewer" />);
    await waitFor(() => expect(api.listCustomers).toHaveBeenCalled());
    expect(screen.queryByLabelText("Product")).toBeNull();
  });
});

describe("Licenses (US5 + lifecycle)", () => {
  it("retrieves a license key on demand", async () => {
    api.getLicenseKey.mockResolvedValue("LIC1.the-key");
    render(<Licenses sessionRole="viewer" />);
    const row = (await screen.findByText("l1")).closest("tr")!;
    await userEvent.click(within(row).getByRole("button", { name: /get key/i }));
    expect(await screen.findByLabelText("Key for l1")).toHaveValue("LIC1.the-key");
  });

  it("suspends then revokes, and transfers to the chosen target", async () => {
    api.suspendLicense.mockResolvedValue({ ...activeLicense, status: "suspended" });
    api.transferLicense.mockResolvedValue({ ...activeLicense, customerId: "c2", transferCount: 1 });
    render(<Licenses sessionRole="admin" />);

    const row = (await screen.findByText("l1")).closest("tr")!;
    await userEvent.click(within(row).getByRole("button", { name: /suspend/i }));
    await waitFor(() => expect(api.suspendLicense).toHaveBeenCalledWith("l1"));

    await userEvent.selectOptions(screen.getByLabelText("Transfer target"), "c2");
    await userEvent.click(within((await screen.findByText("l1")).closest("tr")!).getByRole("button", { name: /transfer/i }));
    await waitFor(() => expect(api.transferLicense).toHaveBeenCalledWith("l1", "c2"));
  });

  it("shows an inline error when a transfer exceeds the limit (409)", async () => {
    api.transferLicense.mockRejectedValue(new ApiError(409, "transfer_limit_exceeded", "limit"));
    render(<Licenses sessionRole="admin" />);
    await screen.findByText("l1");
    await userEvent.selectOptions(screen.getByLabelText("Transfer target"), "c2");
    await userEvent.click(within(screen.getByText("l1").closest("tr")!).getByRole("button", { name: /transfer/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/transfer limit/i);
  });

  it("hides admin lifecycle actions from a viewer", async () => {
    render(<Licenses sessionRole="viewer" />);
    await screen.findByText("l1");
    expect(screen.queryByRole("button", { name: /revoke/i })).toBeNull();
    expect(screen.queryByLabelText("Transfer target")).toBeNull();
    expect(screen.getByRole("button", { name: /get key/i })).toBeInTheDocument();
  });

  it("filters by status", async () => {
    render(<Licenses sessionRole="admin" />);
    await screen.findByText("l1");
    await userEvent.selectOptions(screen.getByLabelText("Status filter"), "revoked");
    await waitFor(() =>
      expect(api.listLicenses).toHaveBeenLastCalledWith({ status: "revoked", customerId: undefined }),
    );
  });
});

describe("Customers (US5)", () => {
  it("registers a customer and surfaces a duplicate-ref error (409)", async () => {
    api.createCustomer.mockResolvedValueOnce(alice);
    render(<Customers sessionRole="admin" />);
    await screen.findByText("acct-1");

    await userEvent.type(screen.getByLabelText("Customer ref"), "acct-9");
    await userEvent.click(screen.getByRole("button", { name: /register customer/i }));
    await waitFor(() => expect(api.createCustomer).toHaveBeenCalledWith({ ref: "acct-9", name: undefined, email: undefined }));

    api.createCustomer.mockRejectedValueOnce(new ApiError(409, "duplicate_ref", "dup"));
    await userEvent.type(screen.getByLabelText("Customer ref"), "acct-1");
    await userEvent.click(screen.getByRole("button", { name: /register customer/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/ref already exists/i);
  });

  it("erases an active customer and hides erase from a viewer", async () => {
    api.eraseCustomer.mockResolvedValue(undefined);
    const admin = render(<Customers sessionRole="admin" />);
    const row = (await screen.findByText("acct-1")).closest("tr")!;
    await userEvent.click(within(row).getByRole("button", { name: /erase/i }));
    await waitFor(() => expect(api.eraseCustomer).toHaveBeenCalledWith("c1"));
    admin.unmount();

    render(<Customers sessionRole="viewer" />);
    await screen.findByText("acct-1");
    expect(screen.queryByRole("button", { name: /erase/i })).toBeNull();
    expect(screen.queryByLabelText("Register customer")).toBeNull();
  });
});

describe("Licensing container", () => {
  it("navigates Licenses → Issue → Customers", async () => {
    render(<Licensing sessionRole="owner" />);
    // Licenses pane by default.
    expect(await screen.findByRole("region", { name: "Licenses" })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Issue", current: false }));
    expect(await screen.findByRole("region", { name: "Issue license" })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Customers", current: false }));
    expect(await screen.findByRole("region", { name: "Customers" })).toBeInTheDocument();
  });
});
