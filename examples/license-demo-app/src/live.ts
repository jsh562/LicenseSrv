// Live-issue mode: log into the running LicenseSrv API (same-origin via the Vite proxy) and issue a
// fresh license against the seeded plan/customer, then hand the signed token back to be verified with
// the bundled keyring. Mirrors examples/license-demo/issue-demo.mjs (login → CSRF → POST /admin/licenses).

function readCookie(name: string): string | null {
  const m = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return m ? decodeURIComponent(m[1]!) : null;
}

export interface LiveCreds {
  tenantSlug: string;
  email: string;
  password: string;
}

/** Log in, then issue a fresh license for the seeded plan+customer. Returns the signed LIC1 token. */
export async function issueLive(creds: LiveCreds, planId: string, customerId: string): Promise<string> {
  const login = await fetch("/admin/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ tenantSlug: creds.tenantSlug, email: creds.email, password: creds.password }),
  });
  if (!login.ok) throw new Error(`Login failed (HTTP ${login.status}). Is the stack up and seeded?`);

  const csrf = readCookie("admin_csrf");
  if (!csrf) throw new Error("No CSRF cookie after login.");

  const res = await fetch("/admin/licenses", {
    method: "POST",
    headers: { "content-type": "application/json", "x-csrf-token": csrf },
    credentials: "include",
    body: JSON.stringify({ planId, customerId }),
  });
  if (!res.ok) throw new Error(`Issue failed (HTTP ${res.status}): ${await res.text()}`);

  const body = (await res.json()) as { licenseKey?: string; license?: { licenseKey?: string } };
  const token = body.licenseKey ?? body.license?.licenseKey;
  if (!token) throw new Error("No licenseKey in the issue response.");
  return token;
}
