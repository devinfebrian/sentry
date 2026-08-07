import { createAdminClient, requireUser, type SupabaseClientLike } from "../_shared/auth.ts";
import { isActiveMembership, parseUploadRequest, PolicyError } from "../_shared/auth-policy.ts";
import { environmentAllowedOrigins, errorResponse, handleCors, HttpError, jsonResponse, readJson } from "../_shared/cors.ts";
import { deduplicateRows, parseWorkbook } from "../_shared/parser.ts";
import XLSX from "./spreadsheet.ts";
import {
  claimUploadForParsing,
  completeParse,
  isProcessingLeaseFresh,
  markFailed,
  ParseCompletionEventError,
  ProcessingLeaseLostError,
  reconcileParseEvent,
  type UploadRecord,
} from "./processing.ts";

const allowedOrigins = environmentAllowedOrigins();
const parserFailureMessage = "Unable to parse upload. You can retry this upload.";
const parserStateFailureMessage = "Parser state could not be recorded.";

function responseForError(error: unknown, request: Request) {
  if (error instanceof HttpError || error instanceof PolicyError) {
    return errorResponse(error.message, error.status, request, allowedOrigins);
  }
  return errorResponse("Unable to parse upload.", 500, request, allowedOrigins);
}

function statusResponse(uploadId: string, status: "processing" | "parsed", request: Request, upload?: Pick<UploadRecord, "row_count" | "warnings">) {
  return jsonResponse(
    {
      uploadId,
      status,
      ...(status === "parsed" ? { rowCount: upload?.row_count ?? 0, warnings: upload?.warnings ?? [] } : {}),
    },
    status === "processing" ? 202 : 200,
    request,
    allowedOrigins,
  );
}

function failedResponse(uploadId: string, request: Request) {
  return jsonResponse({ uploadId, status: "failed", error: parserFailureMessage }, 422, request, allowedOrigins);
}

async function currentStateResponse(admin: SupabaseClientLike, upload: UploadRecord, actorId: string, request: Request) {
  const { data, error } = await admin
    .from("sentinel_uploads")
    .select("status, row_count, warnings")
    .eq("id", upload.id)
    .maybeSingle();
  if (error || !data) {
    return errorResponse(parserStateFailureMessage, 500, request, allowedOrigins);
  }

  if (data.status === "parsed") {
    const rowCount = typeof data.row_count === "number" ? data.row_count : 0;
    const warnings = Array.isArray(data.warnings) ? data.warnings : [];
    try {
      await reconcileParseEvent(
        admin,
        { ...upload, status: "parsed", row_count: rowCount, warnings },
        actorId,
        rowCount,
        warnings.length,
      );
    } catch {
      return errorResponse(parserStateFailureMessage, 500, request, allowedOrigins);
    }
    return statusResponse(upload.id, "parsed", request, { row_count: rowCount, warnings });
  }
  if (data.status === "failed") {
    return failedResponse(upload.id, request);
  }
  return statusResponse(upload.id, "processing", request);
}

async function parseAuthorizedUpload(request: Request, uploadId: string, session: Awaited<ReturnType<typeof requireUser>>) {
  const { client, user } = session;
  const { data: uploadData, error: uploadError } = await client
    .from("sentinel_uploads")
    .select("id, workspace_id, investigation_id, storage_path, status, row_count, warnings, processing_started_at")
    .eq("id", uploadId)
    .maybeSingle();

  if (uploadError || !uploadData) {
    throw new HttpError("Upload access denied.", 403);
  }

  const upload = uploadData as UploadRecord;
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

  if (upload.status === "parsed") {
    const admin = await createAdminClient();
    try {
      await reconcileParseEvent(admin, upload, user.id, upload.row_count, upload.warnings.length);
    } catch {
      return errorResponse(parserStateFailureMessage, 500, request, allowedOrigins);
    }
    return statusResponse(upload.id, "parsed", request, upload);
  }
  if (upload.status === "processing" && isProcessingLeaseFresh(upload)) {
    return statusResponse(upload.id, "processing", request);
  }
  if (upload.status === "created" || upload.status === "uploading") {
    throw new HttpError("Upload is not ready for parsing. Finish uploading the file first.", 409);
  }

  const admin = await createAdminClient();
  const claim = await claimUploadForParsing(admin, upload);
  if (claim.status === "parsed") {
    try {
      await reconcileParseEvent(admin, upload, user.id, claim.row_count, claim.warnings.length);
    } catch {
      return errorResponse(parserStateFailureMessage, 500, request, allowedOrigins);
    }
    return statusResponse(upload.id, "parsed", request, claim);
  }
  if (claim.status === "failed") {
    return failedResponse(upload.id, request);
  }
  if (claim.status === "processing") {
    return statusResponse(upload.id, "processing", request);
  }

  const claimedUpload: UploadRecord = {
    ...upload,
    status: "processing",
    processing_started_at: claim.processing_started_at,
  };

  try {

    const { error: startEventError } = await admin.from("sentinel_activity_events").insert({
      workspace_id: upload.workspace_id,
      investigation_id: upload.investigation_id,
      actor_id: user.id,
      event_type: "parse-started",
      metadata: { status: "processing", upload_id: upload.id },
    });
    if (startEventError) {
      throw new Error("Unable to record parse activity.");
    }

    const { data: file, error: downloadError } = await admin.storage.from("sentinel-imports").download(upload.storage_path);
    if (downloadError || !file) {
      throw new Error("Unable to download upload.");
    }

    const parsed = parseWorkbook(await file.arrayBuffer(), XLSX);
    const rows = deduplicateRows(parsed.rows);
    await completeParse(admin, claimedUpload, parsed, rows, user.id);
    return statusResponse(upload.id, "parsed", request, { row_count: rows.length, warnings: parsed.warnings });
  } catch (error) {
    if (error instanceof ParseCompletionEventError) {
      return errorResponse(parserStateFailureMessage, 500, request, allowedOrigins);
    }

    if (error instanceof ProcessingLeaseLostError) {
      return currentStateResponse(admin, claimedUpload, user.id, request);
    }

    try {
      await markFailed(admin, claimedUpload, user.id, parserFailureMessage);
    } catch (failureError) {
      if (failureError instanceof ProcessingLeaseLostError) {
        return currentStateResponse(admin, claimedUpload, user.id, request);
      }
      return errorResponse(parserStateFailureMessage, 500, request, allowedOrigins);
    }
    return failedResponse(upload.id, request);
  }
}

export async function handleRequest(request: Request) {
  if (request.method !== "POST") {
    return errorResponse("Method not allowed.", 405, request, allowedOrigins);
  }

  try {
    const session = await requireUser(request);
    const { uploadId } = parseUploadRequest(await readJson(request));
    return await parseAuthorizedUpload(request, uploadId, session);
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
