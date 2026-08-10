import { CASE_STAGE_LABELS } from "../../domain/caseStages";
import type { CaseStage } from "../../domain/types";
import { StatusBadge } from "../ui/StatusBadge";

const stepDescriptions: Record<string, string> = {
  summary: "No agent run has started for this investigation.",
  findings: "Findings will appear after analysis produces reviewed outputs.",
  evidence: "Evidence review will be available after source data is processed.",
  decision: "A decision record will be available after findings and evidence are reviewed.",
  report: "A report will be available after analysis and decision review are complete.",
};

export function AnalysisNotStartedState({ step, stage }: { step: string; stage?: CaseStage }) {
  return (
    <section className="state-panel" aria-labelledby="analysis-not-started-title">
      <span className="state-kicker">Analysis status</span>
      <h3 id="analysis-not-started-title">Analysis not started</h3>
      <p>{stepDescriptions[step] ?? "Analysis has not started for this investigation."}</p>
      <div role="status" aria-live="polite">
        <StatusBadge status="not-assessed" label="Risk: Not assessed" tone="neutral" />
        {stage && <span>Stage: {CASE_STAGE_LABELS[stage]}</span>}
      </div>
    </section>
  );
}
