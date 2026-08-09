import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentRefusalError } from "../_shared/fraudPatterns";

const authMocks = vi.hoisted(() => ({
  createAdminClient: vi.fn(),
  requireUser: vi.fn(),
}));

// The provider sits behind the FindingsModel port, so these tests never speak Gemini —
// they exercise the route's handling of a model that answers, declines, or is unconfigured.
const modelMocks = vi.hoisted(() => ({
  createGeminiModel: vi.fn(),
  MissingModelKeyError: class MissingModelKeyError extends Error {},
}));

vi.mock("../_shared/auth.ts", () => authMocks);
vi.mock("./geminiModel.ts", () => modelMocks);

const uploadId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const workspaceId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const investigationId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const importRows = [
  { source_row: 2, entity: "Northstar", values: { entity: "Northstar", amount: 100 } },
  { source_row: 3, entity: "Northstar", values: { entity: "Northstar", amount: 100 } },
  { source_row: 4, entity: "Meridian", values: { entity: "Meridian", amount: 50 } },
];

function result<T>(data: T, error: unknown = null) {
  return { data, error };
}

/** Chain that resolves at maybeSingle(), for the user-scoped reads. */
function singleQuery(value: unknown) {
  const chain: Record<string, unknown> = {};
  Object.assign(chain, {
    select: vi.fn(() => chain),
    eq: vi.fn(() => chain),
    maybeSingle: vi.fn(async () => value),
  });
  return chain;
}

/** Chain that resolves at limit(), for the import-rows read. */
function listQuery(value: unknown) {
  const chain: Record<string, unknown> = {};
  Object.assign(chain, {
    select: vi.fn(() => chain),
    eq: vi.fn(() => chain),
    order: vi.fn(() => chain),
    limit: vi.fn(async () => value),
  });
  return chain;
}

function setup(options: {
  upload?: unknown;
  membership?: unknown;
  rows?: unknown;
  rpcResults?: unknown[];
} = {}) {
  const upload = options.upload === undefined
    ? result({ id: uploadId, workspace_id: workspaceId, investigation_id: investigationId, status: "parsed" })
    : options.upload;
  const membership = options.membership === undefined
    ? result({ workspace_id: workspaceId, status: "active", role: "analyst" })
    : options.membership;

  const client = {
    from: vi.fn((table: string) =>
      table === "sentinel_uploads" ? singleQuery(upload) : singleQuery(membership)
    ),
  };

  const rpcResults = [...(options.rpcResults ?? [])];
  const rpc = vi.fn(async () => rpcResults.shift() ?? result({ findingCount: 1, evidenceCount: 2 }));
  const importRowsQuery = listQuery(options.rows === undefined ? result(importRows) : options.rows);
  const admin = { from: vi.fn(() => importRowsQuery), rpc };

  authMocks.requireUser.mockResolvedValue({ client, user: { id: "user-1" } });
  authMocks.createAdminClient.mockResolvedValue(admin);
  return { admin, client, rpc };
}

function request(body: unknown = { uploadId, agentKey: "deterministic" }, method = "POST") {
  return new Request("https://functions.local/analyze-upload", {
    method,
    headers: { authorization: "Bearer token", "content-type": "application/json" },
    body: method === "POST" ? JSON.stringify(body) : undefined,
  });
}

async function body(response: Response) {
  return await response.json();
}

function rpcNames(rpc: ReturnType<typeof vi.fn>) {
  return rpc.mock.calls.map((call) => call[0]);
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("analyze-upload route", () => {
  it("rejects a non-POST request", async () => {
    const { handleRequest } = await import("./index");
    setup();

    expect((await handleRequest(request(undefined, "GET"))).status).toBe(405);
  });

  it("rejects an agent key the database would not recognise", async () => {
    // An unrecognised agent_key would own no findings and clear nothing, so it must be
    // refused at the edge rather than written and quietly doing nothing.
    const { handleRequest } = await import("./index");
    setup();

    const response = await handleRequest(request({ uploadId, agentKey: "reporting" }));

    expect(response.status).toBe(400);
  });

  it("denies access when the caller is not an active member", async () => {
    const { handleRequest } = await import("./index");
    setup({ membership: result(null) });

    expect((await handleRequest(request())).status).toBe(403);
  });

  it("refuses to analyse an upload that has not been parsed", async () => {
    // Analysis reads persisted rows. Running against an unparsed upload would report "no
    // findings" for a file nobody has read yet.
    const { handleRequest } = await import("./index");
    setup({
      upload: result({ id: uploadId, workspace_id: workspaceId, investigation_id: investigationId, status: "uploaded" }),
    });

    const response = await handleRequest(request());

    expect(response.status).toBe(409);
  });

  it("runs the deterministic agent over the persisted rows and records the result", async () => {
    const { handleRequest } = await import("./index");
    const { rpc } = setup();

    const response = await handleRequest(request());

    expect(response.status).toBe(200);
    expect(await body(response)).toEqual({
      uploadId,
      agentKey: "deterministic",
      agent: "Financial analysis",
      status: "complete",
      rowCount: 3,
      findingCount: 1,
      evidenceCount: 2,
    });
    expect(rpcNames(rpc)).toEqual(["sentinel_start_agent_run", "sentinel_record_analysis"]);
    expect(rpc).toHaveBeenCalledWith("sentinel_record_analysis", expect.objectContaining({
      p_agent_key: "deterministic",
      // The two Northstar rows share an amount, so the rules have something to say.
      p_findings: expect.arrayContaining([expect.objectContaining({ rule: "duplicate-amount" })]),
    }));
  });

  it("records the row count the agent actually saw", async () => {
    const { handleRequest } = await import("./index");
    const { rpc } = setup();

    await handleRequest(request());

    expect(rpc).toHaveBeenCalledWith("sentinel_start_agent_run", expect.objectContaining({
      p_input_count: 3,
    }));
  });

  it("records a refusal as a failed run with a readable reason", async () => {
    const { handleRequest } = await import("./index");
    const { rpc } = setup();
    modelMocks.createGeminiModel.mockReturnValue({
      propose: vi.fn(async () => {
        throw new AgentRefusalError("SAFETY");
      }),
    });

    const response = await handleRequest(request({ uploadId, agentKey: "fraud-pattern" }));

    expect(response.status).toBe(422);
    expect(await body(response)).toEqual({
      uploadId,
      agentKey: "fraud-pattern",
      status: "failed",
      reason: expect.stringContaining("declined"),
    });
    expect(rpcNames(rpc)).toEqual(["sentinel_start_agent_run", "sentinel_fail_analysis"]);
  });

  it("names the missing key when the project has no model configured", async () => {
    // The most likely first failure on a fresh deployment, and the one where a generic
    // "analysis failed" would send someone hunting in the wrong place.
    const { handleRequest } = await import("./index");
    const { rpc } = setup();
    modelMocks.createGeminiModel.mockImplementation(() => {
      throw new modelMocks.MissingModelKeyError("no key");
    });

    const response = await handleRequest(request({ uploadId, agentKey: "fraud-pattern" }));

    expect(response.status).toBe(422);
    expect((await body(response)).reason).toContain("GEMINI_API_KEY");
    expect(rpc).toHaveBeenCalledWith("sentinel_fail_analysis", expect.objectContaining({
      p_agent_key: "fraud-pattern",
    }));
  });

  it("writes the fraud agent's findings under its own key", async () => {
    // The delete inside sentinel_record_analysis is scoped by this value. Sending the wrong
    // key here is how one producer would erase another's findings.
    const { handleRequest } = await import("./index");
    const { rpc } = setup();
    modelMocks.createGeminiModel.mockReturnValue({
      propose: vi.fn(async () => ({
        findings: [{
          rule: "threshold-clustering",
          summary: "Two payments to Northstar share an amount",
          confidence: 0.6,
          evidence: [{ sourceRow: 2, claim: "amount = 100", relevance: "supporting" }],
        }],
      })),
    });

    const response = await handleRequest(request({ uploadId, agentKey: "fraud-pattern" }));

    expect(response.status).toBe(200);
    expect(rpc).toHaveBeenCalledWith("sentinel_record_analysis", expect.objectContaining({
      p_agent_key: "fraud-pattern",
      p_findings: [expect.objectContaining({ rule: "threshold-clustering", confidence: 0.6 })],
    }));
  });

  it("surfaces an unreadable import as a server error rather than as an empty analysis", async () => {
    // Zero rows and unreadable rows are different facts; recording the second as the first
    // would write an empty, authoritative-looking analysis over a real one.
    const { handleRequest } = await import("./index");
    const { rpc } = setup({ rows: result(null, { message: "boom" }) });

    const response = await handleRequest(request());

    expect(response.status).toBe(500);
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe("AgentRefusalError", () => {
  it("names the category so the reason is specific", () => {
    expect(new AgentRefusalError("cyber").message).toContain("cyber");
  });
});
