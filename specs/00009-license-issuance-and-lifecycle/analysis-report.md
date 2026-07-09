# Analysis Report — E008 License Issuance and Lifecycle

**Scope**: cross-artifact consistency across spec.md, plan.md, tasks.md (+ data-model, contracts, 3 checklists).
**Verdict**: No CRITICAL, no HIGH. 3 MEDIUM + 5 LOW. Coverage complete (19/19 FRs mapped). The checklist phase already tightened most artifacts; residual findings are polish + one contract-vs-spec reconciliation.

## Findings Table

| ID | Category | Severity | Location(s) | Summary | Recommendation |
|----|----------|----------|-------------|---------|----------------|
| F1 | Consistency | MEDIUM | spec Key Entities → Customer | "a display/reference label, minimal PII" bundles the non-PII `ref` with the PII display name, contradicting FR-011's separation | Split into reference label (non-PII, survives anonymization), display name (PII, cleared), contact email (PII, cleared). |
| F2 | Coverage | MEDIUM | spec FR-019 / SC | Customer erasure/anonymization (GDPR-load-bearing) has no US acceptance scenario and no SC | Add an SC for customer erasure (anonymize-if-licensed / hard-delete, audited without PII). |
| F3 | Consistency (cross-artifact) | MEDIUM | contract customer-erasure vs spec FR-011/019 + data-model | Contract says the customer `ref` is "replaced with an opaque pseudonym" on anonymization; spec + data-model treat `ref` as a non-PII pseudonymous label that SURVIVES (only name+email cleared) | Reconcile the contract to match spec + data-model: `ref` survives; `name`+`email` are cleared. |
| F4 | Ambiguity | LOW | spec FR-009 | The configurable transfer-limit default value is not stated (plan pins 3, AD-006) | State the default (3) for clarity; behavior already testable. |
| F5 | Duplication | LOW | spec FR-007, FR-008 | Reinstate-of-revoked is covered by both FR-007 (explicit) and FR-008 (implicit "not suspended") — not cross-referenced | Harmless; accept (both agree). |
| F6 | Underspecification | LOW | spec FR-013 | "expose status for downstream" names no interface + has no SC | Accept — product-spec granularity; the registry (SC-007) + data-model expose status. |
| F7 | Coverage | LOW | spec FR-011/FR-014 | Customer edit/update (correct a name/email) is unspecified | Accept — register/list/erase suffices for the MVP; edit is a later add. |
| F8 | Coverage | LOW | spec US6/FR-018 | Reissue (P2) has an acceptance scenario but no SC | Accept — P2, non-blocking. |

## Quality Summaries

- **Spec Quality**: previously 25/25; checklist-amended (FR-011 PII enumeration, FR-014 reissue+erase audit, FR-015 fail-closed tenant). Residual: 2 MEDIUM (Key Entities wording, erasure SC/coverage), rest LOW. No `[NEEDS CLARIFICATION]` markers. State machine coherent.
- **Compliance**: Policy Auditor **PASS** — no MUST/SHOULD violations; verified the signer/effective seams, forced RLS, append-only audit, no-ORM, `/src`, module boundaries against the live source. No principle drift from the amendments.

## Coverage Summary

All FR-001..FR-019 map to ≥1 task (WBS requirement-coverage map). Completion markers verified on 3+-task requirements (FR-001@T014, FR-002@T013, FR-003@T014, FR-006@T013, FR-007@T018, FR-008@—, FR-009/010@T025, FR-011@T031, FR-012@T032, FR-014@T044, FR-015@T028, FR-019@T029; FR-018@T035/DEFERRED). Both integration seams are foundational: T005 (`app.signer` decorator), T006 (effective read model productId+planId).

## Unmapped Tasks

Setup (T001), module scaffold (T004/T009), Frontend, Polish carry no FR tag by design. No gold-plating.

## Metrics

- Total requirements: 19 FR (+ 10 SC) · Total tasks: 46 · Coverage: 100% · CRITICAL: 0 · HIGH: 0 · MEDIUM: 3 · LOW: 5
