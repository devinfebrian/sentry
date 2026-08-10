import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import type { ActivityEntry, CaseStatus, CaseSummary } from "../../domain/types";
import { DecisionPanel } from "./DecisionPanel";

const caseItem = (status: CaseStatus, ownerId: string | null = "analyst-1"): CaseSummary => ({
  id: "INV-ABC123",
  databaseId: "inv-uuid-1",
  entity: "Northwind Freight",
  owner: "ada.lovelace",
  ownerId,
  risk: "high",
  stageId: "analysed",
  status,
  ageDays: 2,
  lastActivity: new Date().toISOString(),
});

const recommendedBy = (actorId: string): ActivityEntry => ({
  id: "event-1",
  investigationId: "inv-uuid-1",
  actorId,
  type: "case-recommended",
  metadata: { recommendation: "approve", from_status: "open", to_status: "review" },
  rationale: "Settlement explains the outlier.",
  occurredAt: new Date(Date.now() - 5 * 60_000).toISOString(),
});

function renderPanel(overrides: Partial<Parameters<typeof DecisionPanel>[0]> & { __entries?: ActivityEntry[] } = {}) {
  const record = vi.fn().mockResolvedValue({ status: "review" });
  const entries = overrides.__entries ?? [];
  const { __entries, ...rest } = overrides;
  const activityService = { list: vi.fn().mockResolvedValue(entries) };

  render(
    <MemoryRouter>
      <DecisionPanel
        caseItem={caseItem("open")}
        viewerId="analyst-1"
        role="analyst"
        decisionService={{ record }}
        activityService={activityService}
        onDecided={vi.fn()}
        {...rest}
      />
    </MemoryRouter>,
  );

  return { record, activityService };
}

describe("DecisionPanel", () => {
  it("offers the owner both recommendations while the case is open", async () => {
    renderPanel();

    expect(await screen.findByRole("button", { name: /recommend approve/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /recommend reject/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^approve$/i })).not.toBeInTheDocument();
  });

  it("offers nothing to an analyst who does not own the case", async () => {
    renderPanel({ caseItem: caseItem("open", "someone-else") });

    await waitFor(() => expect(screen.queryByRole("button", { name: /recommend/i })).not.toBeInTheDocument());
    expect(screen.getByText(/only the assigned analyst/i)).toBeInTheDocument();
  });

  it("sends the chosen action and the typed rationale", async () => {
    const { record } = renderPanel();

    await userEvent.click(await screen.findByRole("button", { name: /recommend approve/i }));
    await userEvent.type(screen.getByRole("textbox", { name: /rationale/i }), "Settlement explains it.");
    await userEvent.click(screen.getByRole("button", { name: /^record decision$/i }));

    await waitFor(() => expect(record).toHaveBeenCalledWith("inv-uuid-1", "recommend-approve", "Settlement explains it."));
  });

  it("will not submit an empty rationale", async () => {
    const { record } = renderPanel();

    await userEvent.click(await screen.findByRole("button", { name: /recommend approve/i }));
    await userEvent.click(screen.getByRole("button", { name: /^record decision$/i }));

    expect(record).not.toHaveBeenCalled();
  });

  it("gives a manager all three decisions on a case somebody else recommended", async () => {
    renderPanel({
      caseItem: caseItem("review"),
      role: "manager",
      viewerId: "manager-1",
      __entries: [recommendedBy("analyst-1")],
    });

    expect(await screen.findByRole("button", { name: /^approve$/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^reject$/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /request more evidence/i })).toBeInTheDocument();
  });

  it("withholds approval from the manager who wrote the recommendation, and says why", async () => {
    renderPanel({
      caseItem: caseItem("review", "manager-1"),
      role: "manager",
      viewerId: "manager-1",
      __entries: [recommendedBy("manager-1")],
    });

    expect(await screen.findByText(/another manager must decide/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^approve$/i })).not.toBeInTheDocument();
  });

  it("lets a manager reopen a decided case, and nothing else", async () => {
    renderPanel({
      caseItem: caseItem("approved"),
      role: "manager",
      viewerId: "manager-1",
      __entries: [recommendedBy("analyst-1")],
    });

    expect(await screen.findByRole("button", { name: /request more evidence/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^approve$/i })).not.toBeInTheDocument();
  });

  it("shows the refusal the database returned rather than a generic failure", async () => {
    const record = vi.fn().mockRejectedValue(new Error("You recommended this case. Another manager must decide it."));
    renderPanel({ decisionService: { record } });

    await userEvent.click(await screen.findByRole("button", { name: /recommend approve/i }));
    await userEvent.type(screen.getByRole("textbox", { name: /rationale/i }), "Mine.");
    await userEvent.click(screen.getByRole("button", { name: /^record decision$/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/another manager must decide/i);
  });

  it("shows the history with each decision's rationale", async () => {
    renderPanel({ caseItem: caseItem("review"), __entries: [recommendedBy("analyst-1")] });

    expect(await screen.findByText("Settlement explains the outlier.")).toBeInTheDocument();
  });
});
