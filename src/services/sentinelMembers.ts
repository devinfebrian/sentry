import type { PostgrestResponse } from "@supabase/supabase-js";
import type { SentinelMember, SentinelMemberRole, SentinelMemberService } from "../domain/types";
import type { Database } from "../lib/database.types";

type MemberRow = Pick<
  Database["public"]["Tables"]["sentinel_members"]["Row"],
  "user_id" | "role" | "status" | "created_at"
> & { invited_email?: string | null };
type MemberContext = { workspaceId: string; userId: string; role: SentinelMemberRole | null };

export type MemberSource = "sentinel_members" | "sentinel_manager_roster";

/**
 * `authenticated` holds only a column-level SELECT grant on sentinel_members that
 * deliberately excludes invited_email, so asking for that column here is a 42501
 * "permission denied for table" — not an empty result. Managers read addresses through
 * public.sentinel_manager_roster instead: a security_invoker view over a security
 * definer function that returns rows only for workspaces where the caller is a manager.
 */
export const MANAGER_ROSTER_COLUMNS = "user_id, role, status, invited_email, created_at";
export const MEMBER_COLUMNS = "user_id, role, status, created_at";

type MemberReadQuery = {
  eq(column: "workspace_id", value: string): {
    order(column: "created_at", options: { ascending: boolean }): PromiseLike<PostgrestResponse<MemberRow>>;
  };
};

export type RpcError = { message?: string; code?: string };

export type SentinelMemberClient = {
  from(table: MemberSource): {
    select(columns: string): MemberReadQuery;
  };
  functions: {
    invoke(
      name: "invite-member",
      options: { body: { email: string; role: "analyst" } },
    ): Promise<{ data: unknown; error: unknown }>;
  };
  rpc(
    name: "sentinel_activate_member" | "sentinel_set_member_role" | "sentinel_reject_invitation",
    args: Record<string, string>,
  ): Promise<{ data: unknown; error: RpcError | null }>;
};

// Mirrors normalizeEmail in supabase/functions/_shared/auth-policy.ts so an obviously
// invalid address is rejected before it costs a function call.
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const maxEmailLength = 254;

export const INVALID_EMAIL_ERROR = "Enter a valid email address.";
export const GENERIC_INVITE_ERROR = "Unable to invite member.";

function mapError(operation: string, error: { message?: string } | null) {
  const message = error?.message || "Unknown Supabase error.";
  return new Error(`Unable to ${operation}: ${message}`);
}

export const MEMBER_NOT_FOUND_ERROR = "Member not found. Reload the roster and try again.";
export const MANAGER_REQUIRED_ERROR = "Manager membership required.";

/**
 * The RPCs raise P0001 with finished user-facing prose, so those messages are
 * shown as written rather than wrapped. Mirrors how processing.ts keys off
 * P0001 for a lost processing lease.
 */
export function mapRpcError(operation: string, error: RpcError | null) {
  if (error?.code === "P0001" && error.message?.trim()) return new Error(error.message);
  if (error?.code === "P0002") return new Error(MEMBER_NOT_FOUND_ERROR);
  if (error?.code === "42501") return new Error(MANAGER_REQUIRED_ERROR);
  return mapError(operation, error);
}

/** Shared with WorkspacePage so the form rejects a bad address before any network call. */
export function normalizeMemberEmail(value: string) {
  const email = value.trim().toLowerCase();
  return email.length <= maxEmailLength && emailPattern.test(email) ? email : null;
}

function mapRow(row: MemberRow, userId: string): SentinelMember {
  return {
    userId: row.user_id,
    email: row.invited_email ?? null,
    role: row.role,
    status: row.status,
    joinedAt: row.created_at,
    isSelf: row.user_id === userId,
  };
}

/**
 * supabase-js reports a non-2xx Edge Function reply as a FunctionsHttpError whose
 * `message` is a generic "non-2xx status code" string; the readable message lives in the
 * untouched Response on `context`, which errorResponse() serializes as `{ error }`.
 */
async function inviteErrorMessage(error: unknown) {
  const context = (error as { context?: unknown } | null)?.context;
  if (!(context instanceof Response)) return GENERIC_INVITE_ERROR;

  try {
    const body: unknown = await context.clone().json();
    const message = (body as { error?: unknown } | null)?.error;
    return typeof message === "string" && message.trim() ? message : GENERIC_INVITE_ERROR;
  } catch {
    return GENERIC_INVITE_ERROR;
  }
}

export function createSentinelMemberService(
  client: SentinelMemberClient,
  context: MemberContext,
): SentinelMemberService {
  return {
    async list() {
      const isManager = context.role === "manager";
      const source: MemberSource = isManager ? "sentinel_manager_roster" : "sentinel_members";
      const { data, error } = await client
        .from(source)
        .select(isManager ? MANAGER_ROSTER_COLUMNS : MEMBER_COLUMNS)
        .eq("workspace_id", context.workspaceId)
        .order("created_at", { ascending: true });

      if (error) throw mapError("list members", error);
      // For an analyst, RLS narrows sentinel_members to their own row and no address is
      // readable; a single emailless row is the intended outcome, not a failure.
      return (data ?? []).map((row) => mapRow(row, context.userId));
    },

    async invite(email) {
      const normalized = normalizeMemberEmail(email);
      if (!normalized) throw new Error(INVALID_EMAIL_ERROR);

      const { error } = await client.functions.invoke("invite-member", {
        body: { email: normalized, role: "analyst" },
      });

      if (error) throw new Error(await inviteErrorMessage(error));
    },

    async activate(userId) {
      const { error } = await client.rpc("sentinel_activate_member", {
        p_workspace_id: context.workspaceId,
        p_user_id: userId,
      });

      if (error) throw mapRpcError("activate member", error);
    },
  };
}
