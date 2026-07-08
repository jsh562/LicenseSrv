// Component tests (T036, FR-015/SC-010): catalog views render against a mocked catalogApi; RequireRole
// hides admin actions from a viewer; a type-mismatched value surfaces an inline error; the Products →
// Plans → PlanValues drill-down navigates. ../../../api is mocked (ApiError kept real for instanceof).
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError, type Entitlement, type Plan, type PlanEntitlementValue, type Product } from "../../../api";
import { Catalog } from "../Catalog";
import { Entitlements } from "../Entitlements";
import { PlanValues } from "../PlanValues";
import { Plans } from "../Plans";
import { Products } from "../Products";

vi.mock("../../../api", async (orig) => {
  const actual = await orig<typeof import("../../../api")>();
  return {
    ...actual,
    catalogApi: {
      listProducts: vi.fn(),
      createProduct: vi.fn(),
      archiveProduct: vi.fn(),
      listPlans: vi.fn(),
      createPlan: vi.fn(),
      archivePlan: vi.fn(),
      listEntitlements: vi.fn(),
      createEntitlement: vi.fn(),
      archiveEntitlement: vi.fn(),
      listPlanEntitlements: vi.fn(),
      setPlanValue: vi.fn(),
      removePlanValue: vi.fn(),
    },
  };
});

// eslint-disable-next-line import/first
import { catalogApi } from "../../../api";

const api = vi.mocked(catalogApi);

const product: Product = { id: "p1", key: "acme-cad", name: "Acme CAD", description: null, status: "active", createdAt: "", updatedAt: "" };
const plan: Plan = { id: "pl1", productId: "p1", key: "standard", name: "Standard", description: null, maxActivations: 1, status: "active", createdAt: "", updatedAt: "" };
const boolEnt: Entitlement = { id: "e1", key: "export-pdf", name: "Export PDF", type: "boolean", description: null, status: "active", createdAt: "", updatedAt: "" };
const intEnt: Entitlement = { id: "e2", key: "max-projects", name: "Max Projects", type: "integer_limit", description: null, status: "active", createdAt: "", updatedAt: "" };

beforeEach(() => {
  vi.clearAllMocks();
  api.listProducts.mockResolvedValue([product]);
  api.listPlans.mockResolvedValue([plan]);
  api.listEntitlements.mockResolvedValue([boolEnt, intEnt]);
  api.listPlanEntitlements.mockResolvedValue([]);
});
afterEach(cleanup);

describe("Products (US1)", () => {
  it("lists products and lets an admin create one", async () => {
    api.createProduct.mockResolvedValue(product);
    render(<Products sessionRole="admin" onOpen={vi.fn()} />);
    await screen.findByText("acme-cad");
    await userEvent.type(screen.getByLabelText("Product key"), "widget");
    await userEvent.type(screen.getByLabelText("Product name"), "Widget");
    await userEvent.click(screen.getByRole("button", { name: /add product/i }));
    await waitFor(() => expect(api.createProduct).toHaveBeenCalledWith({ key: "widget", name: "Widget" }));
  });

  it("hides create/archive from a viewer", async () => {
    render(<Products sessionRole="viewer" onOpen={vi.fn()} />);
    await screen.findByText("acme-cad");
    expect(screen.queryByLabelText("Create product")).toBeNull();
    expect(screen.queryByRole("button", { name: /archive/i })).toBeNull();
  });

  it("surfaces a duplicate-key error (409)", async () => {
    api.createProduct.mockRejectedValue(new ApiError(409, "duplicate_key", "dup"));
    render(<Products sessionRole="admin" onOpen={vi.fn()} />);
    await screen.findByText("acme-cad");
    await userEvent.type(screen.getByLabelText("Product key"), "acme-cad");
    await userEvent.type(screen.getByLabelText("Product name"), "Dup");
    await userEvent.click(screen.getByRole("button", { name: /add product/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/key already exists/i);
  });
});

describe("Entitlements (US3)", () => {
  it("creates an integer-limit entitlement", async () => {
    api.createEntitlement.mockResolvedValue(intEnt);
    render(<Entitlements sessionRole="admin" />);
    await screen.findByText("export-pdf");
    await userEvent.type(screen.getByLabelText("Entitlement key"), "seats");
    await userEvent.type(screen.getByLabelText("Entitlement name"), "Seats");
    await userEvent.selectOptions(screen.getByLabelText("Entitlement type"), "integer_limit");
    await userEvent.click(screen.getByRole("button", { name: /add entitlement/i }));
    await waitFor(() =>
      expect(api.createEntitlement).toHaveBeenCalledWith({ key: "seats", name: "Seats", type: "integer_limit" }),
    );
  });
});

describe("PlanValues (US4)", () => {
  it("shows an inline error when a value doesn't match the entitlement type (400)", async () => {
    api.setPlanValue.mockRejectedValue(new ApiError(400, "validation_error", "bad"));
    render(<PlanValues plan={plan} sessionRole="admin" onBack={vi.fn()} />);
    await screen.findByLabelText("Set entitlement value");
    await userEvent.selectOptions(screen.getByLabelText("Entitlement"), "e2"); // integer_limit
    await userEvent.type(screen.getByLabelText("Limit value"), "not-a-number");
    await userEvent.click(screen.getByRole("button", { name: /set value/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/doesn't match/i);
  });

  it("sets a boolean value", async () => {
    const val: PlanEntitlementValue = { entitlementId: "e1", key: "export-pdf", type: "boolean", value: true };
    api.setPlanValue.mockResolvedValue(val);
    render(<PlanValues plan={plan} sessionRole="admin" onBack={vi.fn()} />);
    await screen.findByLabelText("Set entitlement value");
    await userEvent.selectOptions(screen.getByLabelText("Entitlement"), "e1"); // boolean
    await userEvent.click(screen.getByRole("button", { name: /set value/i }));
    await waitFor(() => expect(api.setPlanValue).toHaveBeenCalledWith("pl1", "e1", true));
  });
});

describe("Catalog container", () => {
  it("drills Products → Plans → PlanValues and switches to the Entitlements pane", async () => {
    render(<Catalog sessionRole="owner" />);
    // Products pane by default.
    const productRow = (await screen.findByText("acme-cad")).closest("tr")!;
    await userEvent.click(within(productRow).getByRole("button", { name: "Plans" }));

    // Plans view for the product.
    const planRow = (await screen.findByText("standard")).closest("tr")!;
    await userEvent.click(within(planRow).getByRole("button", { name: "Entitlements" }));

    // PlanValues view.
    expect(await screen.findByRole("region", { name: "Plan entitlements" })).toBeInTheDocument();

    // Switch to the Entitlements pane via the catalog nav.
    await userEvent.click(screen.getByRole("button", { name: "Entitlements", current: false }));
    expect(await screen.findByRole("region", { name: "Entitlements" })).toBeInTheDocument();
  });
});

describe("catalog admin actions (archive / remove / plans)", () => {
  it("archives a product, an entitlement, and removes a plan value", async () => {
    api.archiveProduct.mockResolvedValue(product);
    api.archiveEntitlement.mockResolvedValue(boolEnt);
    api.listPlanEntitlements.mockResolvedValue([{ entitlementId: "e1", key: "export-pdf", type: "boolean", value: true } as PlanEntitlementValue]);
    api.removePlanValue.mockResolvedValue(undefined);

    const { unmount } = render(<Products sessionRole="admin" onOpen={vi.fn()} />);
    const prodRow = (await screen.findByText("acme-cad")).closest("tr")!;
    await userEvent.click(within(prodRow).getByRole("button", { name: /archive/i }));
    await waitFor(() => expect(api.archiveProduct).toHaveBeenCalledWith("p1"));
    unmount();

    const ents = render(<Entitlements sessionRole="admin" />);
    const entRow = (await screen.findByText("export-pdf")).closest("tr")!;
    await userEvent.click(within(entRow).getByRole("button", { name: /archive/i }));
    await waitFor(() => expect(api.archiveEntitlement).toHaveBeenCalledWith("e1"));
    ents.unmount();

    render(<PlanValues plan={plan} sessionRole="admin" onBack={vi.fn()} />);
    const valRow = (await screen.findByText("export-pdf")).closest("tr")!;
    await userEvent.click(within(valRow).getByRole("button", { name: /remove/i }));
    await waitFor(() => expect(api.removePlanValue).toHaveBeenCalledWith("pl1", "e1"));
  });

  it("creates and archives a plan, and navigates back", async () => {
    api.createPlan.mockResolvedValue(plan);
    api.archivePlan.mockResolvedValue(plan);
    const onBack = vi.fn();
    render(<Plans product={product} sessionRole="admin" onOpen={vi.fn()} onBack={onBack} />);
    await screen.findByText("standard");

    await userEvent.type(screen.getByLabelText("Plan key"), "pro");
    await userEvent.type(screen.getByLabelText("Plan name"), "Pro");
    await userEvent.clear(screen.getByLabelText("Seat limit"));
    await userEvent.type(screen.getByLabelText("Seat limit"), "5");
    await userEvent.click(screen.getByRole("button", { name: /add plan/i }));
    await waitFor(() => expect(api.createPlan).toHaveBeenCalledWith("p1", { key: "pro", name: "Pro", maxActivations: 5 }));

    const planRow = screen.getByText("standard").closest("tr")!;
    await userEvent.click(within(planRow).getByRole("button", { name: /archive/i }));
    await waitFor(() => expect(api.archivePlan).toHaveBeenCalledWith("pl1"));

    await userEvent.click(screen.getByRole("button", { name: /products/i }));
    expect(onBack).toHaveBeenCalled();
  });
});
