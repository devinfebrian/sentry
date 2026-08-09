import { describe, expect, it, vi } from "vitest";
import type { AgentRun, SentinelAgentRunService } from "../domain/types";
import {
  createSentinelAgentRunService,
  runAgentAcrossUploads,
  runsToTrigger,
  type SentinelAgentRunClient,
  toPipelineStages,
} from "./sentinelAgentRuns";

const workspaceId = "workspace-1";
const investigationId = "investigation-1";

function run(overrides: Partial<AgentRun> = {}): AgentRun {
  return {
    id: "run-1",
    uploadId: "upload-1",
    agentKey: "deterministic",
    status: "complete",
    inputCount: 10,
    outputCount: 2,
    ...overrides,
  };
}

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: "run-1",
    upload_id: "upload-1",
    agent_key: "deterministic",
    status: "complete",
    failure_reason: null,
    input_count: 10,
    output_count: 2,
    started_at: "2026-08-09T10:00:00Z",
    completed_at: "2026-08-09T10:00:05Z",
    ...overrides,
  };
}

function fakeClient(options: { rows?: unknown[]; error?: unknown; invoke?: unknown } = {}) {
  const eq = vi.fn();
  const chain: Record<string, unknown> = {};
  Object.assign(chain, {
    select: vi.fn(() => chain),
    eq: vi.fn((column: string, value: string) => {
      eq(column, value);
      return chain;
    }),
    order: vi.fn(() => chain),
    limit: vi.fn(async () => ({ data: options.rows ?? [], error: options.error ?? null })),
  });

  const invoke = vi.fn(async () => (options.invoke ?? { data: { status: "complete" }, error: null }));
  const client = {
    from: vi.fn(() => chain),
    functions: { invoke },
  } as unknown as SentinelAgentRunClient;

  return { client, eq, invoke };
}

describe("toPipelineStages", () => {
  it("counts uploads, not rows, as the stage's progress", () => {
    // A run either finishes or it does not — there is no partial progress within one. What
    // is genuinely fractional is how many of the case's uploads an agent has got through.
    const [stage] = toPipelineStages([
      run({ id: "a", uploadId: "u1", status: "complete" }),
      run({ id: "b", uploadId: "u2", status: "complete" }),
      run({ id: "c", uploadId: "u3", status: "waiting" }),
    ]);

    expect(stage.completed).toBe(2);
    expect(stage.total).toBe(3);
  });

  it("orders stages by the pipeline position, not by arrival", () => {
    const stages = toPipelineStages([
      run({ id: "a", agentKey: "fraud-pattern" }),
      run({ id: "b", agentKey: "deterministic" }),
    ]);

    expect(stages.map((stage) => stage.name)).toEqual([
      "Financial analysis",
      "Fraud pattern investigator",
    ]);
  });

  it("reads as failed when any upload failed, even alongside successes", () => {
    // The spec's rule is that failure is never hidden. A stage that rolled one failure into
    // a mostly-green summary would hide exactly the thing worth showing.
    const [stage] = toPipelineStages([
      run({ id: "a", uploadId: "u1", status: "complete" }),
      run({ id: "b", uploadId: "u2", status: "failed", failureReason: "The model declined." }),
    ]);

    expect(stage.status).toBe("failed");
    expect(stage.failureReason).toBe("The model declined.");
  });

  it("says how many uploads a repeated failure affected", () => {
    const [stage] = toPipelineStages([
      run({ id: "a", uploadId: "u1", status: "failed", failureReason: "No model configured." }),
      run({ id: "b", uploadId: "u2", status: "failed", failureReason: "No model configured." }),
    ]);

    expect(stage.failureReason).toBe("No model configured. (2 uploads affected)");
  });

  it("prefers running over waiting so an in-flight agent does not read as idle", () => {
    const [stage] = toPipelineStages([
      run({ id: "a", uploadId: "u1", status: "waiting" }),
      run({ id: "b", uploadId: "u2", status: "running" }),
    ]);

    expect(stage.status).toBe("running");
  });

  it("only reports a completion time once every upload is done", () => {
    const [stage] = toPipelineStages([
      run({ id: "a", uploadId: "u1", status: "complete", completedAt: "2026-08-09T10:00:00Z" }),
      run({ id: "b", uploadId: "u2", status: "waiting" }),
    ]);

    expect(stage.completedAt).toBeUndefined();
  });

  it("sums the rows read and the findings produced", () => {
    const [stage] = toPipelineStages([
      run({ id: "a", uploadId: "u1", inputCount: 10, outputCount: 2 }),
      run({ id: "b", uploadId: "u2", inputCount: 5, outputCount: 1 }),
    ]);

    expect(stage.inputCount).toBe(15);
    expect(stage.outputCount).toBe(3);
  });

  it("ignores an agent key this build does not know about", () => {
    // A newer deployment could write a key this bundle has no descriptor for. Skipping it
    // beats rendering an unnamed stage or throwing on read.
    expect(toPipelineStages([run({ agentKey: "reporting" })])).toEqual([]);
  });
});

describe("createSentinelAgentRunService", () => {
  it("scopes to one investigation when given an id", async () => {
    const { client, eq } = fakeClient({ rows: [row()] });
    const service = createSentinelAgentRunService(client, { workspaceId });

    const runs = await service.list(investigationId);

    expect(eq).toHaveBeenCalledWith("workspace_id", workspaceId);
    expect(eq).toHaveBeenCalledWith("investigation_id", investigationId);
    expect(runs[0]).toEqual({
      id: "run-1",
      uploadId: "upload-1",
      agentKey: "deterministic",
      status: "complete",
      failureReason: undefined,
      inputCount: 10,
      outputCount: 2,
      startedAt: "2026-08-09T10:00:00Z",
      completedAt: "2026-08-09T10:00:05Z",
    });
  });

  it("reads the whole workspace when no investigation is named", async () => {
    const { client, eq } = fakeClient({ rows: [] });
    const service = createSentinelAgentRunService(client, { workspaceId });

    await service.list();

    expect(eq).toHaveBeenCalledWith("workspace_id", workspaceId);
    expect(eq).not.toHaveBeenCalledWith("investigation_id", expect.anything());
  });

  it("reports a read failure rather than an empty pipeline", async () => {
    const { client } = fakeClient({ error: { message: "permission denied" } });
    const service = createSentinelAgentRunService(client, { workspaceId });

    await expect(service.list(investigationId)).rejects.toThrow(/permission denied/);
  });

  it("surfaces the reason when a run comes back failed", async () => {
    // The function answers 422 with a reason for a failed run; supabase-js hands that back
    // as data, not as a transport error. Treating it as success would render a retry that
    // silently did nothing.
    const { client } = fakeClient({
      invoke: { data: { status: "failed", reason: "The analysis model declined this request." }, error: null },
    });
    const service = createSentinelAgentRunService(client, { workspaceId });

    await expect(service.run("upload-1", "fraud-pattern")).rejects.toThrow(/declined/);
  });

  it("passes the upload and agent through to the function", async () => {
    const { client, invoke } = fakeClient();
    const service = createSentinelAgentRunService(client, { workspaceId });

    await service.run("upload-1", "fraud-pattern");

    expect(invoke).toHaveBeenCalledWith("analyze-upload", {
      body: { uploadId: "upload-1", agentKey: "fraud-pattern" },
    });
  });
});

describe("runsToTrigger", () => {
  it("re-runs the completed uploads when nothing is outstanding", () => {
    // Without this a stage that has succeeded offers no way back: the agent-scoped delete
    // exists precisely so a completed agent can be run again, and the UI never reached it.
    const runs = [
      run({ id: "a", uploadId: "u1", agentKey: "fraud-pattern", status: "complete" }),
      run({ id: "b", uploadId: "u2", agentKey: "fraud-pattern", status: "complete" }),
    ];

    expect(runsToTrigger(runs, "fraud-pattern").map((item) => item.uploadId)).toEqual(["u1", "u2"]);
  });

  it("prefers outstanding uploads over completed ones", () => {
    // A stage reads failed when one upload of three failed. Retrying should act on that
    // one, not redo the two that already succeeded.
    const runs = [
      run({ id: "a", uploadId: "u1", agentKey: "fraud-pattern", status: "complete" }),
      run({ id: "b", uploadId: "u2", agentKey: "fraud-pattern", status: "failed" }),
      run({ id: "c", uploadId: "u3", agentKey: "fraud-pattern", status: "waiting" }),
    ];

    expect(runsToTrigger(runs, "fraud-pattern").map((item) => item.uploadId)).toEqual(["u2", "u3"]);
  });

  it("never targets a run already in flight", () => {
    const runs = [run({ id: "a", uploadId: "u1", agentKey: "fraud-pattern", status: "running" })];

    expect(runsToTrigger(runs, "fraud-pattern")).toEqual([]);
  });

  it("ignores other agents entirely", () => {
    const runs = [
      run({ id: "a", uploadId: "u1", agentKey: "deterministic", status: "complete" }),
      run({ id: "b", uploadId: "u2", agentKey: "fraud-pattern", status: "complete" }),
    ];

    expect(runsToTrigger(runs, "fraud-pattern").map((item) => item.uploadId)).toEqual(["u2"]);
  });
});

describe("runAgentAcrossUploads", () => {
  it("runs every upload waiting on or failed for that agent, and nothing else", async () => {
    const service = { list: vi.fn(), run: vi.fn().mockResolvedValue(undefined) } as unknown as SentinelAgentRunService;
    const runs = [
      run({ id: "a", uploadId: "u1", agentKey: "fraud-pattern", status: "failed" }),
      run({ id: "b", uploadId: "u2", agentKey: "fraud-pattern", status: "waiting" }),
      run({ id: "c", uploadId: "u3", agentKey: "fraud-pattern", status: "complete" }),
      run({ id: "d", uploadId: "u4", agentKey: "deterministic", status: "failed" }),
    ];

    await runAgentAcrossUploads(service, runs, "fraud-pattern");

    expect((service.run as ReturnType<typeof vi.fn>).mock.calls).toEqual([
      ["u1", "fraud-pattern"],
      ["u2", "fraud-pattern"],
    ]);
  });

  it("stops at the first failure so its reason reaches the caller", async () => {
    const runFn = vi.fn()
      .mockRejectedValueOnce(new Error("The analysis model is unavailable."))
      .mockResolvedValue(undefined);
    const service = { list: vi.fn(), run: runFn } as unknown as SentinelAgentRunService;
    const runs = [
      run({ id: "a", uploadId: "u1", agentKey: "fraud-pattern", status: "failed" }),
      run({ id: "b", uploadId: "u2", agentKey: "fraud-pattern", status: "failed" }),
    ];

    await expect(runAgentAcrossUploads(service, runs, "fraud-pattern")).rejects.toThrow(/unavailable/);
    expect(runFn).toHaveBeenCalledTimes(1);
  });
});
