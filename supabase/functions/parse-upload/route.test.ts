import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { HttpError, MAX_JSON_BODY_BYTES } from "../_shared/cors";

const authMocks = vi.hoisted(() => ({
  createAdminClient: vi.fn(),
  requireUser: vi.fn(),
}));

const spreadsheetMock = vi.hoisted(() => ({
  read: vi.fn(),
  utils: { sheet_to_json: vi.fn() },
}));

vi.mock("../_shared/auth.ts", () => authMocks);
vi.mock("./spreadsheet.ts", () => ({ default: spreadsheetMock }));

const uploadId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const workspaceId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const investigationId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const uploadedUpload = {
  id: uploadId,
  workspace_id: workspaceId,
  investigation_id: investigationId,
  storage_path: `${workspaceId}/${investigationId}/${uploadId}/ledger.xlsx`,
  status: "uploaded",
  row_count: 0,
  warnings: [],
  processing_started_at: null,
};

function result<T>(data: T, error: unknown = null) {
  return { data, error };
}

function query(result: unknown | (() => unknown)) {
  let chain!: Record<string, ReturnType<typeof vi.fn>>;
  const resolve = () => (typeof result === "function" ? (result as () => unknown)() : result);
  chain = {
    select: vi.fn(() => chain),
    eq: vi.fn(() => chain),
    is: vi.fn(() => chain),
    maybeSingle: vi.fn(async () => resolve()),
  };
  return chain;
}

function makeAdmin(options: {
  updateResults?: unknown[];
  latest?: unknown;
  uploadSelectResults?: unknown[];
  eventErrors?: unknown[];
  rpcResults?: unknown[];
  download?: unknown;
}) {
  const updateResults = [...(options.updateResults ?? [result({ id: uploadId })])];
  const updateQuery = query(() => updateResults.shift() ?? result({ id: uploadId }));
  const uploadSelectResults = [...(options.uploadSelectResults ?? (options.latest === undefined ? [] : [options.latest]))];
  const uploadSelectQueries: ReturnType<typeof query>[] = [];
  const update = vi.fn(() => updateQuery);
  const uploadSelect = vi.fn(() => {
    const uploadSelectQuery = query(() => uploadSelectResults.shift() ?? result({ id: uploadId }));
    uploadSelectQueries.push(uploadSelectQuery);
    return uploadSelectQuery;
  });
  const activityInsert = vi.fn(async () => ({ error: options.eventErrors?.shift() ?? null }));
  const rpcResults = [...(options.rpcResults ?? [result({ status: "parsed", row_count: 2, warnings: [] })])];
  const rpc = vi.fn(async () => rpcResults.shift() ?? result({ status: "parsed", row_count: 2, warnings: [] }));
  const download = vi.fn(async () => options.download ?? result(null, { message: "download failed" }));

  const admin = {
    from: vi.fn((table: string) => {
      if (table === "sentinel_uploads") {
        return { update, select: uploadSelect };
      }
      return { insert: activityInsert };
    }),
    rpc,
    storage: { from: vi.fn(() => ({ download })) },
  };

  return { admin, updateQuery, update, activityInsert, rpc, uploadSelect, uploadSelectQueries, download };
}

function makeClient(upload = uploadedUpload) {
  const uploadQuery = query(result(upload));
  const membershipQuery = query(result({ workspace_id: workspaceId, status: "active", role: "analyst" }));
  const from = vi.fn((table: string) => table === "sentinel_uploads" ? { select: vi.fn(() => uploadQuery) } : { select: vi.fn(() => membershipQuery) });
  return { client: { from }, uploadQuery, membershipQuery };
}

function request(body = JSON.stringify({ uploadId }), headers: HeadersInit = { "Content-Type": "application/json" }) {
  return new Request("http://localhost/functions/v1/parse-upload", {
    method: "POST",
    headers,
    body,
  });
}

async function body(response: Response) {
  return response.json();
}

let handleRequest: (request: Request) => Promise<Response>;
let handleRoute: (request: Request) => Promise<Response>;

beforeAll(async () => {
  vi.stubGlobal("Deno", { serve: vi.fn() });
  ({ handleRequest, handleRoute } = await import("./index.ts"));
});

afterEach(() => {
  vi.clearAllMocks();
  spreadsheetMock.read.mockReset();
  spreadsheetMock.utils.sheet_to_json.mockReset();
});

afterAll(() => {
  vi.unstubAllGlobals();
});

function setup(options: Parameters<typeof makeAdmin>[0] = {}, upload = uploadedUpload) {
  const client = makeClient(upload);
  const admin = makeAdmin(options);
  authMocks.requireUser.mockResolvedValue({ client: client.client, user: { id: "user-1", email: "user@example.com" } });
  authMocks.createAdminClient.mockResolvedValue(admin.admin);
  return { ...client, ...admin };
}

describe("parse-upload processing route", () => {
  it("handles CORS preflight through handleRoute", async () => {
    const response = await handleRoute(new Request("http://localhost/functions/v1/parse-upload", {
      method: "OPTIONS",
      headers: { Origin: "http://localhost:5173" },
    }));

    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("http://localhost:5173");
  });

  it("rejects disallowed origins through handleRoute", async () => {
    const response = await handleRoute(new Request("http://localhost/functions/v1/parse-upload", {
      method: "OPTIONS",
      headers: { Origin: "https://not-sentinel.example" },
    }));

    expect(response.status).toBe(403);
    expect(await body(response)).toEqual({ error: "Origin not allowed." });
  });

  it.each([null, "Basic not-a-bearer", "Bearer"])("rejects missing or invalid bearer %s", async (authorization) => {
    authMocks.requireUser.mockRejectedValueOnce(new HttpError("Authentication required.", 401));
    const headers = new Headers({ "Content-Type": "application/json", Origin: "http://localhost:5173" });
    if (authorization) {
      headers.set("Authorization", authorization);
    }

    const response = await handleRoute(new Request("http://localhost/functions/v1/parse-upload", {
      method: "POST",
      headers,
      body: JSON.stringify({ uploadId }),
    }));

    expect(response.status).toBe(401);
    expect(await body(response)).toEqual({ error: "Authentication required." });
    expect(authMocks.createAdminClient).not.toHaveBeenCalled();
  });

  it("authenticates before consuming an oversized request body", async () => {
    const requestToAuthenticate = request(JSON.stringify({ uploadId }), {
      "Content-Type": "application/json",
      "Content-Length": String(MAX_JSON_BODY_BYTES + 1),
    });
    authMocks.requireUser.mockRejectedValueOnce(new HttpError("Authentication required.", 401));

    const response = await handleRequest(requestToAuthenticate);

    expect(response.status).toBe(401);
    expect(await body(response)).toEqual({ error: "Authentication required." });
    expect(requestToAuthenticate.bodyUsed).toBe(false);
  });

  it("rejects non-POST methods through handleRoute", async () => {
    const response = await handleRoute(new Request("http://localhost/functions/v1/parse-upload", {
      method: "GET",
      headers: { Origin: "http://localhost:5173" },
    }));

    expect(response.status).toBe(405);
    expect(await body(response)).toEqual({ error: "Method not allowed." });
  });

  it("returns 202 for a fresh processing upload without claiming again", async () => {
    const freshUpload = {
      ...uploadedUpload,
      status: "processing",
      processing_started_at: new Date(Date.now() - 1000).toISOString(),
    };
    setup({}, freshUpload);

    const response = await handleRequest(request());

    expect(response.status).toBe(202);
    expect(await body(response)).toEqual({ uploadId, status: "processing" });
    expect(authMocks.createAdminClient).not.toHaveBeenCalled();
  });

  it("marks upload failed when finalization RPC fails without losing lease", async () => {
    spreadsheetMock.read.mockReturnValue({ SheetNames: ["Ledger"], Sheets: { Ledger: {} } });
    spreadsheetMock.utils.sheet_to_json.mockReturnValue([["Entity", "Amount"], ["Northstar", "10"]]);
    const fake = setup({
      rpcResults: [
        result(null, { code: "XX000", message: "database unavailable" }),
        result({ status: "failed", error_message: "Unable to parse upload. You can retry this upload." }),
      ],
      download: result({ arrayBuffer: vi.fn(async () => new ArrayBuffer(1)) }),
    });

    const response = await handleRequest(request());

    expect(response.status).toBe(422);
    expect(await body(response)).toEqual({ uploadId, status: "failed", error: "Unable to parse upload. You can retry this upload." });
    expect(fake.rpc).toHaveBeenNthCalledWith(1, "sentinel_finalize_upload", expect.any(Object));
    expect(fake.rpc).toHaveBeenNthCalledWith(2, "sentinel_fail_upload", expect.any(Object));
  });

  it("reconciles parsed event when stale claimant loses conditional claim", async () => {
    const staleUpload = {
      ...uploadedUpload,
      status: "processing",
      processing_started_at: new Date(Date.now() - 15 * 60 * 1000 - 1).toISOString(),
    };
    const fake = setup({
      updateResults: [result(null)],
      latest: result({ status: "parsed", row_count: 3, warnings: ["review"] }),
      rpcResults: [result(true)],
    }, staleUpload);

    const response = await handleRequest(request());

    expect(response.status).toBe(200);
    expect(await body(response)).toEqual({ uploadId, status: "parsed", rowCount: 3, warnings: ["review"] });
    expect(fake.rpc).toHaveBeenCalledWith("sentinel_reconcile_parse_event", {
      upload_id: uploadId,
      workspace_id: workspaceId,
      investigation_id: investigationId,
      actor_id: "user-1",
      row_count: 3,
      warning_count: 1,
    });
  });

  it("replaces rows and finalizes through one RPC without REST row writes", async () => {
    spreadsheetMock.read.mockReturnValue({ SheetNames: ["Ledger"], Sheets: { Ledger: {} } });
    spreadsheetMock.utils.sheet_to_json.mockReturnValue([
      ["Entity", "Amount"],
      ["Northstar", "10"],
      ["Northstar updated", "20"],
    ]);
    const fake = setup({
      rpcResults: [result({ status: "parsed", row_count: 2, warnings: [] })],
      download: result({ arrayBuffer: vi.fn(async () => new ArrayBuffer(1)) }),
      eventErrors: [null],
    }, { ...uploadedUpload, status: "processing", processing_started_at: null });

    const response = await handleRequest(request());

    expect(response.status).toBe(200);
    expect(await body(response)).toEqual({ uploadId, status: "parsed", rowCount: 2, warnings: [] });
    expect(fake.rpc).toHaveBeenCalledWith("sentinel_finalize_upload", {
      upload_id: uploadId,
      workspace_id: workspaceId,
      investigation_id: investigationId,
      lease_started_at: expect.any(String),
      rows: [
        { sourceRow: 2, entity: "Northstar", values: { entity: "Northstar", amount: 10 } },
        { sourceRow: 3, entity: "Northstar updated", values: { entity: "Northstar updated", amount: 20 } },
      ],
      warnings: [],
      actor_id: "user-1",
    });
    expect(fake.activityInsert).toHaveBeenCalledTimes(1);
    expect(fake.activityInsert).toHaveBeenCalledWith(expect.objectContaining({
      event_type: "parse-started",
      metadata: { status: "processing", upload_id: uploadId },
    }));
    // Every agent goes on the board, so the pipeline shows the whole sequence rather than
    // materialising stages as they happen to start.
    expect(fake.rpc).toHaveBeenCalledWith("sentinel_seed_agent_runs", expect.objectContaining({
      p_upload_id: uploadId,
      p_agent_keys: ["deterministic", "fraud-pattern"],
    }));
    // The deterministic rules follow the parse in the same request, scoped to their own key
    // so they cannot clear another producer's findings.
    expect(fake.rpc).toHaveBeenCalledWith("sentinel_record_analysis", expect.objectContaining({
      p_upload_id: uploadId,
      p_workspace_id: workspaceId,
      p_investigation_id: investigationId,
      p_agent_key: "deterministic",
    }));
  });

  it("reports a successful parse and records the failure when the analysis fails", async () => {
    // The rows are the product; the findings are a reading of them. Losing the reading
    // must not lose the rows, or a transient analysis fault would look like a parse fault.
    // It must not lose the reading silently either — the failure lands on the agent's run.
    spreadsheetMock.read.mockReturnValue({ SheetNames: ["Ledger"], Sheets: { Ledger: {} } });
    spreadsheetMock.utils.sheet_to_json.mockReturnValue([
      ["Entity", "Amount"],
      ["Northstar", "10"],
      ["Northstar updated", "20"],
    ]);
    const fake = setup({
      rpcResults: [
        result({ status: "parsed", row_count: 2, warnings: [] }),
        result(null, { message: "analysis exploded" }),
      ],
      download: result({ arrayBuffer: vi.fn(async () => new ArrayBuffer(1)) }),
      eventErrors: [null],
    }, { ...uploadedUpload, status: "processing", processing_started_at: null });

    const response = await handleRequest(request());

    expect(response.status).toBe(200);
    expect(await body(response)).toEqual({ uploadId, status: "parsed", rowCount: 2, warnings: [] });
    // The old behaviour swallowed this into a console warning, which left the pipeline
    // showing a stage that never moved. A reader now gets a reason and a retry.
    expect(fake.rpc).toHaveBeenCalledWith("sentinel_fail_analysis", expect.objectContaining({
      p_agent_key: "deterministic",
      p_reason: expect.any(String),
    }));
  });

  it("fails parse through transaction RPC without REST row cleanup", async () => {
    const fake = setup({
      rpcResults: [result({ status: "failed", error_message: "Unable to parse upload. You can retry this upload." })],
      eventErrors: [null],
    });

    const response = await handleRequest(request());

    expect(response.status).toBe(422);
    expect(await body(response)).toEqual({ uploadId, status: "failed", error: "Unable to parse upload. You can retry this upload." });
    expect(fake.rpc).toHaveBeenCalledWith("sentinel_fail_upload", {
      upload_id: uploadId,
      workspace_id: workspaceId,
      investigation_id: investigationId,
      lease_started_at: expect.any(String),
      actor_id: "user-1",
      error_text: "Unable to parse upload. You can retry this upload.",
    });
  });

  it("returns current state when finalization loses lease", async () => {
    const fake = setup({
      rpcResults: [result(null, { code: "P0001", message: "Processing lease lost." })],
      uploadSelectResults: [result({ status: "failed", row_count: 0, warnings: [] })],
      eventErrors: [null],
      download: result({ arrayBuffer: vi.fn(async () => new ArrayBuffer(1)) }),
    });
    spreadsheetMock.read.mockReturnValue({ SheetNames: ["Ledger"], Sheets: { Ledger: {} } });
    spreadsheetMock.utils.sheet_to_json.mockReturnValue([["Entity", "Amount"], ["Northstar", "10"]]);

    const response = await handleRequest(request());

    expect(response.status).toBe(422);
    expect(await body(response)).toEqual({ uploadId, status: "failed", error: "Unable to parse upload. You can retry this upload." });
    expect(fake.rpc).toHaveBeenCalledTimes(1);
  });

  it("reconciles committed parsed state when finalization outcome loses lease", async () => {
    spreadsheetMock.read.mockReturnValue({ SheetNames: ["Ledger"], Sheets: { Ledger: {} } });
    spreadsheetMock.utils.sheet_to_json.mockReturnValue([["Entity", "Amount"], ["Northstar", "10"]]);
    const fake = setup({
      rpcResults: [result(null, { code: "P0001", message: "Processing lease lost." }), result(true)],
      uploadSelectResults: [result({ status: "parsed", row_count: 1, warnings: ["review"] })],
      download: result({ arrayBuffer: vi.fn(async () => new ArrayBuffer(1)) }),
    });

    const response = await handleRequest(request());

    expect(response.status).toBe(200);
    expect(await body(response)).toEqual({ uploadId, status: "parsed", rowCount: 1, warnings: ["review"] });
    expect(fake.rpc).toHaveBeenNthCalledWith(2, "sentinel_reconcile_parse_event", {
      upload_id: uploadId,
      workspace_id: workspaceId,
      investigation_id: investigationId,
      actor_id: "user-1",
      row_count: 1,
      warning_count: 1,
    });
  });

  it("returns 500 when failure transaction RPC cannot record parser state", async () => {
    const fake = setup({
      rpcResults: [result(null, { code: "XX000", message: "database unavailable" })],
      eventErrors: [null],
    });

    const response = await handleRequest(request());

    expect(response.status).toBe(500);
    expect(await body(response)).toEqual({ error: "Parser state could not be recorded." });
    expect(fake.rpc).toHaveBeenCalledWith("sentinel_fail_upload", expect.any(Object));
  });

  it("reconciles already parsed upload before returning short-circuit state", async () => {
    const fake = setup({ rpcResults: [result(false)] }, { ...uploadedUpload, status: "parsed", row_count: 4, warnings: ["review"] });

    const response = await handleRequest(request());

    expect(response.status).toBe(200);
    expect(await body(response)).toEqual({ uploadId, status: "parsed", rowCount: 4, warnings: ["review"] });
    expect(fake.rpc).toHaveBeenCalledWith("sentinel_reconcile_parse_event", {
      upload_id: uploadId,
      workspace_id: workspaceId,
      investigation_id: investigationId,
      actor_id: "user-1",
      row_count: 4,
      warning_count: 1,
    });
  });

  it("returns failed state when stale claimant loses to failed upload", async () => {
    const staleUpload = {
      ...uploadedUpload,
      status: "processing",
      processing_started_at: new Date(Date.now() - 15 * 60 * 1000 - 1).toISOString(),
    };
    const fake = setup({
      updateResults: [result(null)],
      latest: result({ status: "failed", row_count: 0, warnings: [] }),
    }, staleUpload);

    const response = await handleRequest(request());

    expect(response.status).toBe(422);
    expect(await body(response)).toEqual({ uploadId, status: "failed", error: "Unable to parse upload. You can retry this upload." });
    expect(fake.rpc).not.toHaveBeenCalled();
  });
});
