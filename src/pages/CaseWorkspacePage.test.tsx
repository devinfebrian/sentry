import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";
import type { CaseSummary, SentinelActivityService, SentinelDecisionService, SentinelInvestigationService } from "../domain/types";
import { fixtureCases, fixtureDecision, fixtureEvidence, fixtureFindings, fixturePipeline } from "../demo/fixtures";
import { CaseWorkspacePage } from "./CaseWorkspacePage";

const importedCase: CaseSummary = {
  id: "INV-IMPORTED1",
  databaseId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  entity: "Imported Company",
  owner: "test-user",
  ownerId: null,
  risk: "not-assessed",
  stageId: "awaiting-import",
  status: "open",
  ageDays: 0,
  lastActivity: "2026-08-06T10:00:00.000Z",
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

const decisionViewerId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

const analysedCase: CaseSummary = {
  ...importedCase,
  id: "INV-ANALYSED2",
  ownerId: decisionViewerId,
  stageId: "analysed",
  risk: "high",
  status: "open",
};

/**
 * Renders the case workspace for a persisted case, stubbing the services DecisionPanel
 * needs so its own tests can focus on which panel the workspace chose rather than on
 * plumbing every service through by hand each time.
 */
function renderCasePage({
  step = "summary",
  caseItem,
  role = null,
  viewerId = decisionViewerId,
}: {
  step?: string;
  caseItem: CaseSummary;
  role?: "analyst" | "manager" | null;
  viewerId?: string | null;
}) {
  const service = { getById: vi.fn(async () => caseItem) };
  const decisionService: Pick<SentinelDecisionService, "record"> = {
    record: vi.fn(async () => ({ status: "review" as const })),
  };
  const activityService: SentinelActivityService = { list: vi.fn(async () => []) };
  const view = renderWorkspace(service, step, { viewerId, role, decisionService, activityService });
  return { ...view, service, decisionService, activityService };
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

  it("says the step is not built rather than that analysis has not started, once the case is analysed", async () => {
    // Regression coverage for the panel contradicting itself: a case at stage "analysed"
    // with findings on record must never render "Analysis not started" on report just
    // because that step has no producer of its own. Decision used to share this fate too,
    // until DecisionPanel gave it a real implementation — see the "decision step" describe
    // block below for its own coverage now that it renders something real.
    const analysedCase: CaseSummary = { ...importedCase, id: "INV-ANALYSED1", stageId: "analysed", risk: "high" };
    const analysedService = { getById: vi.fn(async () => analysedCase) };

    renderWorkspace(analysedService, "report", { analysisService: analysisWith([realFinding], [realEvidence]) });

    expect(await screen.findByRole("heading", { name: /this step is not built yet/i })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /analysis not started/i })).not.toBeInTheDocument();
    expect(screen.getByText("Stage: Analysed")).toBeInTheDocument();
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
      // importedCase's stageId is "awaiting-import", which has no upload at all — distinct
      // from the adjacent "awaiting-analysis" stage this label used to claim regardless.
      expect(screen.getAllByText("Stage: Awaiting import").length).toBeGreaterThan(0);
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

describe("CaseWorkspacePage heading status badge", () => {
  // The page heading badge and DecisionPanel's own badge render the same caseItem.status
  // through the same statusLabels/statusTones exported from DecisionPanel.tsx, so they
  // cannot drift the way they used to: the heading used to run
  // caseItem.status.replace("-", " ") (a no-op — no CaseStatus value has a hyphen) with its
  // own ad hoc tone rule, so a case in "review" showed "review" up top and "Pending
  // approval" in the panel below it.
  it("shows the mapped status label, not the raw status string", async () => {
    const reviewCase: CaseSummary = { ...importedCase, id: "INV-REVIEW1", status: "review" };
    const service = { getById: vi.fn(async () => reviewCase) };

    const { container } = renderWorkspace(service, "summary");

    await screen.findByRole("heading", { name: /investigation summary/i });
    const badge = container.querySelector(".page-heading-simple .status-badge");
    expect(badge).not.toBeNull();
    expect(badge).toHaveTextContent("Pending approval");
    expect(badge!.className).toContain("status-action");
  });

  it("paints a closed case with the risk tone, matching the panel rather than the old action/confirm split", async () => {
    const closedCase: CaseSummary = { ...importedCase, id: "INV-CLOSED1", status: "closed" };
    const service = { getById: vi.fn(async () => closedCase) };

    const { container } = renderWorkspace(service, "summary");

    await screen.findByRole("heading", { name: /investigation summary/i });
    const badge = container.querySelector(".page-heading-simple .status-badge");
    expect(badge).toHaveTextContent("Closed");
    expect(badge!.className).toContain("status-risk");
  });
});

describe("CaseWorkspacePage decision step", () => {
  // The decision step's static page heading (from stepCopy) always reads "Decision record",
  // whether or not the panel below it is built — so a "heading named Decision record" query
  // cannot distinguish "panel present" from "panel absent" on this step. DecisionPanel's own
  // <section aria-labelledby="decision-panel-title"> gets an implicit ARIA "region" role from
  // having an accessible name, which the plain <header> above it does not, so querying by
  // that role is what actually asserts the panel mounted.
  it("puts a real decision panel on the decision step of an analysed case", async () => {
    renderCasePage({ step: "decision", caseItem: analysedCase, role: "analyst" });

    expect(await screen.findByRole("region", { name: "Decision record" })).toBeInTheDocument();
    expect(screen.queryByText(/this step is not built yet/i)).not.toBeInTheDocument();
  });

  it("still says the report step is not built", async () => {
    renderCasePage({ step: "report", caseItem: analysedCase, role: "analyst" });

    expect(await screen.findByText(/this step is not built yet/i)).toBeInTheDocument();
  });

  it("says analysis has not started on the decision step of a case awaiting import", async () => {
    renderCasePage({ step: "decision", caseItem: { ...analysedCase, stageId: "awaiting-import" }, role: "analyst" });

    expect(await screen.findByRole("heading", { name: /analysis not started/i })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Decision record" })).not.toBeInTheDocument();
  });

  // The whole point of wiring onDecided to setRetryKey is that a recorded decision is
  // reflected back to the reader without a manual reload — a decision that updates the
  // database but leaves the page showing the old status is exactly the bug this slice
  // exists to remove. This asserts the re-read actually happens, not just that the write
  // succeeded.
  it("re-reads the case after a decision is recorded, so the page stops showing stale state", async () => {
    const { service } = renderCasePage({ step: "decision", caseItem: analysedCase, role: "analyst" });

    await screen.findByRole("region", { name: "Decision record" });
    expect(service.getById).toHaveBeenCalledTimes(1);

    await userEvent.click(await screen.findByRole("button", { name: /recommend approve/i }));
    await userEvent.type(screen.getByRole("textbox", { name: /rationale/i }), "Evidence supports approval.");
    await userEvent.click(screen.getByRole("button", { name: /^record decision$/i }));

    await waitFor(() => expect(service.getById).toHaveBeenCalledTimes(2));
  });
});
