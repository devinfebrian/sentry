import { describe, expect, it, vi } from "vitest";
import type { PostgrestResponse } from "@supabase/supabase-js";
import {
  ANALYSIS_COLUMNS,
  createSentinelAnalysisService,
  DEFAULT_FINDING_LIMIT,
  type SentinelAnalysisClient,
  type SentinelAnalysisReadQuery,
} from "./sentinelAnalysis";

const workspaceId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const investigationId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const findingRow = {
  id: "finding-1",
  investigation_id: investigationId,
  rule: "outlier-amount",
  agent: "Financial analysis",
  summary: "Whale records 400, 4x the median of 100",
  confidence: 1,
  severity: null,
  created_at: "2026-08-09T09:00:00.000Z",
  sentinel_evidence: [
    {
      id: "evidence-1",
      source_row: 20,
      source_label: "Row 20 — Whale",
      claim: "amount = 400",
      relevance: "supporting" as const,
      state: "unreviewed" as const,
      created_at: "2026-08-09T09:00:00.000Z",
    },
    {
      id: "evidence-2",
      source_row: 2,
      source_label: "Row 2 — Entity 1",
      claim: "Median amount across this import is 100",
      relevance: "context" as const,
      state: "unreviewed" as const,
      created_at: "2026-08-09T09:00:00.000Z",
    },
  ],
};

type FindingRow = typeof findingRow;

function listResponse(data: FindingRow[]): PostgrestResponse<FindingRow> {
  return { data, error: null, status: 200, statusText: "OK", success: true, count: data.length };
}

function createClient(response: PromiseLike<PostgrestResponse<FindingRow>>) {
  let query!: SentinelAnalysisReadQuery;
  const eq = vi.fn((_column: "workspace_id" | "investigation_id", _value: string): SentinelAnalysisReadQuery => query);
  const order = vi.fn((_column: "created_at", _options: { ascending: boolean }): SentinelAnalysisReadQuery => query);
  const limit = vi.fn((_count: number) => response);
  query = { eq, order, limit } satisfies SentinelAnalysisReadQuery;

  const select = vi.fn((_columns: string) => query);
  const from = vi.fn((_table: "sentinel_findings") => ({ select }));
  return { client: { from } satisfies SentinelAnalysisClient, from, select, eq, order, limit };
}

function serviceFor(response: PromiseLike<PostgrestResponse<FindingRow>> = Promise.resolve(listResponse([findingRow]))) {
  const fake = createClient(response);
  return { ...fake, service: createSentinelAnalysisService(fake.client, { workspaceId }) };
}

describe("createSentinelAnalysisService", () => {
  it("scopes findings to the workspace and investigation, bounded", async () => {
    const fake = serviceFor();

    await fake.service.list(investigationId);

    expect(fake.from).toHaveBeenCalledWith("sentinel_findings");
    expect(fake.select).toHaveBeenCalledWith(ANALYSIS_COLUMNS);
    expect(fake.eq).toHaveBeenNthCalledWith(1, "workspace_id", workspaceId);
    expect(fake.eq).toHaveBeenNthCalledWith(2, "investigation_id", investigationId);
    expect(fake.limit).toHaveBeenCalledWith(DEFAULT_FINDING_LIMIT);
  });

  it("splits embedded evidence by relevance, which is how the domain models it", async () => {
    const { findings } = await serviceFor().service.list(investigationId);

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      id: "finding-1",
      agent: "Financial analysis",
      summary: "Whale records 400, 4x the median of 100",
      confidence: 1,
      evidenceIds: ["evidence-1"],
      contradictoryEvidenceIds: [],
    });
  });

  it("gives each evidence record the provenance of the finding it belongs to", async () => {
    const { evidence } = await serviceFor().service.list(investigationId);

    expect(evidence).toHaveLength(2);
    expect(evidence[0]).toMatchObject({
      id: "evidence-1",
      source: "Row 20 — Whale",
      claim: "amount = 400",
      agent: "Financial analysis",
      state: "unreviewed",
      relevance: "supporting",
    });
    expect(evidence[1].relevance).toBe("context");
  });

  it("returns empty collections for an investigation with no findings", async () => {
    // A clean import is the common case and must not read as an error.
    await expect(serviceFor(Promise.resolve(listResponse([]))).service.list(investigationId))
      .resolves.toEqual({ findings: [], evidence: [] });
  });

  it("tolerates a finding whose evidence embed came back null", async () => {
    const orphan = { ...findingRow, sentinel_evidence: null } as unknown as FindingRow;
    const { findings, evidence } = await serviceFor(Promise.resolve(listResponse([orphan]))).service.list(investigationId);

    expect(findings[0].evidenceIds).toEqual([]);
    expect(evidence).toEqual([]);
  });

  it("carries each finding's severity, and null where no producer rated it", async () => {
    const rated: FindingRow = { ...findingRow, id: "f1", severity: "high" };
    const unrated: FindingRow = {
      ...findingRow,
      id: "f2",
      agent: "Fraud pattern investigator",
      rule: "round-number-clustering",
      confidence: 0.9,
      severity: null,
    };
    const { service } = serviceFor(Promise.resolve(listResponse([rated, unrated])));
    const { findings } = await service.list(investigationId);

    expect(findings[0].severity).toBe("high");
    expect(findings[1].severity).toBeNull();
  });

  it("wraps a denied read in a readable message", async () => {
    const denied = {
      data: null,
      error: { code: "42501", message: "findings denied", details: "", hint: "", name: "PostgrestError" },
      status: 403,
      statusText: "Forbidden",
      success: false,
      count: null,
    } as unknown as PostgrestResponse<FindingRow>;

    await expect(serviceFor(Promise.resolve(denied)).service.list(investigationId))
      .rejects.toThrow("Unable to load analysis: findings denied");
  });
});
