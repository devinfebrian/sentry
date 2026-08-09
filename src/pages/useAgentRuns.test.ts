import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRun } from "../domain/types";
import { POLL_GIVE_UP_MS, useAgentRuns } from "./useAgentRuns";

const investigationId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

function run(overrides: Partial<AgentRun> = {}): AgentRun {
  return {
    id: "run-1",
    uploadId: "upload-1",
    agentKey: "deterministic",
    status: "complete",
    inputCount: 3,
    outputCount: 1,
    ...overrides,
  };
}

function service(list: () => Promise<AgentRun[]>) {
  return { list: vi.fn(list), run: vi.fn(async () => undefined) };
}

/** Let queued promise callbacks run without advancing the fake clock. */
async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe("useAgentRuns", () => {
  beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
  afterEach(() => vi.useRealTimers());

  it("keeps asking while a case has no runs yet", async () => {
    // Landing on the summary straight after an import is exactly this moment: the parse has
    // not finished seeding runs, and the page used to sit on "Analysis not started" until
    // it was reloaded.
    const runs = service(async () => []);
    renderHook(() => useAgentRuns(investigationId, runs));

    await waitFor(() => expect(runs.list).toHaveBeenCalledTimes(1));
    await advance(2_000);
    expect(runs.list.mock.calls.length).toBeGreaterThan(1);
  });

  it("stops once the runs arrive", async () => {
    let seeded = false;
    const runs = service(async () => (seeded ? [run({ status: "waiting" })] : []));
    const { result } = renderHook(() => useAgentRuns(investigationId, runs));

    await waitFor(() => expect(runs.list).toHaveBeenCalledTimes(1));
    seeded = true;
    await advance(2_000);
    await waitFor(() => expect(result.current.state).toMatchObject({ status: "ready" }));

    const settled = runs.list.mock.calls.length;
    await advance(30_000);
    // `waiting` is a resting state — the AI agent sits there until asked — so polling on it
    // would never stop.
    expect(runs.list).toHaveBeenCalledTimes(settled);
  });

  it("watches a run that is already in flight until it settles", async () => {
    let status: AgentRun["status"] = "running";
    const runs = service(async () => [run({ status })]);
    renderHook(() => useAgentRuns(investigationId, runs));

    await waitFor(() => expect(runs.list).toHaveBeenCalledTimes(1));
    await advance(2_000);
    expect(runs.list.mock.calls.length).toBeGreaterThan(1);

    status = "complete";
    await advance(5_000);
    const settled = runs.list.mock.calls.length;
    await advance(30_000);
    expect(runs.list).toHaveBeenCalledTimes(settled);
  });

  it("gives up rather than polling an unfinished parse forever", async () => {
    const runs = service(async () => []);
    renderHook(() => useAgentRuns(investigationId, runs));

    await waitFor(() => expect(runs.list).toHaveBeenCalledTimes(1));
    await advance(POLL_GIVE_UP_MS + 10_000);

    const settled = runs.list.mock.calls.length;
    await advance(60_000);
    expect(runs.list).toHaveBeenCalledTimes(settled);
  });

  it("does not poll an empty workspace view", async () => {
    // No runs workspace-wide means nothing has been imported, not a parse in flight.
    const runs = service(async () => []);
    renderHook(() => useAgentRuns(undefined, runs, { scope: "workspace" }));

    await waitFor(() => expect(runs.list).toHaveBeenCalledTimes(1));
    await advance(30_000);
    expect(runs.list).toHaveBeenCalledTimes(1);
    expect(runs.list).toHaveBeenCalledWith(undefined);
  });

  it("reports a failed first read rather than an empty pipeline", async () => {
    const runs = service(async () => {
      throw new Error("permission denied");
    });
    const { result } = renderHook(() => useAgentRuns(investigationId, runs));

    await waitFor(() => expect(result.current.state.status).toBe("error"));
  });

  it("keeps the runs on screen when a later poll fails", async () => {
    // The first read succeeded, so what is displayed is real. Replacing it with an error
    // because one refresh dropped would lose information the reader already has.
    let attempts = 0;
    const runs = service(async () => {
      attempts += 1;
      if (attempts > 1) throw new Error("network blip");
      return [run({ status: "running" })];
    });
    const { result } = renderHook(() => useAgentRuns(investigationId, runs));

    await waitFor(() => expect(result.current.state).toMatchObject({ status: "ready" }));
    await advance(5_000);

    expect(result.current.state).toMatchObject({ status: "ready" });
  });

  it("re-reads on demand after an agent has been run", async () => {
    const runs = service(async () => [run({ status: "complete" })]);
    const { result } = renderHook(() => useAgentRuns(investigationId, runs));

    await waitFor(() => expect(runs.list).toHaveBeenCalledTimes(1));
    act(() => result.current.refresh());
    await flush();

    await waitFor(() => expect(runs.list).toHaveBeenCalledTimes(2));
  });
});
