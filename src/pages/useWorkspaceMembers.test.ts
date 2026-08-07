import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { SentinelMember } from "../domain/types";
import { useWorkspaceMembers } from "./useWorkspaceMembers";

const activeManager: SentinelMember = {
  userId: "22222222-2222-4222-8222-222222222222",
  email: "manager@example.com",
  role: "manager",
  status: "active",
  joinedAt: "2026-08-01T09:00:00.000Z",
  isSelf: true,
};

const pendingAnalyst: SentinelMember = {
  userId: "33333333-3333-4333-8333-333333333333",
  email: "analyst@example.com",
  role: "analyst",
  status: "pending",
  joinedAt: "2026-08-04T09:00:00.000Z",
  isSelf: false,
};

function service(members: SentinelMember[]) {
  return { list: vi.fn(async () => members) };
}

describe("useWorkspaceMembers", () => {
  it("sorts pending members ahead of active ones", async () => {
    const memberService = service([activeManager, pendingAnalyst]);
    const { result } = renderHook(() => useWorkspaceMembers(memberService));

    await waitFor(() => expect(result.current.state.status).toBe("ready"));
    expect(result.current.members.map((member) => member.userId)).toEqual([
      pendingAnalyst.userId,
      activeManager.userId,
    ]);
  });

  it("counts only active managers", async () => {
    const memberService = service([activeManager, pendingAnalyst]);
    const { result } = renderHook(() => useWorkspaceMembers(memberService));

    await waitFor(() => expect(result.current.state.status).toBe("ready"));
    expect(result.current.activeManagerCount).toBe(1);
  });

  it("refetches the roster after a successful mutation", async () => {
    const memberService = service([activeManager, pendingAnalyst]);
    const { result } = renderHook(() => useWorkspaceMembers(memberService));
    await waitFor(() => expect(result.current.state.status).toBe("ready"));
    memberService.list.mockClear();

    let outcome: { ok: boolean; message: string } | undefined;
    await act(async () => {
      outcome = await result.current.mutate(async () => undefined, "Member activated.");
    });

    expect(memberService.list).toHaveBeenCalledTimes(1);
    expect(outcome).toEqual({ ok: true, message: "Member activated." });
  });

  it("reports the action as done when only the refresh fails", async () => {
    const memberService = service([activeManager]);
    const { result } = renderHook(() => useWorkspaceMembers(memberService));
    await waitFor(() => expect(result.current.state.status).toBe("ready"));
    memberService.list.mockRejectedValueOnce(new Error("network down"));

    let outcome: { ok: boolean; message: string } | undefined;
    await act(async () => {
      outcome = await result.current.mutate(async () => undefined, "Member activated.");
    });

    expect(outcome?.ok).toBe(true);
    expect(outcome?.message).toMatch(/could not be refreshed/i);
  });

  it("reports a failed mutation without refreshing the roster", async () => {
    const memberService = service([activeManager]);
    const { result } = renderHook(() => useWorkspaceMembers(memberService));
    await waitFor(() => expect(result.current.state.status).toBe("ready"));
    memberService.list.mockClear();

    let outcome: { ok: boolean; message: string } | undefined;
    await act(async () => {
      outcome = await result.current.mutate(async () => {
        throw new Error("Workspace must keep at least one manager.");
      }, "Role changed.");
    });

    expect(outcome).toEqual({ ok: false, message: "Workspace must keep at least one manager." });
    expect(memberService.list).not.toHaveBeenCalled();
  });
});
