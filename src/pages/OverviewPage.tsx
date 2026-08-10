import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { AgentPipeline } from "../components/operations/AgentPipeline";
import { Button } from "../components/ui/Button";
import { EmptyState } from "../components/ui/EmptyState";
import { ErrorState } from "../components/ui/ErrorState";
import { LoadingState } from "../components/ui/LoadingState";
import { StatusBadge } from "../components/ui/StatusBadge";
import type { AgentStage, CaseStage, CaseSummary, SentinelInvestigationService } from "../domain/types";
import type { RefObject } from "react";

export interface OverviewDemoData {
  cases: CaseSummary[];
  pipeline: AgentStage[];
}

export interface OverviewPageProps {
  onImportData?: () => void;
  importButtonRef?: RefObject<HTMLButtonElement | null>;
  investigationService?: Pick<SentinelInvestigationService, "list"> | null;
  demoData?: OverviewDemoData;
}

const riskLabels = { low: "Low risk", medium: "Medium risk", high: "High risk", "not-assessed": "Not assessed" } as const;
const stageLabels: Record<CaseStage, string> = {
  "awaiting-import": "Analysis not started",
  analysing: "Analysing",
  "analysis-failed": "Analysis failed",
  "awaiting-analysis": "Awaiting analysis",
  "fraud-review": "Fraud review",
  analysed: "Analysed",
};

type LoadState =
  | { status: "loading" }
  | { status: "error"; error: unknown }
  | { status: "ready"; cases: CaseSummary[] };

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Try again to reload persisted investigations.";
}

export function OverviewPage({ onImportData, importButtonRef, investigationService, demoData }: OverviewPageProps) {
  const [stages, setStages] = useState<AgentStage[]>(() => demoData?.pipeline ?? []);
  const [retryKey, setRetryKey] = useState(0);
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const requestIdRef = useRef(0);

  useEffect(() => {
    const requestId = ++requestIdRef.current;
    let active = true;
    const isCurrent = () => active && requestIdRef.current === requestId;

    if (demoData) {
      setState({ status: "ready", cases: demoData.cases });
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
      .then(() => investigationService.list())
      .then((cases) => {
        if (isCurrent()) setState({ status: "ready", cases });
      })
      .catch((error: unknown) => {
        if (isCurrent()) setState({ status: "error", error });
      });

    return () => {
      active = false;
    };
  }, [demoData, investigationService, retryKey]);

  const retryStage = (stageId: string) => {
    setStages((current) => current.map((stage) => stage.id === stageId ? { ...stage, status: "running" } : stage));
  };

  const retry = () => setRetryKey((current) => current + 1);
  const cases = state.status === "ready" ? state.cases : [];
  const activeCases = cases.slice(0, 4);

  return (
    <div className="overview-page">
      <header className="page-heading">
        <div>
          <span className="eyebrow">Wednesday, 05 August 2026 / Finance operations</span>
          <h1>Overview</h1>
          <p>Review work in motion, resolve evidence gaps, and move decisions forward.</p>
        </div>
        {/* One button: the dialog now names the investigation as well as importing its
            data, so a separate "Import data" would open the same thing. */}
        <div className="page-actions">
          <Button ref={importButtonRef} variant="primary" onClick={onImportData}>New investigation</Button>
        </div>
      </header>

      {state.status === "loading" && <LoadingState label="Loading overview cases" />}
      {state.status === "error" && <ErrorState title="Overview unavailable" description={errorMessage(state.error)} action={<Button variant="secondary" onClick={retry}>Retry</Button>} />}
      {state.status === "ready" && cases.length === 0 && <EmptyState title="No investigations yet" description="Import financial data to create your first persisted investigation." action={<Button variant="primary" onClick={onImportData}>Import data</Button>} />}
      {state.status === "ready" && cases.length > 0 && <>
        <section className="metric-strip" aria-label="Queue metrics">
          <div className="metric-cell"><span>Open cases</span><strong className="numeric">{cases.filter((item) => item.status !== "closed").length}</strong><em>Persisted queue</em></div>
          <div className="metric-cell metric-cell-risk"><span>High risk</span><strong className="numeric">{cases.filter((item) => item.risk === "high").length}</strong><em>Assessment required</em></div>
          <div className="metric-cell"><span>Evidence ready</span><strong>Not assessed</strong><em>Analysis not started</em></div>
          <div className="metric-cell"><span>Confirmed impact</span><strong>Not assessed</strong><em>Analysis not started</em></div>
        </section>

        {demoData && <AgentPipeline stages={stages} onRetry={retryStage} />}

        <section className="overview-cases" aria-labelledby="active-cases-title">
          <div className="section-header-lined">
            <div>
              <span className="section-kicker">Review queue / active</span>
              <h2 id="active-cases-title">Cases in motion</h2>
            </div>
            <Link className="text-link" to="/cases">View all cases <span aria-hidden="true">-&gt;</span></Link>
          </div>
          <div className="case-list">
            {activeCases.map((item) => (
              <Link className="case-list-row" to={`/cases/${item.id}/summary`} key={item.id}>
                <span className="case-list-identity"><span className="numeric">{item.id}</span><strong>{item.entity}</strong></span>
                <span>{item.owner}</span>
                <span>{stageLabels[item.stageId] ?? item.stageId}</span>
                <StatusBadge status={item.risk} label={riskLabels[item.risk]} tone={item.risk === "high" ? "risk" : item.risk === "low" ? "confirm" : item.risk === "not-assessed" ? "neutral" : "warning"} />
                <span className="case-list-arrow" aria-hidden="true">-&gt;</span>
              </Link>
            ))}
          </div>
        </section>
      </>}
    </div>
  );
}
