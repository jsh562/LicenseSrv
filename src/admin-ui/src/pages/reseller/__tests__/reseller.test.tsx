// Component tests (E018 T050; FR-001..FR-017). The reseller console fronts the four surfaces across the three
// admin planes against a mocked resellerApi: OPERATOR reseller management (onboard + lifecycle, surfacing the
// distinct 409 codes inline), RESELLER sub-tenant management (list + provision under the hard quota, surfacing
// 409 quota_exceeded), the per-field BRANDING editor (reseller defaults + locks; a sub-tenant override of a
// provider-locked field refused 409 field_locked), and domain / email VERIFICATION (initiate -> verify ->
// activate; 409 not_verified / binding_conflict). Admin-only actions are hidden from a viewer by RequireRole, and
// the Shell nav reaches the Reseller tab. The api module is mocked (real types + ApiError kept).
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  DomainBinding,
  ResellerBranding,
  ResellerList,
  SubTenantList,
} from "../../../api";
import { Shell } from "../../../components/Shell";
import { Branding } from "../Branding";
import { Domains } from "../Domains";
import { Resellers } from "../Resellers";
import { SubTenants } from "../SubTenants";

vi.mock("../../../api", async (orig) => {
  const actual = await orig<typeof import("../../../api")>();
  return {
    ...actual,
    resellerApi: {
      listResellers: vi.fn(),
      getReseller: vi.fn(),
      onboardReseller: vi.fn(),
      updateQuota: vi.fn(),
      suspendReseller: vi.fn(),
      reinstateReseller: vi.fn(),
      offboardReseller: vi.fn(),
      moveSubTenant: vi.fn(),
      listSubTenants: vi.fn(),
      getSubTenant: vi.fn(),
      provisionSubTenant: vi.fn(),
      getResellerBranding: vi.fn(),
      setResellerBranding: vi.fn(),
      listDomains: vi.fn(),
      getDomain: vi.fn(),
      initiateDomain: vi.fn(),
      verifyDomain: vi.fn(),
      activateDomain: vi.fn(),
      getBranding: vi.fn(),
      setBranding: vi.fn(),
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
import { resellerApi } from "../../../api";

const api = vi.mocked(resellerApi);

const resellerList: ResellerList = {
  truncated: false,
  resellers: [
    { resellerId: "r-1", displayName: "Acme Partners", status: "active", subTenantQuota: 10, subTenantCount: 2 },
  ],
};

const subTenantList: SubTenantList = {
  truncated: false,
  subTenantQuota: 2,
  subTenantCount: 2,
  subTenants: [
    { subTenantId: "s-1", displayName: "Customer One", status: "active", readOnly: false, createdAt: "2026-08-12T00:00:00Z" },
    { subTenantId: "s-2", displayName: "Customer Two", status: "active", readOnly: false, createdAt: "2026-08-12T00:00:00Z" },
  ],
};

const resellerBranding: ResellerBranding = {
  fields: { productName: "Acme Cloud" },
  locked: ["productName"],
  updatedAt: "2026-08-12T00:00:00Z",
  resolved: [
    { field: "logoUrl", value: null, source: "platform", locked: false },
    { field: "primaryColor", value: null, source: "platform", locked: false },
    { field: "secondaryColor", value: null, source: "platform", locked: false },
    { field: "productName", value: "Acme Cloud", source: "reseller", locked: true },
    { field: "supportUrl", value: null, source: "platform", locked: false },
    { field: "helpUrl", value: null, source: "platform", locked: false },
    { field: "emailSenderAddress", value: null, source: "none", locked: false },
    { field: "customDomain", value: null, source: "none", locked: false },
  ],
};

const pendingBinding: DomainBinding = {
  bindingId: "b-1",
  kind: "domain",
  host: "app.acme.test",
  status: "pending",
  challenge: "licensesrv-verify=abc123",
  verifiedAt: null,
  activatedAt: null,
  createdAt: "2026-08-12T00:00:00Z",
};

beforeEach(() => {
  vi.clearAllMocks();
  api.listResellers.mockResolvedValue(resellerList);
  api.onboardReseller.mockResolvedValue(resellerList.resellers[0]!);
  api.suspendReseller.mockResolvedValue({ ...resellerList.resellers[0]!, status: "suspended" });
  api.listSubTenants.mockResolvedValue(subTenantList);
  api.provisionSubTenant.mockResolvedValue({
    subTenantId: "s-3",
    displayName: "Customer Three",
    status: "active",
    readOnly: false,
    createdAt: "2026-08-12T00:00:00Z",
  });
  api.getResellerBranding.mockResolvedValue(resellerBranding);
  api.setResellerBranding.mockResolvedValue(resellerBranding);
  api.getBranding.mockResolvedValue({
    overrides: {},
    lockedFields: ["productName"],
    updatedAt: "2026-08-12T00:00:00Z",
    resolved: resellerBranding.resolved,
  });
  api.setBranding.mockResolvedValue({
    overrides: {},
    lockedFields: ["productName"],
    updatedAt: "2026-08-12T00:00:00Z",
    resolved: resellerBranding.resolved,
  });
  api.listDomains.mockResolvedValue({ bindings: [pendingBinding], truncated: false });
  api.initiateDomain.mockResolvedValue(pendingBinding);
  api.verifyDomain.mockResolvedValue({ ...pendingBinding, status: "verified", verifiedAt: "2026-08-12T01:00:00Z" });
});
afterEach(cleanup);

describe("Resellers (operator, US4)", () => {
  it("lists resellers with status + quota position", async () => {
    render(<Resellers sessionRole="admin" />);
    await screen.findByText("Acme Partners");
    const row = screen.getByText("Acme Partners").closest("tr")!;
    expect(within(row).getByText("active")).toBeInTheDocument();
    expect(within(row).getByText("10")).toBeInTheDocument();
  });

  it("onboards a new reseller and surfaces a 409 onboarding_conflict inline", async () => {
    const { ApiError } = await vi.importActual<typeof import("../../../api")>("../../../api");
    api.onboardReseller.mockRejectedValueOnce(new ApiError(409, "onboarding_conflict", "already"));
    render(<Resellers sessionRole="admin" />);
    await screen.findByText("Acme Partners");
    await userEvent.type(screen.getByLabelText("Display name"), "New Partner");
    await userEvent.type(screen.getByLabelText("First admin reference"), "admin@new");
    await userEvent.click(screen.getByRole("button", { name: /onboard reseller/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/already a reseller or a sub-tenant/i);
  });

  it("suspends a reseller (reversible read-only cascade)", async () => {
    render(<Resellers sessionRole="admin" />);
    await screen.findByText("Acme Partners");
    await userEvent.click(screen.getByLabelText("Suspend Acme Partners"));
    await waitFor(() => expect(api.suspendReseller).toHaveBeenCalledWith("r-1"));
  });

  it("hides lifecycle + onboard controls from a viewer", async () => {
    render(<Resellers sessionRole="viewer" />);
    await screen.findByText("Acme Partners");
    expect(screen.queryByLabelText("Onboard reseller")).toBeNull();
    expect(screen.queryByLabelText("Suspend Acme Partners")).toBeNull();
  });
});

describe("SubTenants (reseller, US1)", () => {
  it("shows the quota position and provisions under the hard cap", async () => {
    api.listSubTenants.mockResolvedValueOnce({ ...subTenantList, subTenantQuota: 5, subTenantCount: 2 });
    render(<SubTenants sessionRole="admin" />);
    await screen.findByText("Customer One");
    expect(screen.getByText(/Using 2 of 5 sub-tenants/)).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("Sub-tenant display name"), "Customer Three");
    await userEvent.type(screen.getByLabelText("Sub-tenant first admin reference"), "admin@c3");
    await userEvent.click(screen.getByRole("button", { name: /provision sub-tenant/i }));
    await waitFor(() => expect(api.provisionSubTenant).toHaveBeenCalled());
  });

  it("surfaces 409 quota_exceeded inline", async () => {
    const { ApiError } = await vi.importActual<typeof import("../../../api")>("../../../api");
    api.listSubTenants.mockResolvedValueOnce({ ...subTenantList, subTenantQuota: 5, subTenantCount: 2 });
    api.provisionSubTenant.mockRejectedValueOnce(new ApiError(409, "quota_exceeded", "full"));
    render(<SubTenants sessionRole="admin" />);
    await screen.findByText("Customer One");
    await userEvent.type(screen.getByLabelText("Sub-tenant display name"), "Customer X");
    await userEvent.type(screen.getByLabelText("Sub-tenant first admin reference"), "admin@x");
    await userEvent.click(screen.getByRole("button", { name: /provision sub-tenant/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/reached your hard sub-tenant quota/i);
  });

  it("never renders license/usage/activation data (metadata-only, FR-017)", async () => {
    render(<SubTenants sessionRole="admin" />);
    await screen.findByText("Customer One");
    expect(screen.queryByText(/license/i)).toBeNull();
    expect(screen.queryByText(/activation/i)).toBeNull();
  });
});

describe("Branding (US2)", () => {
  it("shows the reseller's locked field authoritatively in the resolved view", async () => {
    render(<Branding sessionRole="admin" />);
    const resolved = await screen.findByRole("region", { name: "Resolved branding" });
    const row = within(resolved).getByText("productName").closest("tr")!;
    expect(within(row).getByText("Acme Cloud")).toBeInTheDocument();
    expect(within(row).getByText("set by your provider")).toBeInTheDocument();
  });

  it("saves reseller branding + locks", async () => {
    render(<Branding sessionRole="admin" />);
    await screen.findByRole("form", { name: "Edit branding" });
    await userEvent.click(screen.getByRole("button", { name: /save branding/i }));
    await waitFor(() => expect(api.setResellerBranding).toHaveBeenCalled());
  });

  it("refuses a provider-locked override with 409 field_locked in self mode", async () => {
    const { ApiError } = await vi.importActual<typeof import("../../../api")>("../../../api");
    api.setBranding.mockRejectedValueOnce(new ApiError(409, "field_locked", "locked"));
    render(<Branding sessionRole="admin" />);
    await screen.findByRole("form", { name: "Edit branding" });
    await userEvent.selectOptions(screen.getByLabelText("Branding mode"), "self");
    await waitFor(() => expect(api.getBranding).toHaveBeenCalled());
    await userEvent.click(screen.getByRole("button", { name: /save branding/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/set by your provider and cannot be overridden/i);
  });
});

describe("Domains (US5)", () => {
  it("initiates verification and shows the public DNS challenge", async () => {
    render(<Domains sessionRole="admin" />);
    await screen.findByText("app.acme.test");
    await userEvent.type(screen.getByLabelText("Host"), "portal.acme.test");
    await userEvent.click(screen.getByRole("button", { name: /initiate verification/i }));
    await waitFor(() => expect(api.initiateDomain).toHaveBeenCalledWith({ kind: "domain", host: "portal.acme.test" }));
  });

  it("verifies a pending binding and surfaces 409 binding_conflict inline", async () => {
    const { ApiError } = await vi.importActual<typeof import("../../../api")>("../../../api");
    api.verifyDomain.mockRejectedValueOnce(new ApiError(409, "binding_conflict", "taken"));
    render(<Domains sessionRole="admin" />);
    await screen.findByText("app.acme.test");
    await userEvent.click(screen.getByLabelText("Verify app.acme.test"));
    expect(await screen.findByRole("alert")).toHaveTextContent(/already verified or active for another tenant/i);
  });
});

describe("Shell nav → Reseller (FR-001)", () => {
  it("reaches the Reseller view from the shell nav", async () => {
    render(<Shell who={{ userId: "u1", tenantId: "t1", role: "admin" }} onSignedOut={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "Reseller" }));
    expect(await screen.findByRole("region", { name: "Reseller" })).toBeInTheDocument();
  });
});
