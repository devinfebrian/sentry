import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import type { EvidenceRecord, Finding } from "../../domain/types";
import { FindingPanel } from "./FindingPanel";

const baseFinding: Finding = {
  id: "finding-1",
  caseId: "case-1",
  agent: "Financial analysis",
  summary: "Whale records 400, 4x the median of 100",
  confidence: 0.9,
  severity: null,
  evidenceIds: [],
  contradictoryEvidenceIds: [],
};

const evidence: EvidenceRecord[] = [];

describe("FindingPanel", () => {
  it("renders a capitalised severity badge for a rated finding", () => {
    render(
      <MemoryRouter>
        <FindingPanel finding={{ ...baseFinding, severity: "high" }} evidence={evidence} />
      </MemoryRouter>,
    );

    // A raw slug ("high") would fail this — the label must read as a capitalised word plus "severity".
    expect(screen.getByText("High severity")).toBeInTheDocument();
  });

  it("renders no severity badge for an unrated finding, while still showing confidence", () => {
    render(
      <MemoryRouter>
        <FindingPanel finding={{ ...baseFinding, severity: null }} evidence={evidence} />
      </MemoryRouter>,
    );

    // Assert the confidence badge exists first: an absence check that passes because the
    // component failed to render at all would prove nothing.
    expect(screen.getByText("90% confidence")).toBeInTheDocument();
    expect(screen.queryByText(/severity/i)).not.toBeInTheDocument();
  });

  it("maps a non-high severity to its own label and tone, not just the high case", () => {
    const { container } = render(
      <MemoryRouter>
        <FindingPanel finding={{ ...baseFinding, severity: "medium" }} evidence={evidence} />
      </MemoryRouter>,
    );

    expect(screen.getByText("Medium severity")).toBeInTheDocument();
    expect(container.querySelector('[data-status="medium"]')).toHaveClass("status-warning");
  });
});
