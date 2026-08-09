import type { PostgrestResponse } from "@supabase/supabase-js";
import type { ActivityEntry, ActivityEventType, SentinelActivityService } from "../domain/types";
import type { Database } from "../lib/database.types";

type ActivityRow = Database["public"]["Tables"]["sentinel_activity_events"]["Row"];
type ActivityContext = { workspaceId: string };

export type SentinelActivityReadQuery = {
  eq(column: "workspace_id" | "investigation_id", value: string): SentinelActivityReadQuery;
  order(column: "created_at", options: { ascending: boolean }): SentinelActivityReadQuery;
  limit(count: number): PromiseLike<PostgrestResponse<ActivityRow>>;
};

export type SentinelActivityClient = {
  from(table: "sentinel_activity_events"): {
    select(columns: string): SentinelActivityReadQuery;
  };
};

export const ACTIVITY_COLUMNS = "id, investigation_id, actor_id, event_type, metadata, created_at";

/**
 * Bounded by construction. An audit table only grows, so an unbounded read is a slow leak
 * rather than an obvious bug — the same reasoning that bounded listRows.
 */
export const DEFAULT_ACTIVITY_LIMIT = 50;

function mapError(operation: string, error: { message?: string } | null) {
  return new Error(`Unable to ${operation}: ${error?.message || "Unknown Supabase error."}`);
}

/** metadata is jsonb, so anything but an object is not something we can read fields from. */
function mapMetadata(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function mapRow(row: ActivityRow): ActivityEntry {
  return {
    id: row.id,
    investigationId: row.investigation_id,
    actorId: row.actor_id,
    type: row.event_type as ActivityEventType,
    metadata: mapMetadata(row.metadata),
    occurredAt: row.created_at,
  };
}

export function createSentinelActivityService(
  client: SentinelActivityClient,
  context: ActivityContext,
): SentinelActivityService {
  return {
    async list(options = {}) {
      let query = client
        .from("sentinel_activity_events")
        .select(ACTIVITY_COLUMNS)
        .eq("workspace_id", context.workspaceId);

      if (options.investigationId) {
        query = query.eq("investigation_id", options.investigationId);
      }

      const { data, error } = await query
        .order("created_at", { ascending: false })
        .limit(options.limit ?? DEFAULT_ACTIVITY_LIMIT);

      if (error) throw mapError("load activity", error);
      return (data ?? []).map(mapRow);
    },
  };
}
