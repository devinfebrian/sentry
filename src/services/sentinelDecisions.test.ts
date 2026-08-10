import { describe, expect, it, vi } from "vitest";
import { createSentinelDecisionService } from "./sentinelDecisions";

function clientReturning(result: { data: unknown; error: { code?: string; message?: string } | null }) {
  const rpc = vi.fn().mockResolvedValue(result);
  return { client: { rpc } as never, rpc };
}

const context = { workspaceId: "workspace-1" };

describe("createSentinelDecisionService", () => {
  it("names the investigation, the workspace, the action, and the rationale", async () => {
    const { client, rpc } = clientReturning({ data: { status: "review", event_id: "event-1" }, error: null });

    const result = await createSentinelDecisionService(client, context)
      .record("inv-1", "recommend-approve", "  Settlement explains it.  ");

    expect(rpc).toHaveBeenCalledWith("sentinel_record_decision", {
      p_investigation_id: "inv-1",
      p_workspace_id: "workspace-1",
      p_action: "recommend-approve",
      p_rationale: "Settlement explains it.",
    });
    expect(result).toEqual({ status: "review" });
  });

  it("sends no actor id, because the RPC reads the caller from auth.uid()", async () => {
    const { client, rpc } = clientReturning({ data: { status: "review" }, error: null });

    await createSentinelDecisionService(client, context).record("inv-1", "recommend-reject", "No.");

    expect(Object.keys(rpc.mock.calls[0][1])).not.toContain("p_actor_id");
  });

  it("surfaces a P0001 refusal verbatim, because the database wrote it for a reader", async () => {
    const { client } = clientReturning({
      data: null,
      error: { code: "P0001", message: "You recommended this case. Another manager must decide it." },
    });

    await expect(createSentinelDecisionService(client, context).record("inv-1", "approve", "Yes."))
      .rejects.toThrow("You recommended this case. Another manager must decide it.");
  });

  it("translates a missing investigation into something a reader can act on", async () => {
    const { client } = clientReturning({ data: null, error: { code: "PT404", message: "Investigation not found." } });

    await expect(createSentinelDecisionService(client, context).record("inv-1", "approve", "Yes."))
      .rejects.toThrow(/reload/i);
  });

  it("refuses an empty rationale before spending a network call", async () => {
    const { client, rpc } = clientReturning({ data: null, error: null });

    await expect(createSentinelDecisionService(client, context).record("inv-1", "approve", "   "))
      .rejects.toThrow(/record why/i);
    expect(rpc).not.toHaveBeenCalled();
  });
});
