// Licensing container (FR-015). Frames the three licensing views inside the console — Issue a license,
// browse Licenses (registry + lifecycle), and the Customers registry — under the session's tenant scope
// and role. Selection is local state; every view calls the API under the same session cookie.
import { useState } from "react";

import type { Role } from "../../api";
import { Button } from "../../components/ui/Button";
import { Customers } from "./Customers";
import { Issue } from "./Issue";
import { Licenses } from "./Licenses";

type Pane = "issue" | "licenses" | "customers";

export function Licensing({ sessionRole }: { sessionRole: Role }): JSX.Element {
  const [pane, setPane] = useState<Pane>("licenses");

  return (
    <section aria-label="Licensing" className="space-y-4">
      <nav aria-label="Licensing sections" className="flex items-center gap-2 border-b border-border pb-2">
        <Button
          type="button"
          size="sm"
          variant={pane === "issue" ? "secondary" : "ghost"}
          aria-current={pane === "issue"}
          onClick={() => setPane("issue")}
        >
          Issue
        </Button>
        <Button
          type="button"
          size="sm"
          variant={pane === "licenses" ? "secondary" : "ghost"}
          aria-current={pane === "licenses"}
          onClick={() => setPane("licenses")}
        >
          Licenses
        </Button>
        <Button
          type="button"
          size="sm"
          variant={pane === "customers" ? "secondary" : "ghost"}
          aria-current={pane === "customers"}
          onClick={() => setPane("customers")}
        >
          Customers
        </Button>
      </nav>

      {pane === "issue" && <Issue sessionRole={sessionRole} />}
      {pane === "licenses" && <Licenses sessionRole={sessionRole} />}
      {pane === "customers" && <Customers sessionRole={sessionRole} />}
    </section>
  );
}
