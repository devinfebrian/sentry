import type {
  PostgrestMaybeSingleResponse,
  PostgrestResponse,
  PostgrestSingleResponse,
} from "@supabase/supabase-js";
import type { ImportRow, SentinelUpload, SentinelUploadService, UploadParserResult, UploadParserStatus, UploadStatus } from "../domain/types";
import type { Database, Json } from "../lib/database.types";
import { assertImportableFile, getFilenameLeaf } from "./importFile";

type UploadRow = Database["public"]["Tables"]["sentinel_uploads"]["Row"];
type UploadInsert = Database["public"]["Tables"]["sentinel_uploads"]["Insert"];
type UploadUpdate = Database["public"]["Tables"]["sentinel_uploads"]["Update"];
type ImportRowRow = Database["public"]["Tables"]["sentinel_import_rows"]["Row"];

export type SentinelUploadReadQuery = {
  eq(column: "workspace_id" | "id" | "investigation_id", value: string): SentinelUploadReadQuery;
  order(column: "created_at", options: { ascending: boolean }): SentinelUploadReadQuery;
  limit(count: number): PromiseLike<PostgrestResponse<UploadRow>>;
  maybeSingle(): PromiseLike<PostgrestMaybeSingleResponse<UploadRow>>;
};

export type SentinelUploadInsertQuery = {
  select(columns: "*"): SentinelUploadInsertQuery;
  single(): PromiseLike<PostgrestSingleResponse<UploadRow>>;
};

export type SentinelUploadUpdateQuery = {
  eq(column: "workspace_id" | "id", value: string): SentinelUploadUpdateQuery;
  select(columns: "*"): SentinelUploadUpdateQuery;
  single(): PromiseLike<PostgrestSingleResponse<UploadRow>>;
};

export interface SentinelUploadRecovery {
  kind: "sentinel-upload-recovery";
  investigationId: string;
  uploadId: string;
  retryUpload: () => Promise<SentinelUpload>;
}

export class SentinelUploadRecoveryError extends Error {
  readonly recovery: SentinelUploadRecovery;

  constructor(message: string, recovery: SentinelUploadRecovery) {
    super(message);
    this.name = "SentinelUploadRecoveryError";
    this.recovery = recovery;
  }
}

export type SentinelImportRowReadQuery = {
  eq(column: "workspace_id" | "upload_id", value: string): SentinelImportRowReadQuery;
  order(column: "source_row", options: { ascending: boolean }): SentinelImportRowReadQuery;
  limit(count: number): PromiseLike<PostgrestResponse<ImportRowRow>>;
};

type StorageUpload = {
  upload(
    path: string,
    file: File,
    options?: { contentType?: string; upsert?: boolean },
  ): PromiseLike<{ data: { path: string } | null; error: { message?: string } | null }>;
};

export type SentinelUploadClient = {
  from(table: "sentinel_uploads"): {
    select(columns: "*"): SentinelUploadReadQuery;
    insert(values: UploadInsert): SentinelUploadInsertQuery;
    update(values: UploadUpdate): SentinelUploadUpdateQuery;
  };
  from(table: "sentinel_import_rows"): {
    select(columns: "*"): SentinelImportRowReadQuery;
  };
  storage: {
    from(bucket: "sentinel-imports"): StorageUpload;
  };
  functions: {
    invoke(
      functionName: "parse-upload",
      options: { body: { uploadId: string } },
    ): PromiseLike<{ data: unknown; error: { message?: string } | null }>;
  };
};

type SentinelUploadContext = { workspaceId: string; userId: string };

/**
 * A parse accepts up to MAX_ROWS (100k) rows. Callers ask for a preview, so the read is
 * bounded by construction rather than by every caller remembering to bound it.
 */
export const DEFAULT_ROW_LIMIT = 500;

function sanitizeFilename(filename: string, extension: string) {
  const leaf = getFilenameLeaf(filename);
  const extensionStart = leaf.lastIndexOf(".");
  const base = extensionStart >= 0 ? leaf.slice(0, extensionStart) : leaf;
  const sanitizedBase = base.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[^A-Za-z0-9]+/, "") || "upload";
  const suffix = `.${extension}`;
  const maximumBaseLength = Math.max(1, 255 - suffix.length);
  return `${sanitizedBase.slice(0, maximumBaseLength)}${suffix}`;
}

function mapError(operation: string, error: { message?: string } | null) {
  return new Error(`Unable to ${operation}: ${error?.message || "Unknown Supabase error."}`);
}

function mapWarnings(value: Json): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function mapUpload(row: UploadRow): SentinelUpload {
  return {
    id: row.id,
    investigationId: row.investigation_id,
    status: row.status as UploadStatus,
    rowCount: row.row_count,
    warnings: mapWarnings(row.warnings),
    errorMessage: row.error_message,
  };
}

function mapValues(value: Json): Record<string, string | number> {
  if (!value || Array.isArray(value) || typeof value !== "object") {
    return {};
  }

  const values: Record<string, string | number> = {};
  Object.entries(value).forEach(([key, item]) => {
    if (typeof item === "string" || typeof item === "number") {
      values[key] = item;
    }
  });
  return values;
}

function mapParserResult(value: unknown, uploadId: string): UploadParserResult | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }

  const payload = value as { uploadId?: unknown; status?: unknown; rowCount?: unknown; warnings?: unknown; error?: unknown };
  if (payload.status !== "processing" && payload.status !== "parsed" && payload.status !== "failed") {
    return null;
  }

  const status = payload.status as UploadParserStatus;
  return {
    uploadId: typeof payload.uploadId === "string" ? payload.uploadId : uploadId,
    status,
    ...(typeof payload.rowCount === "number" ? { rowCount: payload.rowCount } : {}),
    ...(Array.isArray(payload.warnings) ? { warnings: payload.warnings.filter((item): item is string => typeof item === "string") } : {}),
    ...(typeof payload.error === "string" ? { errorMessage: payload.error } : {}),
  };
}

async function invokeParser(client: SentinelUploadClient, uploadId: string, operation: string) {
  const { data, error } = await client.functions.invoke("parse-upload", { body: { uploadId } });
  const result = mapParserResult(data, uploadId);
  if (result) {
    return result;
  }
  if (error) {
    throw mapError(operation, error);
  }
  throw new Error(`Unable to ${operation}: Parser returned no status.`);
}

export function createSentinelUploadService(
  client: SentinelUploadClient,
  context: SentinelUploadContext,
): SentinelUploadService {
  const finalizeUpload = async (uploadId: string, storagePath: string, file: File, upsert: boolean) => {
    const { error: storageError } = await client.storage.from("sentinel-imports").upload(storagePath, file, {
      contentType: file.type || undefined,
      upsert,
    });
    if (storageError) {
      throw mapError(upsert ? "retry file upload" : "upload file", storageError);
    }

    const { data: uploadedRow, error: updateError } = await client
      .from("sentinel_uploads")
      .update({ status: "uploaded", uploaded_at: new Date().toISOString() })
      .eq("workspace_id", context.workspaceId)
      .eq("id", uploadId)
      .select("*")
      .single();
    if (updateError) {
      throw mapError("mark upload uploaded", updateError);
    }
    if (!uploadedRow) {
      throw new Error("Unable to mark upload uploaded: Supabase returned no upload.");
    }

    return mapUpload(uploadedRow);
  };

  return {
    async createUpload({ investigationId, file }) {
      const extension = assertImportableFile(file) as UploadInsert["extension"];

      const id = crypto.randomUUID();
      const storagePath = `${context.workspaceId}/${investigationId}/${id}/${sanitizeFilename(file.name, extension)}`;
      const metadata: UploadInsert = {
        id,
        workspace_id: context.workspaceId,
        investigation_id: investigationId,
        storage_path: storagePath,
        original_name: file.name,
        extension,
        mime_type: file.type || null,
        byte_size: file.size,
        uploaded_by: context.userId,
      };

      const { data: insertedUpload, error: insertError } = await client
        .from("sentinel_uploads")
        .insert(metadata)
        .select("*")
        .single();
      if (insertError) {
        throw mapError("create upload", insertError);
      }
      if (!insertedUpload) {
        throw new Error("Unable to create upload: Supabase returned no upload.");
      }

      const retryUpload = () => finalizeUpload(id, storagePath, file, true);
      try {
        return await finalizeUpload(id, storagePath, file, false);
      } catch (caught) {
        throw new SentinelUploadRecoveryError(
          caught instanceof Error ? caught.message : "Unable to upload file. Retry this upload.",
          { kind: "sentinel-upload-recovery", investigationId, uploadId: id, retryUpload },
        );
      }
    },

    async startParsing(uploadId) {
      return invokeParser(client, uploadId, "start parsing");
    },

    async getStatus(uploadId) {
      const { data, error } = await client
        .from("sentinel_uploads")
        .select("*")
        .eq("workspace_id", context.workspaceId)
        .eq("id", uploadId)
        .maybeSingle();
      if (error) {
        throw mapError("load upload", error);
      }
      if (!data) {
        throw new Error("Unable to load upload: Upload not found.");
      }
      return mapUpload(data);
    },

    async retryParsing(uploadId) {
      return invokeParser(client, uploadId, "retry parsing");
    },

    async getLatestForInvestigation(investigationId) {
      const { data, error } = await client
        .from("sentinel_uploads")
        .select("*")
        .eq("workspace_id", context.workspaceId)
        .eq("investigation_id", investigationId)
        .order("created_at", { ascending: false })
        .limit(1);
      if (error) {
        throw mapError("load latest upload", error);
      }

      // No upload is a legitimate state — an investigation can be created without one.
      const row = data?.[0];
      return row ? mapUpload(row) : null;
    },

    async listRows(uploadId, limit = DEFAULT_ROW_LIMIT) {
      const { data, error } = await client
        .from("sentinel_import_rows")
        .select("*")
        .eq("workspace_id", context.workspaceId)
        .eq("upload_id", uploadId)
        .order("source_row", { ascending: true })
        .limit(limit);
      if (error) {
        throw mapError("list import rows", error);
      }

      return (data ?? []).map((row): ImportRow => ({
        entity: row.entity,
        values: mapValues(row.values),
        sourceRow: row.source_row,
      }));
    },
  };
}

export const createSentinelUploads = createSentinelUploadService;
