import { CASE_STAGE_LABELS } from "../../domain/caseStages";
import type { CaseStage, RiskLevel } from "../../domain/types";
import { StatusBadge } from "../ui/StatusBadge";

const stepDescriptions: Record<string, string> = {
  decision: "Decision records are not produced by an agent yet. Nothing here reflects a real review.",
  report: "Report assembly is not produced by an agent yet. Nothing here reflects a real review.",
};

const riskLabels: Record<RiskLevel, string> = { low: "Low risk", medium: "Medium risk", high: "High risk", "not-assessed": "Not assessed" };

/**
 * Shown on report once analysis has begun for the case. Decision used to share this state
 * too, until DecisionPanel gave it a real implementation — this narrowed rather than
 * deleted, because the distinction below is still live for report.
 *
 * Distinct from AnalysisNotStartedState on purpose: "not started" is a claim about the
 * case, and stage already says otherwise once it has moved past awaiting-import. "Not
 * built" is a claim about the software — report has no producer at all, on any case, at
 * any stage. Conflating the two is how "Analysis not started / Stage: Analysed" ended up
 * in one status region.
 */
export function StepNotBuiltState({ step, stage, risk }: { step: string; stage: CaseStage; risk: RiskLevel }) {
  return (
    <section className="state-panel" aria-labelledby="step-not-built-title">
      <span className="state-kicker">Analysis status</span>
      <h3 id="step-not-built-title">This step is not built yet</h3>
      <p>{stepDescriptions[step] ?? "This step has no implementation yet."}</p>
      <div role="status" aria-live="polite">
        <StatusBadge status={risk} label={riskLabels[risk]} tone={risk === "high" ? "risk" : risk === "low" ? "confirm" : risk === "not-assessed" ? "neutral" : "warning"} />
        <span>Stage: {CASE_STAGE_LABELS[stage]}</span>
      </div>
    </section>
  );
}
