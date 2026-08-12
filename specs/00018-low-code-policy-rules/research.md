# Research — Low-Code Policy-Rule Layer (E017)

**Context**: Sandboxed, guarded-expression rule layer for dynamic entitlement decisions in a multi-tenant Node/TS + PostgreSQL license server (offline-first, online control plane). A Licensing Admin authors condition→effect rules (no free-form code) over catalog (E007 plan/entitlement) + license (E008) + usage (E016) context. Constraints: sandboxed-only, deterministic, auditable. Feeds story priorities, acceptance criteria, and edge cases.

## 1. Guarded expression languages
CEL (Common Expression Language) is non-Turing-complete, mutation-free, linear-time, and only calls host-provided functions — orders of magnitude safer/faster than sandboxed JS; mature TS ports exist (cel-js). JSONLogic/JMESPath are safe, side-effect-free, JSON-native but less expressive (good for a JSON builder UI). JSONata is Turing-complete — avoid. Pin exactly one engine.
Src: github.com/google/cel-go; github.com/marcbachmann/cel-js.

## 2. Sandboxing & safety
Node `vm`/`vm2` and `eval`/`new Function` are NOT security boundaries — they run with full privilege and enable injection. Safe path: an AST-parsed, allow-listed evaluator with no host/global access, pure functions over a fixed context, and enforced limits (evaluation timeout, max AST depth/node count, max string/collection sizes). CEL provides these natively; deny I/O, imports, undeclared identifiers.
Src: sourcery.ai eval-injection; github.com/google/cel-spec.

## 3. Deterministic evaluation
Determinism = same input → byte-identical output. Achieve via an INJECTED (frozen) evaluation timestamp from the decision context (never `Date.now()`), no RNG/network, no iteration-order dependence, and stable rule ordering so re-evaluation is idempotent. Enables replay, explanation, and CI snapshot tests.
Src: github.com/google/cel-go; mightybot deterministic-ai.

## 4. Rule model & lifecycle
Rule = `when <guarded expr> then <bounded effect>` attached to an entitlement/plan. Conflicts resolved by explicit priority/salience (higher fires first) with a deterministic tiebreak (ruleId); define first-match vs highest-priority-wins. Support enable/disable, IMMUTABLE versioning (new version = new row), and validate-on-author (parse + type-check + safety-lint before persist) so an unsafe rule never evaluates.
Src: nected rule-conflict; learn.microsoft rules-engine-optimization.

## 5. Decision context & effect surface
Rule sees a BOUNDED, READ-ONLY context: plan/entitlement values (E007), license claims (E008), usage aggregates (E016), injected timestamp. Effects are ALLOW-LISTED and TYPED — adjust a numeric limit (bounded by the plan ceiling), toggle a boolean, select an overage tier — never free mutation. The rule returns an effect DESCRIPTOR; a trusted applier mutates the decision, not the rule. No secrets/PII in context.
Src: cel-go policy README; github.com/google/cel-spec.

## 6. Auditability & testability
Append-only log per evaluation: fired ruleIds + versions, input snapshot/hash, resolved decision. A dry-run/simulate/report-only mode evaluates + logs the would-be outcome WITHOUT enforcing. Preview→active states enable safe rollout; a linter flags overlapping/over-permissive rules pre-deploy.
Src: cloud.google org-policy test; oneuptime dry-run authz.

## Summary
Use a non-Turing-complete guarded engine (CEL recommended; JSONLogic if a JSON builder is preferred) — NEVER eval/Function/vm — with time/size/depth limits and an allow-listed, typed effect surface bounded by the plan ceiling. Guarantee determinism via an injected clock, no RNG/network, and stable priority ordering. Validate rules at author time, version immutably, record append-only decision audits, and provide a dry-run/preview path.

## Offline-first boundary (critical for this codebase)
The engine is a SERVER-SIDE control-plane evaluation. It adjusts entitlement decisions at issuance (before the effective definition is snapshotted+signed into the LIC1 token — `catalog/effective.ts` notes "no dynamic policy logic (that is E017)") and at online evaluation (E013 validate) for dynamic per-request decisions. It does NOT run in the offline verifier core and does NOT change the signed token format — Principle I (offline verify, key never exposed, single crypto core) is preserved; an already-issued offline token carries its snapshotted entitlements.

## Spec implications (edge cases / constraints)
- Author-time rejection is a first-class story (unparseable / unsafe / over-limit / over-bound-effect).
- Conflict-resolution policy must be explicit (priority + deterministic ruleId tiebreak), not implicit.
- Effect values bounded/validated (a rule cannot raise a limit beyond the plan ceiling).
- Missing/null context fields (e.g. usage absent) need defined `has()`-guard semantics; a rule error fails CLOSED to the base decision.
- Injected clock from the decision context, not device/server wall-clock, for determinism.
- Audit rows immutable + versioned; dry-run outcomes stored distinctly from enforced ones.

## Sources
| URL | Topic |
|-----|-------|
| github.com/google/cel-go | 1,3 |
| github.com/marcbachmann/cel-js | 1 |
| sourcery.ai/vulnerabilities/eval-injection-javascript | 2 |
| github.com/google/cel-spec | 2,5 |
| nected.ai rule-conflict | 4 |
| learn.microsoft.com rules-engine-optimization | 4 |
| cloud.google.com organization-policy/test-policies | 6 |
