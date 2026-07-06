// Root: resolve an existing session on mount (GET /me), then show the console shell or the login page.
// A 401 simply means "not signed in" — the login form takes over. Sign-out returns here.
import { useEffect, useState } from "react";

import { adminApi, type Principal } from "./api";
import { Shell } from "./components/Shell";
import { Login } from "./pages/Login";

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

  if (!ready) return <p>Loading…</p>;
  if (!who) return <Login onSignedIn={setWho} />;
  return <Shell who={who} onSignedOut={() => setWho(null)} />;
}
