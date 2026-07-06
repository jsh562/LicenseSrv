// App root: an existing session (GET /me resolves) lands on the console shell; a 401 falls back to the
// login page. Mocks ../api so no network is touched.
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "../api";
import { App } from "../App";

vi.mock("../api", async (orig) => {
  const actual = await orig<typeof import("../api")>();
  return {
    ...actual,
    adminApi: {
      me: vi.fn(),
      logout: vi.fn(),
      listUsers: vi.fn().mockResolvedValue([]),
      listApiKeys: vi.fn().mockResolvedValue([]),
      listAudit: vi.fn().mockResolvedValue({ entries: [], nextCursor: null }),
    },
  };
});

// eslint-disable-next-line import/first
import { adminApi } from "../api";

const api = vi.mocked(adminApi);

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe("App", () => {
  it("shows the console shell when a session already exists, and returns to login on sign-out", async () => {
    api.me.mockResolvedValue({ userId: "u1", tenantId: "t1", role: "owner" });
    api.logout.mockResolvedValue(undefined);
    const { default: userEvent } = await import("@testing-library/user-event");
    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: /sign out/i }));
    await waitFor(() => expect(screen.getByRole("form", { name: /sign in/i })).toBeInTheDocument());
  });

  it("shows the login page on a 401 (not signed in)", async () => {
    api.me.mockRejectedValue(new ApiError(401, "unauthenticated", "nope"));
    render(<App />);
    await waitFor(() => expect(screen.getByRole("form", { name: /sign in/i })).toBeInTheDocument());
  });
});
