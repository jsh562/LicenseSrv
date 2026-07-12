// Licensing container (FR-015). Frames the three licensing views inside the console — Issue a license,
// browse Licenses (registry + lifecycle), and the Customers registry — under the session's tenant scope
// and role. Selection is local state; every view calls the API under the same session cookie.
import { useState } from "react";

import type { Role } from "../../api";
import { Customers } from "./Customers";
import { Issue } from "./Issue";
import { Licenses } from "./Licenses";

type Pane = "issue" | "licenses" | "customers";

export function Licensing({ sessionRole }: { sessionRole: Role }): JSX.Element {
  const [pane, setPane] = useState<Pane>("licenses");

  return (
    <section aria-label="Licensing">
      <nav aria-label="Licensing sections">
        <button type="button" aria-current={pane === "issue"} onClick={() => setPane("issue")}>
          Issue
        </button>
        <button type="button" aria-current={pane === "licenses"} onClick={() => setPane("licenses")}>
          Licenses
        </button>
        <button type="button" aria-current={pane === "customers"} onClick={() => setPane("customers")}>
          Customers
        </button>
      </nav>

      {pane === "issue" && <Issue sessionRole={sessionRole} />}
      {pane === "licenses" && <Licenses sessionRole={sessionRole} />}
      {pane === "customers" && <Customers sessionRole={sessionRole} />}
    </section>
  );
}
