import type { CaseStatus, DecisionAction, SentinelDecisionService } from "../domain/types";

type RpcError = { code?: string; message?: string };

export type SentinelDecisionClient = {
  rpc(
    name: "sentinel_record_decision",
    args: { p_investigation_id: string; p_workspace_id: string; p_action: DecisionAction; p_rationale: string },
  ): Promise<{ data: unknown; error: RpcError | null }>;
};

type DecisionContext = { workspaceId: string };

export const EMPTY_RATIONALE_ERROR = "Record why you are making this decision.";
export const MAX_RATIONALE_LENGTH = 2000;
export const LONG_RATIONALE_ERROR = `Rationale must be ${MAX_RATIONALE_LENGTH} characters or fewer.`;
export const CASE_NOT_FOUND_ERROR = "This case is no longer available. Reload the page and try again.";

/**
 * P0001 messages are written for a reader by the function that raised them, so passing one
 * through untouched is more useful than any sentence this layer could substitute. PT404 is
 * the exception: PostgREST's own explicit-status convention (the PT prefix plus a
 * three-digit code sets the HTTP status directly), raised when the investigation lookup
 * finds no row. "Investigation not found" is a true statement about a query, not advice.
 */
function mapRpcError(error: RpcError | null) {
  if (error?.code === "P0001" && error.message?.trim()) return new Error(error.message);
  if (error?.code === "PT404") return new Error(CASE_NOT_FOUND_ERROR);
  return new Error(`Unable to record decision: ${error?.message || "Unknown Supabase error."}`);
}

export function createSentinelDecisionService(
  client: SentinelDecisionClient,
  context: DecisionContext,
): SentinelDecisionService {
  return {
    async record(investigationId, action, rationale) {
      // Checked here as well as in the RPC. The database is the authority; this only saves
      // a round trip on the mistake a reader is most likely to make.
      const trimmed = rationale.trim();
      if (!trimmed) throw new Error(EMPTY_RATIONALE_ERROR);
      if (trimmed.length > MAX_RATIONALE_LENGTH) throw new Error(LONG_RATIONALE_ERROR);

      // No actor argument: the RPC resolves the caller from auth.uid(), so a client cannot
      // sign someone else's name to a decision.
      const { data, error } = await client.rpc("sentinel_record_decision", {
        p_investigation_id: investigationId,
        p_workspace_id: context.workspaceId,
        p_action: action,
        p_rationale: trimmed,
      });

      if (error) throw mapRpcError(error);

      const status = (data as { status?: string } | null)?.status;
      return { status: status as CaseStatus };
    },
  };
}
