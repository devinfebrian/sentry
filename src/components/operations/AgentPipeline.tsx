import type { AgentStage } from "../../domain/types";
import { Link } from "react-router-dom";
import { AgentStage as AgentStageCard } from "./AgentStage";

interface AgentPipelineProps {
  stages: AgentStage[];
  mode?: "summary" | "detail";
  onRetry?: (stageId: string) => void | Promise<void>;
}

export function AgentPipeline({ stages, mode = "summary", onRetry }: AgentPipelineProps) {
  const orderedStages = [...stages].sort((a, b) => a.order - b.order);

  return (
    <section className={`agent-pipeline agent-pipeline-${mode}`} aria-labelledby="agent-pipeline-title">
      <div className="section-header-lined">
        <div>
          <span className="section-kicker">Operations / automation</span>
          <h2 id="agent-pipeline-title">Agent pipeline</h2>
        </div>
        {mode === "summary" ? (
          <Link className="text-link" to="/operations">View full pipeline <span aria-hidden="true">-&gt;</span></Link>
        ) : (
          <span className="section-meta numeric">4 agents / 24 active cases</span>
        )}
      </div>
      <ol className="agent-stage-list">
        {orderedStages.map((stage) => (
          <AgentStageCard key={stage.id} stage={stage} compact={mode === "summary"} onRetry={onRetry} />
        ))}
      </ol>
      {mode === "detail" && (
        <div className="pipeline-detail-footer">
          <span>Run status updates appear here as agents produce new evidence.</span>
          <span className="status-live" role="status" aria-live="polite">Last checked 2 min ago</span>
        </div>
      )}
    </section>
  );
}
