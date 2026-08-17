// Sign-in page (US1, FR-015). Collects tenant slug + email + password and calls the login endpoint.
// The server is enumeration-safe, so this surface shows a single generic error for any failure and a
// distinct throttled message on a 429 (locked). On success it hands the resolved principal upward.
import { useState, type FormEvent } from "react";

import { adminApi, ApiError, type Principal } from "../api";
import { Button } from "../components/ui/Button";
import { Card } from "../components/ui/Card";
import { Field, Input } from "../components/ui/Field";

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
    <main className="login grid min-h-full place-items-center p-6">
      <Card className="w-full max-w-sm p-6">
        <div className="mb-6 flex items-center gap-2">
          <span className="grid h-8 w-8 place-items-center rounded-md bg-primary text-base font-bold text-primary-fg">
            L
          </span>
          <h1 className="text-lg font-semibold tracking-tight">Admin Console</h1>
        </div>
        <form onSubmit={submit} aria-label="Sign in" className="space-y-4">
          <Field label="Workspace">
            <Input
              name="tenantSlug"
              value={tenantSlug}
              onChange={(e) => setTenantSlug(e.target.value)}
              autoComplete="organization"
              required
            />
          </Field>
          <Field label="Email">
            <Input
              name="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="username"
              required
            />
          </Field>
          <Field label="Password">
            <Input
              name="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              required
            />
          </Field>
          {error && (
            <p role="alert" className="error text-sm text-danger">
              {error}
            </p>
          )}
          <Button type="submit" className="w-full" loading={busy}>
            {busy ? "Signing in…" : "Sign in"}
          </Button>
        </form>
      </Card>
    </main>
  );
}
