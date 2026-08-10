import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import type { CaseSummary } from "../../domain/types";
import { CaseHeader } from "./CaseHeader";

const analysedCase: CaseSummary = {
  id: "INV-0001",
  databaseId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  entity: "Acme Holdings",
  owner: "test-user",
  risk: "high",
  stageId: "analysed",
  status: "review",
  ageDays: 3,
  lastActivity: "2026-08-09T09:00:00.000Z",
};

function stepLink(name: string) {
  return screen.getByRole("link", { name: new RegExp(name, "i") });
}

describe("CaseHeader step rail", () => {
  it("marks summary and findings complete on an analysed case viewed from report", () => {
    render(
      <MemoryRouter>
        <CaseHeader caseItem={analysedCase} currentStep="report" />
      </MemoryRouter>,
    );

    expect(within(stepLink("summary")).getByText("Complete")).toBeInTheDocument();
    expect(within(stepLink("findings")).getByText("Complete")).toBeInTheDocument();
  });

  it("never marks evidence, decision, or report complete — analysed evidences nothing past findings", () => {
    // Regression coverage: analysed backs only summary and findings. Nothing writes
    // sentinel_evidence.state, and decision/report are fixture-backed, so stamping any of
    // the three Complete off the same stage would claim work that never happened.
    render(
      <MemoryRouter>
        <CaseHeader caseItem={analysedCase} currentStep="report" />
      </MemoryRouter>,
    );

    expect(within(stepLink("evidence")).queryByText("Complete")).not.toBeInTheDocument();
    expect(within(stepLink("decision")).queryByText("Complete")).not.toBeInTheDocument();
    expect(within(stepLink("report")).queryByText("Complete")).not.toBeInTheDocument();
  });

  it("marks nothing complete for a case that has not reached analysed", () => {
    const unanalysed: CaseSummary = { ...analysedCase, stageId: "fraud-review" };

    render(
      <MemoryRouter>
        <CaseHeader caseItem={unanalysed} currentStep="report" />
      </MemoryRouter>,
    );

    expect(screen.queryByText("Complete")).not.toBeInTheDocument();
  });
});
