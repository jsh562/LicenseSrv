// Catalog container (FR-015). Frames the no-code catalog inside the console: a "Products & Plans"
// drill-down (products → a product's plans → a plan's entitlement values) and a separate "Entitlements"
// pane for defining features. Selection is local state; every view calls the API under the session scope.
import { useState } from "react";

import type { Plan, Product, Role } from "../../api";
import { Entitlements } from "./Entitlements";
import { PlanValues } from "./PlanValues";
import { Plans } from "./Plans";
import { Products } from "./Products";

type Pane = "catalog" | "entitlements";

export function Catalog({ sessionRole }: { sessionRole: Role }): JSX.Element {
  const [pane, setPane] = useState<Pane>("catalog");
  const [product, setProduct] = useState<Product | null>(null);
  const [plan, setPlan] = useState<Plan | null>(null);

  const tab = (active: boolean): string =>
    `rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
      active ? "bg-primary text-primary-fg" : "text-fg-muted hover:bg-surface-muted"
    }`;

  return (
    <section aria-label="Catalog" className="space-y-4">
      <nav aria-label="Catalog sections" className="flex items-center gap-1 border-b border-border pb-3">
        <button type="button" aria-current={pane === "catalog"} onClick={() => setPane("catalog")} className={tab(pane === "catalog")}>
          Products &amp; Plans
        </button>
        <button type="button" aria-current={pane === "entitlements"} onClick={() => setPane("entitlements")} className={tab(pane === "entitlements")}>
          Entitlements
        </button>
      </nav>

      {pane === "entitlements" && <Entitlements sessionRole={sessionRole} />}

      {pane === "catalog" && !product && (
        <Products
          sessionRole={sessionRole}
          onOpen={(p) => {
            setProduct(p);
            setPlan(null);
          }}
        />
      )}
      {pane === "catalog" && product && !plan && (
        <Plans product={product} sessionRole={sessionRole} onOpen={setPlan} onBack={() => setProduct(null)} />
      )}
      {pane === "catalog" && product && plan && (
        <PlanValues plan={plan} sessionRole={sessionRole} onBack={() => setPlan(null)} />
      )}
    </section>
  );
}
