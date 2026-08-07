import { AnalysisNotStartedState } from "../components/cases/AnalysisNotStartedState";

interface AnalysisNotStartedPageProps {
  module: string;
  step: string;
}

export function AnalysisNotStartedPage({ module, step }: AnalysisNotStartedPageProps) {
  return (
    <div className="module-boundary-page">
      <header className="page-heading page-heading-simple">
        <div>
          <span className="eyebrow">Workspace / {module}</span>
          <h1>{module}</h1>
          <p>This module becomes available after an investigation has started processing source data.</p>
        </div>
      </header>
      <AnalysisNotStartedState step={step} />
    </div>
  );
}
