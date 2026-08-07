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
  props: { demoData?: ComponentProps<typeof CaseWorkspacePage>["demoData"] } = {},
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
