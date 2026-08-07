import { describe, expect, it, vi } from "vitest";
import type { ParsedImportRow } from "../_shared/parser";
import {
  claimUploadForParsing,
  completeParse,
  isProcessingLeaseFresh,
  markFailed,
  markProcessing,
  ParseFinalizationError,
  ProcessingLeaseLostError,
  processingLeaseMs,
  reconcileParseEvent,
  type UploadRecord,
} from "./processing";

const now = new Date("2026-08-06T12:00:00.000Z");
const actorId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const upload: UploadRecord = {
  id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  workspace_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  investigation_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  storage_path: "workspace/investigation/upload/ledger.xlsx",
  status: "processing",
  row_count: 0,
  warnings: [],
  processing_started_at: now.toISOString(),
};

function response<T>(data: T, error: unknown = null) {
  return Promise.resolve({ data, error });
}

function uploadQuery(result: PromiseLike<{ data: unknown; error: unknown }>) {
  let query!: Record<string, ReturnType<typeof vi.fn>>;
  const eq = vi.fn(() => query);
  const is = vi.fn(() => query);
  const select = vi.fn(() => query);
  const maybeSingle = vi.fn(() => result);
  query = { eq, is, select, maybeSingle };
  return { query, eq, is, select, maybeSingle };
}

function adminFor(options: {
  uploadResult?: PromiseLike<{ data: unknown; error: unknown }>;
  eventResult?: PromiseLike<{ error: unknown }>;
  latestResult?: PromiseLike<{ data: unknown; error: unknown }>;
}) {
  const uploadUpdate = uploadQuery(options.uploadResult ?? response({ id: upload.id }));
  const latest = uploadQuery(options.latestResult ?? response(null));
  const update = vi.fn(() => uploadUpdate.query);
  const insert = vi.fn(() => options.eventResult ?? response(null));
  const select = vi.fn(() => latest.query);
  const from = vi.fn((table: string) =>
    table === "sentinel_uploads" ? { update, select } : { insert },
  );

  return { admin: { from }, uploadUpdate, latest, update, insert };
}

function transactionRpcFake(options: {
  rows?: ParsedImportRow[];
  status?: "processing" | "parsed";
  lease?: string | null;
  failSourceRow?: number;
  events?: Array<{ metadata: Record<string, unknown> }>;
}) {
  let rows = [...(options.rows ?? [])];
  let status = options.status ?? "processing";
  let events = [...(options.events ?? [])];
  const lease = options.lease ?? upload.processing_started_at;
  const rpc = vi.fn(async (name: string, payload: Record<string, any>) => {
    if ((name === "sentinel_finalize_upload" || name === "sentinel_fail_upload") && payload.lease_started_at !== lease) {
      return { data: null, error: { code: "P0001", message: "Processing lease lost." } };
    }

    if (name === "sentinel_finalize_upload") {
      const previous = { rows, status, events };
      try {
        rows = [];
        for (const row of payload.rows as ParsedImportRow[]) {
          if (row.sourceRow === options.failSourceRow) {
            throw new Error("simulated row insert failure");
          }
          rows.push(row);
        }
        status = "parsed";
        events = [...events, { metadata: { upload_id: payload.upload_id } }];
        return { data: { status, row_count: rows.length, warnings: payload.warnings }, error: null };
      } catch (error) {
        rows = previous.rows;
        status = previous.status;
        events = previous.events;
        return { data: null, error };
      }
    }

    if (name === "sentinel_reconcile_parse_event") {
      if (status !== "parsed" || events.some((event) => event.metadata.upload_id === payload.upload_id)) {
        return { data: false, error: null };
      }
      events = [...events, { metadata: { upload_id: payload.upload_id } }];
      return { data: true, error: null };
    }

    return { data: null, error: null };
  });

  return {
    admin: { rpc },
    getRows: () => rows,
    getEvents: () => events,
  };
}

describe("parse upload processing recovery", () => {
  it("finalizes parsed rows and state through one typed transaction RPC", async () => {
    const rpc = vi.fn(async () => ({
      data: { status: "parsed", row_count: 1, warnings: ["review"] },
      error: null,
    }));
    const admin = { rpc };
    const rows = [{ sourceRow: 2, entity: "Northstar", values: { entity: "Northstar", amount: 10 } }];

    await completeParse(admin, upload, { warnings: ["review"], rows, headers: ["entity", "amount"] }, rows, actorId);

    expect(rpc).toHaveBeenCalledWith("sentinel_finalize_upload", {
      upload_id: upload.id,
      workspace_id: upload.workspace_id,
      investigation_id: upload.investigation_id,
      lease_started_at: upload.processing_started_at,
      rows,
      warnings: ["review"],
      actor_id: actorId,
    });
  });

  it("maps transaction RPC lease mismatch to ProcessingLeaseLostError", async () => {
    const admin = {
      rpc: vi.fn(async () => ({ data: null, error: { code: "P0001", message: "Processing lease lost." } })),
    };

    await expect(
      completeParse(admin, upload, { warnings: [], rows: [], headers: [] }, [], actorId),
    ).rejects.toBeInstanceOf(ProcessingLeaseLostError);
  });

  it("maps non-lease finalization RPC failure to ParseFinalizationError", async () => {
    const admin = {
      rpc: vi.fn(async () => ({ data: null, error: { code: "XX000", message: "database unavailable" } })),
    };

    await expect(
      completeParse(admin, upload, { warnings: [], rows: [], headers: [] }, [], actorId),
    ).rejects.toBeInstanceOf(ParseFinalizationError);
  });

  it("replaces full row set through transaction RPC", async () => {
    const previousRows = [{ sourceRow: 2, entity: "Old", values: { entity: "Old", amount: 1 } }];
    const nextRows = [{ sourceRow: 2, entity: "New", values: { entity: "New", amount: 2 } }];
    const fake = transactionRpcFake({ rows: previousRows });

    await completeParse(fake.admin, upload, { warnings: [], rows: nextRows, headers: [] }, nextRows, actorId);

    expect(fake.getRows()).toEqual(nextRows);
    expect(fake.getEvents()).toEqual([{ metadata: { upload_id: upload.id } }]);
  });

  it("rolls back all rows when one transaction insert fails", async () => {
    const previousRows = [{ sourceRow: 2, entity: "Old", values: { entity: "Old", amount: 1 } }];
    const nextRows = [
      { sourceRow: 2, entity: "New", values: { entity: "New", amount: 2 } },
      { sourceRow: 3, entity: "Broken", values: { entity: "Broken", amount: 3 } },
    ];
    const fake = transactionRpcFake({ rows: previousRows, failSourceRow: 3 });

    await expect(completeParse(fake.admin, upload, { warnings: [], rows: nextRows, headers: [] }, nextRows, actorId)).rejects.toThrow();

    expect(fake.getRows()).toEqual(previousRows);
    expect(fake.getEvents()).toEqual([]);
  });

  it("uses upload identity to reconcile parse-completed event exactly once", async () => {
    const fake = transactionRpcFake({ status: "parsed" });

    await expect(reconcileParseEvent(fake.admin, upload, actorId, 2, 0)).resolves.toBe(true);
    await expect(reconcileParseEvent(fake.admin, upload, actorId, 2, 0)).resolves.toBe(false);

    expect(fake.getEvents()).toEqual([{ metadata: { upload_id: upload.id } }]);
  });

  it("fails upload through typed transaction RPC without REST row cleanup", async () => {
    const rpc = vi.fn(async () => ({
      data: { status: "failed", error_message: "Unable to parse upload. You can retry this upload." },
      error: null,
    }));
    const admin = { rpc };

    await markFailed(admin, upload, actorId, "Unable to parse upload. You can retry this upload.");

    expect(rpc).toHaveBeenCalledWith("sentinel_fail_upload", {
      upload_id: upload.id,
      workspace_id: upload.workspace_id,
      investigation_id: upload.investigation_id,
      lease_started_at: upload.processing_started_at,
      actor_id: actorId,
      error_text: "Unable to parse upload. You can retry this upload.",
    });
  });

  it("reconciles parsed event identity through typed transaction RPC", async () => {
    const rpc = vi.fn(async () => ({ data: true, error: null }));
    const admin = { rpc };

    await expect(reconcileParseEvent(admin, upload, actorId, 4, 2)).resolves.toBe(true);
    expect(rpc).toHaveBeenCalledWith("sentinel_reconcile_parse_event", {
      upload_id: upload.id,
      workspace_id: upload.workspace_id,
      investigation_id: upload.investigation_id,
      actor_id: actorId,
      row_count: 4,
      warning_count: 2,
    });
  });

  it("uses a fixed fifteen-minute lease and treats fresh processing as active", () => {
    expect(processingLeaseMs).toBe(15 * 60 * 1000);
    expect(
      isProcessingLeaseFresh(
        { ...upload, processing_started_at: new Date(now.getTime() - processingLeaseMs + 1).toISOString() },
        now,
      ),
    ).toBe(true);
    expect(
      isProcessingLeaseFresh(
        { ...upload, processing_started_at: new Date(now.getTime() - processingLeaseMs).toISOString() },
        now,
      ),
    ).toBe(false);
    expect(
      isProcessingLeaseFresh(
        { ...upload, processing_started_at: new Date(now.getTime() + 1).toISOString() },
        now,
      ),
    ).toBe(false);
  });

  it.each([
    ["stale", new Date(now.getTime() - processingLeaseMs).toISOString()],
    ["null-timestamp", null],
  ])("reclaims %s processing upload", async (_label, processingStartedAt) => {
    const fake = adminFor({});
    const result = await claimUploadForParsing(fake.admin, { ...upload, processing_started_at: processingStartedAt }, now);

    expect(result).toEqual({ status: "claimed", processing_started_at: now.toISOString() });
    expect(fake.uploadUpdate.eq).toHaveBeenCalledWith("status", "processing");
    if (processingStartedAt === null) {
      expect(fake.uploadUpdate.is).toHaveBeenCalledWith("processing_started_at", null);
    } else {
      expect(fake.uploadUpdate.eq).toHaveBeenCalledWith("processing_started_at", processingStartedAt);
    }
  });

  it.each(["uploaded", "failed"] as const)("keeps %s upload parseable", async (status) => {
    const fake = adminFor({});
    const result = await claimUploadForParsing(fake.admin, { ...upload, status, processing_started_at: null }, now);

    expect(result).toEqual({ status: "claimed", processing_started_at: now.toISOString() });
    expect(fake.uploadUpdate.eq).toHaveBeenCalledWith("status", status);
  });

  it("uses prior status and timestamp for conditional processing claim", async () => {
    const fake = adminFor({});

    await markProcessing(fake.admin, upload, now);

    expect(fake.update).toHaveBeenCalledWith({
      status: "processing",
      processing_started_at: now.toISOString(),
      error_message: null,
    });
    expect(fake.uploadUpdate.eq).toHaveBeenCalledWith("id", upload.id);
    expect(fake.uploadUpdate.eq).toHaveBeenCalledWith("workspace_id", upload.workspace_id);
    expect(fake.uploadUpdate.eq).toHaveBeenCalledWith("status", upload.status);
    expect(fake.uploadUpdate.eq).toHaveBeenCalledWith("processing_started_at", upload.processing_started_at);
  });

  it.each([
    [{ status: "parsed", row_count: 2, warnings: ["warning"] }, { status: "parsed", row_count: 2, warnings: ["warning"] }],
    [{ status: "processing", row_count: 0, warnings: [] }, { status: "processing" }],
    [{ status: "failed", row_count: 0, warnings: [] }, { status: "failed" }],
  ])("returns latest state when concurrent claim loses", async (latest, expected) => {
    const fake = adminFor({
      uploadResult: response(null),
      latestResult: response(latest),
    });

    await expect(claimUploadForParsing(fake.admin, { ...upload, processing_started_at: null }, now)).resolves.toEqual(expected);
  });

  it("returns generic parser state error when failure RPC fails", async () => {
    const admin = { rpc: vi.fn(async () => response(null, new Error("database unavailable"))) };

    await expect(markFailed(admin, upload, actorId)).rejects.toThrow("Unable to record failed upload.");
  });

  it("maps failure RPC lease mismatch without writing through REST", async () => {
    const admin = { rpc: vi.fn(async () => response(null, { code: "P0001", message: "Processing lease lost." })) };

    await expect(markFailed(admin, upload, actorId)).rejects.toBeInstanceOf(ProcessingLeaseLostError);
    expect(admin.rpc).toHaveBeenCalledTimes(1);
  });
});
