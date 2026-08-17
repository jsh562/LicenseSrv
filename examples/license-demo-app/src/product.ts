// The mock customer product ("Acme Analytics") whose Pro features gate on a verified license, plus a
// diagnostic details panel that shows WHICH license is loaded (decoded) and the verify result.
import type { Outcome } from "./verify";
import type { Claims } from "./token";

const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

const SOURCE_LABEL: Record<string, string> = {
  valid: "Valid license",
  tampered: "Tampered license",
  expired: "Expired license",
  pasted: "Pasted license",
  live: "Live-issued license",
};

function bars(n: number): string {
  const heights = [40, 65, 30, 80, 55, 70, 45];
  return `<div class="bars">${heights.slice(0, n).map((h) => `<span style="height:${h}%"></span>`).join("")}</div>`;
}

function fmtTime(unix: number | null): string {
  if (!unix) return "—";
  return new Date(unix * 1000).toLocaleString();
}

/** The product surface: an unlocked Pro dashboard, or a locked overlay explaining why. */
export function renderProduct(o: Outcome): string {
  const seats = o.seats ?? 0;
  const pro = o.pro;
  const overlay = pro
    ? ""
    : `<div class="overlay ${o.ok ? "" : "bad"}">
         <div class="box">
           <div class="lockicon">${o.ok ? "🔒" : "⛔"}</div>
           <h3>${o.ok ? "Pro plan required" : "License " + (o.code === 6 ? "expired" : "invalid")}</h3>
           <p>${o.ok ? "This license does not include Pro." : esc(o.reason)} — advanced analytics are locked.</p>
         </div>
       </div>`;
  return `
    <div class="product ${pro ? "" : "locked"}">
      <div class="appbar">
        <span class="name">Acme Analytics</span>
        <span class="pill ${pro ? "pro" : "free"}">${pro ? "PRO" : "FREE"}</span>
      </div>
      <div class="widgets">
        <div class="widget">
          <h3>Monthly revenue</h3>
          <div class="big">$48.2k</div>
          ${bars(7)}
        </div>
        <div class="widget">
          <h3>Active seats</h3>
          <div class="big">${pro ? 3 : "—"} <span style="font-size:14px;color:var(--fg-muted)">/ ${pro ? seats : "—"}</span></div>
          <div class="note">Pro seat pooling</div>
        </div>
        <div class="widget">
          <h3>Advanced reports</h3>
          <div class="big">${pro ? "12" : "0"}</div>
          <div class="note">Cohort · funnel · retention</div>
        </div>
        <div class="widget">
          <h3>Data export</h3>
          <div class="big">${pro ? "CSV · API" : "—"}</div>
          <div class="note">Pro only</div>
        </div>
      </div>
      ${overlay}
    </div>`;
}

export interface DetailCtx {
  source: string;
  token: string;
  claims: Claims | null;
  trustedKid: string | null;
}

/** The diagnostic panel: which license is loaded (decoded), the verify result, and the trusted key. */
export function renderDetails(o: Outcome, ctx: DetailCtx): string {
  const row = (k: string, v: string): string => `<div class="detail-row"><span class="k">${k}</span><span class="v">${v}</span></div>`;
  const badge = o.ok ? `<span class="badge ok">OK</span>` : `<span class="badge bad">DENIED</span>`;
  const c = ctx.claims;

  // Which license is this? (decoded from the token — this is how you tell them apart).
  const tamperedNote =
    ctx.source === "tampered"
      ? `<p class="note">Same license as “Valid” — but one byte of its signature was flipped, so verification fails.</p>`
      : "";
  const licenseBlock = c
    ? `
      ${row("Source", `<span class="badge src">${esc(SOURCE_LABEL[ctx.source] ?? ctx.source)}</span>`)}
      ${row("License ID", esc(c.licenseId))}
      ${row("Customer", esc(c.customerId))}
      ${row("Plan", esc(c.planId))}
      ${row("Issued", fmtTime(c.issuedAt))}
      ${row("Expires", c.expiresAt ? fmtTime(c.expiresAt) : "Perpetual")}
      ${row("Signed by key", esc(c.keyId))}
      ${tamperedNote}
      <details class="tokbox"><summary>Show LIC1 token</summary><div class="token">${esc(ctx.token)}</div></details>`
    : `${row("Source", `<span class="badge src">${esc(SOURCE_LABEL[ctx.source] ?? ctx.source)}</span>`)}
       <p class="note">Could not decode this token's claims (is it a valid LIC1 token?).</p>
       <details class="tokbox"><summary>Show token</summary><div class="token">${esc(ctx.token)}</div></details>`;

  return `
    <h3 class="sub-h">Current license</h3>
    ${licenseBlock}
    <h3 class="sub-h">Verification (offline, in-browser)</h3>
    ${row("Result", `${badge} <span class="v">${esc(o.reason)}</span>`)}
    ${row("Reason code", String(o.code))}
    ${row("Entitlements", "")}
    <div class="ents">
      <span class="ent">pro = ${o.pro}</span>
      ${o.seats !== undefined ? `<span class="ent">seats = ${o.seats}</span>` : ""}
    </div>
    ${ctx.trustedKid ? row("Trusted key", `${esc(ctx.trustedKid)} <span class="k" style="font-weight:400">— product public key, shared by every license</span>`) : ""}
    ${o.nextAnchor ? row("Next anchor", String(o.nextAnchor)) : ""}
    <p class="note">Verified 100% in your browser by the Rust core (WASM) — no network call.</p>`;
}
