import type { PostgrestResponse } from "@supabase/supabase-js";
import type { EvidenceRecord, EvidenceState, Finding, SentinelAnalysisService } from "../domain/types";

type EvidenceRow = {
  id: string;
  source_row: number;
  source_label: string;
  claim: string;
  relevance: "supporting" | "contradictory" | "context";
  state: EvidenceState;
  created_at: string;
};

type FindingRow = {
  id: string;
  investigation_id: string;
  rule: string;
  agent: string;
  summary: string;
  confidence: number;
  created_at: string;
  sentinel_evidence: EvidenceRow[] | null;
};

export type SentinelAnalysisReadQuery = {
  eq(column: "workspace_id" | "investigation_id", value: string): SentinelAnalysisReadQuery;
  order(column: "created_at", options: { ascending: boolean }): SentinelAnalysisReadQuery;
  limit(count: number): PromiseLike<PostgrestResponse<FindingRow>>;
};

export type SentinelAnalysisClient = {
  from(table: "sentinel_findings"): {
    select(columns: string): SentinelAnalysisReadQuery;
  };
};

/**
 * Evidence is embedded rather than fetched separately: it exists only as part of a
 * finding, and a foreign key already relates them, so one round trip is enough.
 *
 * The relationship must be named. Following this schema's convention, evidence carries
 * both a plain `finding_id` FK and a composite workspace-scoped one, and PostgREST
 * refuses an ambiguous embed with PGRST201 rather than picking. We name the
 * workspace-scoped constraint: it is the one that also proves the evidence and its
 * finding belong to the same workspace.
 */
export const EVIDENCE_RELATIONSHIP = "sentinel_evidence!sentinel_evidence_workspace_finding_fkey";

export const ANALYSIS_COLUMNS =
  "id, investigation_id, rule, agent, summary, confidence, created_at, "
  + `${EVIDENCE_RELATIONSHIP}(id, source_row, source_label, claim, relevance, state, created_at)`;

/** Bounded like every other read here — an analysis re-run only ever adds rows. */
export const DEFAULT_FINDING_LIMIT = 100;

type AnalysisContext = { workspaceId: string };

function mapError(operation: string, error: { message?: string } | null) {
  return new Error(`Unable to ${operation}: ${error?.message || "Unknown Supabase error."}`);
}

export function createSentinelAnalysisService(
  client: SentinelAnalysisClient,
  context: AnalysisContext,
): SentinelAnalysisService {
  return {
    async list(investigationId, limit = DEFAULT_FINDING_LIMIT) {
      const { data, error } = await client
        .from("sentinel_findings")
        .select(ANALYSIS_COLUMNS)
        .eq("workspace_id", context.workspaceId)
        .eq("investigation_id", investigationId)
        .order("created_at", { ascending: true })
        .limit(limit);

      if (error) throw mapError("load analysis", error);

      const findings: Finding[] = [];
      const evidence: EvidenceRecord[] = [];

      for (const row of data ?? []) {
        const linked = row.sentinel_evidence ?? [];
        for (const item of linked) {
          evidence.push({
            id: item.id,
            caseId: row.investigation_id,
            source: item.source_label,
            claim: item.claim,
            // Evidence inherits the finding's provenance: it exists because of that rule.
            agent: row.agent,
            confidence: row.confidence,
            state: item.state,
            timestamp: item.created_at,
            relevance: item.relevance,
          });
        }

        findings.push({
          id: row.id,
          caseId: row.investigation_id,
          agent: row.agent,
          summary: row.summary,
          confidence: row.confidence,
          // Not yet selected from sentinel_findings.severity — this read path predates it.
          severity: null,
          // The domain splits evidence by relevance; the table stores it as one column.
          evidenceIds: linked.filter((item) => item.relevance === "supporting").map((item) => item.id),
          contradictoryEvidenceIds: linked.filter((item) => item.relevance === "contradictory").map((item) => item.id),
        });
      }

      return { findings, evidence };
    },
  };
}
