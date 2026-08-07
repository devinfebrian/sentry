import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  PostgrestMaybeSingleResponse,
  PostgrestResponse,
  PostgrestSingleResponse,
} from "@supabase/supabase-js";
import type { Database } from "../lib/database.types";
import {
  createSentinelUploadService,
  type SentinelImportRowReadQuery,
  type SentinelUploadClient,
  type SentinelUploadInsertQuery,
  type SentinelUploadReadQuery,
  type SentinelUploadUpdateQuery,
} from "./sentinelUploads";

type UploadRow = Database["public"]["Tables"]["sentinel_uploads"]["Row"];
type UploadInsert = Database["public"]["Tables"]["sentinel_uploads"]["Insert"];
type ImportRow = Database["public"]["Tables"]["sentinel_import_rows"]["Row"];
type UploadReadQuery = SentinelUploadReadQuery;
type UploadInsertQuery = SentinelUploadInsertQuery;
type UploadUpdateQuery = SentinelUploadUpdateQuery;
type ImportRowReadQuery = SentinelImportRowReadQuery;

const context = {
  workspaceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  userId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
};
const investigationId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const uploadId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

const uploadRow: UploadRow = {
  id: uploadId,
  workspace_id: context.workspaceId,
  investigation_id: investigationId,
  storage_path: `${context.workspaceId}/${investigationId}/${uploadId}/ledger.csv`,
  original_name: "ledger.csv",
  extension: "csv",
  mime_type: "text/csv",
  byte_size: 23,
  status: "uploaded",
  row_count: 2,
  warnings: ["Skipped blank row"],
  error_message: null,
  uploaded_by: context.userId,
  created_at: "2026-08-06T10:00:00.000Z",
  uploaded_at: "2026-08-06T10:01:00.000Z",
  processing_started_at: null,
  processed_at: null,
};

const importRows: ImportRow[] = [
  {
    id: "row-2",
    workspace_id: context.workspaceId,
    investigation_id: investigationId,
    upload_id: uploadId,
    source_row: 2,
    entity: "Northstar Ltd",
    values: { entity: "Northstar Ltd", amount: 1200 },
    created_at: "2026-08-06T10:02:00.000Z",
  },
  {
    id: "row-3",
    workspace_id: context.workspaceId,
    investigation_id: investigationId,
    upload_id: uploadId,
    source_row: 3,
    entity: "Orchid Supply",
    values: { entity: "Orchid Supply", amount: 450, note: "review" },
    created_at: "2026-08-06T10:02:00.000Z",
  },
];

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function singleResponse<T>(data: T): PostgrestSingleResponse<T> {
  return { data, error: null, status: 200, statusText: "OK", success: true, count: null };
}

function maybeSingleResponse<T>(data: T | null): PostgrestMaybeSingleResponse<T> {
  return { data, error: null, status: 200, statusText: "OK", success: true, count: null };
}

function listResponse<T>(data: T[]): PostgrestResponse<T> {
  return { data, error: null, status: 200, statusText: "OK", success: true, count: data.length };
}

function errorResponse<T>(operation: string, message: string): PostgrestSingleResponse<T> {
  return {
    data: null,
    error: {
      code: "42501",
      message,
      details: "",
      hint: "",
      name: "PostgrestError",
      toJSON: () => ({ name: "PostgrestError", message, details: "", hint: "", code: "42501" }),
    },
    status: 403,
    statusText: operation,
    success: false,
    count: null,
  };
}

function createReadQuery(response: PromiseLike<PostgrestMaybeSingleResponse<UploadRow>>) {
  let query!: UploadReadQuery;
  const eq = vi.fn((_column: "workspace_id" | "id", _value: string): UploadReadQuery => query);
  const maybeSingle = vi.fn(() => response);
  query = { eq, maybeSingle } satisfies UploadReadQuery;
  return { query, eq, maybeSingle };
}

function createUploadInsertQuery(response: PromiseLike<PostgrestSingleResponse<UploadRow>>) {
  let query!: UploadInsertQuery;
  const select = vi.fn((_columns: "*"): UploadInsertQuery => query);
  const single = vi.fn(() => response);
  query = { select, single } satisfies UploadInsertQuery;
  return { query, select, single };
}

function createUploadUpdateQuery(response: PromiseLike<PostgrestSingleResponse<UploadRow>>) {
  let query!: UploadUpdateQuery;
  const eq = vi.fn((_column: "workspace_id" | "id", _value: string): UploadUpdateQuery => query);
  const select = vi.fn((_columns: "*"): UploadUpdateQuery => query);
  const single = vi.fn(() => response);
  query = { eq, select, single } satisfies UploadUpdateQuery;
  return { query, eq, select, single };
}

function createRowQuery(response: PromiseLike<PostgrestResponse<ImportRow>>) {
  let query!: ImportRowReadQuery;
  const eq = vi.fn((_column: "workspace_id" | "upload_id", _value: string): ImportRowReadQuery => query);
  const order = vi.fn((_column: "source_row", _options: { ascending: boolean }) => response);
  query = { eq, order } satisfies ImportRowReadQuery;
  return { query, eq, order };
}

function createClient(options: {
  insertQuery?: UploadInsertQuery;
  updateQuery?: UploadUpdateQuery;
  uploadReadQuery?: UploadReadQuery;
  rowQuery?: ImportRowReadQuery;
  storageResponse?: { data: { path: string } | null; error: null | { message: string } };
  invokeResponse?: { data: unknown; error: null | { message: string } };
}) {
  const insert = vi.fn((_values: UploadInsert) => {
    if (!options.insertQuery) throw new Error("Unexpected upload insert.");
    return options.insertQuery;
  });
  const update = vi.fn((_values: Database["public"]["Tables"]["sentinel_uploads"]["Update"]) => {
    if (!options.updateQuery) throw new Error("Unexpected upload update.");
    return options.updateQuery;
  });
  const selectUpload = vi.fn((_columns: "*") => {
    if (!options.uploadReadQuery) throw new Error("Unexpected upload select.");
    return options.uploadReadQuery;
  });
  const selectRows = vi.fn((_columns: "*") => {
    if (!options.rowQuery) throw new Error("Unexpected row select.");
    return options.rowQuery;
  });
  const fromMock = vi.fn((table: "sentinel_uploads" | "sentinel_import_rows") =>
    table === "sentinel_uploads"
      ? { select: selectUpload, insert, update }
      : {
          select: selectRows,
          insert: vi.fn(() => {
            throw new Error("Normalized row insert is forbidden.");
          }),
          update: vi.fn(() => {
            throw new Error("Normalized row update is forbidden.");
          }),
          delete: vi.fn(() => {
            throw new Error("Normalized row delete is forbidden.");
          }),
        },
  );
  const upload = vi.fn(
    (_path: string, _file: File, _options?: { contentType?: string; upsert?: boolean }) =>
      Promise.resolve(options.storageResponse ?? { data: { path: "uploaded" }, error: null }),
  );
  const storageFrom = vi.fn((_bucket: "sentinel-imports") => ({ upload }));
  const invoke = vi.fn((_functionName: "parse-upload", _options: { body: { uploadId: string } }) =>
    Promise.resolve(options.invokeResponse ?? { data: { uploadId, status: "processing" }, error: null }),
  );
  const client = {
    from: fromMock as unknown as SentinelUploadClient["from"],
    storage: { from: storageFrom },
    functions: { invoke },
  } satisfies SentinelUploadClient;
  return { client, from: fromMock, insert, update, selectUpload, selectRows, storageFrom, upload, invoke };
}

function serviceFor(options: Parameters<typeof createClient>[0] = {}) {
  const fake = createClient(options);
  return { ...fake, service: createSentinelUploadService(fake.client, context) };
}

describe("createSentinelUploadService", () => {
  it.each(["notes.txt", "ledger.pdf", "ledger"])("rejects unsupported extension %s before any adapter call", async (name) => {
    const fake = serviceFor();

    await expect(fake.service.createUpload({ investigationId, file: new File(["data"], name) })).rejects.toThrow(
      /CSV, XLS, or XLSX/i,
    );
    expect(fake.from).not.toHaveBeenCalled();
    expect(fake.storageFrom).not.toHaveBeenCalled();
  });

  it("rejects empty and oversized files before any adapter call", async () => {
    const fake = serviceFor();

    await expect(fake.service.createUpload({ investigationId, file: new File([], "empty.csv") })).rejects.toThrow(/empty/i);
    await expect(
      fake.service.createUpload({ investigationId, file: new File([new Uint8Array(26214401)], "large.csv") }),
    ).rejects.toThrow(/25 MB/i);
    expect(fake.from).not.toHaveBeenCalled();
    expect(fake.storageFrom).not.toHaveBeenCalled();
  });

  it("sanitizes the filename into the exact workspace investigation upload path", async () => {
    const { query: insertQuery } = createUploadInsertQuery(Promise.resolve(singleResponse(uploadRow)));
    const { query: updateQuery } = createUploadUpdateQuery(Promise.resolve(singleResponse(uploadRow)));
    const fake = serviceFor({ insertQuery, updateQuery });
    vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue(uploadId);

    await fake.service.createUpload({
      investigationId,
      file: new File(["entity,amount\nNorthstar,1200"], "../Quarterly ledger (Q2)!.CSV", { type: "text/csv" }),
    });

    const path = fake.upload.mock.calls[0]?.[0];
    expect(path).toBe(`${context.workspaceId}/${investigationId}/${uploadId}/Quarterly-ledger-Q2-.csv`);
    expect(path).toMatch(/^[A-Za-z0-9-]+\/[A-Za-z0-9-]+\/[A-Za-z0-9-]+\/[A-Za-z0-9][A-Za-z0-9._-]*$/);
  });

  it("inserts only client-permitted created metadata and uploads original file", async () => {
    const { query: insertQuery } = createUploadInsertQuery(Promise.resolve(singleResponse(uploadRow)));
    const { query: updateQuery } = createUploadUpdateQuery(Promise.resolve(singleResponse(uploadRow)));
    const fake = serviceFor({ insertQuery, updateQuery });
    vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue(uploadId);
    const file = new File(["entity,amount\nNorthstar,1200"], "ledger.csv", { type: "text/csv" });

    await fake.service.createUpload({ investigationId, file });

    expect(fake.insert).toHaveBeenCalledWith({
      id: uploadId,
      workspace_id: context.workspaceId,
      investigation_id: investigationId,
      storage_path: `${context.workspaceId}/${investigationId}/${uploadId}/ledger.csv`,
      original_name: file.name,
      extension: "csv",
      mime_type: file.type,
      byte_size: file.size,
      uploaded_by: context.userId,
    });
    expect(fake.upload).toHaveBeenCalledWith(
      `${context.workspaceId}/${investigationId}/${uploadId}/ledger.csv`,
      file,
      { contentType: file.type, upsert: false },
    );
  });

  it("marks upload uploaded with uploaded_at after Storage succeeds", async () => {
    const { query: insertQuery } = createUploadInsertQuery(Promise.resolve(singleResponse({ ...uploadRow, status: "created" })));
    const { query: updateQuery } = createUploadUpdateQuery(Promise.resolve(singleResponse(uploadRow)));
    const fake = serviceFor({ insertQuery, updateQuery });
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-06T10:01:00.000Z"));

    await expect(fake.service.createUpload({ investigationId, file: new File(["data"], "ledger.csv") })).resolves.toMatchObject({
      status: "uploaded",
    });
    expect(fake.update).toHaveBeenCalledWith({ status: "uploaded", uploaded_at: "2026-08-06T10:01:00.000Z" });
  });

  it("maps insert, Storage, and status update failures with operation context", async () => {
    const { query: insertQuery } = createUploadInsertQuery(Promise.resolve(errorResponse("insert", "insert denied")));
    await expect(serviceFor({ insertQuery }).service.createUpload({ investigationId, file: new File(["x"], "ledger.csv") })).rejects.toThrow(
      "Unable to create upload: insert denied",
    );

    const successfulInsert = createUploadInsertQuery(Promise.resolve(singleResponse(uploadRow))).query;
    const storageFailure = { data: null, error: { message: "storage denied" } };
    await expect(
      serviceFor({ insertQuery: successfulInsert, storageResponse: storageFailure }).service.createUpload({
        investigationId,
        file: new File(["x"], "ledger.csv"),
      }),
    ).rejects.toThrow("Unable to upload file: storage denied");

    const successfulStorageInsert = createUploadInsertQuery(Promise.resolve(singleResponse(uploadRow))).query;
    const failedUpdate = createUploadUpdateQuery(Promise.resolve(errorResponse("update", "status denied"))).query;
    await expect(
      serviceFor({ insertQuery: successfulStorageInsert, updateQuery: failedUpdate }).service.createUpload({
        investigationId,
        file: new File(["x"], "ledger.csv"),
      }),
    ).rejects.toThrow("Unable to mark upload uploaded: status denied");
  });

  it("returns typed recovery identity when Storage fails after metadata insertion", async () => {
    const { query: insertQuery } = createUploadInsertQuery(Promise.resolve(singleResponse({ ...uploadRow, status: "created" })));
    const { query: updateQuery } = createUploadUpdateQuery(Promise.resolve(singleResponse(uploadRow)));
    const fake = serviceFor({ insertQuery, updateQuery, storageResponse: { data: null, error: { message: "storage denied" } } });
    vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue(uploadId);
    fake.upload
      .mockResolvedValueOnce({ data: null, error: { message: "storage denied" } })
      .mockResolvedValueOnce({ data: { path: uploadRow.storage_path }, error: null });

    const failure = await fake.service.createUpload({ investigationId, file: new File(["x"], "ledger.csv") }).catch((error: unknown) => error);

    expect(failure).toMatchObject({
      recovery: {
        kind: "sentinel-upload-recovery",
        investigationId,
        uploadId,
        retryUpload: expect.any(Function),
      },
    });
    expect(fake.insert).toHaveBeenCalledTimes(1);

    await expect((failure as { recovery: { retryUpload: () => Promise<unknown> } }).recovery.retryUpload()).resolves.toMatchObject({
      id: uploadId,
      status: "uploaded",
    });
    expect(fake.upload).toHaveBeenNthCalledWith(2, uploadRow.storage_path, expect.any(File), { contentType: undefined, upsert: true });
    expect(fake.update).toHaveBeenCalledTimes(1);
  });

  it("invokes parse-upload with upload id and preserves parser status", async () => {
    const fake = serviceFor();

    await expect(fake.service.startParsing(uploadId)).resolves.toEqual({ uploadId, status: "processing" });
    expect(fake.invoke).toHaveBeenCalledWith("parse-upload", { body: { uploadId } });

    const failed = serviceFor({ invokeResponse: { data: null, error: { message: "function unavailable" } } });
    await expect(failed.service.startParsing(uploadId)).rejects.toThrow("Unable to start parsing: function unavailable");
  });

  it("loads scoped upload status and maps warnings and nullable errors", async () => {
    const { query, eq } = createReadQuery(Promise.resolve(maybeSingleResponse({
      ...uploadRow,
      status: "failed",
      warnings: ["Missing amount", 42, { ignored: true }],
      error_message: "Parser stopped",
    })));
    const fake = serviceFor({ uploadReadQuery: query });

    await expect(fake.service.getStatus(uploadId)).resolves.toEqual({
      id: uploadId,
      investigationId,
      status: "failed",
      rowCount: uploadRow.row_count,
      warnings: ["Missing amount"],
      errorMessage: "Parser stopped",
    });
    expect(eq).toHaveBeenNthCalledWith(1, "workspace_id", context.workspaceId);
    expect(eq).toHaveBeenNthCalledWith(2, "id", uploadId);
  });

  it("maps missing and status query errors clearly", async () => {
    const { query: missingQuery } = createReadQuery(Promise.resolve(maybeSingleResponse(null)));
    await expect(serviceFor({ uploadReadQuery: missingQuery }).service.getStatus(uploadId)).rejects.toThrow(
      "Unable to load upload: Upload not found.",
    );

    const errorQuery = createReadQuery(Promise.resolve({
      ...errorResponse<UploadRow>("select", "status denied"),
      data: null,
    } as PostgrestMaybeSingleResponse<UploadRow>)).query;
    await expect(serviceFor({ uploadReadQuery: errorQuery }).service.getStatus(uploadId)).rejects.toThrow(
      "Unable to load upload: status denied",
    );
  });

  it("retries parser with same failed upload id without creating or writing rows", async () => {
    const fake = serviceFor();

    await expect(fake.service.retryParsing(uploadId)).resolves.toEqual({ uploadId, status: "processing" });
    expect(fake.invoke).toHaveBeenCalledWith("parse-upload", { body: { uploadId } });
    expect(fake.from).not.toHaveBeenCalled();
  });

  it("lists scoped import rows in source order and maps string and numeric values", async () => {
    const { query, eq, order } = createRowQuery(Promise.resolve(listResponse([importRows[1]!, importRows[0]!] )));
    const fake = serviceFor({ rowQuery: query });

    await expect(fake.service.listRows(uploadId)).resolves.toEqual([
      { entity: "Orchid Supply", values: { entity: "Orchid Supply", amount: 450, note: "review" }, sourceRow: 3 },
      { entity: "Northstar Ltd", values: { entity: "Northstar Ltd", amount: 1200 }, sourceRow: 2 },
    ]);
    expect(eq).toHaveBeenNthCalledWith(1, "workspace_id", context.workspaceId);
    expect(eq).toHaveBeenNthCalledWith(2, "upload_id", uploadId);
    expect(order).toHaveBeenCalledWith("source_row", { ascending: true });
  });

  it("maps row query failures without exposing a row write path", async () => {
    const errorQuery = createRowQuery(Promise.resolve({
      data: null,
      error: {
        code: "42501",
        message: "rows denied",
        details: "",
        hint: "",
        name: "PostgrestError",
        toJSON: () => ({ name: "PostgrestError", message: "rows denied", details: "", hint: "", code: "42501" }),
      },
      status: 403,
      statusText: "Forbidden",
      success: false,
      count: null,
    })).query;
    const fake = serviceFor({ rowQuery: errorQuery });

    await expect(fake.service.listRows(uploadId)).rejects.toThrow("Unable to list import rows: rows denied");
    expect(fake.from).toHaveBeenCalledTimes(1);
    expect(fake.from).not.toHaveBeenCalledWith("sentinel_import_rows", expect.objectContaining({ insert: expect.anything() }));
  });
});
