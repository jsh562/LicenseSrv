// Shared CSRF protection for cookie-authenticated state-changing requests (E005 FR-019, AD-006).
// Promoted to src/server/console/ so every console module reuses one double-submit implementation.
// The server issues a random token in a JS-readable cookie; the SPA echoes it in the X-CSRF-Token header
// on every mutating request. The server accepts only when the two match. SameSite=Strict on the session
// cookie is necessary but not sufficient; this is the second gate.
import { randomBytes, timingSafeEqual } from "node:crypto";
export const CSRF_COOKIE = "admin_csrf";
export const CSRF_HEADER = "x-csrf-token";
/** Issue a fresh anti-CSRF token (32 bytes, url-safe) to place in the readable CSRF cookie. */
export function issueCsrfToken() {
    return randomBytes(32).toString("base64url");
}
/** True iff both the cookie token and the header token are present and equal (timing-safe). */
export function csrfValid(cookieToken, headerToken) {
    if (!cookieToken || !headerToken)
        return false;
    const a = Buffer.from(cookieToken);
    const b = Buffer.from(headerToken);
    return a.length === b.length && timingSafeEqual(a, b);
}
