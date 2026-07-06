// Component tests (T042, FR-015/SC-010): login flow + generic/locked errors, shell nav, RequireRole
// hiding privileged actions from a viewer, and the users/api-keys/audit views rendering against a
// mocked API. ../api is mocked so views are exercised in isolation (ApiError/roleAtLeast stay real).
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError, type ApiKeyMeta, type AuditEntry, type UserRow } from "../api";
import { RequireRole, roleAtLeast } from "../components/RequireRole";
import { Shell } from "../components/Shell";
import { ApiKeys } from "../pages/ApiKeys";
import { Audit } from "../pages/Audit";
import { Login } from "../pages/Login";
import { Users } from "../pages/Users";

vi.mock("../api", async (orig) => {
  const actual = await orig<typeof import("../api")>();
  return {
    ...actual,
    adminApi: {
      login: vi.fn(),
      me: vi.fn(),
      logout: vi.fn(),
      listUsers: vi.fn(),
      createUser: vi.fn(),
      updateUser: vi.fn(),
      listApiKeys: vi.fn(),
      createApiKey: vi.fn(),
      rotateApiKey: vi.fn(),
      revokeApiKey: vi.fn(),
      listAudit: vi.fn(),
    },
  };
});

// eslint-disable-next-line import/first
import { adminApi } from "../api";

const api = vi.mocked(adminApi);

beforeEach(() => {
  vi.clearAllMocks();
  api.listUsers.mockResolvedValue([]);
  api.listApiKeys.mockResolvedValue([]);
  api.listAudit.mockResolvedValue({ entries: [], nextCursor: null });
});
afterEach(cleanup);

describe("RequireRole (SC-010)", () => {
  it("ranks roles and renders children only at/above the minimum", () => {
    expect(roleAtLeast("owner", "admin")).toBe(true);
    expect(roleAtLeast("viewer", "admin")).toBe(false);
    render(
      <RequireRole role="viewer" min="admin">
        <button>secret</button>
      </RequireRole>,
    );
    expect(screen.queryByText("secret")).toBeNull();
  });
});

describe("Login (US1)", () => {
  it("signs in and hands the principal upward", async () => {
    api.login.mockResolvedValue({ userId: "u1", role: "owner", expiresAt: "2026-01-01T00:00:00Z" });
    api.me.mockResolvedValue({ userId: "u1", tenantId: "t1", role: "owner" });
    const onSignedIn = vi.fn();
    render(<Login onSignedIn={onSignedIn} />);

    await userEvent.type(screen.getByLabelText("Workspace"), "acme");
    await userEvent.type(screen.getByLabelText("Email"), "owner@acme.test");
    await userEvent.type(screen.getByLabelText("Password"), "pw");
    await userEvent.click(screen.getByRole("button", { name: /sign in/i }));

    await waitFor(() => expect(onSignedIn).toHaveBeenCalledWith({ userId: "u1", tenantId: "t1", role: "owner" }));
  });

  it("shows a generic error on failure (no enumeration)", async () => {
    api.login.mockRejectedValue(new ApiError(401, "invalid_credentials", "invalid credentials"));
    render(<Login onSignedIn={vi.fn()} />);
    await userEvent.type(screen.getByLabelText("Workspace"), "acme");
    await userEvent.type(screen.getByLabelText("Email"), "x@y.z");
    await userEvent.type(screen.getByLabelText("Password"), "bad");
    await userEvent.click(screen.getByRole("button", { name: /sign in/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/sign in failed/i);
  });

  it("shows a distinct lockout message on 429", async () => {
    api.login.mockRejectedValue(new ApiError(429, "account_locked", "locked"));
    render(<Login onSignedIn={vi.fn()} />);
    await userEvent.type(screen.getByLabelText("Workspace"), "acme");
    await userEvent.type(screen.getByLabelText("Email"), "x@y.z");
    await userEvent.type(screen.getByLabelText("Password"), "bad");
    await userEvent.click(screen.getByRole("button", { name: /sign in/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/locked/i);
  });
});

describe("Shell nav (FR-015)", () => {
  it("switches between users, api-keys, and audit views", async () => {
    render(<Shell who={{ userId: "u1", tenantId: "t1", role: "owner" }} onSignedOut={vi.fn()} />);
    // Default: users.
    expect(await screen.findByRole("region", { name: "Users" })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "API Keys" }));
    expect(await screen.findByRole("region", { name: "API keys" })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Audit" }));
    expect(await screen.findByRole("region", { name: "Audit log" })).toBeInTheDocument();
  });

  it("signs out via the API and notifies upward", async () => {
    api.logout.mockResolvedValue(undefined);
    const onSignedOut = vi.fn();
    render(<Shell who={{ userId: "u1", tenantId: "t1", role: "owner" }} onSignedOut={onSignedOut} />);
    await userEvent.click(screen.getByRole("button", { name: /sign out/i }));
    await waitFor(() => expect(onSignedOut).toHaveBeenCalled());
    expect(api.logout).toHaveBeenCalled();
  });
});

describe("Users view (US3)", () => {
  const rows: UserRow[] = [
    { id: "u-owner", status: "active", role: "owner", createdAt: "2026-01-01T00:00:00Z" },
    { id: "u-view", status: "active", role: "viewer", createdAt: "2026-01-02T00:00:00Z" },
  ];

  it("hides the invite form from a viewer but shows it to an admin", async () => {
    api.listUsers.mockResolvedValue(rows);
    const { rerender } = render(<Users sessionRole="viewer" />);
    await screen.findByText("u-owner");
    expect(screen.queryByLabelText("Invite user")).toBeNull();

    rerender(<Users sessionRole="admin" />);
    expect(await screen.findByLabelText("Invite user")).toBeInTheDocument();
  });

  it("creates a user and refreshes", async () => {
    api.listUsers.mockResolvedValue(rows);
    api.createUser.mockResolvedValue({ id: "u-new", status: "invited" });
    render(<Users sessionRole="admin" />);
    await screen.findByText("u-owner");
    await userEvent.type(screen.getByLabelText("New user email"), "new@acme.test");
    await userEvent.click(screen.getByRole("button", { name: "Invite" }));
    await waitFor(() =>
      expect(api.createUser).toHaveBeenCalledWith({ email: "new@acme.test", role: "viewer" }),
    );
    expect(await screen.findByRole("status")).toHaveTextContent(/invited/i);
  });

  it("surfaces the last-owner safeguard (409) when demoting", async () => {
    api.listUsers.mockResolvedValue(rows);
    api.updateUser.mockRejectedValue(new ApiError(409, "last_owner", "last owner"));
    render(<Users sessionRole="owner" />);
    await screen.findByText("u-owner");
    const ownerRow = screen.getByText("u-owner").closest("tr")!;
    await userEvent.selectOptions(within(ownerRow).getByLabelText("Role for u-owner"), "admin");
    expect(await screen.findByRole("alert")).toHaveTextContent(/last owner/i);
  });

  it("changes a role and deactivates a user", async () => {
    api.listUsers.mockResolvedValue(rows);
    api.updateUser.mockResolvedValue({ id: "u-view", role: "admin", status: "active" });
    render(<Users sessionRole="owner" />);
    await screen.findByText("u-view");
    const viewRow = screen.getByText("u-view").closest("tr")!;

    await userEvent.selectOptions(within(viewRow).getByLabelText("Role for u-view"), "admin");
    await waitFor(() => expect(api.updateUser).toHaveBeenCalledWith("u-view", { role: "admin" }));

    await userEvent.click(within(viewRow).getByRole("button", { name: /deactivate/i }));
    await waitFor(() =>
      expect(api.updateUser).toHaveBeenCalledWith("u-view", { status: "deactivated" }),
    );
  });
});

describe("ApiKeys view (US4)", () => {
  const keys: ApiKeyMeta[] = [
    { id: "k1", scopes: ["validate"], status: "active", createdAt: "2026-01-01T00:00:00Z", revokedAt: null },
  ];

  it("reveals a created secret exactly once and never lists it", async () => {
    api.listApiKeys.mockResolvedValue(keys);
    api.createApiKey.mockResolvedValue({ id: "k2", secret: "lsk_supersecret", scopes: ["validate"] });
    render(<ApiKeys sessionRole="admin" />);
    await screen.findByText("k1");
    // The secret is not in the list.
    expect(screen.queryByText(/lsk_/)).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: /create key/i }));
    const banner = await screen.findByText("lsk_supersecret");
    expect(banner).toBeInTheDocument();
    // Dismiss → secret gone.
    await userEvent.click(screen.getByRole("button", { name: /done/i }));
    expect(screen.queryByText("lsk_supersecret")).toBeNull();
  });

  it("hides create/rotate/revoke from a viewer", async () => {
    api.listApiKeys.mockResolvedValue(keys);
    render(<ApiKeys sessionRole="viewer" />);
    await screen.findByText("k1");
    expect(screen.queryByRole("button", { name: /create key/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /rotate/i })).toBeNull();
  });

  it("rotates a key (new secret shown once) and revokes a key", async () => {
    api.listApiKeys.mockResolvedValue(keys);
    api.rotateApiKey.mockResolvedValue({ id: "k1b", secret: "lsk_rotated", scopes: ["validate"] });
    api.revokeApiKey.mockResolvedValue({ id: "k1", status: "revoked" });
    render(<ApiKeys sessionRole="admin" />);
    await screen.findByText("k1");

    await userEvent.click(screen.getByRole("button", { name: /rotate/i }));
    expect(await screen.findByText("lsk_rotated")).toBeInTheDocument();
    expect(api.rotateApiKey).toHaveBeenCalledWith("k1");

    await userEvent.click(screen.getByRole("button", { name: /revoke/i }));
    await waitFor(() => expect(api.revokeApiKey).toHaveBeenCalledWith("k1"));
  });
});

describe("Audit view (US5)", () => {
  const entries: AuditEntry[] = [
    { id: "a1", actor: "u1", action: "auth.login", target: "acme", securityEvent: false, ts: "2026-01-01T00:00:00Z" },
    { id: "a2", actor: "u2", action: "authz.denied", target: "GET /x", securityEvent: true, ts: "2026-01-02T00:00:00Z" },
  ];

  it("renders entries and re-queries with the security filter", async () => {
    api.listAudit.mockResolvedValue({ entries, nextCursor: null });
    render(<Audit />);
    await screen.findByText("auth.login");
    expect(screen.getByText("authz.denied")).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText("From"), "2026-01-01T00:00");
    await userEvent.type(screen.getByLabelText("To"), "2026-12-31T00:00");
    await userEvent.type(screen.getByLabelText("Actor"), "u1");
    await userEvent.click(screen.getByLabelText(/security events only/i));
    await userEvent.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() =>
      expect(api.listAudit).toHaveBeenLastCalledWith(
        expect.objectContaining({ securityEvent: true, actor: "u1", from: "2026-01-01T00:00", to: "2026-12-31T00:00" }),
      ),
    );
  });

  it("pages via the cursor with Load more", async () => {
    api.listAudit
      .mockResolvedValueOnce({ entries: [entries[0]!], nextCursor: "cursor-1" })
      .mockResolvedValueOnce({ entries: [entries[1]!], nextCursor: null });
    render(<Audit />);
    await screen.findByText("auth.login");

    await userEvent.click(await screen.findByRole("button", { name: /load more/i }));
    await screen.findByText("authz.denied");
    expect(api.listAudit).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: "cursor-1" }));
  });

  it("shows an error when the audit query fails", async () => {
    api.listAudit.mockRejectedValue(new Error("boom"));
    render(<Audit />);
    expect(await screen.findByRole("alert")).toHaveTextContent(/could not load/i);
  });
});
