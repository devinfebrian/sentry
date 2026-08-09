import { createAdminClient, requireUser, type SupabaseClientLike } from "../_shared/auth.ts";
import { isActiveMembership, parseUploadRequest, PolicyError } from "../_shared/auth-policy.ts";
import { environmentAllowedOrigins, errorResponse, handleCors, HttpError, jsonResponse, readJson } from "../_shared/cors.ts";
import type { ParsedImportRow, ParserValue } from "../_shared/parser.ts";
import { AGENT_DESCRIPTORS, isAgentKey, type AgentKey } from "../_shared/agentKeys.ts";
import { AgentRefusalError, AgentUnavailableError } from "../_shared/fraudPatterns.ts";
import { failAnalysis, recordAnalysis, startAgentRun, type UploadScope } from "../_shared/analysisRuns.ts";
import { PRODUCERS } from "./agents.ts";
import { createGeminiModel, MissingModelKeyError } from "./geminiModel.ts";

/**
 * Runs one agent against an already-parsed upload.
 *
 * This is the piece parse-upload's inline analysis could never be: re-runnable. Analysis
 * reads the persisted rows rather than the file, so an agent can be retried after a failure,
 * after a new agent is added, or after a prompt changes — without re-importing anything.
 */

const allowedOrigins = environmentAllowedOrigins();

/**
 * Rows read back for analysis. The parser accepts up to 100,000; reading all of them into a
 * function's memory to hand to a producer is not something to do without a bound. When an
 * upload exceeds this, the run's input_count records what was actually analysed, so the
 * number on screen is the number the agent saw.
 */
export const ANALYSIS_ROW_LIMIT = 10_000;

function responseForError(error: unknown, request: Request) {
  if (error instanceof HttpError || error instanceof PolicyError) {
    return errorResponse(error.message, error.status, request, allowedOrigins);
  }
  return errorResponse("Unable to analyse upload.", 500, request, allowedOrigins);
}

function parseAgentKey(body: unknown): AgentKey {
  const value = (body as { agentKey?: unknown })?.agentKey;
  if (!isAgentKey(value)) {
    throw new PolicyError("Unknown agent.", 400);
  }
  return value;
}

/**
 * Turns a plain-language reason out of whatever went wrong.
 *
 * Every branch names something the reader can act on. A run row cannot exist in the failed
 * state without one of these, so this is the last place a failure can become legible.
 */
function failureReason(error: unknown): string {
  if (error instanceof AgentRefusalError) return error.message;
  if (error instanceof AgentUnavailableError) return error.message;
  if (error instanceof MissingModelKeyError) {
    return "This workspace has no analysis model configured. Set GEMINI_API_KEY and retry.";
  }
  return "The agent stopped before it finished. You can retry this agent.";
}

/**
 * Reads back the rows the parse persisted.
 *
 * Headers are reconstructed from the row objects and sorted, because jsonb does not preserve
 * key order — the spreadsheet's original column order is not recoverable from storage. Every
 * analysis now runs through this same path, so every run sees the same header order as every
 * other run; only the original file's ordering is lost, and nothing depends on it.
 */
async function loadRows(admin: SupabaseClientLike, upload: UploadScope) {
  const { data, error } = await admin
    .from("sentinel_import_rows")
    .select("source_row, entity, values")
    .eq("workspace_id", upload.workspace_id)
    .eq("upload_id", upload.id)
    .order("source_row", { ascending: true })
    .limit(ANALYSIS_ROW_LIMIT);

  if (error) {
    throw new HttpError("Unable to read the imported rows for this upload.", 500);
  }

  const rows: ParsedImportRow[] = (data ?? []).map((row: {
    source_row: number;
    entity: string;
    values: Record<string, ParserValue> | null;
  }) => ({
    sourceRow: row.source_row,
    entity: row.entity,
    values: row.values ?? {},
  }));

  const headers = [...new Set(rows.flatMap((row) => Object.keys(row.values)))].sort();
  return { headers, rows };
}

async function analyzeAuthorizedUpload(
  request: Request,
  uploadId: string,
  agentKey: AgentKey,
  session: Awaited<ReturnType<typeof requireUser>>,
) {
  const { client, user } = session;

  const { data: uploadData, error: uploadError } = await client
    .from("sentinel_uploads")
    .select("id, workspace_id, investigation_id, status")
    .eq("id", uploadId)
    .maybeSingle();

  if (uploadError || !uploadData) {
    throw new HttpError("Upload access denied.", 403);
  }

  const upload = uploadData as UploadScope & { status: string };

  const { data: membership, error: membershipError } = await client
    .from("sentinel_members")
    .select("workspace_id, status, role")
    .eq("workspace_id", upload.workspace_id)
    .eq("user_id", user.id)
    .eq("status", "active")
    .maybeSingle();

  if (membershipError || !isActiveMembership(membership)) {
    throw new HttpError("Upload access denied.", 403);
  }

  // Analysis reads persisted rows, so there is nothing to read until the parse has written
  // them. Saying so is more useful than running an agent over an empty set and reporting
  // "no findings" for a file that was never parsed.
  if (upload.status !== "parsed") {
    throw new HttpError("This upload has not been parsed yet. Parse it before running analysis.", 409);
  }

  const admin = await createAdminClient();
  const scope: UploadScope = {
    id: upload.id,
    workspace_id: upload.workspace_id,
    investigation_id: upload.investigation_id,
  };

  const { headers, rows } = await loadRows(admin, scope);
  await startAgentRun(admin, scope, agentKey, rows.length);

  let findings;
  try {
    findings = await PRODUCERS[agentKey]({ headers, rows, model: createGeminiModel });
  } catch (error) {
    const reason = failureReason(error);
    // A failure that cannot be recorded is the one failure the UI would show as "waiting"
    // forever, so let it surface as a 500 rather than swallowing it.
    await failAnalysis(admin, scope, agentKey, reason, user.id);
    return jsonResponse(
      { uploadId: upload.id, agentKey, status: "failed", reason },
      422,
      request,
      allowedOrigins,
    );
  }

  const recorded = await recordAnalysis(admin, scope, agentKey, findings, user.id);

  return jsonResponse(
    {
      uploadId: upload.id,
      agentKey,
      agent: AGENT_DESCRIPTORS[agentKey].name,
      status: "complete",
      rowCount: rows.length,
      findingCount: recorded.findingCount,
      evidenceCount: recorded.evidenceCount,
    },
    200,
    request,
    allowedOrigins,
  );
}

export async function handleRequest(request: Request) {
  if (request.method !== "POST") {
    return errorResponse("Method not allowed.", 405, request, allowedOrigins);
  }

  try {
    const session = await requireUser(request);
    const body = await readJson(request);
    const { uploadId } = parseUploadRequest(body);
    const agentKey = parseAgentKey(body);
    return await analyzeAuthorizedUpload(request, uploadId, agentKey, session);
  } catch (error) {
    return responseForError(error, request);
  }
}

export async function handleRoute(request: Request) {
  const corsResponse = handleCors(request, allowedOrigins);
  return corsResponse ?? (await handleRequest(request));
}

if (typeof Deno !== "undefined" && typeof Deno.serve === "function") {
  Deno.serve(handleRoute);
}
