import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { SessionContext, useSession } from "../session";

function Probe(): JSX.Element {
  const { who } = useSession();
  return <div>role:{who?.role ?? "none"}</div>;
}

describe("useSession", () => {
  it("returns the default (unset) session outside a provider", () => {
    render(<Probe />);
    expect(screen.getByText("role:none")).toBeInTheDocument();
  });

  it("returns the provided principal", () => {
    render(
      <SessionContext.Provider value={{ who: { userId: "u", tenantId: "t", role: "admin" }, setWho: vi.fn() }}>
        <Probe />
      </SessionContext.Provider>,
    );
    expect(screen.getByText("role:admin")).toBeInTheDocument();
  });
});
