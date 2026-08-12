// Policy Rules view (E017, US1/US4/US5; FR-001/002/011/013/016). The operator surface for the low-code
// policy-rule engine: an admin AUTHORS a guarded `when → then` rule (a structured-JSON condition + a closed typed
// effect + a priority + a target entitlement) which the server VALIDATES before persist (distinct 400 codes —
// invalid_condition / unsafe_operator / effect_out_of_bounds / condition_too_large / rule_set_limit_exceeded —
// surfaced inline), lists the tenant's rules with their live status, PREVIEWs/ACTIVATEs/DISABLEs a rule's head
// version (the lifecycle transition, 409 invalid_state_transition surfaced), DRY-RUNs a candidate against a
// supplied sample context or a real license (non-enforcing, mode=dry_run), and inspects a rule's FULL immutable
// version history. Author/edit/status/dry-run actions are admin-only and hidden from a viewer by RequireRole; the
// server still enforces RBAC + double-submit CSRF fail-closed regardless of what the SPA shows. There is NO
// runtime evaluation here — a live decision is an internal issuance-path seam, never a console call. No secret or
// signing key is ever shown.
import { useCallback, useEffect, useState, type FormEvent } from "react";

import {
  ApiError,
  policyApi,
  type DryRunResult,
  type PolicyRuleDetail,
  type PolicyRuleStatus,
  type PolicyRuleSummary,
  type Role,
} from "../../api";
import { RequireRole } from "../../components/RequireRole";

/** A starter condition/effect so the author fields are never a blank slate (a simple always-true limit lift). */
const SAMPLE_CONDITION = '{ "==": [1, 1] }';
const SAMPLE_EFFECT = '{ "kind": "adjust_limit", "value": 50000 }';

/** Map a create/edit ApiError to a human message, keeping the DISTINCT author-time 400 codes explainable. */
function authorErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    switch (err.code) {
      case "invalid_condition":
        return "The condition is not a well-formed structured rule.";
      case "unsafe_operator":
        return "The condition uses a disallowed / host-access operator (rejected by the sandbox allow-list).";
      case "effect_out_of_bounds":
        return "The effect exceeds the entitlement's authored maximum or targets an undefined entitlement.";
      case "condition_too_large":
        return "The condition is too large / too deeply nested.";
      case "rule_set_limit_exceeded":
        return "This would push the tenant's live rule set past its configured size limit.";
      case "not_found":
        return "The target entitlement does not exist in this workspace.";
      case "validation_error":
        return `Invalid request: ${err.message}`;
      default:
        return err.message || "Could not save the rule.";
    }
  }
  return "Could not save the rule.";
}

/** Parse a JSON textarea, throwing a friendly error the form surfaces inline rather than a raw SyntaxError. */
function parseJson(label: string, text: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`The ${label} is not valid JSON.`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`The ${label} must be a JSON object.`);
  }
  return parsed as Record<string, unknown>;
}

export function PolicyRules({ sessionRole }: { sessionRole: Role }): JSX.Element {
  const [rules, setRules] = useState<PolicyRuleSummary[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Author form state.
  const [targetEntitlementId, setTargetEntitlementId] = useState("");
  const [priority, setPriority] = useState("100");
  const [status, setStatus] = useState<PolicyRuleStatus>("preview");
  const [condition, setCondition] = useState(SAMPLE_CONDITION);
  const [effect, setEffect] = useState(SAMPLE_EFFECT);

  // Version-history + dry-run panels (keyed by the selected rule).
  const [detail, setDetail] = useState<PolicyRuleDetail | null>(null);
  const [dryRunRuleKey, setDryRunRuleKey] = useState("");
  const [dryRunLicenseId, setDryRunLicenseId] = useState("");
  const [dryRunResult, setDryRunResult] = useState<DryRunResult | null>(null);

  const refresh = useCallback(async () => {
    const res = await policyApi.listRules();
    setRules(res.rules);
    setTruncated(res.truncated);
  }, []);

  useEffect(() => {
    void refresh().catch(() => setError("Could not load policy rules."));
  }, [refresh]);

  async function create(e: FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    setNotice(null);
    let cond: Record<string, unknown>;
    let eff: Record<string, unknown>;
    try {
      cond = parseJson("condition", condition);
      eff = parseJson("effect", effect);
    } catch (parseErr) {
      setError(parseErr instanceof Error ? parseErr.message : "Invalid JSON.");
      return;
    }
    try {
      const created = await policyApi.createRule({
        targetEntitlementId: targetEntitlementId.trim(),
        priority: Number(priority) || 0,
        status,
        condition: cond,
        effect: eff,
      });
      const warned = created.warnings && created.warnings.length > 0 ? ` (${created.warnings.length} lint warning(s))` : "";
      setNotice(`Rule ${created.ruleKey} saved as version ${created.version} (${created.status})${warned}.`);
      await refresh();
    } catch (err) {
      setError(authorErrorMessage(err));
    }
  }

  async function changeStatus(rule: PolicyRuleSummary, next: PolicyRuleStatus): Promise<void> {
    setError(null);
    setNotice(null);
    try {
      const summary = await policyApi.setStatus(rule.ruleKey, next);
      setNotice(`Rule ${summary.ruleKey} is now ${summary.status}.`);
      await refresh();
    } catch (err) {
      if (err instanceof ApiError && err.code === "invalid_state_transition") {
        setError(`Cannot move ${rule.status} → ${next} (invalid lifecycle transition).`);
      } else {
        setError("Could not change the rule status.");
      }
    }
  }

  async function showHistory(ruleKey: string): Promise<void> {
    setError(null);
    setDryRunResult(null);
    try {
      setDetail(await policyApi.getRule(ruleKey));
    } catch {
      setDetail(null);
      setError("Could not load the rule history.");
    }
  }

  async function runDryRun(e: FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    setNotice(null);
    setDryRunResult(null);
    if (!dryRunRuleKey.trim() || !dryRunLicenseId.trim()) return;
    try {
      const res = await policyApi.dryRun(dryRunRuleKey.trim(), { licenseId: dryRunLicenseId.trim() });
      setDryRunResult(res);
    } catch (err) {
      if (err instanceof ApiError && err.code === "not_found") setError("No such rule or license in this workspace.");
      else if (err instanceof ApiError && err.code === "validation_error") setError(`Dry-run rejected: ${err.message}`);
      else setError("Dry-run failed.");
    }
  }

  return (
    <section aria-label="Policy Rules">
      <h3>Policy rules</h3>
      {error && <p role="alert" className="error">{error}</p>}
      {notice && <p role="status">{notice}</p>}

      <RequireRole role={sessionRole} min="admin">
        <form onSubmit={create} aria-label="Author policy rule">
          <input
            aria-label="Target entitlement id"
            placeholder="entitlement uuid"
            value={targetEntitlementId}
            onChange={(e) => setTargetEntitlementId(e.target.value)}
            required
          />
          <input
            aria-label="Priority"
            type="number"
            min={0}
            placeholder="100"
            value={priority}
            onChange={(e) => setPriority(e.target.value)}
          />
          <select aria-label="Initial status" value={status} onChange={(e) => setStatus(e.target.value as PolicyRuleStatus)}>
            <option value="preview">preview</option>
            <option value="active">active</option>
            <option value="disabled">disabled</option>
          </select>
          <textarea
            aria-label="Condition JSON"
            placeholder={SAMPLE_CONDITION}
            value={condition}
            onChange={(e) => setCondition(e.target.value)}
          />
          <textarea
            aria-label="Effect JSON"
            placeholder={SAMPLE_EFFECT}
            value={effect}
            onChange={(e) => setEffect(e.target.value)}
          />
          <button type="submit">Validate &amp; save rule</button>
        </form>
      </RequireRole>

      {truncated && <p role="status">Showing the first 1000 rules (list truncated).</p>}
      {rules.length === 0 ? (
        <p role="status">No policy rules yet.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Rule</th><th>Entitlement</th><th>Priority</th><th>Effect</th><th>Status</th><th>Version</th><th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {rules.map((r) => (
              <tr key={r.ruleKey}>
                <td>{r.ruleKey}</td>
                <td>{r.targetEntitlementId}</td>
                <td>{r.priority}</td>
                <td>{r.effectKind ?? "—"}</td>
                <td>{r.status}</td>
                <td>{r.latestVersion}</td>
                <td>
                  <button type="button" onClick={() => void showHistory(r.ruleKey)}>History</button>
                  <RequireRole role={sessionRole} min="admin">
                    <button type="button" aria-label={`Preview ${r.ruleKey}`} onClick={() => void changeStatus(r, "preview")}>Preview</button>
                    <button type="button" aria-label={`Activate ${r.ruleKey}`} onClick={() => void changeStatus(r, "active")}>Activate</button>
                    <button type="button" aria-label={`Disable ${r.ruleKey}`} onClick={() => void changeStatus(r, "disabled")}>Disable</button>
                  </RequireRole>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <RequireRole role={sessionRole} min="admin">
        <form onSubmit={runDryRun} aria-label="Dry-run policy rule">
          <h4>Dry-run</h4>
          <input
            aria-label="Dry-run rule key"
            placeholder="rule uuid"
            value={dryRunRuleKey}
            onChange={(e) => setDryRunRuleKey(e.target.value)}
          />
          <input
            aria-label="Dry-run license id"
            placeholder="license uuid"
            value={dryRunLicenseId}
            onChange={(e) => setDryRunLicenseId(e.target.value)}
          />
          <button type="submit">Simulate</button>
        </form>
      </RequireRole>

      {dryRunResult && (
        <div role="region" aria-label="Dry-run result">
          <p>{`Would-be ${dryRunResult.decision.target}: ${String(dryRunResult.decision.baseValue)} → ${String(dryRunResult.decision.resolvedValue)} (source: ${dryRunResult.decision.source}${dryRunResult.decision.clamped ? ", clamped" : ""})`}</p>
          <p>{dryRunResult.firedRule ? `Fired rule ${dryRunResult.firedRule.ruleKey} v${dryRunResult.firedRule.version}` : "No rule fired (base decision stands)."}</p>
          {dryRunResult.consideredNotApplied.length > 0 && (
            <p>{`Considered, not applied: ${dryRunResult.consideredNotApplied.map((c) => `${c.ruleKey} v${c.version}`).join(", ")}`}</p>
          )}
        </div>
      )}

      {detail && (
        <div role="region" aria-label="Version history">
          <h4>{`History for ${detail.ruleKey} (latest v${detail.latestVersion}, ${detail.status})`}</h4>
          <table>
            <thead>
              <tr><th>Version</th><th>Priority</th><th>Status</th><th>Author</th><th>Created</th></tr>
            </thead>
            <tbody>
              {detail.versions.map((v) => (
                <tr key={v.version}>
                  <td>{v.version}</td>
                  <td>{v.priority}</td>
                  <td>{v.status}</td>
                  <td>{v.author}</td>
                  <td>{v.createdAt}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
