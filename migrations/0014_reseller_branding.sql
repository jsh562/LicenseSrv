-- E018 reseller + white-label tenancy (FR-001..FR-017). Extends the E002 tenancy substrate
-- (expand-only, sequential after 0013_policy_rules.sql). Adds a shallow, one-level reseller->
-- sub-tenant overlay and per-tenant white-label branding WITHOUT weakening tenant isolation.
--
-- Expand-only: ONE additive self-ref column on tenant (parent_reseller_id) + ONE additive nullable
-- column on audit_log (actor_reseller_id) + three NEW tenant-owned tables (reseller, branding_profile,
-- domain_binding). NO existing column is altered; the per-tenant forced-RLS predicate is UNCHANGED.
--
-- ISOLATION MODEL (AD-001/002, HINT-001) -- the crux of this feature:
--   * The per-tenant tenant_isolation predicate is NEVER broadened to include parent_reseller_id.
--   * A reseller SUBTREE READ ("list my customers") runs on the RLS-bypassing `privileged` seam
--     (see src/server/db/client.ts) which reads tenant rows WHERE parent_reseller_id = :reseller
--     AFTER asserting the caller owns that reseller -- the same "cross-tenant only via an explicit
--     audited platform-admin path" seam E002 already uses. It is NOT reachable under a tenant session.
--   * A reseller ACTION on a sub-tenant is a SCOPED DESCENT: the subtree-membership gate asserts
--     ownership, then the mutation executes under the sub-tenant's OWN `app.current_tenant` scope
--     (withTenant), so RLS enforces the write against the sub-tenant's own rows -- no widened predicate.
--   * An out-of-subtree reference (sibling / parent / platform) resolves to zero rows -> 404, no
--     existence disclosure, + a security_event audit row (FR-004/005, SC-002/007, HINT-002).
--
-- NO crypto / NO token change (Principle I): nothing here touches the E004 signer or E001 verifier;
-- branding is presentation-only and never alters a license's contents or the signed token. These
-- tables store NO key, secret, or PII -- only presentation refs, business identities, and PUBLIC DNS
-- challenge values (a domain/email verification token is a public DNS record, not a secret).

-- =====================================================================================================
-- 1. tenant (E002) -- expand-only self-referential reseller link. Existing rows keep NULL (direct-platform).
-- =====================================================================================================
-- parent_reseller_id: a SUB-TENANT points UP to its managing reseller tenant (one level). NULL = a
-- direct-platform tenant (no reseller) OR a reseller tenant itself (a reseller has no parent -- nesting
-- is out of scope). The one-level invariant (a reseller never has a parent) is a service-layer guard:
-- a single-column CHECK cannot assert "this id is not referenced as a parent elsewhere".
ALTER TABLE tenant
  ADD COLUMN parent_reseller_id uuid;

ALTER TABLE tenant
  -- self-ref FK to the tenant root PK (single-column id -> composite-safe: references the real PK).
  -- ON DELETE NO ACTION: a reseller with sub-tenants can never be hard-deleted out from under them
  -- (offboarding MUST first transfer/reassign every sub-tenant, FR-012); tenants are tombstoned, not deleted.
  ADD CONSTRAINT tenant_parent_reseller_fk
    FOREIGN KEY (parent_reseller_id) REFERENCES tenant (id) ON DELETE NO ACTION,
  -- a tenant can never be its own reseller (trivial self-loop guard).
  ADD CONSTRAINT tenant_parent_reseller_not_self
    CHECK (parent_reseller_id IS NULL OR parent_reseller_id <> id);

-- Subtree lookup index (privileged/platform-admin seam): "all sub-tenants of reseller R". This index is
-- deliberately NOT tenant_id-leading because a subtree read is a cross-tenant operator/reseller-seam
-- query (AD-002), NEVER a per-tenant RLS-scoped query. Partial: only linked sub-tenants are indexed.
CREATE INDEX tenant_parent_reseller ON tenant (parent_reseller_id) WHERE parent_reseller_id IS NOT NULL;

-- =====================================================================================================
-- 2. reseller -- NEW tenant-owned 1:1 side-table (PK = tenant_id) for reseller-ONLY attributes.
-- =====================================================================================================
-- A reseller IS a tenant (AD-003): the hot `tenant` row stays lean; reseller lifecycle state + quota
-- live here, one row per tenant that is a reseller. status is DERIVED into a read-only cascade for its
-- sub-tenants at request time (AD-007) -- no fan-out write on suspend/reinstate.
CREATE TABLE reseller (
  tenant_id        uuid        NOT NULL,                        -- 1:1 with a tenant that IS a reseller
  status           text        NOT NULL DEFAULT 'active'        -- active | suspended (reversible read-only cascade) | offboarding
                     CHECK (status IN ('active','suspended','offboarding')),
  sub_tenant_quota int         NOT NULL                         -- HARD cap on sub-tenants (platform-default at onboarding; only the operator may raise it, FR-003)
                     CHECK (sub_tenant_quota >= 0),
  offboarding_started_at timestamptz,                            -- set once when status→offboarding; STABLE start of the grace window (graceEndsAt = offboarding_started_at + config grace window, FR-012). NULL unless offboarding.
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  -- offboarding_started_at is present exactly when the reseller is offboarding (a stable grace anchor, not the mutable updated_at).
  CONSTRAINT reseller_offboarding_shape CHECK (
    (status = 'offboarding') = (offboarding_started_at IS NOT NULL)),
  PRIMARY KEY (tenant_id),
  -- FK to the tenant root; ON DELETE NO ACTION (a reseller row is demoted via status/DELETE by lifecycle,
  -- never cascade-removed) -- keeps reseller semantics explicit.
  CONSTRAINT reseller_tenant_fk FOREIGN KEY (tenant_id) REFERENCES tenant (id) ON DELETE NO ACTION
);

-- =====================================================================================================
-- 3. branding_profile -- NEW tenant-owned 1:1 white-label settings (PK = tenant_id). One per tenant.
-- =====================================================================================================
-- Presentation-ONLY (AD-004/005). Applied branding is resolved PER FIELD at read by precedence
-- sub-tenant override -> reseller default -> platform default (NEVER stored resolved -> no drift when a
-- reseller default/lock changes, SC-004). locked_fields is the RESELLER's per-field lock set: a field
-- named here is authoritative and a sub-tenant override for it is IGNORED at resolution (FR-006/007).
-- NO secret / NO PII (INV minimized): logo/colors/product name/support links + a from-address business
-- identity only. Trust signals (revocation/tamper/signing identity/audit/legal) are NEVER sourced here
-- (FR-008) -- the resolver excludes them so no branding config can spoof them.
CREATE TABLE branding_profile (
  tenant_id      uuid        NOT NULL,                          -- one branding profile per tenant (reseller default OR sub-tenant override layer)
  logo_ref       text,                                         -- contract logoUrl: reference to a logo asset (URL/asset id); no binary, no secret
  color_primary  text,                                         -- contract primaryColor: brand color (e.g. hex); presentation only
  color_secondary text,                                        -- contract secondaryColor: brand accent color
  product_name   text,                                         -- contract productName: white-label product name
  support_url    text,                                         -- contract supportUrl: support link
  help_url       text,                                         -- contract helpUrl: help/documentation link
  email_sender   text,                                         -- contract emailSenderAddress: from-address identity; ACTIVE only when a matching domain_binding is 'active' (FR-013)
  custom_domain  text,                                         -- contract customDomain: optional Host-header domain; ACTIVE only when a matching domain_binding is 'active'
  locked_fields  jsonb       NOT NULL DEFAULT '[]',            -- RESELLER-set set of locked field names (contract BrandingFieldName allow-list); [] on a sub-tenant profile
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id),
  -- locked_fields is a JSON array of field-name strings; the member allow-list is the contract
  -- BrandingFieldName set {logoUrl,primaryColor,secondaryColor,productName,supportUrl,helpUrl,
  -- emailSenderAddress,customDomain}, enforced service-layer (a DB CHECK cannot cleanly enumerate/evolve it).
  CONSTRAINT branding_profile_locked_fields_array CHECK (jsonb_typeof(locked_fields) = 'array'),
  CONSTRAINT branding_profile_tenant_fk FOREIGN KEY (tenant_id) REFERENCES tenant (id) ON DELETE NO ACTION
);

-- =====================================================================================================
-- 4. domain_binding -- NEW tenant-owned custom-domain / email-sender ownership binding (pending->verified).
-- =====================================================================================================
-- DNS-proof-before-activation (AD-006, FR-013): a custom domain via TXT/CNAME challenge, an email sender
-- via SPF+DKIM/DMARC alignment. challenge_token is a PUBLIC DNS value (NOT a secret). A host/sender binds
-- to AT MOST ONE tenant -- see the GLOBAL partial-unique index below (the one deliberately cross-tenant
-- guarantee under forced RLS).
CREATE TABLE domain_binding (
  id                  uuid        NOT NULL,
  tenant_id           uuid        NOT NULL REFERENCES tenant (id),
  binding_type        text        NOT NULL                     -- custom_domain (Host->tenant) | email_sender (from-address domain)
                        CHECK (binding_type IN ('custom_domain','email_sender')),
  host                text        NOT NULL,                     -- NORMALIZED fqdn / sender domain (lower-cased) -- the global-uniqueness key
  status              text        NOT NULL DEFAULT 'pending'    -- pending (claimed, unproven) | verified (ownership proven) | active (in use for white-label)
                        CHECK (status IN ('pending','verified','active')),
  verification_method text        NOT NULL                     -- dns_txt | dns_cname (domain) | spf_dkim_dmarc (email)
                        CHECK (verification_method IN ('dns_txt','dns_cname','spf_dkim_dmarc')),
  challenge_token     text        NOT NULL,                     -- PUBLIC DNS challenge value the owner publishes; NOT a secret / NOT PII
  verified_at         timestamptz,                              -- set once ownership is proven (verified|active)
  activated_at        timestamptz,                              -- set IFF status='active' (explicit /activate step after verify)
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  -- the verification method must match the binding type (domain uses DNS challenge; email uses send-auth alignment).
  CONSTRAINT domain_binding_method_shape CHECK (
    (binding_type = 'custom_domain' AND verification_method IN ('dns_txt','dns_cname')) OR
    (binding_type = 'email_sender'  AND verification_method =  'spf_dkim_dmarc')),
  -- state machine (pending -> verified -> active): verified_at present once proven (verified|active);
  -- activated_at present IFF active; pending carries neither timestamp.
  CONSTRAINT domain_binding_status_shape CHECK (
    (status = 'pending'  AND verified_at IS NULL     AND activated_at IS NULL) OR
    (status = 'verified' AND verified_at IS NOT NULL AND activated_at IS NULL) OR
    (status = 'active'   AND verified_at IS NOT NULL AND activated_at IS NOT NULL))
);

-- =====================================================================================================
-- Indexes.
-- =====================================================================================================
-- reseller: operator/platform-admin scan of resellers by lifecycle status (privileged seam, small table).
CREATE INDEX reseller_status ON reseller (status);

-- domain_binding, per-tenant listing (tenant_id-leading, matches the RLS predicate; E002 convention):
-- "my bindings of a type in a state" (verify polling / branding editor).
CREATE INDEX domain_binding_tenant ON domain_binding (tenant_id, binding_type, status);

-- ONE-BINDING-PER-HOST (FR-013, SC-011, AD-006) -- the SINGLE deliberately NON-tenant-scoped index.
-- A UNIQUE INDEX is a PHYSICAL constraint enforced across ALL rows REGARDLESS of RLS: RLS filters row
-- VISIBILITY / per-tenant DML row-matching, but it does NOT weaken unique-index enforcement, and it does
-- NOT read the app.current_tenant GUC. So global single-binding holds even under forced RLS and even for
-- an unset GUC. It is PARTIAL on status IN ('verified','active'): multiple tenants MAY hold a 'pending'
-- claim on the same host (no squatting lock-out of the true owner), but AT MOST ONE may hold a 'verified'
-- OR 'active' binding -- covering BOTH states is critical so an ACTIVE host cannot be re-verified/claimed
-- by another tenant (a 'verified'-only predicate would let an active row escape the guarantee). The losing
-- verify/activate attempt hits this index -> unique_violation, mapped to 409 binding_conflict WITHOUT
-- disclosing which tenant holds it. Inbound Host->tenant routing (an unauthenticated request with no
-- tenant scope yet) resolves the owning tenant on the `privileged` seam via this index, NOT via RLS.
CREATE UNIQUE INDEX domain_binding_host_bound_uniq
  ON domain_binding (binding_type, host) WHERE status IN ('verified','active');

-- =====================================================================================================
-- RLS: same form as E002 (0002) / E016 (0012) / E017 (0013). ENABLE + FORCE (owners subject too);
-- unset GUC -> NULL -> zero rows (refuse unscoped access); a cross-tenant reference -> not found.
-- The per-tenant predicate is UNCHANGED -- reseller subtree reach is the privileged seam, never here.
-- =====================================================================================================
ALTER TABLE reseller         ENABLE ROW LEVEL SECURITY; ALTER TABLE reseller         FORCE ROW LEVEL SECURITY;
ALTER TABLE branding_profile ENABLE ROW LEVEL SECURITY; ALTER TABLE branding_profile FORCE ROW LEVEL SECURITY;
ALTER TABLE domain_binding   ENABLE ROW LEVEL SECURITY; ALTER TABLE domain_binding   FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON reseller
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
CREATE POLICY tenant_isolation ON branding_profile
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
CREATE POLICY tenant_isolation ON domain_binding
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

-- =====================================================================================================
-- 5. audit_log (E002) -- expand-only dual-identity projection for cross-tenant reseller actions (AD-008).
-- =====================================================================================================
-- A reseller action on a sub-tenant is recorded as ONE append-only row written under the SUB-TENANT
-- (target) scope, so it lands in the target's own tamper-evident trail and stays RLS-consistent with the
-- mutation: tenant_id = the target sub-tenant, actor = the acting reseller-admin principal (a pseudonymous
-- ref; a member of the RESELLER tenant, i.e. FOREIGN to tenant_id). actor_reseller_id captures the OTHER
-- identity the target scope cannot: the acting reseller's HOME tenant id -- so the row records the full
-- dual identity (WHO the reseller is, not merely WHICH admin string). It is NULL for an ordinary
-- non-delegated action (a tenant acting on itself), and set only for a reseller-admin acting on a
-- sub-tenant, which is what distinguishes a delegated cross-tenant action. It is stored INDEPENDENTLY of
-- the mutable tenant.parent_reseller_id, so the attribution SURVIVES a later sub-tenant transfer to a
-- different reseller (the parent link re-points; this historical row does not). security_event=true
-- records a denied upward/lateral escalation (FR-005/009, SC-005/007). No FK (parity with the existing
-- un-FK'd tenant_id; keeps the append-only trail decoupled from referential state). audit_log stays
-- SELECT,INSERT ONLY (no app UPDATE/DELETE) -> tamper-evident; the new column is covered by E002's grant.
ALTER TABLE audit_log
  ADD COLUMN actor_reseller_id uuid;

-- =====================================================================================================
-- Grants (least-privilege, non-owner licensesrv_app role).
-- =====================================================================================================
-- reseller / branding_profile / domain_binding are MUTABLE config (not append-only ledgers): the app role
-- gets full DML. Stale-pending-binding reaping and any tenant GDPR erase run on the OWNER role, not here.
GRANT SELECT, INSERT, UPDATE, DELETE ON reseller         TO licensesrv_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON branding_profile TO licensesrv_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON domain_binding   TO licensesrv_app;
-- The additive tenant.parent_reseller_id + audit_log.actor_reseller_id columns are covered by E002's
-- existing table-level grants (audit_log remains SELECT,INSERT only -> append-only). No new grant needed.
