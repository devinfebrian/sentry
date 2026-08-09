import type { ParsedImport, ParsedImportRow } from "../_shared/parser.ts";
import type { AnalysisFinding } from "../_shared/analysis.ts";
import type { SupabaseClientLike } from "../_shared/auth.ts";

export const processingLeaseMs = 15 * 60 * 1000;

export type UploadStatus = "created" | "uploading" | "uploaded" | "processing" | "parsed" | "failed";

export interface UploadRecord {
  id: string;
  workspace_id: string;
  investigation_id: string;
  storage_path: string;
  status: UploadStatus;
  row_count: number;
  warnings: string[];
  processing_started_at: string | null;
}

export class ProcessingLeaseLostError extends Error {
  constructor() {
    super("Processing lease is no longer owned.");
    this.name = "ProcessingLeaseLostError";
  }
}

export class ParseCompletionEventError extends Error {
  constructor() {
    super("Unable to record parse activity.");
    this.name = "ParseCompletionEventError";
  }
}

export class ParseFinalizationError extends Error {
  constructor() {
    super("Unable to finalize parsed upload.");
    this.name = "ParseFinalizationError";
  }
}

export class ParserStateError extends Error {
  constructor() {
    super("Unable to record failed upload.");
    this.name = "ParserStateError";
  }
}

export interface ParsedUploadState {
  status: "parsed";
  row_count: number;
  warnings: string[];
}

export interface FailedUploadState {
  status: "failed";
  error_message: string;
}

function isLeaseLostRpcError(error: unknown) {
  if (!error || typeof error !== "object") {
    return false;
  }

  const rpcError = error as { code?: unknown; message?: unknown };
  return rpcError.code === "P0001" || (typeof rpcError.message === "string" && /processing lease lost/i.test(rpcError.message));
}

async function callParserRpc<T>(admin: SupabaseClientLike, functionName: string, payload: Record<string, unknown>, errorType: Error) {
  let result: { data: unknown; error: unknown };
  try {
    result = await admin.rpc(functionName, payload);
  } catch {
    throw errorType;
  }

  const { data, error } = result;
  if (error) {
    if (isLeaseLostRpcError(error)) {
      throw new ProcessingLeaseLostError();
    }
    throw errorType;
  }
  return data as T;
}

export function isProcessingLeaseFresh(upload: Pick<UploadRecord, "status" | "processing_started_at">, now = new Date()) {
  if (upload.status !== "processing" || !upload.processing_started_at) {
    return false;
  }

  const startedAt = Date.parse(upload.processing_started_at);
  const age = now.getTime() - startedAt;
  return Number.isFinite(startedAt) && age >= 0 && age < processingLeaseMs;
}

export async function markProcessing(admin: SupabaseClientLike, upload: UploadRecord, now = new Date()) {
  let query = admin
    .from("sentinel_uploads")
    .update({ status: "processing", processing_started_at: now.toISOString(), error_message: null })
    .eq("id", upload.id)
    .eq("workspace_id", upload.workspace_id)
    .eq("status", upload.status);

  query = upload.processing_started_at === null
    ? query.is("processing_started_at", null)
    : query.eq("processing_started_at", upload.processing_started_at);

  const { data, error } = await query.select("id").maybeSingle();
  if (error) {
    throw new Error("Unable to mark upload processing.");
  }
  return Boolean(data);
}

export async function claimUploadForParsing(admin: SupabaseClientLike, upload: UploadRecord, now = new Date()) {
  if (isProcessingLeaseFresh(upload, now)) {
    return { status: "processing" as const };
  }

  if (await markProcessing(admin, upload, now)) {
    return { status: "claimed" as const, processing_started_at: now.toISOString() };
  }

  const { data: latest, error } = await admin
    .from("sentinel_uploads")
    .select("status, row_count, warnings")
    .eq("id", upload.id)
    .maybeSingle();
  if (error) {
    throw new Error("Unable to read upload processing state.");
  }

  if (latest?.status === "parsed") {
    return {
      status: "parsed" as const,
      row_count: latest.row_count,
      warnings: latest.warnings,
    };
  }

  if (latest?.status === "failed") {
    return { status: "failed" as const };
  }

  return { status: "processing" as const };
}

const parserFailureMessage = "Unable to parse upload. You can retry this upload.";

function constrainToProcessingLease(query: any, upload: UploadRecord) {
  query = query.eq("id", upload.id).eq("workspace_id", upload.workspace_id).eq("status", "processing");
  return upload.processing_started_at === null
    ? query.is("processing_started_at", null)
    : query.eq("processing_started_at", upload.processing_started_at);
}

export async function hasProcessingLease(admin: SupabaseClientLike, upload: UploadRecord) {
  if (!upload.processing_started_at) {
    return false;
  }

  const { data, error } = await constrainToProcessingLease(
    admin.from("sentinel_uploads").select("id"),
    upload,
  ).maybeSingle();
  return !error && Boolean(data);
}

export async function assertProcessingLease(admin: SupabaseClientLike, upload: UploadRecord) {
  if (!(await hasProcessingLease(admin, upload))) {
    throw new ProcessingLeaseLostError();
  }
}

export async function markFailed(
  admin: SupabaseClientLike,
  upload: UploadRecord,
  actorId?: string,
  errorText = parserFailureMessage,
) {
  return callParserRpc<FailedUploadState>(
    admin,
    "sentinel_fail_upload",
    {
      upload_id: upload.id,
      workspace_id: upload.workspace_id,
      investigation_id: upload.investigation_id,
      lease_started_at: upload.processing_started_at,
      actor_id: actorId ?? null,
      error_text: errorText,
    },
    new ParserStateError(),
  );
}

export async function completeParse(
  admin: SupabaseClientLike,
  upload: UploadRecord,
  parsed: ParsedImport,
  rows: ParsedImportRow[],
  actorId?: string,
) {
  const warnings = parsed.warnings;
  return callParserRpc<ParsedUploadState>(
    admin,
    "sentinel_finalize_upload",
    {
      upload_id: upload.id,
      workspace_id: upload.workspace_id,
      investigation_id: upload.investigation_id,
      lease_started_at: upload.processing_started_at,
      rows: rows.map((row) => ({ sourceRow: row.sourceRow, entity: row.entity, values: row.values })),
      warnings,
      actor_id: actorId ?? null,
    },
    new ParseFinalizationError(),
  );
}

export class AnalysisRecordError extends Error {
  constructor() {
    super("Unable to record analysis.");
    this.name = "AnalysisRecordError";
  }
}

/**
 * Persists the findings for an upload, replacing any previous run.
 *
 * Deliberately not part of completeParse: the rows are the product, the analysis is a
 * reading of them. If this fails the parse still succeeded and the caller keeps its
 * result — analysis can be re-run against the persisted rows at any time.
 */
export async function recordAnalysis(
  admin: SupabaseClientLike,
  upload: Pick<UploadRecord, "id" | "workspace_id" | "investigation_id">,
  findings: AnalysisFinding[],
  actorId?: string,
) {
  return callParserRpc<{ findingCount: number; evidenceCount: number }>(
    admin,
    "sentinel_record_analysis",
    {
      p_upload_id: upload.id,
      p_workspace_id: upload.workspace_id,
      p_investigation_id: upload.investigation_id,
      p_findings: findings,
      p_actor_id: actorId ?? null,
    },
    new AnalysisRecordError(),
  );
}

export async function reconcileParseEvent(
  admin: SupabaseClientLike,
  upload: UploadRecord,
  actorId: string,
  rowCount: number,
  warningCount: number,
) {
  return callParserRpc<boolean>(
    admin,
    "sentinel_reconcile_parse_event",
    {
      upload_id: upload.id,
      workspace_id: upload.workspace_id,
      investigation_id: upload.investigation_id,
      actor_id: actorId,
      row_count: rowCount,
      warning_count: warningCount,
    },
    new ParseCompletionEventError(),
  );
}
