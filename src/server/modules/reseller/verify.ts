// Domain / email-sender ownership verification — the `domain_binding` state machine + one-binding-per-host
// (E018, US5; FR-013; AD-006, INV-5/6). A reseller proves it OWNS a custom domain (via a DNS TXT/CNAME
// challenge) or is AUTHORIZED to send as an email sender (via SPF + DKIM/DMARC alignment) BEFORE that
// domain/sender may white-label the experience (verify-before-activate). A binding walks `pending → verified
// → active`; a given host binds to AT MOST ONE tenant globally (the migration's partial-unique index).
//
// THE MODEL (data-model.md "one-binding-per-host", INV-5/6):
//   * INITIATE creates a `pending` binding + returns the PUBLIC DNS challenge records to publish. Multiple
//     tenants MAY hold a `pending` claim on the same host (no squatting lock-out of the true owner); a host
//     ALREADY verified/active by ANOTHER tenant is refused `409 binding_conflict`.
//   * VERIFY runs the DNS proof (via the INJECTED {@link DnsResolver} — never a real network lookup in the
//     module logic, so tests are deterministic). Proof met → `pending → verified` (`verified_at` set); the
//     losing claim on a host already verified/active by another tenant hits the global partial-unique index
//     → `409 binding_conflict`. Proof unmet → the binding STAYS `pending` and the unmet records are returned
//     `409 not_verified`. An already verified/active binding is an idempotent no-op.
//   * ACTIVATE promotes `verified → active` (`activated_at` set) for white-label. A `pending` binding cannot
//     be activated → `409 not_verified`. An already-`active` binding is an idempotent no-op.
//
// HOST NORMALIZATION (data-model resolved decision): every host is stored/compared NORMALIZED — trim, lower-
// case, strip a trailing dot, and IDNA/punycode (ToASCII) for domain labels — so the global-uniqueness key
// and inbound Host→tenant routing always compare canonical forms.
//
// The DNS challenge token is a PUBLIC proof, never a secret; this module performs NO cryptography and holds no
// secret (presentation-only, Principle I). Cross-tenant conflict detection + inbound-host routing run on the
// audited `privileged` seam (a request has no tenant scope yet); a tenant's OWN bindings read/write under its
// OWN `app.current_tenant` (forced RLS).
import { randomUUID } from "node:crypto";
import { domainToASCII } from "node:url";

import type pg from "pg";

import { privileged, withTenant } from "../../db/client.js";
import type { BrandingFieldName } from "./branding.js";
import { ResellerError } from "./index.js";

/** What is being verified (contract `VerificationKind`) — a custom `domain` or an `email_sender`. */
export type VerificationKind = "domain" | "email_sender";

/** The `domain_binding.binding_type` DB value (data-model). `domain` ↔ `custom_domain`; `email_sender` ↔ `email_sender`. */
export type BindingType = "custom_domain" | "email_sender";

/** The `domain_binding.verification_method` DB value — DNS TXT/CNAME (domain) or SPF+DKIM/DMARC (email). */
export type VerificationMethod = "dns_txt" | "dns_cname" | "spf_dkim_dmarc";

/** A `domain_binding.status` — the three-state lifecycle (contract `BindingStatus`). */
export type BindingStatus = "pending" | "verified" | "active";

/** A DNS record the owner must publish to prove ownership/send-authorization (contract `DnsRecord`). PUBLIC, never a secret. */
export interface DnsRecord {
  purpose: "domain_ownership" | "spf" | "dkim" | "dmarc";
  recordType: "TXT" | "CNAME";
  name: string;
  value: string;
}

/**
 * A resolved domain/email-sender binding (contract `DomainBinding`). `challenge` is DERIVED from the stored
 * `binding_type`/`host`/`verification_method`/`challenge_token` at read (never a stored column) so it always
 * reflects the canonical records to publish. Timestamps are `Date`; the route layer serializes to ISO-8601.
 */
export interface DomainBinding {
  bindingId: string;
  kind: VerificationKind;
  host: string;
  status: BindingStatus;
  verificationMethod: VerificationMethod;
  challenge: DnsRecord[];
  verifiedAt: Date | null;
  activatedAt: Date | null;
  createdAt: Date;
}

/**
 * The injected DNS-lookup surface (AD-006, implementation-standards §3 Determinism). Mirrors the subset of
 * `node:dns/promises` the verifier needs, so the production adapter is a thin pass-through while unit +
 * integration tests supply results DETERMINISTICALLY with NO real network access. A lookup that finds nothing
 * MAY reject (as `node:dns` does on `ENOTFOUND`/`ENODATA`) — the checker treats a rejection as "record absent".
 */
export interface DnsResolver {
  /** Resolve TXT records — an array of records, each a list of string chunks (joined to one value). */
  resolveTxt(hostname: string): Promise<string[][]>;
  /** Resolve CNAME records — the canonical target hostnames. */
  resolveCname(hostname: string): Promise<string[]>;
}

// --- DNS challenge scaffolding (PUBLIC, deterministic; not secrets) -------------------------------------------

/** The challenge sub-domain prefix a domain-ownership record is published under. */
export const CHALLENGE_HOST_PREFIX = "_licensing-challenge";
/** The TXT challenge value prefix — `<prefix><token>` is the record the owner publishes. */
export const CHALLENGE_VALUE_PREFIX = "lic-verify=";
/** The CNAME challenge target suffix — `<token><suffix>` is the canonical name the owner points to. */
export const CHALLENGE_CNAME_SUFFIX = ".verify.licensing.example";
/** The DKIM selector the email-sender alignment record is published under (`<selector>._domainkey.<host>`). */
export const DKIM_SELECTOR = "licensing";
/** The SPF include token an email sender must authorize in its `v=spf1` record. */
export const SPF_INCLUDE = "_spf.licensing.example";

/** Map the contract `kind` to the DB `binding_type`. */
export function kindToBindingType(kind: VerificationKind): BindingType {
  return kind === "domain" ? "custom_domain" : "email_sender";
}

/** Map the DB `binding_type` back to the contract `kind`. */
export function bindingTypeToKind(bindingType: BindingType): VerificationKind {
  return bindingType === "custom_domain" ? "domain" : "email_sender";
}

/**
 * The DEFAULT verification method for a kind (FR-013): a custom domain proves ownership via a DNS TXT
 * challenge; an email sender proves send-authorization via SPF + DKIM/DMARC alignment. A domain MAY instead
 * use a CNAME challenge (see {@link methodMatchesKind}).
 */
export function defaultMethod(kind: VerificationKind): VerificationMethod {
  return kind === "domain" ? "dns_txt" : "spf_dkim_dmarc";
}

/**
 * Whether a verification method is valid for a kind — mirrors the `domain_binding_method_shape` DB CHECK:
 * a `domain` uses `dns_txt`/`dns_cname`; an `email_sender` uses `spf_dkim_dmarc`. Enforced at the service
 * layer so a mismatched method fails fast with `validation_error` before hitting the DB.
 */
export function methodMatchesKind(kind: VerificationKind, method: VerificationMethod): boolean {
  return kind === "domain"
    ? method === "dns_txt" || method === "dns_cname"
    : method === "spf_dkim_dmarc";
}

/**
 * NORMALIZE a host to its canonical form (data-model resolved decision): (1) trim surrounding whitespace,
 * (2) lower-case, (3) strip a trailing dot (drop the root label), (4) convert Unicode/IDN labels to ASCII
 * punycode (IDNA ToASCII). The SAME normalization is applied at write time AND at inbound Host→tenant lookup,
 * so the global partial-unique key and the routing seam always compare canonical forms (INV-5). Pure.
 */
export function normalizeHost(input: string): string {
  let host = input.trim().toLowerCase();
  if (host.endsWith(".")) host = host.slice(0, -1);
  // `domainToASCII` returns "" for an input it cannot parse as a domain; fall back to the lower-cased form so
  // a malformed host still normalizes deterministically (later validated/refused at the DB/route boundary).
  const ascii = domainToASCII(host);
  return ascii !== "" ? ascii : host;
}

/** The sending DOMAIN of an email-sender address (the part after `@`), normalized — the `email_sender` binding host. */
export function emailSenderDomain(emailOrDomain: string): string {
  const at = emailOrDomain.lastIndexOf("@");
  const domain = at >= 0 ? emailOrDomain.slice(at + 1) : emailOrDomain;
  return normalizeHost(domain);
}

/** Generate a fresh PUBLIC challenge token (not a secret) — a short, URL/DNS-safe hex value. */
export function generateChallengeToken(): string {
  return randomUUID().replace(/-/g, "").slice(0, 16);
}

/**
 * Build the canonical DNS records to publish for a binding (FR-013). Deterministic in
 * `(kind, host, method, token)` so the SAME records are surfaced at initiate AND checked at verify:
 *   * domain + `dns_txt`   → a TXT `_licensing-challenge.<host>` = `lic-verify=<token>` (ownership).
 *   * domain + `dns_cname` → a CNAME `_licensing-challenge.<host>` → `<token>.verify.licensing.example`.
 *   * email  + `spf_dkim_dmarc` → SPF (`v=spf1 include:… ~all`) + DKIM (`<sel>._domainkey.<host>`) + DMARC
 *     (`_dmarc.<host>`) — proving authorized SENDING, not mere address control.
 * Pure; the token/records are PUBLIC.
 */
export function buildChallengeRecords(
  kind: VerificationKind,
  host: string,
  method: VerificationMethod,
  token: string,
): DnsRecord[] {
  if (kind === "domain") {
    const name = `${CHALLENGE_HOST_PREFIX}.${host}`;
    if (method === "dns_cname") {
      return [{ purpose: "domain_ownership", recordType: "CNAME", name, value: `${token}${CHALLENGE_CNAME_SUFFIX}` }];
    }
    return [{ purpose: "domain_ownership", recordType: "TXT", name, value: `${CHALLENGE_VALUE_PREFIX}${token}` }];
  }
  // email_sender → SPF + DKIM/DMARC alignment.
  return [
    { purpose: "spf", recordType: "TXT", name: host, value: `v=spf1 include:${SPF_INCLUDE} ~all` },
    { purpose: "dkim", recordType: "TXT", name: `${DKIM_SELECTOR}._domainkey.${host}`, value: `v=DKIM1; k=rsa; p=${token}` },
    { purpose: "dmarc", recordType: "TXT", name: `_dmarc.${host}`, value: `v=DMARC1; p=none` },
  ];
}

/** The outcome of a DNS challenge check — `met` when EVERY record is satisfied; else the `unmet` records. */
export interface VerificationCheck {
  met: boolean;
  unmet: DnsRecord[];
}

/** Flatten a TXT lookup (chunked per record) to one joined string per record. */
function flattenTxt(records: string[][]): string[] {
  return records.map((chunks) => chunks.join(""));
}

/** Strip a trailing dot so a CNAME target compares canonically (DNS returns FQDNs with/without a root dot). */
function stripDot(v: string): string {
  return v.endsWith(".") ? v.slice(0, -1) : v;
}

/** Whether a single DNS record is satisfied by the injected resolver. A resolver rejection ⇒ "absent" ⇒ false. */
async function recordSatisfied(record: DnsRecord, dns: DnsResolver): Promise<boolean> {
  try {
    if (record.recordType === "CNAME") {
      const targets = await dns.resolveCname(record.name);
      const want = stripDot(record.value.toLowerCase());
      return targets.some((t) => stripDot(t.trim().toLowerCase()) === want);
    }
    const values = flattenTxt(await dns.resolveTxt(record.name));
    switch (record.purpose) {
      case "spf":
        return values.some((v) => v.includes("v=spf1") && v.includes(`include:${SPF_INCLUDE}`));
      case "dkim":
        return values.some((v) => v.includes("v=DKIM1") && v.includes(record.value.split("p=")[1] ?? " "));
      case "dmarc":
        return values.some((v) => v.includes("v=DMARC1"));
      case "domain_ownership":
      default:
        return values.some((v) => v.trim() === record.value);
    }
  } catch {
    // A DNS rejection (ENOTFOUND/ENODATA/timeout) is treated as "record not published" — the challenge is unmet,
    // never a thrown 500. No silent success (implementation-standards §2 No Silent Failures).
    return false;
  }
}

/**
 * Check a binding's DNS challenge against the INJECTED resolver (AD-006). A binding is proven only when EVERY
 * published record is satisfied — a domain TXT/CNAME match, or an email SPF-include + DKIM + DMARC alignment.
 * Pure over the injected resolver (no real network); returns the unmet records for a `not_verified` detail.
 */
export async function checkDnsChallenge(records: DnsRecord[], dns: DnsResolver): Promise<VerificationCheck> {
  const unmet: DnsRecord[] = [];
  for (const record of records) {
    if (!(await recordSatisfied(record, dns))) unmet.push(record);
  }
  return { met: unmet.length === 0, unmet };
}

// --- state-machine transition decisions (pure — unit-testable without a DB) -----------------------------------

/** The decision a `verify` call reaches BEFORE touching the DB (pure state-machine transition). */
export type VerifyDecision = "check_dns" | "noop";
/** The decision an `activate` call reaches BEFORE touching the DB (pure state-machine transition). */
export type ActivateDecision = "activate" | "noop" | "reject_not_verified";

/**
 * The `verify` transition (FR-013): a `pending` binding must have its DNS proof checked; an already
 * `verified`/`active` binding is an idempotent no-op (contract: verify on a verified/active binding returns
 * 200 with the current state, no transition). Pure.
 */
export function decideVerify(status: BindingStatus): VerifyDecision {
  return status === "pending" ? "check_dns" : "noop";
}

/**
 * The `activate` transition (FR-013, verify-before-activate): a `verified` binding activates; an already
 * `active` binding is an idempotent no-op; a `pending` binding is REFUSED `409 not_verified` (ownership must
 * be proven first). Pure.
 */
export function decideActivate(status: BindingStatus): ActivateDecision {
  if (status === "active") return "noop";
  if (status === "verified") return "activate";
  return "reject_not_verified";
}

// ==== DomainVerifier — the `domain_binding` data-access + verification state machine ==========================

interface DomainBindingRow_ {
  id: string;
  binding_type: BindingType;
  host: string;
  status: BindingStatus;
  verification_method: VerificationMethod;
  challenge_token: string;
  verified_at: Date | null;
  activated_at: Date | null;
  created_at: Date;
}

const BINDING_COLUMNS =
  "id, binding_type, host, status, verification_method, challenge_token, verified_at, activated_at, created_at";

/** Postgres unique-violation SQLSTATE — the global one-binding-per-host index firing (→ 409 binding_conflict). */
const UNIQUE_VIOLATION = "23505";

function mapBinding(row: DomainBindingRow_): DomainBinding {
  const kind = bindingTypeToKind(row.binding_type);
  return {
    bindingId: row.id,
    kind,
    host: row.host,
    status: row.status,
    verificationMethod: row.verification_method,
    challenge: buildChallengeRecords(kind, row.host, row.verification_method, row.challenge_token),
    verifiedAt: row.verified_at,
    activatedAt: row.activated_at,
    createdAt: row.created_at,
  };
}

/** Whether a thrown error is a Postgres unique-violation (the one-binding-per-host index). */
function isUniqueViolation(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { code?: string }).code === UNIQUE_VIOLATION;
}

/** The binding-backed branding field ↔ `binding_type` mapping — the only two fields gated on an active binding. */
const FIELD_TO_BINDING_TYPE: Record<"customDomain" | "emailSenderAddress", BindingType> = {
  customDomain: "custom_domain",
  emailSenderAddress: "email_sender",
};

/**
 * The domain/email-sender ownership verifier (T045). Owns the `domain_binding` lifecycle + the one-binding-
 * per-host guarantee, driving DNS proofs through the INJECTED {@link DnsResolver} so verification is
 * deterministic and network-free (AD-006). Stateless apart from the pool + resolver; one shared instance.
 */
export class DomainVerifier {
  constructor(
    private readonly pool: pg.Pool,
    private readonly dns: DnsResolver,
  ) {}

  /**
   * INITIATE a `pending` binding for a host + return the DNS challenge to publish (FR-013). The host is
   * NORMALIZED; the method defaults per kind (or an explicit method is validated against the kind's shape).
   * A host ALREADY verified/active by ANOTHER tenant is refused `409 binding_conflict` (no cross-tenant
   * disclosure) — but a `pending` claim never locks out the true owner (multiple pendings are allowed).
   */
  async initiate(
    tenantId: string,
    params: { kind: VerificationKind; host: string; method?: VerificationMethod },
  ): Promise<DomainBinding> {
    const kind = params.kind;
    const method = params.method ?? defaultMethod(kind);
    if (!methodMatchesKind(kind, method)) {
      throw new ResellerError("validation_error", 400, "verification method does not match the binding kind", {
        kind,
        method,
      });
    }
    const bindingType = kindToBindingType(kind);
    const host = kind === "email_sender" ? emailSenderDomain(params.host) : normalizeHost(params.host);
    if (host === "") {
      throw new ResellerError("validation_error", 400, "a valid host is required", { host: params.host });
    }
    // A host already bound (verified/active) to ANOTHER tenant is refused up front (contract 409 binding_conflict).
    const owner = await this.boundHostOwner(bindingType, host);
    if (owner !== null && owner !== tenantId) {
      throw new ResellerError("binding_conflict", 409, "host is already bound to another tenant", {
        host,
        kind,
      });
    }
    const token = generateChallengeToken();
    const id = randomUUID();
    return withTenant(this.pool, tenantId, async (q) => {
      const r = await q(
        `INSERT INTO domain_binding
           (id, tenant_id, binding_type, host, status, verification_method, challenge_token)
         VALUES ($1, current_setting('app.current_tenant')::uuid, $2, $3, 'pending', $4, $5)
         RETURNING ${BINDING_COLUMNS}`,
        [id, bindingType, host, method, token],
      );
      return mapBinding(r.rows[0] as DomainBindingRow_);
    });
  }

  /** List the calling tenant's bindings (own scope; forced RLS), deterministically ordered `(host, id)`. */
  async list(tenantId: string): Promise<DomainBinding[]> {
    return withTenant(this.pool, tenantId, async (q) => {
      const r = await q(
        `SELECT ${BINDING_COLUMNS} FROM domain_binding
          WHERE tenant_id = current_setting('app.current_tenant')::uuid
          ORDER BY host ASC, id ASC`,
      );
      return (r.rows as DomainBindingRow_[]).map(mapBinding);
    });
  }

  /** Get ONE of the calling tenant's bindings (own scope). Null when unknown / cross-tenant (caller → 404). */
  async get(tenantId: string, bindingId: string): Promise<DomainBinding | null> {
    return withTenant(this.pool, tenantId, async (q) => {
      const r = await q(
        `SELECT ${BINDING_COLUMNS} FROM domain_binding
          WHERE tenant_id = current_setting('app.current_tenant')::uuid AND id = $1`,
        [bindingId],
      );
      return r.rowCount ? mapBinding(r.rows[0] as DomainBindingRow_) : null;
    });
  }

  /**
   * VERIFY a binding — run its DNS proof and, if met, transition `pending → verified` (FR-013). An unknown
   * binding → `404 not_found`; an already verified/active binding is an idempotent no-op (200 current state);
   * an unmet proof leaves it `pending` and returns `409 not_verified` (with the unmet records); a host
   * verified/active by another tenant first → `409 binding_conflict` (the global partial-unique index).
   */
  async verify(tenantId: string, bindingId: string): Promise<DomainBinding> {
    const binding = await this.get(tenantId, bindingId);
    if (!binding) throw new ResellerError("not_found", 404, "binding not found", { bindingId });
    if (decideVerify(binding.status) === "noop") return binding; // already verified/active — idempotent no-op.

    const check = await checkDnsChallenge(binding.challenge, this.dns);
    if (!check.met) {
      throw new ResellerError("not_verified", 409, "the DNS challenge is not yet satisfied", {
        bindingId,
        host: binding.host,
        unmet: check.unmet,
      });
    }
    // Guard the cross-tenant conflict BEFORE the write (no disclosure of which tenant holds it); the DB index
    // is the authoritative safety net (a concurrent claim → unique_violation → binding_conflict).
    const bindingType = kindToBindingType(binding.kind);
    const owner = await this.boundHostOwner(bindingType, binding.host);
    if (owner !== null && owner !== tenantId) {
      throw new ResellerError("binding_conflict", 409, "host is already bound to another tenant", {
        host: binding.host,
        kind: binding.kind,
      });
    }
    try {
      return await withTenant(this.pool, tenantId, async (q) => {
        const r = await q(
          `UPDATE domain_binding
              SET status = 'verified', verified_at = now(), updated_at = now()
            WHERE tenant_id = current_setting('app.current_tenant')::uuid AND id = $1 AND status = 'pending'
            RETURNING ${BINDING_COLUMNS}`,
          [bindingId],
        );
        if (!r.rowCount) throw new ResellerError("not_found", 404, "binding not found", { bindingId });
        return mapBinding(r.rows[0] as DomainBindingRow_);
      });
    } catch (e) {
      if (isUniqueViolation(e)) {
        throw new ResellerError("binding_conflict", 409, "host is already bound to another tenant", {
          host: binding.host,
          kind: binding.kind,
        });
      }
      throw e;
    }
  }

  /**
   * ACTIVATE a `verified` binding for white-label (FR-013, verify-before-activate). An unknown binding →
   * `404 not_found`; a `pending` binding → `409 not_verified` (ownership unproven); an already-`active`
   * binding is an idempotent no-op; a `verified → active` transition that would duplicate a host bound by
   * another tenant → `409 binding_conflict` (the global partial-unique index).
   */
  async activate(tenantId: string, bindingId: string): Promise<DomainBinding> {
    const binding = await this.get(tenantId, bindingId);
    if (!binding) throw new ResellerError("not_found", 404, "binding not found", { bindingId });
    const decision = decideActivate(binding.status);
    if (decision === "noop") return binding; // already active — idempotent.
    if (decision === "reject_not_verified") {
      throw new ResellerError("not_verified", 409, "the binding must be verified before activation", {
        bindingId,
        host: binding.host,
        status: binding.status,
      });
    }
    const bindingType = kindToBindingType(binding.kind);
    const owner = await this.boundHostOwner(bindingType, binding.host);
    if (owner !== null && owner !== tenantId) {
      throw new ResellerError("binding_conflict", 409, "host is already bound to another tenant", {
        host: binding.host,
        kind: binding.kind,
      });
    }
    try {
      return await withTenant(this.pool, tenantId, async (q) => {
        const r = await q(
          `UPDATE domain_binding
              SET status = 'active', activated_at = now(), updated_at = now()
            WHERE tenant_id = current_setting('app.current_tenant')::uuid AND id = $1 AND status = 'verified'
            RETURNING ${BINDING_COLUMNS}`,
          [bindingId],
        );
        if (!r.rowCount) throw new ResellerError("not_found", 404, "binding not found", { bindingId });
        return mapBinding(r.rows[0] as DomainBindingRow_);
      });
    } catch (e) {
      if (isUniqueViolation(e)) {
        throw new ResellerError("binding_conflict", 409, "host is already bound to another tenant", {
          host: binding.host,
          kind: binding.kind,
        });
      }
      throw e;
    }
  }

  // --- branding-resolution integration (US5 replaces the US2 `assertBindingBackedVerified` placeholder) ------

  /**
   * The binding-backed branding fields (`customDomain`/`emailSenderAddress`) a tenant has ACTIVE (own scope).
   * Consumed by the branding resolver's `activeBoundFields` so a binding-backed field takes effect ONLY once
   * its host is verified+activated (FR-013). A field with no active binding falls through to null.
   */
  async activeBoundFields(tenantId: string): Promise<Set<BrandingFieldName>> {
    return withTenant(this.pool, tenantId, (q) => this.readActiveBoundFields(q, tenantId, "own"));
  }

  /**
   * The active binding-backed fields for a tenant read on the audited `privileged` seam — used to resolve a
   * sub-tenant's applied branding where the effective value came from its RESELLER's default layer (a
   * sub-tenant cannot read its reseller's bindings under RLS; AD-002, HINT-001). Downward-only, no disclosure.
   */
  async activeBoundFieldsPrivileged(tenantId: string): Promise<Set<BrandingFieldName>> {
    return privileged(this.pool, (q) => this.readActiveBoundFields(q, tenantId, "privileged"));
  }

  private async readActiveBoundFields(
    q: (text: string, params?: readonly unknown[]) => Promise<pg.QueryResult>,
    tenantId: string,
    mode: "own" | "privileged",
  ): Promise<Set<BrandingFieldName>> {
    const where =
      mode === "own"
        ? "tenant_id = current_setting('app.current_tenant')::uuid AND status = 'active'"
        : "tenant_id = $1 AND status = 'active'";
    const params = mode === "own" ? [] : [tenantId];
    const r = await q(`SELECT DISTINCT binding_type FROM domain_binding WHERE ${where}`, params);
    const out = new Set<BrandingFieldName>();
    for (const row of r.rows as { binding_type: BindingType }[]) {
      if (row.binding_type === "custom_domain") out.add("customDomain");
      else if (row.binding_type === "email_sender") out.add("emailSenderAddress");
    }
    return out;
  }

  /**
   * Assert every binding-backed branding field in `fields` is backed by an ACTIVE binding for its host,
   * else `409 not_verified` (US5 replacement for the US2 placeholder). `customDomain` needs an active
   * `custom_domain` binding for the normalized domain; `emailSenderAddress` needs an active `email_sender`
   * binding for the address's sending domain. Reads the tenant's OWN active bindings (own scope; forced RLS).
   */
  async assertBrandingFieldsBacked(
    tenantId: string,
    fields: Partial<Record<BrandingFieldName, string>>,
  ): Promise<void> {
    const custom = fields.customDomain;
    const email = fields.emailSenderAddress;
    if (custom === undefined && email === undefined) return;
    const active = await withTenant(this.pool, tenantId, async (q) => {
      const r = await q(
        `SELECT binding_type, host FROM domain_binding
          WHERE tenant_id = current_setting('app.current_tenant')::uuid AND status = 'active'`,
      );
      return r.rows as { binding_type: BindingType; host: string }[];
    });
    const backed = (type: BindingType, host: string): boolean =>
      active.some((b) => b.binding_type === type && b.host === host);

    if (custom !== undefined) {
      const host = normalizeHost(custom);
      if (!backed(FIELD_TO_BINDING_TYPE.customDomain, host)) {
        throw new ResellerError("not_verified", 409, "custom domain is not a verified+active binding", {
          field: "customDomain",
          host,
        });
      }
    }
    if (email !== undefined) {
      const host = emailSenderDomain(email);
      if (!backed(FIELD_TO_BINDING_TYPE.emailSenderAddress, host)) {
        throw new ResellerError("not_verified", 409, "email sender is not a verified+active binding", {
          field: "emailSenderAddress",
          host,
        });
      }
    }
  }

  /**
   * The tenant that holds a VERIFIED/ACTIVE binding for a host, or null (data-model INV-5). Read on the
   * audited `privileged` seam because a request-time host claim spans tenants (the global one-binding-per-host
   * index is deliberately non-tenant-scoped) — never a broadened RLS predicate. Also backs inbound Host→tenant
   * routing.
   */
  async boundHostOwner(bindingType: BindingType, host: string): Promise<string | null> {
    return privileged(this.pool, async (q) => {
      const r = await q(
        `SELECT tenant_id FROM domain_binding
          WHERE binding_type = $1 AND host = $2 AND status IN ('verified','active')
          LIMIT 1`,
        [bindingType, host],
      );
      return r.rowCount ? (r.rows[0] as { tenant_id: string }).tenant_id : null;
    });
  }
}

/**
 * The production {@link DnsResolver} — a thin adapter over `node:dns/promises` (the ONLY real network access,
 * kept OUT of the module logic so tests inject deterministic results, AD-006). Passed to {@link DomainVerifier}
 * at composition time (`index.ts`).
 */
export function nodeDnsResolver(): DnsResolver {
  return {
    async resolveTxt(hostname: string): Promise<string[][]> {
      const { resolveTxt } = await import("node:dns/promises");
      return resolveTxt(hostname);
    },
    async resolveCname(hostname: string): Promise<string[]> {
      const { resolveCname } = await import("node:dns/promises");
      return resolveCname(hostname);
    },
  };
}
