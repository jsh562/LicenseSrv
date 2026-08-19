# Admin Console — section reference

A plain-language guide to the LicenseSrv admin console: what each section in the left nav is
for, and — because the words look similar — how the different **keys and identities** in the
system actually differ.

If you only read one thing, read the next section.

## The four identities (read this first)

LicenseSrv has four things that people constantly conflate because three of them contain the
word "key". They are completely different:

| Thing | What it is | Who holds it | How it authenticates | Managed in |
|-------|------------|--------------|----------------------|------------|
| **User** | A **human** account for your team | People at your company | Email + password → a session cookie, plus a role (`owner` / `admin` / `viewer`) | **Users** |
| **API key** | A **machine** credential for your software | Your backend / SDK / CI | An `x-api-key` header, gated by **scopes** | **API Keys** |
| **Signing key** | The **cryptographic key that signs licenses** — one per *product* | The server (private half never leaves it) | n/a — it *produces* signatures; its **public** half is the "trusted key" verifiers pin | provisioned per product via the API (`POST /v1/products/:productId/signing-keys`) |
| **License / Customer** | A **signed token issued *for* a customer** (end-user) | Your customer's installed software | Verified **offline** against the product's public signing key | **Licensing** |

Two clarifications that trip everyone up:

- **The "trusted key" is the product, not the end user.** Each *product* gets its own signing
  key. Every license you issue for that product — no matter which customer it's for — is signed
  by that one product key, and every copy of your software trusts that same public key (its
  **keyring**, published at `GET /v1/products/:productId/keyring`). That's why the demo app shows
  the *same* trusted key for a valid, a tampered, and an expired license: they're all licenses of
  the same product. What tells them apart is inside each token (its license id, customer, expiry).
- **The customer is not a key and does not log in.** A customer is simply *who a license is for* —
  the `cid` claim baked into the token. Customers never sign in to this console; your team does.

Quick mental model: **Users** sign in · **API keys** let your software call in · **signing keys**
(per product) vouch for **licenses** · **customers** are who those licenses are for.

## Why the keys are shaped this way

A natural next question: *why* is the signing key per-product, is there also a per-license key, and
are those the only crypto keys? The whole scheme falls out of **one constraint**.

**The constraint: the verifier runs offline, embedded inside your shipped software, with no call
home.** That forces three things:

1. **Asymmetric signing (Ed25519).** The server holds a *private* key and signs licenses; your
   software holds only the *public* key and verifies. The public key can't forge anything, so it's
   safe to bake into every copy of the app (or publish openly) — the same pattern as TLS certs,
   code signing, and JWTs.
2. **The trust anchor is keyed at the unit of software distribution — the product.** The public key
   has to be pinned *in the binary*, so "which key do I trust?" is really "which product am I." One
   public key per product lets that product's software verify **any** license for it — any customer,
   forever, offline, with no per-customer key exchange.
3. **Per-product isolates blast radius and lifecycle.** Rotating or revoking one product's key never
   touches another product's licenses.

Why not the other granularities:

| Scheme | Why not |
|--------|---------|
| **One global key** (whole vendor) | A single private-key compromise or rotation hits *every* product at once; no per-product revocation. |
| **Per-customer key** | Software would need a different key per customer → reintroduces online key distribution, defeating offline verification; key management explodes. |
| **Per-license key** | Breaks offline verification — the verifier can't know a license's key in advance, so it'd fetch a key/cert-chain per license (an online lookup per validation). And it would *still* need a product-level root to sign it → pure overhead. |

**There is no per-license key.** A license is just **signed data** — CBOR claims (license id,
product, plan, customer, expiry, seats, entitlements, a fresh nonce, and for machine-bound tokens
some salted fingerprint hashes) signed **once** by the product key. Uniqueness and tamper-evidence
come from the signed payload + the per-issuance nonce, not from a key of its own. Flip one byte and
the product-key signature fails. (This is exactly why the demo shows the same trusted key *and the
same license id* for "valid" and "tampered" — the tampered one just fails signature verification.)
The token fields that look key-ish aren't: `sk` = clock-skew seconds, `fpk` = the *K* in K-of-N
fingerprint matching, `fp` = salted machine-signal hashes, `non` = anti-replay nonce.

**The other secrets** exist because different jobs need different crypto — but none is a per-license
keypair:

- **Keystore master key — server-global custody root.** Guards every private signing seed *at rest*:
  split with **Shamir k-of-n** custodian shares (no single admin/host holds it), reconstructed in
  memory at boot, AES-256-GCM envelope-encrypting the private keys. A database dump leaks nothing.
- **`API_KEY_SECRET` — server-global HMAC.** Hashes API keys so the DB stores only hashes.
- **Billing webhook secret — per billing-connection HMAC.** Verifies inbound provider webhooks;
  envelope-encrypted under the master, write-only, rotatable.
- **Session + CSRF tokens — per session.** Random opaque tokens (stored as hashes) for human login.
- **Fingerprint salts + rollback anchor — one-way values, not keys.**
- **Release signing — CI only, keyless cosign** (ephemeral OIDC identity); entirely separate from
  license signing.

The organizing principle: **asymmetric where a client must verify offline → per-product** (the public
half ships in the app); **symmetric/HMAC where only the server checks its own artifacts →
server-global or per-integration** (no public half needed); and **everything private-at-rest sits
under one custody root**. Full details:
[`specs/00005-signing-service-and-key-custody`](../specs/00005-signing-service-and-key-custody/spec.md).

## Sections

The left nav, top to bottom.

### Users
Human accounts that can sign in to this workspace. Invite teammates by email and set each one's
**role** — `owner` > `admin` > `viewer` (owners manage everything, admins operate, viewers read).
A safeguard prevents removing or demoting the **last owner**, so a workspace can never be locked
out. This is the *human* plane; machines use API Keys instead.

### API Keys
Machine credentials your software presents (as `x-api-key`) to call the runtime API — this is how
an embedded app activates, validates, leases, or reports usage without a human in the loop. Each
key carries one or more **scopes**: `activate` (node-lock activation), `validate` (online
enforcement), `lease` (floating seats), `usage.ingest` (usage metering), and `admin` (management).
The secret is shown **once** at creation — copy it then; it's never displayed again — and you can
**rotate** or **revoke** a key at any time. (The create form currently exposes `activate`,
`validate`, and `admin`; `lease` and `usage.ingest` exist in the model and gate their runtime
planes.) Unlike Users, API keys have no password and no role — they're gated purely by scope.

### Audit
A read-only, **append-only** record of everything that happened in the workspace — who did what,
when, to what. Filter by time range, by a specific actor, or to **security events only**, and page
through with "load more". There is deliberately no edit or delete: the log is immutable by
construction, so it can be trusted as evidence.

### Catalog
Where you model **what you sell**, no code required. Three nested concepts:
- **Products** — the applications you license (each product owns its own signing key).
- **Plans** — the sellable packages within a product (e.g. Free, Pro, Enterprise).
- **Entitlements** — the named capabilities a product can grant. Three types: **`boolean`** (an
  on/off feature flag), **`integer_limit`** (a numeric cap, e.g. seats), and **`metered`** (a
  consumption entitlement with an aggregation — `sum` / `count` / `unique_count` — a unit, and an
  optional allowance).

A plan assigns concrete **values** to a product's entitlements; those values are what get baked
into every license issued on that plan.

### Licensing
Issue and manage the licenses themselves.
- **Issue** — pick a product, plan, and customer (and an optional expiry; blank = perpetual) to
  mint a **signed LIC1 token**, shown once for you to deliver. If the signer is unavailable you'll
  get a `503` and **nothing is minted** (fail-closed — you never get a half-signed license).
- **Licenses** — the registry and full lifecycle: **suspend / reinstate**, **revoke**, and
  **transfer** a license to another customer (bounded by a per-license transfer limit).
- **Activations** — the machines a license is bound to (node-lock seats), with a
  seats-used-vs-limit summary; an admin can **reclaim a seat** by deactivating a machine.
- **Customers** — the end-users licenses are issued for (the `cid` inside each token). Includes a
  GDPR-style erase (anonymize if licensed, else delete).

### Billing
Connect a billing provider (**Stripe**, **Paddle**, or **generic**) so subscription changes drive
license lifecycle automatically. You map a provider plan → your catalog `{product, plan}`, set a
**grace** window, and can **rotate** the webhook signing secret or run an on-demand
**reconciliation**. Provider **webhooks** then suspend/reinstate licenses as subscriptions change,
under a synthetic (non-human) actor. The webhook secret is **write-only** — entered once, never
displayed. Note: LicenseSrv is the entitlement authority, **not** the payment processor — card
handling is out of scope.

### Leases
The operator view for **floating (concurrent) seats** — as opposed to node-lock activations. Where
an *activation* binds a license to a specific machine, a **lease** is a time-bounded checkout from
a shared pool: seats are acquired, renewed, and released (or expire), so a fixed number can float
across many machines. Enter a license id to see its live and recently-ended leases and a
concurrency-used-vs-cap summary (cap = `maxConcurrent` + overage), and **force-release** a live
lease to reclaim its seat immediately.

### Usage
The consumption view for **metered entitlements**. Enter a license id and a time window to see, per
metered entitlement, the aggregation type, unit, accrued **value**, optional **allowance**, and an
**over-quota** signal. Values are floored at zero for display by default; an admin can toggle
**true signed net** (`raw`) to see the exact stored value that billing true-up consumes. Read-only.
Consumption is fed by the `usage.ingest` API-key plane.

### Policy
A low-code rule engine that **adjusts entitlement decisions at issuance**. Author a guarded
**`when → then`** rule — a structured-JSON **condition** plus a typed **effect** (e.g.
`adjust_limit`), a **priority**, and a target entitlement — which the server validates against a
sandbox before saving. Rules move through a **lifecycle** (`preview` → `active` → `disabled`), keep
an immutable **version history**, and can be **dry-run** against a sample context or a real license
to preview which rule fires and the resulting decision — all without affecting live traffic until
you activate.

### Reseller
Partner / white-label multi-tenancy. One shell over four views:
- **Resellers** — platform-operator lifecycle for partner tenants: onboard, set a sub-tenant
  **quota**, suspend / reinstate / offboard, and **move** a sub-tenant between resellers.
- **Sub-tenants** — a reseller provisioning its own customer workspaces, up to quota.
- **Branding** — per-field white-labeling (names, colors, logos) with reseller defaults + locks.
- **Domains** — verifying custom domains and email senders (DNS + SPF/DKIM/DMARC).

Administration is **downward-only** — you can only manage tenants beneath you, and out-of-subtree
targets simply 404. Branding is presentation-only: it **never** changes license contents or the
signed token, and never white-labels security/trust signals (tamper/revocation notices, signing
identity, audit).

## Going deeper

- Each section maps to a feature spec under [`specs/`](../specs/) — e.g. Catalog →
  [`00008-no-code-licensing-catalog`](../specs/00008-no-code-licensing-catalog/spec.md),
  Licensing → [`00009-license-issuance-and-lifecycle`](../specs/00009-license-issuance-and-lifecycle/spec.md),
  Billing → [`00015-billing-driven-entitlement-automation`](../specs/00015-billing-driven-entitlement-automation/spec.md),
  Leases → [`00016-floating-and-concurrent-seats`](../specs/00016-floating-and-concurrent-seats/spec.md),
  Usage → [`00017-usage-metering-and-aggregation`](../specs/00017-usage-metering-and-aggregation/spec.md),
  Policy → [`00018-low-code-policy-rules`](../specs/00018-low-code-policy-rules/spec.md),
  Reseller → [`00019-reseller-and-white-label-tenancy`](../specs/00019-reseller-and-white-label-tenancy/spec.md).
  Signing keys are [`00005-signing-service-and-key-custody`](../specs/00005-signing-service-and-key-custody/spec.md);
  the offline verifier is [`00002-offline-verifier-core`](../specs/00002-offline-verifier-core/spec.md).
- The plain-language capability overview lives in [`specs/prd.md`](../specs/prd.md).
- To *see* it working end-to-end, run the demos: the CLI ([`examples/license-demo/`](../examples/license-demo/README.md),
  `npm run demo`) and the in-browser gated app ([`examples/license-demo-app/`](../examples/license-demo-app/README.md),
  `npm run demo-app`). See the ["Try it end-to-end"](../README.md) section of the root README.
