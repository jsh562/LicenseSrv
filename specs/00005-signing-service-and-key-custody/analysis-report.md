# Analysis Report — Signing Service and Key Custody (E004)

> Date: 2026-07-02 | Feature: `specs/00005-signing-service-and-key-custody/` | Mode: analyze `apply all`
> Sources: Spec Validator (spec.md), Policy Auditor (plan.md), cross-artifact coverage/consistency (spec↔plan↔data-model↔contracts↔tasks).

## Verdict

**PASS — no CRITICAL, no HIGH.** Spec Validator PASS (with refinements, ~26/29). Policy Auditor PASS (no MUST breach; AD-001 is a documented, conformance-gated advisory, not a Principle III violation). Requirement→task coverage is 100%.

## Findings

| ID | Category | Severity | Location | Summary | Recommendation | Remediation |
|----|----------|----------|----------|---------|----------------|-------------|
| F1 | Consistency | MEDIUM | spec Compliance Check L230; data-model L6 | Stale TR range "TR-001…017" — omits TR-018 | Update to "TR-001…018" | APPLIED |
| F2 | Duplication/Clarity | MEDIUM | spec TR-011 / TR-018 | TR-018 near-duplicates TR-011's fail-closed clause and embeds rationale; its conformance-verify-before-return behavior is unhomed | Sharpen TR-018 to the output dichotomy + verify-gate, cross-ref TR-011, move rationale to a note; home the verify-gate in OBJ1 deliverable | APPLIED |
| F3 | Underspecification | MEDIUM | spec TR-005 / TR-007 / Edge Cases | `retired` status has no governing TR; overlap window unbounded; state machine not in requirements | Add a TR for retired-key behavior + bounded overlap window | APPLIED (TR-019) |
| F4 | Coverage | MEDIUM | spec TR-013 | Backup-separation requirement has no Success Criterion | Add an SC homing TR-013 | APPLIED (SC-008) |
| F5 | Clarity | LOW | spec TR-001 / TR-010 | Both use "expose"; interface-shape vs runtime-leakage boundary blurred | Tighten TR-001 to "define/offer … export/read operation" | APPLIED |
| F6 | Performance | LOW | spec TR-018 / plan constraints | Inline conformance-verify on the tier-0 hot path interacts with p95<300ms + caching/pre-issue | Note the interaction in the plan; decide sync vs pre-issue | APPLIED (plan HINT) |
| F7 | Coverage | LOW | spec Integration Points / Key Entities | E007 `product` dependency not captured as an IP | Add an IP for the E007 catalog | APPLIED (IP-007) |
| F8 | Clarity | LOW | spec Technical Constraints | "SHOULD support caching/pre-issue" untracked (no TR/SC) | Mark explicitly advisory | APPLIED |
| F9 | Advisory | INFO | plan AD-001 / token.ts | TS LIC1 encoder vs "single Rust core owns encode/decode" (ADR-0001) — conscious, conformance-gated deviation | Keep gated in QC (conformance oracle) | NOTED (no change; QC gate) |
| F10 | Consistency | LOW | contracts JWKS | Keyring↔E001 `KeyEntry` needs explicit valid_from(incl)/valid_until(excl) semantics | Document window semantics | APPLIED (contracts README note) |
| F11 | Advisory | INFO | project-instructions Technology Stack | Still names "Drizzle ORM"; E002 AD-006 dropped it for `pg` | Project-level governance nit, not E004's to fix here | NOTED (out of scope) |

## Quality Summaries

- **Spec Quality**: PASS with refinements. IDs contiguous (TR-001…018, SC-001…007, IP-001…006), section-set correct for a technical spec, no placeholders. Refinements above.
- **Compliance**: PASS. Principles I/II/III + Security Requirements all satisfied; ADR-0003/DDR-003/E001/E002 consistent; coverage map complete (TR-018 present). AD-001 advisory tracked for QC.

## Coverage Summary

All requirements have ≥1 task (100%). No uncovered requirement, no uncovered success criterion, no gold-plating (unmapped tasks are Setup/Foundational/Polish only). All 3+-task requirements carry a `[COMPLETES]` marker. Every `← T###:Symbol` has a matching `→ exports:`. File paths, terminology, and phase order match the plan.

After remediation the requirement set grows by TR-019, SC-008, IP-007 (each mapped to plan + tasks).

## Metrics

- Requirements: TR-001…018 (+TR-019 post-remediation) · SC-001…007 (+SC-008) · IP-001…006 (+IP-007)
- Tasks: 38 (T001–T038)
- Coverage: 100%
- CRITICAL: 0 · HIGH: 0 · MEDIUM: 4 · LOW/INFO: 7

## Next Actions

No CRITICAL/HIGH — safe to proceed. Remediations applied below. Then `/sddp-implement` (P1 gate = OBJ1–OBJ4).
