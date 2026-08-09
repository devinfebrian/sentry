import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";
import type { CaseSummary, SentinelInvestigationService } from "../domain/types";
import { fixtureCases, fixtureDecision, fixtureEvidence, fixtureFindings, fixturePipeline } from "../demo/fixtures";
import { CaseWorkspacePage } from "./CaseWorkspacePage";

const importedCase: CaseSummary = {
  id: "INV-IMPORTED1",
  databaseId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  entity: "Imported Company",
  owner: "test-user",
  risk: "not-assessed",
  stageId: "not-started",
  status: "open",
  ageDays: 0,
  lastActivity: "2026-08-06T10:00:00.000Z",
  analysisStatus: "not-started",
};

function renderWorkspace(
  service: Pick<SentinelInvestigationService, "getById">,
  step = "summary",
  props: Partial<ComponentProps<typeof CaseWorkspacePage>> = {},
) {
  const initialCaseId = props.demoData?.cases[0]?.id ?? "INV-IMPORTED1";
  return render(
    <MemoryRouter initialEntries={[`/cases/${initialCaseId}/${step}`]}>
      <Routes>
      <Route path="/cases/:caseId/:step" element={<CaseWorkspacePage investigationService={service} {...props} />} />
      </Routes>
    </MemoryRouter>,
  );
}

const analysisWith = (findings: unknown[], evidence: unknown[] = []) => ({
  list: vi.fn(async () => ({ findings, evidence })),
}) as unknown as ComponentProps<typeof CaseWorkspacePage>["analysisService"];

const realFinding = {
  id: "finding-1",
  caseId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  agent: "Financial analysis",
  summary: "2 rows record 250 for Acme",
  confidence: 1,
  evidenceIds: ["evidence-1"],
  contradictoryEvidenceIds: [],
};

const realEvidence = {
  id: "evidence-1",
  caseId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  source: "Row 2 — Acme",
  claim: "amount = 250",
  agent: "Financial analysis",
  confidence: 1,
  state: "unreviewed" as const,
  timestamp: "2026-08-09T09:00:00.000Z",
  relevance: "supporting" as const,
};

describe("CaseWorkspacePage analysis", () => {
  const service = { getById: vi.fn(async () => importedCase) };

  it("renders a real finding on the findings step", async () => {
    renderWorkspace(service, "findings", { analysisService: analysisWith([realFinding], [realEvidence]) });

    expect(await screen.findByText("2 rows record 250 for Acme")).toBeInTheDocument();
    expect(screen.getByText("Financial analysis")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /analysis not started/i })).not.toBeInTheDocument();
  });

  it("renders the real evidence ledger on the evidence step", async () => {
    renderWorkspace(service, "evidence", { analysisService: analysisWith([realFinding], [realEvidence]) });

    expect(await screen.findByText("Row 2 — Acme")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /analysis not started/i })).not.toBeInTheDocument();
  });

  it("still says analysis not started when a clean import produced none", async () => {
    // The common case. An empty result is a legitimate outcome, not an error.
    renderWorkspace(service, "findings", { analysisService: analysisWith([]) });

    expect(await screen.findByRole("heading", { name: /analysis not started/i })).toBeInTheDocument();
  });

  it("leaves the steps that have no implementation alone", async () => {
    renderWorkspace(service, "decision", { analysisService: analysisWith([realFinding], [realEvidence]) });

    expect(await screen.findByRole("heading", { name: /analysis not started/i })).toBeInTheDocument();
  });

  it("says the analysis could not be loaded rather than that none was started", async () => {
    // A failed read is not an absence of findings. Reporting it as "not started" hid a
    // broken query behind a plausible-looking empty state for an entire slice.
    const failing = {
      list: vi.fn(async () => {
        throw new Error("Unable to load analysis: boom");
      }),
    } as unknown as ComponentProps<typeof CaseWorkspacePage>["analysisService"];

    renderWorkspace(service, "findings", { analysisService: failing });

    expect(await screen.findByRole("heading", { name: /analysis could not be loaded/i })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /analysis not started/i })).not.toBeInTheDocument();
  });
});

describe("CaseWorkspacePage", () => {
  it.each(["summary", "findings", "evidence", "decision", "report"])(
    "renders persisted %s case as analysis not started",
    async (step) => {
      const service = { getById: vi.fn().mockResolvedValue(importedCase) };

      renderWorkspace(service, step);

      expect(await screen.findByRole("heading", { name: /imported company/i })).toBeInTheDocument();
      expect(screen.getAllByText("Analysis not started").length).toBeGreaterThan(0);
      expect(screen.getAllByText("Not assessed").length).toBeGreaterThan(0);
      expect(screen.queryByText("Beneficiary mismatch warrants enhanced review before payment release.")).not.toBeInTheDocument();
      expect(screen.queryByRole("heading", { name: /case workspace unavailable/i })).not.toBeInTheDocument();
      expect(service.getById).toHaveBeenCalledWith("INV-IMPORTED1");
    },
  );

  it("shows loading state while persisted case loads", () => {
    const service = { getById: vi.fn(() => new Promise<CaseSummary | null>(() => undefined)) };

    renderWorkspace(service);

    expect(screen.getByRole("status", { name: /loading case/i })).toBeInTheDocument();
  });

  it("shows retry action after persisted case loading fails", async () => {
    const service = {
      getById: vi.fn()
        .mockRejectedValueOnce(new Error("network unavailable"))
        .mockResolvedValueOnce(importedCase),
    };

    renderWorkspace(service);

    expect(await screen.findByRole("heading", { name: /case workspace unavailable/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
  });

  it("keeps fixture rendering behind an explicit fixture path", () => {
    renderWorkspace({ getById: vi.fn() }, "summary", {
      demoData: {
        cases: fixtureCases,
        pipeline: fixturePipeline,
        evidence: fixtureEvidence,
        findings: fixtureFindings,
        decision: fixtureDecision,
      },
    });

    expect(screen.getByRole("heading", { name: /northstar ltd/i })).toBeInTheDocument();
    expect(screen.getByText("Beneficiary mismatch needs enhanced review.")).toBeInTheDocument();
  });
});
