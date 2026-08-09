import { useState } from "react";
import type { AgentStage as AgentStageData } from "../../domain/types";
import { Button } from "../ui/Button";
import { StatusBadge } from "../ui/StatusBadge";

interface AgentStageProps {
  stage: AgentStageData;
  onRetry?: (stageId: string) => void | Promise<void>;
  compact?: boolean;
}

const statusLabels = {
  waiting: "Waiting",
  running: "Running",
  review: "Review queue",
  complete: "Complete",
  blocked: "Blocked",
  failed: "Failed",
} as const;

function getTone(status: AgentStageData["status"]) {
  if (status === "complete") return "confirm" as const;
  if (status === "failed" || status === "blocked") return "risk" as const;
  if (status === "running" || status === "review") return "action" as const;
  return "neutral" as const;
}

interface StageAction {
  label: string;
  busyLabel: string;
  ariaLabel: string;
}

/** What a click means for a stage in this state, or nothing when there is no work to start. */
function getAction(stage: AgentStageData): StageAction | null {
  switch (stage.status) {
    case "failed":
      return { label: "Retry stage", busyLabel: "Retrying", ariaLabel: `Retry ${stage.name}` };
    case "waiting":
      return { label: "Run agent", busyLabel: "Running", ariaLabel: `Run ${stage.name}` };
    case "complete":
      return { label: "Run again", busyLabel: "Running", ariaLabel: `Run ${stage.name} again` };
    default:
      return null;
  }
}

export function AgentStage({ stage, onRetry, compact = false }: AgentStageProps) {
  const [retrying, setRetrying] = useState(false);
  const percentage = stage.total > 0 ? Math.round((stage.completed / stage.total) * 100) : 0;
  const statusLabel = statusLabels[stage.status];
  const action = getAction(stage);

  const handleRetry = async () => {
    if (!onRetry) return;
    setRetrying(true);
    try {
      await onRetry(stage.id);
    } finally {
      setRetrying(false);
    }
  };

  return (
    <li className={`agent-stage ${compact ? "agent-stage-compact" : ""} agent-stage-${stage.status}`}>
      <div className="agent-stage-topline">
        <span className="agent-stage-order numeric">{String(stage.order).padStart(2, "0")}</span>
        <StatusBadge status={stage.status} label={statusLabel} tone={getTone(stage.status)} />
      </div>
      <h3>{stage.name}</h3>
      <div className="agent-stage-progress-row">
        <div className="agent-stage-progress" role="progressbar" aria-label={`${stage.name} progress`} aria-valuemin={0} aria-valuemax={stage.total} aria-valuenow={stage.completed}>
          <span style={{ width: `${percentage}%` }} />
        </div>
        <span className="numeric agent-stage-percentage">{percentage}%</span>
      </div>
      <div className="agent-stage-meta">
        <span className="numeric">{stage.completed} / {stage.total} complete</span>
        {stage.completedAt && <span>{stage.completedAt}</span>}
      </div>
      {!compact && (stage.inputCount !== undefined || stage.outputCount !== undefined) && (
        <div className="agent-stage-counts">
          <span><b className="numeric">{stage.inputCount ?? 0}</b> input records</span>
          <span><b className="numeric">{stage.outputCount ?? 0}</b> outputs</span>
        </div>
      )}
      {stage.failureReason && (
        <p className="agent-stage-failure">{stage.failureReason}</p>
      )}
      {/* One action against the same run row, labelled for what the click actually does.
          A waiting agent has been scheduled but nothing has asked it to run; a complete one
          can be run again, which is the whole point of scoping findings by producer — a
          re-run replaces this agent's findings and leaves every other agent's alone. Only
          `running` offers nothing, because the work is already in flight.

          "Retry" on a stage that has never run, or one that succeeded, would misdescribe
          it — hence three labels rather than one. */}
      {action && onRetry && (
        <Button
          variant="secondary"
          onClick={handleRetry}
          disabled={retrying}
          aria-label={action.ariaLabel}
        >
          {retrying ? action.busyLabel : action.label}
        </Button>
      )}
    </li>
  );
}
