import { describe, expect, it, vi } from "vitest";
import { createSentinelMemberService, type SentinelMemberClient } from "./sentinelMembers";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const managerId = "22222222-2222-4222-8222-222222222222";
const analystId = "33333333-3333-4333-8333-333333333333";

type MemberRow = {
  user_id: string;
  role: "analyst" | "manager";
  status: "active" | "pending";
  // Absent on the analyst path: authenticated cannot select this column.
  invited_email?: string | null;
  created_at: string;
};

const managerRow: MemberRow = {
  user_id: managerId,
  role: "manager",
  status: "active",
  invited_email: null,
  created_at: "2026-08-01T09:00:00.000Z",
};

const analystRow: MemberRow = {
  user_id: analystId,
  role: "analyst",
  status: "pending",
  invited_email: "analyst@example.com",
  created_at: "2026-08-04T09:00:00.000Z",
};

interface ClientOptions {
  rows?: MemberRow[];
  listError?: { message: string } | null;
  invokeResult?: { data: unknown; error: unknown };
}

function createClient({ rows = [], listError = null, invokeResult }: ClientOptions = {}) {
  const order = vi.fn(async () => ({ data: listError ? null : rows, error: listError }));
  const eq = vi.fn(() => ({ order }));
  const select = vi.fn(() => ({ eq }));
  const from = vi.fn(() => ({ select }));
  const invoke = vi.fn(async () => invokeResult ?? { data: { invited: true }, error: null });

  const client = { from, functions: { invoke } } as unknown as SentinelMemberClient;
  return { client, from, select, eq, order, invoke };
}

function httpError(status: number, body: unknown) {
  const error = new Error("Edge Function returned a non-2xx status code");
  error.name = "FunctionsHttpError";
  return Object.assign(error, {
    context: new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  });
}

describe("createSentinelMemberService", () => {
  describe("list", () => {
    it("reads the manager roster view so invited emails are visible", async () => {
      const { client, from, select } = createClient({ rows: [managerRow, analystRow] });
      const service = createSentinelMemberService(client, { workspaceId, userId: managerId, role: "manager" });

      await service.list();

      expect(from).toHaveBeenCalledWith("sentinel_manager_roster");
      expect(select).toHaveBeenCalledWith("user_id, role, status, invited_email, created_at");
    });

    it("reads sentinel_members without invited_email for an analyst", async () => {
      // authenticated has no column grant on invited_email; requesting it is a 42501,
      // so the analyst path must never ask for that column.
      const { client, from, select } = createClient({ rows: [{ ...analystRow, invited_email: undefined }] });
      const service = createSentinelMemberService(client, { workspaceId, userId: analystId, role: "analyst" });

      await service.list();

      expect(from).toHaveBeenCalledWith("sentinel_members");
      expect(select).toHaveBeenCalledWith("user_id, role, status, created_at");
      expect(select).not.toHaveBeenCalledWith(expect.stringContaining("invited_email"));
    });

    it("maps an analyst row with no readable address to a null email", async () => {
      const { client } = createClient({ rows: [{ ...analystRow, invited_email: undefined }] });
      const service = createSentinelMemberService(client, { workspaceId, userId: analystId, role: "analyst" });

      await expect(service.list()).resolves.toEqual([
        expect.objectContaining({ userId: analystId, email: null, isSelf: true }),
      ]);
    });

    it("maps rows to members and flags the signed-in member", async () => {
      const { client } = createClient({ rows: [managerRow, analystRow] });
      const service = createSentinelMemberService(client, { workspaceId, userId: managerId, role: "manager" });

      await expect(service.list()).resolves.toEqual([
        {
          userId: managerId,
          email: null,
          role: "manager",
          status: "active",
          joinedAt: "2026-08-01T09:00:00.000Z",
          isSelf: true,
        },
        {
          userId: analystId,
          email: "analyst@example.com",
          role: "analyst",
          status: "pending",
          joinedAt: "2026-08-04T09:00:00.000Z",
          isSelf: false,
        },
      ]);
    });

    it("scopes the query to the active workspace and orders by creation", async () => {
      const { client, from, eq, order } = createClient({ rows: [managerRow] });
      const service = createSentinelMemberService(client, { workspaceId, userId: managerId, role: "manager" });

      await service.list();

      expect(from).toHaveBeenCalledWith("sentinel_manager_roster");
      expect(eq).toHaveBeenCalledWith("workspace_id", workspaceId);
      expect(order).toHaveBeenCalledWith("created_at", { ascending: true });
    });

    it("returns an empty list when the policy filters every row", async () => {
      const { client } = createClient({ rows: [] });
      const service = createSentinelMemberService(client, { workspaceId, userId: analystId, role: "analyst" });

      await expect(service.list()).resolves.toEqual([]);
    });

    it("wraps a Postgrest failure in a readable message", async () => {
      const { client } = createClient({ listError: { message: "permission denied" } });
      const service = createSentinelMemberService(client, { workspaceId, userId: managerId, role: "manager" });

      await expect(service.list()).rejects.toThrow("Unable to list members: permission denied");
    });
  });

  describe("invite", () => {
    it("sends a normalized email with the analyst role", async () => {
      const { client, invoke } = createClient();
      const service = createSentinelMemberService(client, { workspaceId, userId: managerId, role: "manager" });

      await service.invite("  New.Analyst@Example.COM  ");

      expect(invoke).toHaveBeenCalledWith("invite-member", {
        body: { email: "new.analyst@example.com", role: "analyst" },
      });
    });

    it("rejects a malformed email without calling the function", async () => {
      const { client, invoke } = createClient();
      const service = createSentinelMemberService(client, { workspaceId, userId: managerId, role: "manager" });

      await expect(service.invite("not-an-email")).rejects.toThrow("Enter a valid email address.");
      expect(invoke).not.toHaveBeenCalled();
    });

    it("rejects an over-long email without calling the function", async () => {
      const { client, invoke } = createClient();
      const service = createSentinelMemberService(client, { workspaceId, userId: managerId, role: "manager" });

      await expect(service.invite(`${"a".repeat(250)}@example.com`)).rejects.toThrow(
        "Enter a valid email address.",
      );
      expect(invoke).not.toHaveBeenCalled();
    });

    it("surfaces the server message from a 403 response", async () => {
      const { client } = createClient({
        invokeResult: { data: null, error: httpError(403, { error: "Manager membership required." }) },
      });
      const service = createSentinelMemberService(client, { workspaceId, userId: analystId, role: "analyst" });

      await expect(service.invite("analyst@example.com")).rejects.toThrow("Manager membership required.");
    });

    it("surfaces the server message from a 409 response", async () => {
      const { client } = createClient({
        invokeResult: { data: null, error: httpError(409, { error: "Invitation already pending." }) },
      });
      const service = createSentinelMemberService(client, { workspaceId, userId: managerId, role: "manager" });

      await expect(service.invite("analyst@example.com")).rejects.toThrow("Invitation already pending.");
    });

    it("falls back to a generic message when the error body is unreadable", async () => {
      const brokenError = Object.assign(new Error("network down"), {
        context: new Response("<html>gateway</html>", { status: 502 }),
      });
      const { client } = createClient({ invokeResult: { data: null, error: brokenError } });
      const service = createSentinelMemberService(client, { workspaceId, userId: managerId, role: "manager" });

      await expect(service.invite("analyst@example.com")).rejects.toThrow("Unable to invite member.");
    });

    it("falls back to a generic message when the error carries no response", async () => {
      const { client } = createClient({ invokeResult: { data: null, error: new Error("failed to fetch") } });
      const service = createSentinelMemberService(client, { workspaceId, userId: managerId, role: "manager" });

      await expect(service.invite("analyst@example.com")).rejects.toThrow("Unable to invite member.");
    });

    it("resolves when the function accepts the invitation", async () => {
      const { client } = createClient({ invokeResult: { data: { invited: true }, error: null } });
      const service = createSentinelMemberService(client, { workspaceId, userId: managerId, role: "manager" });

      await expect(service.invite("analyst@example.com")).resolves.toBeUndefined();
    });
  });
});
