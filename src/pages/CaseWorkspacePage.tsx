import { useEffect, useRef, useState } from "react";
import { Link, Navigate, useParams } from "react-router-dom";
import { AnalysisNotStartedState } from "../components/cases/AnalysisNotStartedState";
import { AnalysisUnavailableState } from "../components/cases/AnalysisUnavailableState";
import { CaseHeader } from "../components/cases/CaseHeader";
import { AgentPipeline } from "../components/operations/AgentPipeline";
import { StatusBadge } from "../components/ui/StatusBadge";
import { Button } from "../components/ui/Button";
import { ErrorState } from "../components/ui/ErrorState";
import { LoadingState } from "../components/ui/LoadingState";
import { EvidenceLedger } from "../components/evidence/EvidenceLedger";
import { FindingPanel } from "../components/evidence/FindingPanel";
import { DecisionRecord as DecisionRecordComponent } from "../components/decisions/DecisionRecord";
import { UploadStatusPanel } from "../components/cases/UploadStatusPanel";
import { CaseActivityPanel } from "../components/cases/CaseActivityPanel";
import type { MemberNameLookup } from "../services/memberNames";
import { useCaseAnalysis } from "./useCaseAnalysis";
import type { AgentStage, CaseSummary, DecisionRecord as DecisionRecordData, EvidenceRecord, Finding, SentinelActivityService, SentinelAnalysisService, SentinelInvestigationService, SentinelUploadService } from "../domain/types";

const stepCopy: Record<string, { eyebrow: string; title: string; description: string }> = {
  summary: { eyebrow: "Case workspace / summary", title: "Investigation summary", description: "Review current agent progress, risk signals, and the next accountable action." },
  findings: { eyebrow: "Case workspace / findings", title: "Agent findings", description: "Compare conclusions across agents before opening source evidence." },
  evidence: { eyebrow: "Case workspace / evidence", title: "Evidence review", description: "Validate every material claim against a source row." },
  decision: { eyebrow: "Case workspace / decision", title: "Decision record", description: "Record recommendation, rationale, and approval history." },
  report: { eyebrow: "Case workspace / report", title: "Investigation report", description: "Assemble reviewed findings into an export-ready record." },
};

export interface CaseWorkspaceDemoData {
  cases: CaseSummary[];
  pipeline: AgentStage[];
  evidence: EvidenceRecord[];
  findings: Finding[];
  decision: DecisionRecordData;
}

export interface CaseWorkspacePageProps {
  investigationService?: Pick<SentinelInvestigationService, "getById"> | null;
  uploadService?: Pick<SentinelUploadService, "getLatestForInvestigation" | "getStatus" | "listRows" | "retryParsing"> | null;
  activityService?: SentinelActivityService | null;
  analysisService?: SentinelAnalysisService | null;
  memberNames?: MemberNameLookup | null;
  demoData?: CaseWorkspaceDemoData;
}

type LoadState =
  | { status: "loading" }
  | { status: "error"; error: unknown }
  | { status: "ready"; caseItem: CaseSummary | null };

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Try again to reload this persisted investigation.";
}

export function CaseWorkspacePage({ investigationService, uploadService, activityService, analysisService, memberNames, demoData }: CaseWorkspacePageProps) {
  const { caseId = "", step = "summary" } = useParams();
  const [retryKey, setRetryKey] = useState(0);
  const [state, setState] = useState<LoadState>(() => demoData
    ? { status: "ready", caseItem: demoData.cases.find((item) => item.id === caseId) ?? null }
    : { status: "loading" });
  const requestIdRef = useRef(0);

  useEffect(() => {
    const requestId = ++requestIdRef.current;
    let active = true;
    const isCurrent = () => active && requestIdRef.current === requestId;

    if (demoData) {
      setState({ status: "ready", caseItem: demoData.cases.find((item) => item.id === caseId) ?? null });
      return () => {
        active = false;
      };
    }

    setState({ status: "loading" });
    if (!investigationService) {
      setState({ status: "error", error: new Error("Persisted investigation service is unavailable. Sign in again and retry.") });
      return () => {
        active = false;
      };
    }

    void Promise.resolve()
      .then(() => investigationService.getById(caseId))
      .then((caseItem) => {
        if (isCurrent()) setState({ status: "ready", caseItem });
      })
      .catch((error: unknown) => {
        if (isCurrent()) setState({ status: "error", error });
      });

    return () => {
      active = false;
    };
  }, [caseId, demoData, investigationService, retryKey]);

  const retry = () => setRetryKey((current) => current + 1);
  const analysis = useCaseAnalysis(demoData ? undefined : state.status === "ready" ? state.caseItem?.databaseId : undefined, analysisService);

  if (state.status === "loading") return <LoadingState label="Loading case" />;

  if (state.status === "error") {
    return <ErrorState title="Case workspace unavailable" description={errorMessage(state.error)} action={<Button variant="secondary" onClick={retry}>Retry</Button>} />;
  }

  const caseItem = state.caseItem;
  if (!caseItem) {
    return <ErrorState title="Case workspace unavailable" description={`No persisted investigation matches reference ${caseId}. Return to Cases and choose an available investigation.`} action={<Link className="text-link" to="/cases">Return to cases</Link>} />;
  }

  const content = stepCopy[step];
  if (!content) return <Navigate to={`/cases/${caseItem.id}/summary`} replace />;

  const analysisFindings = analysis.status === "ready" ? analysis.findings : [];
  const analysisEvidence = analysis.status === "ready" ? analysis.evidence : [];
  const hasFindings = analysisFindings.length > 0;
  // A failed read is not an absence of findings. Only the findings and evidence steps
  // read analysis at all, so only they can report its failure.
  const analysisFailed = analysis.status === "error" && (step === "findings" || step === "evidence");

  const findings = demoData?.findings.filter((finding) => finding.caseId === caseItem.id) ?? [];
  return (
    <div className="case-workspace-page">
      <CaseHeader caseItem={caseItem} currentStep={step} />
      <div className="case-workspace-content">
        <header className="page-heading page-heading-simple"><div><span className="eyebrow">{content.eyebrow}</span><h2>{content.title}</h2><p>{content.description}</p></div><StatusBadge status={caseItem.status} label={caseItem.status.replace("-", " ")} tone={caseItem.status === "approved" ? "confirm" : "action"} /></header>
        {demoData ? (
          <>
            {step === "summary" && <><AgentPipeline stages={demoData.pipeline} /><section className="workspace-summary-grid"><div className="summary-note"><span className="section-kicker">Risk signal</span><strong>Beneficiary mismatch needs enhanced review.</strong><p>Two supporting evidence records and one contradictory record are linked to this case.</p></div><div className="summary-note"><span className="section-kicker">Next action</span><strong>Confirm alternate beneficiary notice.</strong><p>Decision stays pending until source package is complete.</p></div></section></>}
            {step === "findings" && <section className="finding-list">{findings.map((finding) => <FindingPanel finding={finding} evidence={demoData.evidence} key={finding.id} />)}</section>}
            {step === "evidence" && <EvidenceLedger records={demoData.evidence} caseId={caseItem.id} />}
            {step === "decision" && <DecisionRecordComponent decision={demoData.decision} />}
            {step === "report" && <section className="step-placeholder"><span className="section-kicker">Evidence-led workflow</span><h3>{content.title} module ready</h3><p>Use ordered case steps to keep source review, decision, and reporting connected.</p></section>}
          </>
        ) : (
          <>
            {/* Source data is real once parsed; the rest of the pipeline still is not.
                Each part reports itself, rather than letting one imply the others. */}
            {step === "summary" && <UploadStatusPanel investigationId={caseItem.databaseId} uploadService={uploadService} />}

            {step === "findings" && hasFindings && (
              <section className="finding-list">
                {analysisFindings.map((finding) => (
                  <FindingPanel finding={finding} evidence={analysisEvidence} key={finding.id} />
                ))}
              </section>
            )}
            {step === "evidence" && hasFindings && (
              // No caseId: the query already scoped these to this investigation, and the
              // ledger's own filter matches on reference, which these records do not carry.
              <EvidenceLedger records={analysisEvidence} />
            )}

            {analysisFailed && <AnalysisUnavailableState />}

            {/* Still true wherever analysis produced nothing — a clean import genuinely
                has no findings, and the other steps have no implementation at all. */}
            {!analysisFailed && !(hasFindings && (step === "findings" || step === "evidence")) && (
              <AnalysisNotStartedState step={step} />
            )}
            {step === "summary" && (
              <CaseActivityPanel
                investigationId={caseItem.databaseId}
                activityService={activityService}
                memberNames={memberNames}
              />
            )}
          </>
        )}
      </div>
    </div>
  );
}
