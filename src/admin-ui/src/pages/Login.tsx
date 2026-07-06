// Sign-in page (US1, FR-015). Collects tenant slug + email + password and calls the login endpoint.
// The server is enumeration-safe, so this surface shows a single generic error for any failure and a
// distinct throttled message on a 429 (locked). On success it hands the resolved principal upward.
import { useState, type FormEvent } from "react";

import { adminApi, ApiError, type Principal } from "../api";

export function Login({ onSignedIn }: { onSignedIn: (who: Principal) => void }): JSX.Element {
  const [tenantSlug, setTenantSlug] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await adminApi.login(tenantSlug.trim(), email.trim(), password);
      const who = await adminApi.me();
      onSignedIn(who);
    } catch (err) {
      if (err instanceof ApiError && err.status === 429) {
        setError("Too many attempts. Your account is temporarily locked — try again later.");
      } else {
        setError("Sign in failed. Check your workspace, email, and password.");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="login">
      <h1>Admin Console</h1>
      <form onSubmit={submit} aria-label="Sign in">
        <label>
          Workspace
          <input
            name="tenantSlug"
            value={tenantSlug}
            onChange={(e) => setTenantSlug(e.target.value)}
            autoComplete="organization"
            required
          />
        </label>
        <label>
          Email
          <input
            name="email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="username"
            required
          />
        </label>
        <label>
          Password
          <input
            name="password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
          />
        </label>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        <button type="submit" disabled={busy}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </main>
  );
}
