import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Principal } from "../../api";
import { SessionContext } from "../../session";
import { AppLayout } from "../AppLayout";

function renderLayout(setWho = vi.fn()) {
  const who: Principal = { userId: "u1", tenantId: "t1", role: "owner" };
  render(
    <SessionContext.Provider value={{ who, setWho }}>
      <MemoryRouter initialEntries={["/users"]}>
        <Routes>
          <Route path="/" element={<AppLayout />}>
            <Route path="users" element={<div>USERS PAGE</div>} />
          </Route>
        </Routes>
      </MemoryRouter>
    </SessionContext.Provider>,
  );
  return { setWho };
}

afterEach(() => {
  vi.restoreAllMocks();
  document.documentElement.classList.remove("dark");
});

describe("AppLayout", () => {
  it("renders the section nav, role badge, and the routed outlet", () => {
    renderLayout();
    expect(screen.getByRole("navigation", { name: "Sections" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Users" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Reseller" })).toBeInTheDocument();
    expect(screen.getByLabelText("Your role")).toHaveTextContent("owner");
    expect(screen.getByText("USERS PAGE")).toBeInTheDocument();
  });

  it("toggles dark mode on the document root", async () => {
    renderLayout();
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    await userEvent.click(screen.getByLabelText("Toggle dark mode"));
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });

  it("signs out: calls logout then clears the session", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } })),
    );
    const { setWho } = renderLayout();
    await userEvent.click(screen.getByRole("button", { name: "Sign out" }));
    expect(setWho).toHaveBeenCalledWith(null);
  });
});
