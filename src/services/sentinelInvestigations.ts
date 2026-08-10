import type { PostgrestMaybeSingleResponse, PostgrestResponse, PostgrestSingleResponse } from "@supabase/supabase-js";
import type { CaseStage, CaseSummary, RiskLevel, SentinelInvestigationService } from "../domain/types";
import type { Database } from "../lib/database.types";

/**
 * The queue view's shape, declared here rather than in database.types.ts. That file is
 * hand-curated and analysis relations stay out of it by convention; regenerating it to pick
 * up this view would replace hand-narrowed unions elsewhere with bare strings.
 */
type InvestigationRow = {
  id: string;
  workspace_id: string;
  reference: string;
  entity: string;
  owner_id: string | null;
  status: "open" | "review" | "approved" | "closed";
  created_at: string;
  updated_at: string;
  risk: RiskLevel;
  stage: string;
};

type InvestigationInsert = Database["public"]["Tables"]["sentinel_investigations"]["Insert"];
type InvestigationContext = {
  workspaceId: string;
  userId: string;
  /**
   * Supplies owner display names. A function rather than a service reference, so this
   * module stays unaware of how membership is loaded. Best effort — a failed lookup
   * degrades owner labels, it does not fail the case list.
   */
  loadOwnerNames?: () => Promise<OwnerNames>;
};

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
  from(table: "sentinel_investigations" | "sentinel_investigation_queue"): {
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

/**
 * owner_id references auth.users, not sentinel_members, so PostgREST has no relationship
 * to embed through. Names arrive as a lookup the caller supplies from the roster it has
 * already loaded, rather than a second query per investigation.
 */
export type OwnerNames = ReadonlyMap<string, string>;

export function resolveOwner(ownerId: string | null, names?: OwnerNames) {
  if (!ownerId) return "Unassigned";
  const name = names?.get(ownerId);
  if (name) return name;
  // Better a recognisable fragment than a 36-character UUID in a table cell.
  return `Member ${ownerId.slice(0, 8)}`;
}

const caseStages: readonly CaseStage[] = [
  "awaiting-import", "analysing", "analysis-failed", "awaiting-analysis", "fraud-review", "analysed",
];

/**
 * The view is constrained to these six, but the client cannot prove that. An unrecognised
 * value falls back to the stage that claims the least rather than reaching a table cell as
 * a raw slug.
 */
function toStage(value: string): CaseStage {
  return (caseStages as readonly string[]).includes(value) ? (value as CaseStage) : "awaiting-import";
}

function mapRow(row: InvestigationRow, names?: OwnerNames): CaseSummary {
  const createdAt = Date.parse(row.created_at);
  const ageDays = Number.isFinite(createdAt)
    ? Math.max(0, Math.floor((Date.now() - createdAt) / millisecondsPerDay))
    : 0;

  return {
    id: row.reference,
    databaseId: row.id,
    entity: row.entity,
    owner: resolveOwner(row.owner_id, names),
    risk: row.risk,
    stageId: toStage(row.stage),
    status: row.status,
    ageDays,
    lastActivity: row.updated_at,
  };
}

export function createSentinelInvestigationService(
  client: SentinelInvestigationClient,
  context: InvestigationContext,
): SentinelInvestigationService {
  const ownerNames = async (): Promise<OwnerNames | undefined> => {
    if (!context.loadOwnerNames) return undefined;
    try {
      return await context.loadOwnerNames();
    } catch {
      // Names are a nicety; the case list is not.
      return undefined;
    }
  };

  return {
    async list() {
      const { data, error } = await client
        .from("sentinel_investigation_queue")
        .select("*")
        .eq("workspace_id", context.workspaceId)
        .order("created_at", { ascending: false });

      if (error) throw mapError("list investigations", error);
      const names = await ownerNames();
      return (data ?? []).map((row) => mapRow(row, names));
    },

    async getById(id) {
      const { data, error } = await client
        .from("sentinel_investigation_queue")
        .select("*")
        .eq("workspace_id", context.workspaceId)
        .eq("reference", id)
        .maybeSingle();

      if (error) throw mapError("load investigation", error);
      return data ? mapRow(data, await ownerNames()) : null;
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
          // The insert returns the table row, which has no derived columns. A brand-new case
          // has no uploads and no findings, so this is what the view would say about it.
          return mapRow({ ...data, risk: "not-assessed", stage: "awaiting-import" });
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
