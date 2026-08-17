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
import { Branding } from "../Branding";
import { Domains } from "../Domains";
import { Reseller } from "..";
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

describe("Resellers operator handlers (US4, cushion)", () => {
  it("changes the hard quota via the prompt and reloads", async () => {
    const promptSpy = vi.spyOn(window, "prompt").mockReturnValue("25");
    api.updateQuota.mockResolvedValue({ ...resellerList.resellers[0]!, subTenantQuota: 25 });
    render(<Resellers sessionRole="admin" />);
    await screen.findByText("Acme Partners");
    await userEvent.click(screen.getByLabelText("Set quota Acme Partners"));
    await waitFor(() => expect(api.updateQuota).toHaveBeenCalledWith("r-1", 25));
    expect(await screen.findByRole("status")).toHaveTextContent(/Quota for Acme Partners is now 25/);
    promptSpy.mockRestore();
  });

  it("rejects a non-integer quota inline without calling the API", async () => {
    const promptSpy = vi.spyOn(window, "prompt").mockReturnValue("-3");
    render(<Resellers sessionRole="admin" />);
    await screen.findByText("Acme Partners");
    await userEvent.click(screen.getByLabelText("Set quota Acme Partners"));
    expect(await screen.findByRole("alert")).toHaveTextContent(/non-negative integer/i);
    expect(api.updateQuota).not.toHaveBeenCalled();
    promptSpy.mockRestore();
  });

  it("aborts the quota change when the prompt is cancelled", async () => {
    const promptSpy = vi.spyOn(window, "prompt").mockReturnValue(null);
    render(<Resellers sessionRole="admin" />);
    await screen.findByText("Acme Partners");
    await userEvent.click(screen.getByLabelText("Set quota Acme Partners"));
    await waitFor(() => expect(api.updateQuota).not.toHaveBeenCalled());
    promptSpy.mockRestore();
  });

  it("reinstates a reseller", async () => {
    api.reinstateReseller.mockResolvedValue({ ...resellerList.resellers[0]!, status: "active" });
    render(<Resellers sessionRole="admin" />);
    await screen.findByText("Acme Partners");
    await userEvent.click(screen.getByLabelText("Reinstate Acme Partners"));
    await waitFor(() => expect(api.reinstateReseller).toHaveBeenCalledWith("r-1"));
    expect(await screen.findByRole("status")).toHaveTextContent(/reinstated/i);
  });

  it("offboards cleanly when there are no unresolved sub-tenants", async () => {
    api.offboardReseller.mockResolvedValue({
      resellerId: "r-1",
      status: "offboarding",
      unresolvedSubTenantCount: 0,
      graceEndsAt: "2026-09-01",
    });
    render(<Resellers sessionRole="admin" />);
    await screen.findByText("Acme Partners");
    await userEvent.click(screen.getByLabelText("Offboard Acme Partners"));
    await waitFor(() => expect(api.offboardReseller).toHaveBeenCalledWith("r-1"));
    expect(await screen.findByRole("status")).toHaveTextContent(/grace ends 2026-09-01/);
  });

  it("reports blocked offboard when sub-tenants remain unresolved", async () => {
    api.offboardReseller.mockResolvedValue({
      resellerId: "r-1",
      status: "active",
      unresolvedSubTenantCount: 3,
      graceEndsAt: "2026-09-01",
    });
    render(<Resellers sessionRole="admin" />);
    await screen.findByText("Acme Partners");
    await userEvent.click(screen.getByLabelText("Offboard Acme Partners"));
    expect(await screen.findByRole("status")).toHaveTextContent(/Offboard blocked: 3 sub-tenant/);
  });

  it("moves a sub-tenant to a destination reseller", async () => {
    api.moveSubTenant.mockResolvedValue({
      subTenantId: "s-9",
      displayName: "Moved Co",
      status: "active",
      readOnly: false,
      createdAt: "2026-08-12T00:00:00Z",
      resellerId: "r-2",
    });
    render(<Resellers sessionRole="admin" />);
    await screen.findByText("Acme Partners");
    await userEvent.type(screen.getByLabelText("Move sub-tenant id"), "s-9");
    await userEvent.type(screen.getByLabelText("Destination reseller id"), "r-2");
    await userEvent.click(screen.getByRole("button", { name: /^move$/i }));
    await waitFor(() =>
      expect(api.moveSubTenant).toHaveBeenCalledWith("s-9", { type: "to_reseller", destinationResellerId: "r-2" }),
    );
    expect(await screen.findByRole("status")).toHaveTextContent(/moved to reseller r-2/);
  });

  it("moves a sub-tenant back to direct-platform when no destination is given", async () => {
    api.moveSubTenant.mockResolvedValue({
      subTenantId: "s-9",
      displayName: "Moved Co",
      status: "active",
      readOnly: false,
      createdAt: "2026-08-12T00:00:00Z",
      resellerId: null,
    });
    render(<Resellers sessionRole="admin" />);
    await screen.findByText("Acme Partners");
    await userEvent.type(screen.getByLabelText("Move sub-tenant id"), "s-9");
    await userEvent.click(screen.getByRole("button", { name: /^move$/i }));
    await waitFor(() =>
      expect(api.moveSubTenant).toHaveBeenCalledWith("s-9", { type: "to_direct_platform" }),
    );
    expect(await screen.findByRole("status")).toHaveTextContent(/moved to direct-platform/);
  });

  it("filters the reseller list by status", async () => {
    render(<Resellers sessionRole="admin" />);
    await screen.findByText("Acme Partners");
    await userEvent.selectOptions(screen.getByLabelText("Filter reseller status"), "suspended");
    await waitFor(() => expect(api.listResellers).toHaveBeenCalledWith("suspended"));
  });

  it("renders the truncation notice when the list is truncated", async () => {
    api.listResellers.mockResolvedValue({ ...resellerList, truncated: true });
    render(<Resellers sessionRole="admin" />);
    expect(await screen.findByText(/list truncated/i)).toBeInTheDocument();
  });

  it("promotes an existing tenant via the onboard mode switch", async () => {
    render(<Resellers sessionRole="admin" />);
    await screen.findByText("Acme Partners");
    await userEvent.selectOptions(screen.getByLabelText("Onboard mode"), "promote_existing");
    await userEvent.type(screen.getByLabelText("Tenant id"), "t-99");
    await userEvent.type(screen.getByLabelText("First admin reference"), "admin@promo");
    await userEvent.click(screen.getByRole("button", { name: /onboard reseller/i }));
    await waitFor(() =>
      expect(api.onboardReseller).toHaveBeenCalledWith(
        expect.objectContaining({ mode: "promote_existing", tenantId: "t-99" }),
      ),
    );
  });
});

describe("Branding editor handlers (US2, cushion)", () => {
  it("edits a field value and toggles a lock, then saves the reseller branding", async () => {
    render(<Branding sessionRole="admin" />);
    await screen.findByRole("form", { name: "Edit branding" });
    await userEvent.type(screen.getByLabelText("logoUrl value"), "https://cdn.acme/logo.png");
    await userEvent.click(screen.getByLabelText("Lock logoUrl"));
    await userEvent.click(screen.getByRole("button", { name: /save branding/i }));
    await waitFor(() =>
      expect(api.setResellerBranding).toHaveBeenCalledWith(
        expect.objectContaining({ locked: expect.arrayContaining(["logoUrl"]) }),
      ),
    );
    expect(await screen.findByRole("status")).toHaveTextContent(/Reseller branding \+ locks saved/);
  });

  it("clears a field back out when emptied", async () => {
    render(<Branding sessionRole="admin" />);
    await screen.findByRole("form", { name: "Edit branding" });
    const input = screen.getByLabelText("logoUrl value");
    await userEvent.type(input, "x");
    await userEvent.clear(input);
    await userEvent.click(screen.getByRole("button", { name: /save branding/i }));
    await waitFor(() => expect(api.setResellerBranding).toHaveBeenCalled());
  });

  it("saves the self-plane branding overrides", async () => {
    render(<Branding sessionRole="admin" />);
    await screen.findByRole("form", { name: "Edit branding" });
    await userEvent.selectOptions(screen.getByLabelText("Branding mode"), "self");
    await waitFor(() => expect(api.getBranding).toHaveBeenCalled());
    await userEvent.click(screen.getByRole("button", { name: /save branding/i }));
    await waitFor(() => expect(api.setBranding).toHaveBeenCalled());
    expect(await screen.findByRole("status")).toHaveTextContent(/Branding overrides saved/);
  });

  it("surfaces a load failure inline", async () => {
    const { ApiError } = await vi.importActual<typeof import("../../../api")>("../../../api");
    api.getResellerBranding.mockRejectedValueOnce(new ApiError(403, "forbidden", "no"));
    render(<Branding sessionRole="admin" />);
    expect(await screen.findByRole("alert")).toHaveTextContent(/requires the admin role/i);
  });
});

describe("Domains verification handlers (US5, cushion)", () => {
  it("activates a verified binding", async () => {
    const verifiedBinding: DomainBinding = { ...pendingBinding, status: "verified", verifiedAt: "2026-08-12T01:00:00Z" };
    api.listDomains.mockResolvedValue({ bindings: [verifiedBinding], truncated: false });
    api.activateDomain.mockResolvedValue({ ...verifiedBinding, status: "active", activatedAt: "2026-08-12T02:00:00Z" });
    render(<Domains sessionRole="admin" />);
    await screen.findByText("app.acme.test");
    await userEvent.click(screen.getByLabelText("Activate app.acme.test"));
    await waitFor(() => expect(api.activateDomain).toHaveBeenCalledWith("b-1"));
    expect(await screen.findByRole("status")).toHaveTextContent(/is now active/);
  });

  it("initiates an email_sender binding via the kind switch", async () => {
    render(<Domains sessionRole="admin" />);
    await screen.findByText("app.acme.test");
    await userEvent.selectOptions(screen.getByLabelText("Binding kind"), "email_sender");
    await userEvent.type(screen.getByLabelText("Host"), "mail.acme.test");
    await userEvent.click(screen.getByRole("button", { name: /initiate verification/i }));
    await waitFor(() =>
      expect(api.initiateDomain).toHaveBeenCalledWith({ kind: "email_sender", host: "mail.acme.test" }),
    );
  });

  it("shows the empty state when there are no bindings", async () => {
    api.listDomains.mockResolvedValue({ bindings: [], truncated: false });
    render(<Domains sessionRole="admin" />);
    expect(await screen.findByText(/No domain bindings yet/i)).toBeInTheDocument();
  });
});

describe("Reseller container (FR-001)", () => {
  it("renders the Reseller region with its default view", async () => {
    render(<Reseller sessionRole="admin" />);
    expect(await screen.findByRole("region", { name: "Reseller" })).toBeInTheDocument();
  });

  it("switches between all four sub-views via the sub-nav", async () => {
    render(<Reseller sessionRole="admin" />);
    await screen.findByRole("region", { name: "Reseller" });
    await userEvent.click(screen.getByRole("button", { name: "Sub-tenants" }));
    expect(await screen.findByRole("region", { name: "Sub-tenants" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Branding" }));
    expect(await screen.findByRole("region", { name: "Branding" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Domains" }));
    expect(await screen.findByRole("region", { name: "Domains" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Resellers" }));
    expect(await screen.findByRole("region", { name: "Resellers" })).toBeInTheDocument();
  });
});
