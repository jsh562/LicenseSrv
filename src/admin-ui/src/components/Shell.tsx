// Console shell (FR-015). Once signed in, the shell frames the three views (users / API keys / audit)
// and a sign-out control, all inheriting the session's tenant scope + role. Nav is local state (no
// router dependency); every view calls the API under the same session cookie.
import { useState } from "react";

import { adminApi, type Principal } from "../api";
import { ApiKeys } from "../pages/ApiKeys";
import { Audit } from "../pages/Audit";
import { Users } from "../pages/Users";

type Tab = "users" | "api-keys" | "audit";

export function Shell({ who, onSignedOut }: { who: Principal; onSignedOut: () => void }): JSX.Element {
  const [tab, setTab] = useState<Tab>("users");

  async function signOut(): Promise<void> {
    try {
      await adminApi.logout();
    } finally {
      onSignedOut();
    }
  }

  return (
    <div className="shell">
      <header>
        <nav aria-label="Sections">
          <button type="button" aria-current={tab === "users"} onClick={() => setTab("users")}>
            Users
          </button>
          <button type="button" aria-current={tab === "api-keys"} onClick={() => setTab("api-keys")}>
            API Keys
          </button>
          <button type="button" aria-current={tab === "audit"} onClick={() => setTab("audit")}>
            Audit
          </button>
        </nav>
        <div className="session">
          <span>{who.role}</span>
          <button type="button" onClick={() => void signOut()}>
            Sign out
          </button>
        </div>
      </header>
      <main>
        {tab === "users" && <Users sessionRole={who.role} />}
        {tab === "api-keys" && <ApiKeys sessionRole={who.role} />}
        {tab === "audit" && <Audit />}
      </main>
    </div>
  );
}
