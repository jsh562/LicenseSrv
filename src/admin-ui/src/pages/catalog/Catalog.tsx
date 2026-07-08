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

  return (
    <section aria-label="Catalog">
      <nav aria-label="Catalog sections">
        <button type="button" aria-current={pane === "catalog"} onClick={() => setPane("catalog")}>
          Products &amp; Plans
        </button>
        <button type="button" aria-current={pane === "entitlements"} onClick={() => setPane("entitlements")}>
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
