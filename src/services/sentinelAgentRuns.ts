import type { PostgrestResponse } from "@supabase/supabase-js";
import type { AgentRun, AgentRunStatus, AgentStage, SentinelAgentRunService } from "../domain/types";
import { AGENT_DESCRIPTORS, isAgentKey, type AgentKey } from "../domain/agents";

type AgentRunRow = {
  id: string;
  upload_id: string;
  agent_key: string;
  status: AgentRunStatus;
  failure_reason: string | null;
  input_count: number;
  output_count: number;
  started_at: string | null;
  completed_at: string | null;
};

export type SentinelAgentRunReadQuery = {
  eq(column: "workspace_id" | "investigation_id", value: string): SentinelAgentRunReadQuery;
  order(column: "created_at", options: { ascending: boolean }): SentinelAgentRunReadQuery;
  limit(count: number): PromiseLike<PostgrestResponse<AgentRunRow>>;
};

export type SentinelAgentRunClient = {
  from(table: "sentinel_agent_runs"): {
    select(columns: string): SentinelAgentRunReadQuery;
  };
  functions: {
    invoke(name: string, options: { body: unknown }): PromiseLike<{ data: unknown; error: unknown }>;
  };
};

export const AGENT_RUN_COLUMNS =
  "id, upload_id, agent_key, status, failure_reason, input_count, output_count, started_at, completed_at";

/** An investigation accumulates one run per agent per upload; this bounds an unusual case. */
export const DEFAULT_RUN_LIMIT = 200;

type AgentRunContext = { workspaceId: string };

function mapError(operation: string, error: { message?: string } | null) {
  return new Error(`Unable to ${operation}: ${error?.message || "Unknown Supabase error."}`);
}

/**
 * Collapses an investigation's runs into one stage per agent.
 *
 * `completed / total` counts uploads, not rows: an agent has genuinely finished 2 of 3
 * uploads, and that is a fraction worth showing. A per-run percentage would have to invent
 * partial progress, since a run either finishes or does not.
 *
 * Status precedence is failed > running > waiting > complete. A stage that has failed
 * anywhere reads as failed even if other uploads succeeded — the design spec's rule that
 * failure is never hidden matters more here than a flattering summary.
 */
export function toPipelineStages(runs: AgentRun[]): AgentStage[] {
  const byAgent = new Map<AgentKey, AgentRun[]>();
  for (const run of runs) {
    if (!isAgentKey(run.agentKey)) continue;
    byAgent.set(run.agentKey, [...(byAgent.get(run.agentKey) ?? []), run]);
  }

  const stages: AgentStage[] = [];

  for (const [agentKey, agentRuns] of byAgent) {
    const descriptor = AGENT_DESCRIPTORS[agentKey];
    const failed = agentRuns.filter((run) => run.status === "failed");
    const complete = agentRuns.filter((run) => run.status === "complete");

    const status: AgentRunStatus = failed.length > 0
      ? "failed"
      : agentRuns.some((run) => run.status === "running")
        ? "running"
        : agentRuns.some((run) => run.status === "waiting")
          ? "waiting"
          : "complete";

    const started = agentRuns.map((run) => run.startedAt).filter((value): value is string => Boolean(value)).sort();
    const finished = agentRuns.map((run) => run.completedAt).filter((value): value is string => Boolean(value)).sort();

    stages.push({
      id: agentKey,
      order: descriptor.order,
      name: descriptor.name,
      status,
      completed: complete.length,
      total: agentRuns.length,
      startedAt: started[0],
      completedAt: status === "complete" ? finished[finished.length - 1] : undefined,
      // One upload's reason reads better than a joined list; the count says there are more.
      failureReason: failed.length > 0
        ? failed.length === 1
          ? failed[0].failureReason
          : `${failed[0].failureReason} (${failed.length} uploads affected)`
        : undefined,
      inputCount: agentRuns.reduce((total, run) => total + run.inputCount, 0),
      outputCount: agentRuns.reduce((total, run) => total + run.outputCount, 0),
    });
  }

  return stages.sort((left, right) => left.order - right.order);
}

/**
 * Decides which of an agent's runs a single click should act on.
 *
 * Outstanding work comes first: a stage reading `failed` because one upload of three failed
 * should retry that one, not redo the two that succeeded. Only when nothing is outstanding
 * does the click mean "do it again", and then it targets the completed runs.
 *
 * A `running` run is never targeted, so a second click cannot double-trigger work already
 * in flight.
 */
export function runsToTrigger(runs: AgentRun[], agentKey: string): AgentRun[] {
  const forAgent = runs.filter((run) => run.agentKey === agentKey);
  const outstanding = forAgent.filter((run) => run.status === "failed" || run.status === "waiting");

  return outstanding.length > 0 ? outstanding : forAgent.filter((run) => run.status === "complete");
}

/**
 * Runs one agent across the uploads that click should act on.
 *
 * Sequential rather than parallel: these are model calls, and a reader who clicks retry
 * wants the first real reason back, not four concurrent requests racing to report the same
 * outage. The loop stops at the first failure so that reason reaches the caller.
 */
export async function runAgentAcrossUploads(
  service: SentinelAgentRunService,
  runs: AgentRun[],
  agentKey: string,
) {
  for (const run of runsToTrigger(runs, agentKey)) {
    await service.run(run.uploadId, run.agentKey);
  }
}

export function createSentinelAgentRunService(
  client: SentinelAgentRunClient,
  context: AgentRunContext,
): SentinelAgentRunService {
  return {
    async list(investigationId) {
      let query = client
        .from("sentinel_agent_runs")
        .select(AGENT_RUN_COLUMNS)
        .eq("workspace_id", context.workspaceId);

      // Omitted on the workspace-wide Operations view, where the pipeline spans every case.
      if (investigationId) query = query.eq("investigation_id", investigationId);

      const { data, error } = await query
        .order("created_at", { ascending: true })
        .limit(DEFAULT_RUN_LIMIT);

      if (error) throw mapError("load agent runs", error);

      return (data ?? []).map((row) => ({
        id: row.id,
        uploadId: row.upload_id,
        agentKey: row.agent_key,
        status: row.status,
        failureReason: row.failure_reason ?? undefined,
        inputCount: row.input_count,
        outputCount: row.output_count,
        startedAt: row.started_at ?? undefined,
        completedAt: row.completed_at ?? undefined,
      }));
    },

    async run(uploadId, agentKey) {
      const { data, error } = await client.functions.invoke("analyze-upload", {
        body: { uploadId, agentKey },
      });

      if (error) throw mapError("run this agent", error as { message?: string });

      // A run that failed comes back as a normal response carrying its reason, not as a
      // transport error. Surfacing that reason is the difference between "retry did
      // nothing" and "retry ran and the model declined again".
      const outcome = data as { status?: string; reason?: string } | null;
      if (outcome?.status === "failed") {
        throw new Error(outcome.reason || "This agent failed again. Check the pipeline for details.");
      }
    },
  };
}
