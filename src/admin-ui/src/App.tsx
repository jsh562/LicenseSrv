// Root: resolve an existing session on mount (GET /me), then render either the login page or the
// routed console (real URLs per section, back-button, deep-linking). A 401 just means "not signed in".
import { useEffect, useState } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";

import { adminApi, type Principal, type Role } from "./api";
import { AppLayout } from "./components/AppLayout";
import { SessionContext } from "./session";
import { ApiKeys } from "./pages/ApiKeys";
import { Audit } from "./pages/Audit";
import { Login } from "./pages/Login";
import { Users } from "./pages/Users";
import { Billing } from "./pages/billing/Billing";
import { Catalog } from "./pages/catalog/Catalog";
import { Leases } from "./pages/leases/Leases";
import { Licensing } from "./pages/licensing/Licensing";
import { PolicyRules } from "./pages/policy/PolicyRules";
import { Reseller } from "./pages/reseller";
import { Usage } from "./pages/usage/Usage";

function AuthedRoutes({ role }: { role: Role }): JSX.Element {
  return (
    <Routes>
      <Route path="/" element={<AppLayout />}>
        <Route index element={<Navigate to="/users" replace />} />
        <Route path="users" element={<Users sessionRole={role} />} />
        <Route path="api-keys" element={<ApiKeys sessionRole={role} />} />
        <Route path="audit" element={<Audit />} />
        {/* Catalog / Licensing / Reseller keep their own in-page sub-nav for now (`/*` catch-all). */}
        <Route path="catalog/*" element={<Catalog sessionRole={role} />} />
        <Route path="licensing/*" element={<Licensing sessionRole={role} />} />
        <Route path="billing" element={<Billing sessionRole={role} />} />
        <Route path="leases" element={<Leases sessionRole={role} />} />
        <Route path="usage" element={<Usage sessionRole={role} />} />
        <Route path="policy" element={<PolicyRules sessionRole={role} />} />
        <Route path="reseller/*" element={<Reseller sessionRole={role} />} />
        <Route path="*" element={<Navigate to="/users" replace />} />
      </Route>
    </Routes>
  );
}

export function App(): JSX.Element {
  const [who, setWho] = useState<Principal | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    adminApi
      .me()
      .then((p) => setWho(p))
      .catch(() => setWho(null))
      .finally(() => setReady(true));
  }, []);

  if (!ready) {
    return <div className="grid h-full place-items-center text-fg-muted">Loading…</div>;
  }

  return (
    <BrowserRouter>
      <SessionContext.Provider value={{ who, setWho }}>
        {who ? <AuthedRoutes role={who.role} /> : <Login onSignedIn={setWho} />}
      </SessionContext.Provider>
    </BrowserRouter>
  );
}
