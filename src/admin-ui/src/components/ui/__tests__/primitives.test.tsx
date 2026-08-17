import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Badge, statusTone } from "../Badge";
import { Button } from "../Button";
import { Card } from "../Card";
import { EmptyState } from "../EmptyState";
import { Field, Input, Select, Textarea } from "../Field";
import { PageHeader } from "../PageHeader";
import { Spinner } from "../Spinner";
import { Table, TBody, Td, Th, THead, Tr } from "../Table";

describe("statusTone", () => {
  it("maps statuses to semantic tones", () => {
    expect(statusTone("active")).toBe("success");
    expect(statusTone("verified")).toBe("success");
    expect(statusTone("suspended")).toBe("warning");
    expect(statusTone("pending")).toBe("warning");
    expect(statusTone("revoked")).toBe("danger");
    expect(statusTone("expired")).toBe("danger");
    expect(statusTone("perpetual")).toBe("info");
    expect(statusTone("something-else")).toBe("muted");
  });
});

describe("Button", () => {
  it("renders every variant and forwards native attrs", () => {
    for (const variant of ["primary", "secondary", "ghost", "danger"] as const) {
      const { unmount } = render(
        <Button variant={variant} size="sm" aria-label={`btn-${variant}`}>
          {variant}
        </Button>,
      );
      expect(screen.getByRole("button", { name: `btn-${variant}` })).toBeInTheDocument();
      unmount();
    }
  });

  it("is disabled while loading", () => {
    render(<Button loading>Save</Button>);
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });
});

describe("primitives render", () => {
  it("Badge shows its text with a tone", () => {
    render(<Badge tone={statusTone("active")}>active</Badge>);
    expect(screen.getByText("active")).toBeInTheDocument();
  });

  it("PageHeader renders title, description and actions", () => {
    render(<PageHeader title="Users" description="desc" actions={<button>Add</button>} />);
    expect(screen.getByRole("heading", { name: "Users" })).toBeInTheDocument();
    expect(screen.getByText("desc")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add" })).toBeInTheDocument();
  });

  it("EmptyState renders with and without an action", () => {
    const { rerender } = render(<EmptyState title="Nothing" description="none" />);
    expect(screen.getByText("Nothing")).toBeInTheDocument();
    rerender(<EmptyState title="Nothing" action={<button>New</button>} />);
    expect(screen.getByRole("button", { name: "New" })).toBeInTheDocument();
  });

  it("Card / Spinner / Table primitives render real elements", () => {
    render(
      <Card>
        <Spinner size="sm" />
        <Table>
          <THead>
            <Tr>
              <Th>H</Th>
            </Tr>
          </THead>
          <TBody>
            <Tr>
              <Td>cell</Td>
            </Tr>
          </TBody>
        </Table>
      </Card>,
    );
    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "H" })).toBeInTheDocument();
    expect(screen.getByRole("cell", { name: "cell" })).toBeInTheDocument();
  });

  it("Field associates label with a control; Select/Textarea render", () => {
    render(
      <div>
        <Field label="Name">
          <Input aria-label="Name" />
        </Field>
        <Select aria-label="Pick">
          <option>a</option>
        </Select>
        <Textarea aria-label="Body" />
      </div>,
    );
    expect(screen.getByLabelText("Name")).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Pick" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Body" })).toBeInTheDocument();
  });
});
