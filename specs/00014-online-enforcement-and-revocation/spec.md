---
feature_branch: "00014-online-enforcement-and-revocation"
created: "2026-07-18"
input: "e013 — Build online validation, heartbeat, and revocation propagation"
spec_type: "product"
spec_maturity: "draft"
epic_id: "E013"
epic_sources: "{PRD:CAP-008}"
---

# Feature Specification: Online Enforcement and Revocation

**Feature Branch**: `00014-online-enforcement-and-revocation`
**Created**: 2026-07-18
**Status**: Draft
**Spec Type**: product
**Spec Maturity**: draft
**Epic ID**: E013
**Epic Sources**: {PRD:CAP-008}
**Product Document**: specs/prd.md

## Problem Statement *(mandatory)*

The offline-first MVP verifies signed license tokens locally until they expire — a deliberate, disclosed gap: a revoked, suspended, or refunded license keeps working on machines that are *online* until its long-lived token expires, so vendors cannot promptly cut off misuse or key-sharing even on connected machines. "Revoke access" is a P1 admin promise (CAP-002) with no teeth until token expiry, and revenue leakage from misused/refunded licenses persists. E013 adds an online-enforcement path — short-lived token renewal via validate/heartbeat plus a signed revocation list — so revocation takes effect within a bounded window for connected clients, while never-connected/air-gapped clients remain unaffected (the disclosed staleness window). It affects vendors relying on prompt revocation and end-customers on connected machines.

## Scope *(mandatory)*

### Included

- **Online validate**: a connected licensed application validates its license + activation and receives a verdict plus a freshly-minted SHORT-lived, offline-verifiable token.
- **Heartbeat / silent renewal**: background renewal of the short-lived token while the license and activation/seat remain valid; re-checks status/expiry/entitlements and updates a last-seen anchor.
- **Revocation & suspension propagation** within a bounded renewal window (revoke-by-ceasing-to-reissue): a revoked/suspended license's short-lived token is not renewed and lapses within TTL; reinstatement resumes renewal.
- **Signed revocation list (CRL)**: a signed, versioned list of revoked license/activation ids with a `next_update`, distributed via CDN and downloadable as a file for air-gap import — the fallback path.
- **Offline-first preservation**: never-connected/air-gapped clients continue on their existing offline credential until its own expiry; the bounded revocation-staleness window is disclosed.
- **Clock-tamper resistance**: signed server time embedded in the renewed token + a client monotonic last-seen anchor + a per-plan offline-tolerance window.
- **Configuration**: short-token TTL / renewal window, heartbeat cadence + grace window, CRL `next_update` TTL, per-plan offline tolerance.

### Excluded

- **Floating / concurrent seat leases + reclamation** — E015 (CAP-010); E013 renews node-locked activations, not floating leases. Rationale: separate epic.
- **Billing-driven revocation automation** — E014 (CAP-009); E013 propagates revocations that already exist (admin-initiated), it does not ingest billing events. Rationale: separate epic.
- **OCSP-style per-request online status lookups** — rejected for p95<120ms latency + fail-open behaviour; short-TTL renewal + CRL chosen instead. Rationale: architecture (research topic 2).
- **Changes to the offline verifier core or the E009 long-lived activation credential's offline behaviour** — E013 is additive; offline verification is unchanged. Rationale: offline-first preserved.
- **New admin UI beyond minimal** (viewing last-seen / CRL status) — deferred. Rationale: keep the MVP focused on the client enforcement path.

### Edge Cases & Boundaries

- Transient network outage: the heartbeat grace window tolerates N missed beats before the effective authorization lapses — no false lockout.
- Offline-runtime bound precedence: the short-lived token's `exp` is the HARD fail-closed limit — offline runtime never extends beyond it. The heartbeat grace window (N missed beats) and the per-plan offline-tolerance window both govern WHEN a connected client must re-anchor/renew before `exp`, and are always ≤ the short-token TTL; they never extend token acceptance past expiry.
- Clock rollback on a client: the monotonic anchor rejects a token/time preceding the last signed server time; the per-plan tolerance bounds exposure.
- Revocation mid-window: a license revoked during a renewal window keeps working until the current short-lived token expires (bounded staleness ≤ TTL — disclosed).
- Never-connected client: unaffected until reconnect; cannot be revoked online (the disclosed gap).
- CRL/CDN unreachable: the client falls back to its short-lived token TTL (fail-open on CRL fetch, fail-closed on token expiry) — the CRL is belt-and-braces, not the primary path.
- Replay of a validate/heartbeat request: nonce anti-replay rejects duplicates; an idempotent retry returns the original result.
- CRL growth as revocations accumulate: bounded via versioned/delta lists.
- Suspended (not revoked) license: renewal refused while suspended; reinstatement resumes renewal.
- Short-lived token presented after license expiry: renewal refused (expiry re-checked).
- Air-gapped site: imports the signed CRL by file (like E010 air-gap activation) to honour revocations offline within the CRL `next_update` window.

## User Scenarios & Testing *(mandatory for product specs only)*

### User Story 1 - Online validate & short-lived renewal (Priority: P1)

A connected licensed application validates online and receives a short-lived, offline-verifiable token that it renews silently in the background, so it keeps running with only a short effective authorization window between server confirmations.

**Why this priority**: The core online-enforcement mechanism and the CAP-008 promise ("connected clients renew short-lived tokens"); every other story builds on it.

**Independent Test**: A connected client calls validate → receives a short-lived token that verifies offline; before it expires the client heartbeats → receives a fresh one.

**Acceptance Scenarios**:

1. **Given** an active license with an active activation, **When** the client validates online, **Then** it receives a short-lived token (TTL = the configured renewal window) that verifies offline and carries signed server time.
2. **Given** a short-lived token nearing expiry, **When** the client heartbeats, **Then** it receives a fresh short-lived token and its last-seen anchor is advanced.
3. **Given** a replayed validate/heartbeat request (reused nonce), **When** it is received, **Then** it is rejected and an idempotent retry returns the original result.

### User Story 2 - Revocation & suspension propagation within the renewal window (Priority: P1)

When an admin revokes or suspends a license, connected clients stop validating after the next renewal — the short-lived token is not re-issued and lapses within the bounded window — so misuse/refunds are cut off promptly for online machines.

**Why this priority**: The epic's first acceptance criterion and the revenue-leakage pain — revocation with teeth.

**Independent Test**: Revoke a license via the admin path → the next heartbeat is refused with a clear reason and the client's short-lived token expires within TTL; a suspended license behaves the same until reinstated.

**Acceptance Scenarios**:

1. **Given** a connected client with a renewing short-lived token, **When** its license is revoked, **Then** the next validate/heartbeat is refused (revoked) and no new token is issued.
2. **Given** the client's current short-lived token, **When** it reaches expiry with no renewal, **Then** offline verification fails — bounded staleness ≤ the renewal window.
3. **Given** a suspended license, **When** the client heartbeats, **Then** renewal is refused with a `suspended` verdict and no new token is issued.
4. **Given** a previously-suspended license that is reinstated, **When** the client next heartbeats, **Then** renewal resumes and a fresh short-lived token is issued.

### User Story 3 - Heartbeat renews only while license + activation valid (Priority: P1)

A periodic heartbeat renews the short-lived token only while the license is active AND the machine's activation/seat is valid and unexpired — re-checking status, seat validity, expiry, and entitlement changes on every beat — so a lapsed/deactivated/expired binding stops renewing.

**Why this priority**: The epic's second acceptance criterion; ensures a renewal reflects current authorization, not just a time bump.

**Independent Test**: Deactivate the machine's activation (or let the license expire) → the next heartbeat is refused; change entitlements → the renewed token reflects the new entitlements.

**Acceptance Scenarios**:

1. **Given** an active license but a deactivated activation, **When** the client heartbeats, **Then** renewal is refused (activation not active).
2. **Given** an expired license, **When** the client heartbeats, **Then** renewal is refused (expired).
3. **Given** an entitlement/plan change on the license, **When** the client renews, **Then** the new short-lived token reflects the updated effective entitlements.

### User Story 4 - Signed revocation list (CRL) fallback & distribution (Priority: P2)

The server publishes a signed, versioned revocation list (with `next_update`) via CDN and as a downloadable file, so clients and air-gapped sites can consult revoked ids as a fallback between renewals, within a bounded, disclosed staleness.

**Why this priority**: A defense-in-depth fallback; the primary mechanism (short-TTL renewal, US2) already delivers the acceptance criterion, so the CRL widens coverage rather than being the sole path.

**Independent Test**: Revoke a license → it appears in the next signed CRL version with an advanced `next_update`; the CRL signature verifies against the keyring; an air-gapped site imports the file and honours the revocation.

**Acceptance Scenarios**:

1. **Given** a revoked license, **When** the CRL is next published, **Then** the license id appears in the signed CRL and the version/`next_update` advance.
2. **Given** a client with a cached, valid CRL, **When** it checks a revoked id, **Then** it treats the license as revoked until `next_update`.
3. **Given** an air-gapped site, **When** it imports the signed CRL file, **Then** revocations within the CRL window are honoured offline.
4. **Given** a forged/tampered CRL whose detached signature fails to verify against the product keyring, **When** a client fetches it, **Then** the client treats it as untrusted (ignores it, does not cache it) and falls back to short-TTL non-reissue enforcement (distinct from an unreachable-CRL fail-open).
5. **Given** a client with a cached CRL at version N, **When** it fetches a validly-signed CRL at version < N, **Then** the older list is rejected and does not supersede the newer one (anti-downgrade).

### User Story 5 - Offline-first preserved (never-connected unaffected) (Priority: P1)

A never-connected or air-gapped client continues to operate on its existing offline credential until that credential's own expiry — E013's online enforcement is strictly additive and does not shorten or break the offline path — and the bounded revocation-staleness window is disclosed to buyers.

**Why this priority**: An explicit acceptance criterion and a non-regression guarantee protecting the offline-first principle (Principle I); it constrains the online path rather than adding a client feature.

**Independent Test**: A client that never calls validate/heartbeat keeps verifying its E009 activation credential offline until expiry, unaffected by E013; the published staleness window matches max(short-token TTL, CRL `next_update`) + offline tolerance.

**Acceptance Scenarios**:

1. **Given** a client that never connects, **When** E013 is deployed, **Then** its offline verification is unchanged and it is not treated as revoked-by-default.
2. **Given** an online client that goes offline within tolerance, **When** it operates offline, **Then** it continues until its short-lived token expires (grace window applies).
3. **Given** the product documentation, **When** a buyer reviews enforcement, **Then** the bounded revocation-staleness window is disclosed honestly.

### User Story 6 - Clock-tamper resistance on renewal (Priority: P3)

The renewal path resists client clock rollback — persisting a monotonic last-seen anchor (the highest signed server time observed) and rejecting local time/tokens preceding it, bounded by a per-plan offline-tolerance window — so a client cannot roll its clock back to extend a short-lived token indefinitely.

**Why this priority**: Hardening on top of the renewal path; core enforcement works without it, and pure-offline rollback is only bounded (not eliminated), so it is a defense-in-depth refinement.

**Independent Test**: Roll a client's clock back after a check-in → validation/renewal beyond the monotonic anchor + tolerance is rejected.

**Acceptance Scenarios**:

1. **Given** a client that has recorded a signed server time, **When** its local clock is rolled back, **Then** a token/time preceding the anchor is rejected.
2. **Given** the per-plan offline-tolerance window, **When** a client runs offline beyond it, **Then** it must re-anchor (renew) to continue.
3. **Given** a never-connected client with a frozen/rolled-back clock, **When** it operates offline, **Then** exposure is bounded by the tolerance window (documented, not fully preventable).

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST provide an authenticated online validate operation by which a connected client validates its license + activation and receives a verdict plus a freshly-minted short-lived token.
- **FR-002**: System MUST mint a short-lived, offline-verifiable token (TTL = the configured renewal window) signed by the existing keyring/signer on validate and heartbeat, carrying signed server time.
- **FR-003**: System MUST provide a heartbeat/renewal operation that renews the short-lived token before expiry and advances the client's last-seen anchor.
- **FR-004**: On every validate/heartbeat, System MUST re-check license status (active), activation status (active), expiry, and current effective entitlements, and MUST refuse renewal with a clear, specific reason when any check fails.
- **FR-005**: System MUST NOT renew a short-lived token for a revoked or suspended license; the outstanding token expires within the bounded renewal window (staleness ≤ TTL).
- **FR-006**: Reinstating a suspended license MUST resume renewal on the next heartbeat.
- **FR-007**: System MUST apply a configurable heartbeat grace/tolerance window (tolerate N missed beats) before the effective authorization lapses, so a transient outage does not cause a false lockout.
- **FR-008**: Validate/heartbeat requests MUST carry a single-use nonce; replays/duplicates MUST be rejected and an idempotent retry MUST return the original result.
- **FR-009**: System MUST publish a signed, versioned revocation list (CRL) of revoked license/activation ids with a `next_update` field.
- **FR-010**: System MUST distribute the CRL via CDN with cache semantics aligned to `next_update`, and MUST provide a downloadable signed CRL file for air-gap import.
- **FR-011**: A client MAY treat an id present in a *valid* CRL as revoked until `next_update`, where a **valid CRL** is one whose detached signature verifies against the product keyring (FR-023) AND whose `version` is ≥ the highest version cached (FR-022). A CRL fetch/unreachable failure MUST fail open (fall back to short-TTL non-reissue enforcement), while token expiry MUST fail closed.
- **FR-012**: E013 MUST be additive: a never-connected/air-gapped client continues on its existing offline credential until that credential's own expiry and MUST NOT be treated as revoked-by-default.
- **FR-013**: System MUST disclose the bounded revocation-staleness window (= max(short-token TTL, CRL `next_update`) + offline tolerance) in the product documentation / API responses.
- **FR-014**: System MUST embed signed server time in the renewed token and support a client monotonic last-seen anchor that rejects local time/tokens preceding it.
- **FR-015**: System MUST support a per-plan offline-tolerance window bounding how long a client may run without a fresh server anchor before it must re-anchor (renew).
- **FR-016**: Short-token TTL / renewal window, heartbeat cadence + grace, CRL `next_update` TTL, and per-plan offline tolerance MUST be configurable with sane defaults.
- **FR-017**: A renewed token MUST reflect the current effective entitlements/plan at renewal time so plan/entitlement changes propagate on renewal.
- **FR-018**: All online-enforcement operations MUST be tenant-scoped — a client can only validate/renew its own tenant's license/activation.
- **FR-019**: Validate/heartbeat outcomes and CRL publications MUST be audited (append-only); denied/revoked renewals and security-relevant refusals MUST be flagged.
- **FR-020**: Online validate/heartbeat MUST meet p95 < 120 ms under nominal load — a defined steady-state profile (e.g. sustained concurrent renewals at the target renewal cadence for the deployment's active-seat count; the concrete rps/concurrency is set from the SAD load model in the plan) — the online-path SLO.
- **FR-021**: The validate, heartbeat, and CRL-fetch endpoints MUST be rate-limited (per-tenant / per-activation), consistent with the existing activation endpoints, so abuse cannot degrade the p95 SLO or enable brute-force/replay pressure.
- **FR-022**: The server MUST publish CRLs with a strictly monotonically increasing `version` per (tenant, product), and a client **that consults CRLs** MUST reject/ignore a fetched CRL whose signed `version` is older than the highest version it has already cached/applied for that (tenant, product) — an older signed list MUST NOT supersede a newer one (anti-downgrade / rollback protection).
- **FR-023**: A client **that consults CRLs** and fetches one whose detached signature fails to verify against the product keyring MUST treat that CRL as UNTRUSTED — ignore it, neither apply nor cache it — and fall back to short-TTL non-reissue enforcement. This is DISTINCT from a CRL fetch/unreachable failure (FR-011): both fall back to token-TTL enforcement, but an unreachable CRL is fail-open on availability, whereas a signature-invalid CRL is rejected as untrusted and never treated as authoritative.

### Key Entities

- **License** *(E008, reused — `specs/00009-license-issuance-and-lifecycle/`)*: `status` (active/suspended/revoked; revoked terminal), expiry, and the effective entitlements snapshot — read on every validate/heartbeat as the online-enforcement gate.
- **Activation** *(E009, reused — `specs/00010-machine-activation-and-seats/`)*: the machine binding + `status` (active/deactivated) and its `machine_bound_token`; E013 renews the token short-lived and re-checks activation/seat validity per beat.
- **Short-lived renewal token**: an offline-verifiable token with a short TTL and signed server time, minted on validate/heartbeat; the client renews it silently in the background.
- **Revocation list (CRL) / revocation entry**: the signed, versioned set of revoked license/activation ids with `next_update`, distributed via CDN and as a file.
- **Check-in / last-seen anchor**: the record of a client's last successful validate/heartbeat (monotonic signed-time anchor), used for clock-tamper resistance and the offline-tolerance window. Holds only signed timestamps + ids (no raw machine identifiers); inherits E009's PII-minimization and GDPR retention/erasability posture.

## Assumptions & Risks *(mandatory)*

### Assumptions

- E008 `license.status` and E009 `activation` are the authoritative sources for online enforcement (E013 reads them; it introduces no new lifecycle).
- The existing E004 signer/keyring mints the short-lived tokens — no new key custody.
- A CDN is available to distribute the signed CRL (a SAD-declared external dependency).
- Clients can implement background renewal, a local monotonic anchor, and CRL consultation.
- Short-token TTL / renewal-window defaults (on the order of days, per-plan tunable) are acceptable for the target buyers.

### Risks

- **Renewal-window vs load / lockout tradeoff** *(likelihood: medium, impact: medium)*: very short TTLs spike server load and risk false lockouts on outages — mitigate via per-plan TTL + the grace window.
- **CRL growth** *(likelihood: medium, impact: medium)*: as revocations accumulate the client download bloats — mitigate via versioned/delta lists.
- **Pure-offline clock rollback is not fully detectable** *(likelihood: low, impact: medium)*: a never-connecting client with a rolled-back clock cannot be caught until reconnect — bound via the monotonic anchor + tolerance window and disclose it honestly (accepted limitation).

## Implementation Signals *(mandatory)*

- `NEW-API` — online validate + heartbeat/renewal endpoints and a signed CRL fetch endpoint.
- `MIGRATION` — additive last-seen/anchor column on `activation` (+ possible CRL version/metadata record); no changes to existing columns.
- `NEW-CONFIG` — short-token TTL / renewal window, heartbeat cadence + grace, CRL `next_update` TTL, per-plan offline tolerance.
- `NEW-WORKER` — periodic signed-CRL (re)generation job (versioned, `next_update`).
- `EXTERNAL-SERVICE` — CDN for CRL distribution (existing SAD dependency).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001** [US1]: A connected client validates online, receives a short-lived token that verifies offline, and renews it before expiry to obtain a fresh token — demonstrated end-to-end.
- **SC-002** [US2]: After an admin revokes a license, a connected client stops receiving renewed tokens and its access lapses within the bounded renewal window (≤ short-token TTL).
- **SC-003** [US3]: A heartbeat is refused with a specific reason when the license is expired/suspended/revoked or the activation is deactivated; a renewed token reflects current entitlements.
- **SC-004** [US2]: The measured revocation-propagation time for connected clients is ≤ the configured renewal window (bounded staleness), verified by measurement.
- **SC-005** [US5]: A never-connected/air-gapped client's offline verification is unchanged by E013 (no regression) and it is not revoked-by-default.
- **SC-006** [US5]: The bounded revocation-staleness window is published/disclosed and equals max(short-token TTL, CRL `next_update`) + offline tolerance.
- **SC-007** [US4]: A revoked license appears in the next signed CRL version with an advanced `next_update`, the CRL signature verifies against the keyring, and an air-gapped site can import it by file.
- **SC-008** [US1]: Online validate/heartbeat meets p95 < 120 ms under nominal load.
- **SC-009** [US6]: A client clock rolled back after a check-in is rejected beyond the monotonic anchor + per-plan tolerance.
- **SC-010** [US1]: Replayed validate/heartbeat requests are rejected (nonce anti-replay) and an idempotent retry returns the original result.
- **SC-011** [US4]: A CRL whose detached signature fails to verify against the product keyring is ignored (neither applied nor cached) and enforcement falls back to short-TTL non-reissue — verified with a forged/tampered CRL (FR-023).
- **SC-012** [US4]: A client rejects a signed CRL whose `version` is below the highest version it has already cached/applied for that (tenant, product) — anti-downgrade (FR-022).
- **SC-013** [US1]: An abusive validate/heartbeat/CRL request rate is throttled (429 + Retry-After) without breaching the p95 < 120 ms SLO for compliant clients (FR-021).
- **SC-014** [US1]: A client cannot validate or renew another tenant's license/activation — a cross-tenant reference resolves to not-found under RLS (FR-018).
- **SC-015** [US2]: A denied/revoked renewal and a CRL publication each emit a flagged, append-only audit entry (FR-019).

## Glossary *(include when spec introduces 2+ domain-specific terms)*

| Term | Definition |
|------|------------|
| Online enforcement | Checking a license's current server-side status while a client is connected, in addition to offline token verification. |
| Short-lived token | An offline-verifiable token with a short TTL (= the renewal window) that a connected client renews in the background. |
| Renewal window | The TTL of the short-lived token; the maximum revocation-propagation staleness for connected clients. |
| Heartbeat | A periodic client check-in that renews the short-lived token while the license/activation remain valid. |
| Revocation propagation | The mechanism (short-TTL non-renewal + CRL) by which a revoked license stops working on connected clients. |
| CRL (revocation list) | A signed, versioned list of revoked license/activation ids with a `next_update`, distributed as a fallback. |
| next_update | The time until which a published CRL is valid/cacheable; bounds CRL-path staleness. |
| Connected-propagation delay | For a connected (renewing) client, the delay between revocation and enforcement — bounded to one renewal window (≤ short-token TTL) by non-reissue. Verified by SC-004. |
| Bounded (worst-case) staleness | The disclosed WORST-CASE maximum delay between revocation and enforcement across all clients (including CRL-fallback + offline) = max(short-token TTL, CRL `next_update`) + offline tolerance. Verified by SC-006. |
| Monotonic anchor | The highest signed server time a client has observed; local time/tokens preceding it are rejected (anti-rollback). |
| Offline-tolerance window | The per-plan span a client may run offline without a fresh server anchor before it must re-anchor (renew). |
| Grace window | The number of missed heartbeats tolerated before effective authorization lapses (avoids false lockout). |

## Compliance Check

**Verdict: PASS** — no CRITICAL violations. All Core Principles and the PRD honest-disclosure / self-host / offline-first constraints are satisfied by explicit FR/US/SC.

**Satisfied principles**:
- **I. Offline-First (additive, not mandatory) / signing keys never exposed** — FR-012 + US5 (P1 non-regression; never-connected client stays on its E009 credential to expiry, not revoked-by-default), FR-011 (CRL fetch fails open), Scope→Excluded (offline verifier core unchanged); short-lived tokens + CRL are signed by the EXISTING E004 keyring/signer with no new key custody (FR-002/009, Assumptions).
- **II. Multi-Tenant Isolation** — FR-018 (all online-enforcement ops tenant-scoped).
- **III. Single Security Core, Fully Audited** — reuses the offline verifier + signer (no per-language crypto reimplementation); FR-019 (validate/heartbeat + CRL publication audited, append-only, refusals flagged).
- **Honest disclosure** — FR-013 + SC-006 publish the bounded revocation-staleness window; Edge Cases/Risks disclose the never-connected gap and the not-fully-detectable offline clock-rollback as accepted, documented limitations.
- **Cloud-agnostic / self-host / air-gap** — FR-010/011 (CRL via CDN AND a downloadable signed file for air-gap import; CDN is a fail-open fallback, not a hard SaaS dependency).
- **Anti-replay + rate-limiting** — FR-008/SC-010 (single-use nonce) and FR-021/SC-013 (rate-limited validate/heartbeat/CRL endpoints, per project-instructions Security Requirements).
- **CRL integrity + anti-rollback** (Principle III) — FR-022/SC-012 (strictly monotonic version; a CRL-consulting client rejects an older signed version — anti-downgrade) and FR-023/SC-011 (a signature-invalid CRL is treated as UNTRUSTED — neither applied nor cached — distinct from the FR-011 unreachable-CRL fail-open, which is a fail-open on availability only).
- **PII/GDPR** — reuses E009's salted-hash/minimized Activation; the new check-in/last-seen anchor holds only signed timestamps + ids and inherits E009's retention/erasability posture (Key Entities).

**Advisories resolved in this spec**: rate-limiting FR added (FR-021); check-in/last-seen GDPR-retention posture made explicit (Key Entities); CRL anti-downgrade (FR-022) + untrusted-signature (FR-023) trust rules added and mapped to Principle III with SC coverage (SC-011/012); verification coverage added for FR-018/019/021 (SC-013/014/015). **Violations**: none.
