import type { AgentStage } from "../../domain/types";
import { Link } from "react-router-dom";
import { AgentStage as AgentStageCard } from "./AgentStage";

interface AgentPipelineProps {
  stages: AgentStage[];
  mode?: "summary" | "detail";
  onRetry?: (stageId: string) => void | Promise<void>;
}

function plural(count: number, noun: string) {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

export function AgentPipeline({ stages, mode = "summary", onRetry }: AgentPipelineProps) {
  const orderedStages = [...stages].sort((a, b) => a.order - b.order);
  const uploadsCovered = orderedStages.reduce((total, stage) => Math.max(total, stage.total), 0);

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
          // Counted from the runs on screen. This read "4 agents / 24 active cases" while
          // the pipeline was demo data, and would have kept saying so over real runs.
          <span className="section-meta numeric">
            {plural(orderedStages.length, "agent")} / {plural(uploadsCovered, "upload")}
          </span>
        )}
      </div>
      {orderedStages.length === 0 ? (
        <p className="agent-pipeline-empty">
          No agent has run yet. Import data into an investigation to start the pipeline.
        </p>
      ) : (
        <ol className="agent-stage-list">
          {orderedStages.map((stage) => (
            <AgentStageCard key={stage.id} stage={stage} compact={mode === "summary"} onRetry={onRetry} />
          ))}
        </ol>
      )}
    </section>
  );
}
