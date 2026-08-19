// The authenticated console frame: a persistent sidebar (deep-linkable section nav) + a topbar
// (role badge, dark-mode toggle, sign out) around the routed page `<Outlet/>`. Replaces the old
// useState-tab Shell; every section is now a real URL.
import { useEffect, useState } from "react";
import { NavLink, Outlet } from "react-router-dom";

import { adminApi } from "../api";
import { useSession } from "../session";
import { Badge } from "./ui/Badge";

const SECTIONS: { to: string; label: string }[] = [
  { to: "/users", label: "Users" },
  { to: "/api-keys", label: "API Keys" },
  { to: "/audit", label: "Audit" },
  { to: "/catalog", label: "Catalog" },
  { to: "/licensing", label: "Licensing" },
  { to: "/billing", label: "Billing" },
  { to: "/leases", label: "Leases" },
  { to: "/usage", label: "Usage" },
  { to: "/policy", label: "Policy" },
  { to: "/reseller", label: "Reseller" },
];

function useDarkMode(): [boolean, () => void] {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains("dark"));
  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
    try {
      localStorage.setItem("ls-theme", dark ? "dark" : "light");
    } catch {
      /* ignore */
    }
  }, [dark]);
  return [dark, () => setDark((d) => !d)];
}

export function AppLayout(): JSX.Element | null {
  const { who, setWho } = useSession();
  const [dark, toggleDark] = useDarkMode();
  if (!who) return null;

  async function signOut(): Promise<void> {
    try {
      await adminApi.logout();
    } finally {
      setWho(null);
    }
  }

  return (
    <div className="flex h-full">
      <aside className="flex w-56 shrink-0 flex-col border-r border-border bg-surface">
        <div className="flex h-14 items-center gap-2 border-b border-border px-4">
          <span className="grid h-7 w-7 place-items-center rounded-md bg-primary text-sm font-bold text-primary-fg">
            L
          </span>
          <span className="font-semibold tracking-tight">LicenseSrv</span>
        </div>
        <nav aria-label="Sections" className="flex-1 space-y-0.5 overflow-y-auto p-2">
          {SECTIONS.map((s) => (
            <NavLink
              key={s.to}
              to={s.to}
              className={({ isActive }) =>
                `block rounded-md px-3 py-2 text-sm font-medium transition-colors ${
                  isActive
                    ? "bg-primary/10 text-primary"
                    : "text-fg-muted hover:bg-surface-muted hover:text-fg"
                }`
              }
            >
              {s.label}
            </NavLink>
          ))}
        </nav>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center justify-end gap-3 border-b border-border bg-surface px-6">
          <div className="session flex items-center gap-3">
            <Badge tone="info" aria-label="Your role">
              {who.role}
            </Badge>
            <button
              type="button"
              onClick={toggleDark}
              aria-label="Toggle dark mode"
              className="rounded-md p-1.5 text-fg-muted hover:bg-surface-muted hover:text-fg"
            >
              {dark ? "☀" : "☾"}
            </button>
            <button
              type="button"
              onClick={() => void signOut()}
              className="rounded-md border border-border px-3 py-1.5 text-sm font-medium hover:bg-surface-muted"
            >
              Sign out
            </button>
          </div>
        </header>
        <main className="min-h-0 flex-1 overflow-y-auto p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
