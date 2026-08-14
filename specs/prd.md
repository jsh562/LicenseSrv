# Product Requirements Document: LicenseSrv

> Date: 2026-06-26 | Status: Draft

## Product Overview

LicenseSrv is a flexible, secure, and fast license server that any software vendor can drop into any application or system. It issues cryptographically signed licenses, verifies them on the customer's machine with no network connection, and lets non-developers configure products, plans, and entitlements without writing code. It runs as a multi-tenant managed service or fully self-hosted inside a customer's own infrastructure, including air-gapped environments. The immediate audience is a vendor licensing their own portfolio of apps; the same product is built to be offered to other vendors as licensing-as-a-service.

## Vision and Why Now

Every software team that sells or gates access to software eventually needs to answer "is this customer allowed to run this, and which features may they use?" Most answer it by hand-rolling key generation and validation per app — slow to build, inconsistent, and a recurring source of forgeable keys. LicenseSrv makes licensing a solved, shared capability: one place to define what is sold, one way to verify it everywhere, and a no-code surface so the people who change pricing and packaging are not blocked on engineering. The vision is that adding licensing to a new app takes minutes and a few lines, and that changing a plan takes a non-developer a few clicks — with verification that is trustworthy, offline-capable, and fast enough to be invisible.

## Problem Statement

Vendors lack a licensing capability that is simultaneously easy to integrate across every stack, secure by construction, able to work offline (including air-gapped), and configurable without engineering. Building it per-app wastes engineering time, produces weak and inconsistent protection, and forces product/commercial changes through release cycles. The cost of not solving it is ongoing: revenue leakage from seat over-use and casual piracy, support load from brittle activation, and an inability for non-developers to manage packaging — all multiplied across every product the vendor ships.

## Background and Evidence

- **Direct need**: the originating vendor wants one licensing capability reusable across their own apps and systems, configurable no-code, working offline and air-gapped.
- **Market validation**: a mature category exists (Keygen, Cryptlex, LicenseSpring, Revenera/FlexNet), confirming demand; buyers evaluate offline activation, SDK/language coverage, reliability, time-to-integrate, and support quality.
- **Revenue stakes**: industry analyses attribute material revenue loss to unlicensed use and seat over-use, and a majority of vendors cite piracy/overuse as a leakage source — establishing the value of deterrence and overuse recovery (not piracy elimination).
- **Differentiation gap**: incumbents are largely cloud/API-first or heavyweight-enterprise; an offline-first, one-core-many-languages, no-code, self-host-or-SaaS product is a credible wedge.

## Target Users, Stakeholders, and Core Personas

### Target Users

- Software vendors and product teams that need to license and gate their own applications across multiple languages and deployment environments.
- (Forward-looking) other vendors who would consume LicenseSrv as a hosted licensing service.

### Stakeholders

- Commercial/product owners who set packaging, plans, and entitlements.
- Security and compliance reviewers who must approve key custody, audit, and data handling.
- Operations owners responsible for availability of issuance and the licensing service.
- End customers (and their operators) who activate and run the licensed software.

### Core Personas

- **Integrating Developer** — embeds licensing into an application. Wants to add verification in minutes, in their language, with minimal code and no cryptography to implement. Pain: per-stack SDKs of uneven quality; verification that adds latency or requires network calls.
- **Licensing / Product Admin (non-developer)** — defines products, plans, and entitlements and issues/revokes licenses. Wants to change packaging without an engineering release. Pain: today, every plan change is a code change.
- **Security & Compliance Reviewer (buyer-side)** — approves adoption. Wants assurances on signing-key custody, tamper-evident audit logs, GDPR handling of machine data, and the option to keep all data in-house. Pain: SaaS-only tools that cannot satisfy data-residency or air-gap requirements.
- **End-Customer Operator** — activates and runs the software, sometimes on fully offline/air-gapped machines. Wants self-service activation, transfer, and deactivation without raising a support ticket. Pain: activation that fails silently or requires vendor intervention.

## User Needs / Jobs To Be Done

- When I add a new app, I want to integrate licensing in minutes in my language, so that licensing is never the bottleneck to shipping.
- When my software runs on a customer machine, I want to verify the license instantly without a network call, so that it works offline and adds no startup delay.
- When packaging or pricing changes, I want a non-developer to reconfigure products/plans/entitlements, so that commercial changes don't wait on engineering.
- When a customer's machine is air-gapped, I want a supported way to activate it, so that regulated and on-prem customers are not excluded.
- When a license is misused, expired, or refunded, I want to control activations and revoke access, so that revenue leakage is contained.
- When a security reviewer evaluates us, I want clear custody, audit, and data-residency answers, so that procurement is not blocked.

## Product Principles or UX Principles

- **Offline-first by default**: verification works with zero network on the hot path; online features are additive, never required to run.
- **Integrate in minutes, any stack**: one verification capability reusable from any language; no customer ever re-implements cryptography.
- **No-code for the common case**: the 90% of licensing configuration is doable by a non-developer through an admin surface; advanced rules degrade gracefully to guarded configuration.
- **Trustworthy by construction**: signing-key custody, tenant isolation, and tamper-evident audit are foundational, not add-ons.
- **Honest about protection**: the product deters casual piracy and recovers seat over-use; it does not claim to stop a determined attacker who controls the machine.
- **Self-host or managed, one product**: the same capability serves a managed multi-tenant service and a fully self-hosted/air-gapped deployment.

## Scope Summary

The MVP (P1) delivers an offline-first, multi-tenant licensing capability: a no-code admin surface to define catalogs and issue signed licenses; an embeddable verifier reusable across stacks; node-locked activation with seat enforcement; air-gapped activation by file exchange; and the security foundation (tenant isolation, access control, audit, key custody). Online enforcement, billing automation, floating seats, usage metering, and advanced policy are explicitly later phases.

### In-Scope Capabilities

- No-code definition of products, plans, and feature entitlements.
- Issuance and lifecycle management of cryptographically signed, offline-verifiable licenses.
- Offline, on-device license verification and feature gating across any language/runtime.
- Machine activation, seat-limit enforcement, and tolerant machine identification.
- Air-gapped activation via signed file exchange.
- Multi-tenant administration with access control, tamper-evident audit, and secure signing-key custody.

### Out-of-Scope Items

- Payment processing and tax/merchant-of-record handling (LicenseSrv is the entitlement authority, not the biller).
- Mandatory always-online enforcement as the default model (offline-first is the default).
- Online heartbeat / real-time revocation propagation, billing-driven automation, floating/concurrent seats — deferred (P2).
- Usage-metered billing and a low-code dynamic policy-rules engine — deferred (P3).
- Reseller/white-label depth beyond basic multi-tenancy — deferred (P3).

## Product Capability Map

Project-level execution anchors used by `specs/project-plan.md`. Capability clusters, not feature stories.

| Capability ID | Capability | Priority | Outcome |
|---------------|------------|----------|---------|
| CAP-001 | No-code licensing catalog | P1 | A non-developer can define products, plans, and entitlements without code or a release. |
| CAP-002 | License issuance & lifecycle | P1 | Admins issue, revoke, suspend, reinstate, and transfer signed licenses. |
| CAP-003 | Offline license verification | P1 | Applications verify licenses and gate features locally with no network call. |
| CAP-004 | Cross-stack embeddable verifier | P1 | Any language/runtime integrates verification quickly without reimplementing crypto. |
| CAP-005 | Machine activation & seat enforcement | P1 | Licenses bind to machines, enforce seat limits, and tolerate minor hardware change. |
| CAP-006 | Air-gapped activation | P1 | Fully offline machines activate via supported signed file exchange. |
| CAP-007 | Multi-tenant administration, access control & audit | P1 | Tenants are isolated; actions are role-controlled, audited, and keys are custodied securely. |
| CAP-008 | Online enforcement & revocation propagation | P2 | Connected clients renew short-lived tokens and revocation takes effect promptly. |
| CAP-009 | Billing-driven entitlement automation | P2 | Subscription events provision/suspend licenses with grace periods. |
| CAP-010 | Floating / concurrent seats | P2 | Concurrent-use products lease and reclaim seats. |
| CAP-011 | Usage metering & low-code policy rules | P3 | Consumption-based entitlements and dynamic, guarded policy decisions. |
| CAP-012 | Reseller / white-label multi-tenancy | P3 | Partners resell and brand licensing on top of LicenseSrv. |

## Success Metrics / KPIs / Desired Outcomes

Targets are credible starting points to validate with design partners, not guarantees.

| Metric | Target | Why It Matters | Measurement Window |
|--------|--------|----------------|--------------------|
| Time-to-first-verified-license (TTFVL) | Median < 30 min from SDK install to first offline verify | Headline adoption signal for developer integration | Per integrator, ongoing |
| Activation success rate | ≥ 99% (excluding intended seat-limit/revoked refusals) | Failed activations are the top licensing support driver | Rolling 30 days |
| Offline-verification reliability | 100% accept valid / 100% reject tampered, expired, wrong-machine | The product's core promise | Continuous |
| Customer self-service rate | ≥ 90% of activations/transfers/deactivations without vendor support | Self-service is a primary value lever | Rolling 30 days |
| Licensing support-ticket reduction | Meaningful reduction vs pre-adoption baseline | Monetizes "stop reinventing licensing" | Per pilot quarter |
| Revenue-leakage reduction | Demonstrable reduction in seat over-use / unlicensed use | Core business outcome (deterrence + overuse recovery) | Per pilot quarter |
| Verification latency (technical SLO) | p99 < 5 ms on commodity hardware | "Fast, embed-anywhere" claim | Continuous |
| License-issuance latency (technical SLO) | p95 issuance < 1 s incl. signing | Issuance is a tier-0 throughput dependency | Continuous |
| Air-gap activation completion | High single-pass success without escalation | Differentiator proof for regulated buyers | Per pilot |
| Multi-language SDK coverage | Native + web/runtime + generated bindings from one core | "One core, many languages" promise | Per release |

## Assumptions

- Licensed applications can embed a small verification library or call a network endpoint.
- The people configuring licensing are non-developers comfortable with a web admin surface.
- The deployment environment provides secure custody for signing keys.
- Most clients can reach the service periodically; air-gapped clients use file exchange.
- Casual piracy and seat over-use — not determined attackers — are the realistic threat to deter.

## Constraints

- Verification must work with no network on the default path and must add no perceptible delay.
- The same product must support both managed multi-tenant and fully self-hosted/air-gapped deployment.
- Strict tenant isolation is mandatory; a cross-tenant data leak is a breach-notification event.
- Signing keys must never be exposed by any interface; custody is a security and procurement gate.
- Machine and customer data are personal-data-adjacent and must be minimized and erasable.

## Dependencies

- **Signing-key custody (tier-0)**: secure key storage; its availability also gates issuance throughput. Highest-impact dependency.
- **Billing provider (P2)**: paid-to-entitled automation depends on an external billing system and the online layer; out of MVP scope.
- **Per-stack verifier packaging**: each supported language path carries ongoing maintenance/support cost (mitigated by the single-core design).
- **Customer-side log export**: regulated buyers expect audit logs exportable to their own monitoring/SIEM.

## Risks

- **Overclaiming protection**: framing must be deterrence + overuse recovery, never "stops piracy"; overclaiming is a credibility and marketing-compliance risk.
- **Signing-key compromise**: would allow forging a product's licenses; mitigated by isolated per-product custody and rotation — but remains the top risk.
- **Multi-tenant isolation defect**: a cross-tenant leak is both a security and a compliance/contractual failure.
- **Revocation gap in offline-first MVP**: a never-connected client cannot be revoked until it reconnects; an accepted MVP limitation that must be disclosed to buyers, not hidden.
- **SDK support burden**: broad language coverage increases the support tail; coverage breadth trades off against support load.

## Open Questions

- Which language stacks are first-priority for a first-class verifier path at launch (informs CAP-004 sequencing)?
- For the commercial path, what is the intended pricing/packaging model (per-tenant, per-active-license, usage)? Affects later monetization, not MVP.
- Which compliance attestations (e.g., SOC 2, specific data-residency commitments) are required by the earliest target buyers?
- Is an on-prem relay (LAN licensing inside customer networks) needed within the first commercial release, or is file-exchange air-gap sufficient?

## Release or Validation Approach

Validate the offline-first, multi-stack thesis with 2–4 design-partner vendors chosen to stress it: one air-gapped/regulated, one SaaS vendor wanting offline tokens, one multi-language shop. Ship at least two reference integrations (one native, one web/runtime) and use them as the acceptance harness; instrument the adoption funnel from install → first verify → first issued license → first air-gap round-trip, with TTFVL as the headline gate. Run a 6–12 week pilot before scale decisions; treat low onboarding activation as a signal to fix onboarding before adding features. Explicitly test the P1/P2 boundary — confirm partners can ship value on offline-first alone; a partner blocking on revocation propagation is the signal to re-prioritize online enforcement.

## Domain Glossary / Terminology

- **License**: an issued, cryptographically signed grant that an application verifies to allow use and unlock features.
- **Entitlement**: a named capability a license grants (a feature flag or a numeric limit).
- **Activation**: binding a license to a specific machine, consuming a seat.
- **Node-locked**: a license tied to one machine; **floating**: seats shared concurrently and reclaimed.
- **Offline verification**: validating a license on-device with no network call.
- **Air-gapped activation**: activating a machine with no network, via signed file exchange.
- **Tenant**: an isolated account that owns its products, licenses, and keys.
- **Revocation**: invalidating a previously issued license.

## Handoff Guidance

Context that downstream architecture and governance work must preserve.

- **Product intent to preserve**: offline-first verification as the default; integrate-in-minutes across any stack; no-code configuration for non-developers; self-host or managed from one product; honest anti-piracy positioning.
- **Scope boundaries to respect**: P1 excludes online-mandatory enforcement, billing automation, floating seats, metering, and advanced policy. Payment processing is permanently out of scope.
- **Critical constraints**: zero-network verify path; strict tenant isolation; signing keys never exposed; minimized, erasable machine/customer data; air-gapped support is first-class.
- **Open decisions needing technical input**: first-priority SDK stacks; need for an on-prem LAN relay; required compliance attestations.

## Project Context Baseline Updates

- Reseller / white-label tenancy (E018, {PRD:CAP-012}) introduces the partner/channel go-to-market as a reusable actor + constraint set: a RESELLER (partner) tenant manages its own customer sub-tenants under delegated, scoped, DOWNWARD-ONLY administration, and a VENDOR/PLATFORM OPERATOR sits above all resellers (the only actor that can move a sub-tenant between resellers, always audited). White-label branding (logo, colors, product name, support links, email/domain identity) is applied per tenant by precedence sub-tenant → reseller → platform, and is presentation-only — it never alters license contents or the signed token. Cross-cutting product boundary: security/trust signals (license revocation/tamper/security notices, the signing identity, audit records, legal/compliance text) are NEVER white-labeled — they stay authoritative regardless of partner branding — and introducing resellers never weakens strict tenant isolation. Reseller onboarding is vendor-initiated with a sub-tenant quota; suspend is reversible and distinct from offboard, and offboarding must transfer-or-reassign every sub-tenant (no orphans).
