import type { AnalysisFinding } from "./analysis.ts";
import type { AgentKey } from "./agentKeys.ts";
import type { SupabaseClientLike } from "./auth.ts";

/**
 * The run lifecycle: seed → start → (record | fail).
 *
 * Unlike the parser's RPCs these take no processing lease. Analysis runs after the parse
 * has finished and released it, so the upload is already 'parsed' by the time anything here
 * is called; the functions verify the upload belongs to the workspace and stop there.
 */

export interface UploadScope {
  id: string;
  workspace_id: string;
  investigation_id: string;
}

export class AnalysisRunError extends Error {
  constructor(message = "Unable to record analysis run.") {
    super(message);
    this.name = "AnalysisRunError";
  }
}

async function callRpc<T>(
  admin: SupabaseClientLike,
  functionName: string,
  payload: Record<string, unknown>,
): Promise<T> {
  let result: { data: unknown; error: unknown };
  try {
    result = await admin.rpc(functionName, payload);
  } catch {
    throw new AnalysisRunError();
  }

  if (result.error) {
    throw new AnalysisRunError();
  }
  return result.data as T;
}

/**
 * Puts every producer on the board as `waiting` the moment an upload parses, so the
 * pipeline shows the full sequence instead of materialising stages as they happen to start.
 * Idempotent — a re-parse leaves existing runs untouched.
 */
export function seedAgentRuns(
  admin: SupabaseClientLike,
  upload: UploadScope,
  agentKeys: readonly AgentKey[],
) {
  return callRpc<number>(admin, "sentinel_seed_agent_runs", {
    p_upload_id: upload.id,
    p_workspace_id: upload.workspace_id,
    p_investigation_id: upload.investigation_id,
    p_agent_keys: agentKeys,
  });
}

export function startAgentRun(
  admin: SupabaseClientLike,
  upload: UploadScope,
  agentKey: AgentKey,
  inputCount: number,
) {
  return callRpc<{ status: string }>(admin, "sentinel_start_agent_run", {
    p_upload_id: upload.id,
    p_workspace_id: upload.workspace_id,
    p_investigation_id: upload.investigation_id,
    p_agent_key: agentKey,
    p_input_count: inputCount,
  });
}

/**
 * Persists one producer's findings and completes its run in the same transaction.
 *
 * The delete inside is scoped to this agent_key, so recording the AI investigator's work
 * never touches what the deterministic rules proved.
 */
export function recordAnalysis(
  admin: SupabaseClientLike,
  upload: UploadScope,
  agentKey: AgentKey,
  findings: AnalysisFinding[],
  actorId?: string,
) {
  return callRpc<{ findingCount: number; evidenceCount: number }>(admin, "sentinel_record_analysis", {
    p_upload_id: upload.id,
    p_workspace_id: upload.workspace_id,
    p_investigation_id: upload.investigation_id,
    p_agent_key: agentKey,
    p_findings: findings,
    p_actor_id: actorId ?? null,
  });
}

/**
 * Records that a producer failed, with a reason the analyst can act on.
 *
 * Findings from an earlier successful run are left alone: a transient API outage is not a
 * retraction of evidence, and clearing them would make it look like one.
 */
export function failAnalysis(
  admin: SupabaseClientLike,
  upload: UploadScope,
  agentKey: AgentKey,
  reason: string,
  actorId?: string,
) {
  return callRpc<{ status: string; reason: string }>(admin, "sentinel_fail_analysis", {
    p_upload_id: upload.id,
    p_workspace_id: upload.workspace_id,
    p_investigation_id: upload.investigation_id,
    p_agent_key: agentKey,
    p_actor_id: actorId ?? null,
    p_reason: reason,
  });
}
