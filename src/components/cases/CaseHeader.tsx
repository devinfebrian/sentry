import { Link } from "react-router-dom";
import { formatRelative } from "../../lib/datetime";
import type { CaseSummary, RiskLevel } from "../../domain/types";
import { StatusBadge } from "../ui/StatusBadge";
import { Button } from "../ui/Button";

interface CaseHeaderProps {
  caseItem: CaseSummary;
  currentStep: string;
}

const steps = [
  { id: "summary", label: "Summary" },
  { id: "findings", label: "Findings" },
  { id: "evidence", label: "Evidence" },
  { id: "decision", label: "Decision" },
  { id: "report", label: "Report" },
] as const;

const riskLabels: Record<RiskLevel, string> = { low: "Low risk", medium: "Medium risk", high: "High risk", "not-assessed": "Not assessed" };

export function CaseHeader({ caseItem, currentStep }: CaseHeaderProps) {
  const currentIndex = Math.max(0, steps.findIndex((step) => step.id === currentStep));
  return (
    <>
      <header className="case-header">
        <div>
          <Link className="back-link" to="/cases">&lt;- Back to cases</Link>
          <span className="eyebrow">Investigation / {caseItem.id}</span>
          <h1>{caseItem.entity}</h1>
          <p>Case owner {caseItem.owner} / Last activity {formatRelative(caseItem.lastActivity)}</p>
        </div>
        <div className="case-header-actions"><StatusBadge status={caseItem.risk} label={riskLabels[caseItem.risk]} tone={caseItem.risk === "high" ? "risk" : caseItem.risk === "low" ? "confirm" : caseItem.risk === "not-assessed" ? "neutral" : "warning"} /><Button variant="secondary">Assign case</Button></div>
      </header>
      <nav className="case-step-rail" aria-label="Case steps">
        {steps.map((step, index) => {
          const active = currentStep === step.id;
          const complete = caseItem.analysisStatus !== "not-started" && index < currentIndex;
          return <Link className={`case-step ${active ? "case-step-active" : ""} ${complete ? "case-step-complete" : ""}`} aria-current={active ? "step" : undefined} to={`/cases/${caseItem.id}/${step.id}`} key={step.id}><span className="numeric" aria-hidden="true">{String(index + 1).padStart(2, "0")}</span><span>{step.label}</span>{complete && <span className="case-step-state">Complete</span>}</Link>;
        })}
      </nav>
    </>
  );
}
