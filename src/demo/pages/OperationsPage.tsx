import { useState } from "react";
import { fixtureActivity, fixturePipeline } from "../fixtures";
import { AgentPipeline } from "../../components/operations/AgentPipeline";
import { StatusBadge } from "../../components/ui/StatusBadge";
import { ActivityLog } from "../../components/activity/ActivityLog";

export function OperationsPage() {
  const [stages, setStages] = useState(fixturePipeline);
  const retryStage = (stageId: string) => setStages((current) => current.map((stage) => stage.id === stageId ? { ...stage, status: "running" } : stage));

  return (
    <div className="operations-page">
      <header className="page-heading page-heading-simple">
        <div>
          <span className="eyebrow">Operations / automation</span>
          <h1>Agent pipeline</h1>
          <p>Observe how each agent moves source records toward a reviewable decision.</p>
        </div>
        <StatusBadge status="operational" label="All systems operational" tone="confirm" />
      </header>
      <AgentPipeline stages={stages} mode="detail" onRetry={retryStage} />
      <section className="activity-section" aria-labelledby="activity-title">
        <div className="section-header-lined"><div><span className="section-kicker">Operations / traceability</span><h2 id="activity-title">Activity log</h2></div><span className="section-meta">Immutable events</span></div>
        <ActivityLog events={fixtureActivity} />
      </section>
    </div>
  );
}
