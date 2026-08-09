import { useState } from "react";
import { AgentPipeline } from "../components/operations/AgentPipeline";
import { Button } from "../components/ui/Button";
import { ErrorState } from "../components/ui/ErrorState";
import { LoadingState } from "../components/ui/LoadingState";
import type { SentinelAgentRunService } from "../domain/types";
import { runAgentAcrossUploads, toPipelineStages } from "../services/sentinelAgentRuns";
import { useAgentRuns } from "./useAgentRuns";

interface OperationsPageProps {
  agentRunService?: SentinelAgentRunService | null;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Try again to reload the agent pipeline.";
}

export function OperationsPage({ agentRunService }: OperationsPageProps) {
  const { state, refresh } = useAgentRuns(undefined, agentRunService, { scope: "workspace" });
  const [actionError, setActionError] = useState<string | null>(null);

  const handleRetry = async (agentKey: string) => {
    if (state.status !== "ready" || !agentRunService) return;
    setActionError(null);
    try {
      await runAgentAcrossUploads(agentRunService, state.runs, agentKey);
    } catch (error) {
      // The agent ran and reported why it could not finish. Saying so beats silently
      // re-rendering the same failed stage as though nothing happened.
      setActionError(errorMessage(error));
    } finally {
      refresh();
    }
  };

  return (
    <div className="operations-page">
      <header className="page-heading page-heading-simple">
        <div>
          <span className="eyebrow">Operations / automation</span>
          <h1>Agent pipeline</h1>
          <p>Every agent run in this workspace, and what each one produced.</p>
        </div>
      </header>

      {state.status === "loading" && <LoadingState label="Loading agent pipeline" />}

      {state.status === "error" && (
        <ErrorState
          title="Agent pipeline unavailable"
          description={errorMessage(state.error)}
          action={<Button variant="secondary" onClick={refresh}>Retry</Button>}
        />
      )}

      {state.status === "ready" && (
        <>
          {actionError && (
            <div role="alert" className="agent-pipeline-action-error">{actionError}</div>
          )}
          <AgentPipeline
            stages={toPipelineStages(state.runs)}
            mode="detail"
            onRetry={handleRetry}
          />
        </>
      )}
    </div>
  );
}
