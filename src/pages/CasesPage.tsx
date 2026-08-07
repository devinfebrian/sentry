import { useEffect, useRef, useState } from "react";
import { CaseQueue } from "../components/cases/CaseQueue";
import { Button } from "../components/ui/Button";
import { EmptyState } from "../components/ui/EmptyState";
import { ErrorState } from "../components/ui/ErrorState";
import { LoadingState } from "../components/ui/LoadingState";
import type { CaseSummary, SentinelInvestigationService } from "../domain/types";
import type { RefObject } from "react";

export interface CasesDemoData {
  cases: CaseSummary[];
}

export interface CasesPageProps {
  investigationService?: Pick<SentinelInvestigationService, "list"> | null;
  onImportData?: () => void;
  importButtonRef?: RefObject<HTMLButtonElement | null>;
  demoData?: CasesDemoData;
}

type LoadState =
  | { status: "loading" }
  | { status: "error"; error: unknown }
  | { status: "ready"; cases: CaseSummary[] };

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Try again to reload persisted investigations.";
}

export function CasesPage({ investigationService, onImportData, importButtonRef, demoData }: CasesPageProps) {
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

  const retry = () => setRetryKey((current) => current + 1);

  return (
    <div className="cases-page">
      <header className="page-heading page-heading-simple">
        <div><span className="eyebrow">Workspace / investigations</span><h1>Cases</h1><p>Prioritize investigations by risk, stage, and the next review action.</p></div>
        <div className="page-actions"><Button variant="primary">New investigation</Button><Button ref={importButtonRef} variant="secondary" onClick={onImportData}>Import data</Button></div>
      </header>
      {state.status === "loading" && <LoadingState label="Loading cases" />}
      {state.status === "error" && <ErrorState title="Cases unavailable" description={errorMessage(state.error)} action={<Button variant="secondary" onClick={retry}>Retry</Button>} />}
      {state.status === "ready" && state.cases.length === 0 && <EmptyState title="No investigations yet" description="Import financial data to create your first persisted investigation." action={<Button variant="primary" onClick={onImportData}>Import data</Button>} />}
      {state.status === "ready" && state.cases.length > 0 && <CaseQueue cases={state.cases} />}
    </div>
  );
}
