import type { PostgrestMaybeSingleResponse, PostgrestResponse, PostgrestSingleResponse } from "@supabase/supabase-js";
import type { CaseSummary, SentinelInvestigationService } from "../domain/types";
import type { Database } from "../lib/database.types";

type InvestigationRow = Database["public"]["Tables"]["sentinel_investigations"]["Row"];
type InvestigationInsert = Database["public"]["Tables"]["sentinel_investigations"]["Insert"];
type InvestigationContext = { workspaceId: string; userId: string };

type InvestigationReadQuery = {
  eq(column: "workspace_id" | "reference", value: string): InvestigationReadQuery;
  order(column: "created_at", options: { ascending: boolean }): PromiseLike<PostgrestResponse<InvestigationRow>>;
  maybeSingle(): PromiseLike<PostgrestMaybeSingleResponse<InvestigationRow>>;
};

type InvestigationInsertQuery = {
  select(columns: "*"): InvestigationInsertQuery;
  single(): PromiseLike<PostgrestSingleResponse<InvestigationRow>>;
};

export type SentinelInvestigationClient = {
  from(table: "sentinel_investigations"): {
    select(columns: "*"): InvestigationReadQuery;
    insert(values: InvestigationInsert): InvestigationInsertQuery;
  };
};

const millisecondsPerDay = 24 * 60 * 60 * 1000;
const maxCreateAttempts = 3;

function generateReference() {
  const token = crypto.randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase();
  return `INV-${token}`;
}

function mapError(operation: string, error: { message?: string } | null) {
  const message = error?.message || "Unknown Supabase error.";
  return new Error(`Unable to ${operation}: ${message}`);
}

function mapRow(row: InvestigationRow): CaseSummary {
  const createdAt = Date.parse(row.created_at);
  const ageDays = Number.isFinite(createdAt)
    ? Math.max(0, Math.floor((Date.now() - createdAt) / millisecondsPerDay))
    : 0;

  return {
    id: row.reference,
    databaseId: row.id,
    entity: row.entity,
    owner: row.owner_id || "Unassigned",
    risk: "not-assessed",
    stageId: "not-started",
    status: row.status,
    ageDays,
    lastActivity: row.updated_at,
    analysisStatus: "not-started",
  };
}

export function createSentinelInvestigationService(
  client: SentinelInvestigationClient,
  context: InvestigationContext,
): SentinelInvestigationService {
  return {
    async list() {
      const { data, error } = await client
        .from("sentinel_investigations")
        .select("*")
        .eq("workspace_id", context.workspaceId)
        .order("created_at", { ascending: false });

      if (error) throw mapError("list investigations", error);
      return (data ?? []).map(mapRow);
    },

    async getById(id) {
      const { data, error } = await client
        .from("sentinel_investigations")
        .select("*")
        .eq("workspace_id", context.workspaceId)
        .eq("reference", id)
        .maybeSingle();

      if (error) throw mapError("load investigation", error);
      return data ? mapRow(data) : null;
    },

    async create({ entity, ownerId }) {
      for (let attempt = 0; attempt < maxCreateAttempts; attempt += 1) {
        const { data, error } = await client
          .from("sentinel_investigations")
          .insert({
            workspace_id: context.workspaceId,
            reference: generateReference(),
            entity,
            owner_id: ownerId || null,
            status: "open",
            created_by: context.userId,
          })
          .select("*")
          .single();

        if (!error) {
          if (!data) throw new Error("Unable to create investigation: Supabase returned no investigation.");
          return mapRow(data);
        }

        if (error.code !== "23505" || attempt === maxCreateAttempts - 1) {
          throw mapError("create investigation", error);
        }
      }

      throw new Error("Unable to create investigation: reference generation exhausted.");
    },
  };
}

export const createSentinelInvestigations = createSentinelInvestigationService;
