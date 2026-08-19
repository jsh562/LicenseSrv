import { renderProduct, renderDetails } from "./product";
import { issueLive } from "./live";
import { decodeClaims } from "./token";
import { ensureReady, buildKeyring, verifyToken, tamper, coreAbi } from "./verify";

interface Bundle {
  keyring: { keys: { kid: string; x: string }[] };
  goodToken: string;
  expiringToken: string;
  expiresAtUnix: number;
  planId: string;
  customerId: string;
}

const $ = <T extends HTMLElement = HTMLElement>(sel: string): T => {
  const el = document.querySelector<T>(sel);
  if (!el) throw new Error(`missing element ${sel}`);
  return el;
};
const nowUnix = (): number => Math.floor(Date.now() / 1000);

function layout(): void {
  $("#app").innerHTML = `
    <header class="top">
      <div class="logo">A</div>
      <div>
        <h1>Acme Analytics</h1>
        <div class="sub">a mock product embedding the LicenseSrv verifier core</div>
      </div>
    </header>
    <p class="tagline">Every check below runs <strong>in your browser</strong> via the Rust verifier (WASM) — no network call to validate the signature. Pick a license and watch Pro lock/unlock.</p>
    <div class="grid">
      <div class="card">
        <div class="tabs">
          <button data-tab="offline" class="active">Offline</button>
          <button data-tab="live">Live issue</button>
        </div>
        <div id="offline-panel">
          <h2>Choose a license</h2>
          <div class="choices">
            <button class="choice active" data-mode="valid">✅ Valid license<small>signed &amp; unexpired — Pro unlocks</small></button>
            <button class="choice" data-mode="tampered">✏️ Tampered<small>one signature byte flipped</small></button>
            <button class="choice" data-mode="expired">⏰ Expired<small>checked past its expiry</small></button>
            <button class="choice" data-mode="paste">📋 Paste your own</button>
          </div>
          <div id="paste-area" style="display:none">
            <label>LIC1 token</label>
            <textarea id="paste-token" rows="5" placeholder="LIC1...."></textarea>
            <button class="action" id="verify-paste">Verify</button>
          </div>
        </div>
        <div id="live-panel" style="display:none">
          <h2>Issue a fresh license</h2>
          <label>Workspace</label><input id="live-tenant" value="acme" />
          <label>Email</label><input id="live-email" value="admin@acme.test" />
          <label>Password</label><input id="live-pass" type="password" value="password123!" />
          <button class="action" id="live-issue">Log in &amp; issue</button>
          <p class="note">Requires the stack running (<code>docker compose up</code>) with <code>npm run demo</code> run once.</p>
          <div id="live-err" class="err" style="display:none"></div>
        </div>
      </div>
      <div>
        <div class="card"><div id="product"></div></div>
        <div class="card" style="margin-top:20px"><h2>Verification details</h2><div id="details"></div></div>
      </div>
    </div>
    <p class="note" id="abi" style="text-align:center;margin-top:20px"></p>`;
}

let bundle: Bundle;
let keyring: ReturnType<typeof buildKeyring>;
let trustedKid: string | null = null;

function showFor(source: string, token: string, at: number): void {
  const o = verifyToken(keyring, token, at);
  $("#product").innerHTML = renderProduct(o);
  $("#details").innerHTML = renderDetails(o, { source, token, claims: decodeClaims(token), trustedKid });
}

function verifyMode(mode: string): void {
  if (mode === "valid") showFor("valid", bundle.goodToken, nowUnix());
  else if (mode === "tampered") showFor("tampered", tamper(bundle.goodToken), nowUnix());
  else if (mode === "expired") showFor("expired", bundle.expiringToken, bundle.expiresAtUnix + 3600);
}

function wire(): void {
  // Tabs
  document.querySelectorAll<HTMLButtonElement>(".tabs button").forEach((b) => {
    b.addEventListener("click", () => {
      document.querySelectorAll(".tabs button").forEach((x) => x.classList.remove("active"));
      b.classList.add("active");
      const live = b.dataset.tab === "live";
      $("#offline-panel").style.display = live ? "none" : "";
      $("#live-panel").style.display = live ? "" : "none";
    });
  });

  // Offline choices
  document.querySelectorAll<HTMLButtonElement>(".choice").forEach((b) => {
    b.addEventListener("click", () => {
      document.querySelectorAll(".choice").forEach((x) => x.classList.remove("active"));
      b.classList.add("active");
      const mode = b.dataset.mode!;
      $("#paste-area").style.display = mode === "paste" ? "" : "none";
      if (mode !== "paste") verifyMode(mode);
    });
  });

  $("#verify-paste").addEventListener("click", () => {
    const token = $<HTMLTextAreaElement>("#paste-token").value.trim();
    if (token) showFor("pasted", token, nowUnix());
  });

  // Live issue
  $("#live-issue").addEventListener("click", () => {
    const btn = $<HTMLButtonElement>("#live-issue");
    const err = $("#live-err");
    err.style.display = "none";
    btn.disabled = true;
    btn.textContent = "Issuing…";
    issueLive(
      {
        tenantSlug: $<HTMLInputElement>("#live-tenant").value.trim(),
        email: $<HTMLInputElement>("#live-email").value.trim(),
        password: $<HTMLInputElement>("#live-pass").value,
      },
      bundle.planId,
      bundle.customerId,
    )
      .then((token) => showFor("live", token, nowUnix()))
      .catch((e: unknown) => {
        err.textContent = e instanceof Error ? e.message : String(e);
        err.style.display = "";
      })
      .finally(() => {
        btn.disabled = false;
        btn.textContent = "Log in & issue";
      });
  });
}

async function boot(): Promise<void> {
  layout();
  try {
    bundle = (await (await fetch("/demo-bundle.json")).json()) as Bundle;
  } catch {
    $("#product").innerHTML = `<p class="err">Could not load demo-bundle.json. Run <code>node scripts/prepare-demo-app.mjs</code> (after <code>npm run demo</code>) to generate it.</p>`;
    return;
  }
  await ensureReady();
  keyring = buildKeyring(bundle.keyring.keys);
  trustedKid = bundle.keyring.keys[0]?.kid ?? null;
  $("#abi").textContent = `verifier core ABI v${coreAbi()} · ${bundle.keyring.keys.length} trusted key(s)`;
  wire();
  verifyMode("valid"); // default view: a valid license, Pro unlocked
}

void boot();
