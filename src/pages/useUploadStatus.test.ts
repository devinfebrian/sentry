import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SentinelUpload } from "../domain/types";
import { POLL_GIVE_UP_MS, PREVIEW_ROW_LIMIT, useUploadStatus } from "./useUploadStatus";

const investigationId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const uploadId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

function upload(status: SentinelUpload["status"], overrides: Partial<SentinelUpload> = {}): SentinelUpload {
  return { id: uploadId, investigationId, status, rowCount: 0, warnings: [], errorMessage: null, ...overrides };
}

const previewRows = [{ entity: "Northstar Ltd", values: { amount: 1200 }, sourceRow: 2 }];

function service(overrides: Partial<{
  getLatestForInvestigation: () => Promise<SentinelUpload | null>;
  getStatus: () => Promise<SentinelUpload>;
  listRows: (id: string, limit?: number) => Promise<typeof previewRows>;
}> = {}) {
  return {
    getLatestForInvestigation: vi.fn(overrides.getLatestForInvestigation ?? (async () => upload("parsed", { rowCount: 3 }))),
    getStatus: vi.fn(overrides.getStatus ?? (async () => upload("parsed", { rowCount: 3 }))),
    listRows: vi.fn(overrides.listRows ?? (async () => previewRows)),
  };
}

/** Let queued promise callbacks run without advancing the fake clock. */
async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("useUploadStatus", () => {
  beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
  afterEach(() => vi.useRealTimers());

  it("reports none when the investigation has no upload", async () => {
    const uploads = service({ getLatestForInvestigation: async () => null });
    const { result } = renderHook(() => useUploadStatus(investigationId, uploads));

    await waitFor(() => expect(result.current.state.status).toBe("none"));
    expect(uploads.getStatus).not.toHaveBeenCalled();
  });

  it("reads bounded preview rows once the upload is already parsed", async () => {
    const uploads = service();
    const { result } = renderHook(() => useUploadStatus(investigationId, uploads));

    await waitFor(() => expect(result.current.state.status).toBe("ready"));
    expect(uploads.listRows).toHaveBeenCalledWith(uploadId, PREVIEW_ROW_LIMIT);
    // A terminal status needs no polling at all.
    expect(uploads.getStatus).not.toHaveBeenCalled();
  });

  it("stops polling once the parser reaches parsed", async () => {
    const uploads = service({
      getLatestForInvestigation: async () => upload("processing"),
      getStatus: vi.fn()
        .mockResolvedValueOnce(upload("processing"))
        .mockResolvedValue(upload("parsed", { rowCount: 3 })) as unknown as () => Promise<SentinelUpload>,
    });
    renderHook(() => useUploadStatus(investigationId, uploads));

    await flush();
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
    const callsAtSettle = uploads.getStatus.mock.calls.length;

    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });

    expect(uploads.getStatus.mock.calls.length).toBe(callsAtSettle);
  });

  it("stops polling once the parser reaches failed", async () => {
    const uploads = service({
      getLatestForInvestigation: async () => upload("processing"),
      getStatus: async () => upload("failed", { errorMessage: "Unable to parse upload." }),
    });
    renderHook(() => useUploadStatus(investigationId, uploads));

    await flush();
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    const callsAtFailure = uploads.getStatus.mock.calls.length;
    expect(callsAtFailure).toBeGreaterThan(0);

    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });

    expect(uploads.getStatus.mock.calls.length).toBe(callsAtFailure);
    // A failed parse produced no rows worth reading.
    expect(uploads.listRows).not.toHaveBeenCalled();
  });

  it("clears its timer on unmount so a pending poll never fires", async () => {
    const uploads = service({
      getLatestForInvestigation: async () => upload("processing"),
      getStatus: async () => upload("processing"),
    });
    const { unmount } = renderHook(() => useUploadStatus(investigationId, uploads));

    await flush();
    unmount();
    const callsAtUnmount = uploads.getStatus.mock.calls.length;

    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });

    expect(uploads.getStatus.mock.calls.length).toBe(callsAtUnmount);
  });

  it("backs off instead of polling at a fixed interval", async () => {
    const uploads = service({
      getLatestForInvestigation: async () => upload("processing"),
      getStatus: async () => upload("processing"),
    });
    renderHook(() => useUploadStatus(investigationId, uploads));
    await flush();

    // A fixed 1.5s interval would reach ~13 calls in 20s; backoff must stay well under.
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });

    expect(uploads.getStatus.mock.calls.length).toBeLessThan(8);
    expect(uploads.getStatus.mock.calls.length).toBeGreaterThan(1);
  });

  it("gives up rather than polling forever", async () => {
    const uploads = service({
      getLatestForInvestigation: async () => upload("processing"),
      getStatus: async () => upload("processing"),
    });
    const { result } = renderHook(() => useUploadStatus(investigationId, uploads));
    await flush();

    await act(async () => { await vi.advanceTimersByTimeAsync(POLL_GIVE_UP_MS + 20_000); });
    const callsAtGiveUp = uploads.getStatus.mock.calls.length;
    expect(result.current.state).toMatchObject({ status: "ready", timedOut: true });

    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(uploads.getStatus.mock.calls.length).toBe(callsAtGiveUp);
  });

  it("surfaces a failed lookup as an error state", async () => {
    const uploads = service({
      getLatestForInvestigation: async () => {
        throw new Error("Unable to load latest upload: denied");
      },
    });
    const { result } = renderHook(() => useUploadStatus(investigationId, uploads));

    await waitFor(() => expect(result.current.state.status).toBe("error"));
  });
});
