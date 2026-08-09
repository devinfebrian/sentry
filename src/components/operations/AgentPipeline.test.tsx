import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { fixturePipeline } from "../../demo/fixtures";
import { AgentPipeline } from "./AgentPipeline";

function renderPipeline(stages = fixturePipeline, props: Partial<React.ComponentProps<typeof AgentPipeline>> = {}) {
  return render(<MemoryRouter><AgentPipeline stages={stages} {...props} /></MemoryRouter>);
}

describe("AgentPipeline", () => {
  it("renders all four stages in order with progress", () => {
    renderPipeline();
    expect(screen.getAllByRole("listitem").map((item) => item.textContent)).toEqual(expect.arrayContaining([
      expect.stringContaining("Financial analysis investigator"),
      expect.stringContaining("Fraud pattern investigator"),
      expect.stringContaining("Evidence review and decision"),
      expect.stringContaining("Reporting"),
    ]));
    expect(screen.getByText("18 / 22 complete")).toBeVisible();
  });

  it("offers retry for failed stage and announces new status", async () => {
    const retry = vi.fn().mockResolvedValue(undefined);
    const failedStage = { ...fixturePipeline[1], status: "failed" as const, failureReason: "Source unavailable" };
    renderPipeline([failedStage], { mode: "detail", onRetry: retry });
    await userEvent.click(screen.getByRole("button", { name: /retry fraud pattern investigator/i }));
    expect(retry).toHaveBeenCalledWith(failedStage.id);
    expect(screen.getByText("Failed")).toBeVisible();
  });

  it("offers a run action for a waiting stage that nothing has started", async () => {
    const run = vi.fn().mockResolvedValue(undefined);
    const waitingStage = { ...fixturePipeline[1], status: "waiting" as const };
    renderPipeline([waitingStage], { mode: "detail", onRetry: run });

    await userEvent.click(screen.getByRole("button", { name: /^run fraud pattern investigator$/i }));

    expect(run).toHaveBeenCalledWith(waitingStage.id);
  });

  it("lets a completed stage be run again", async () => {
    // The agent-scoped delete exists so a finished agent can be re-run without touching any
    // other agent's findings. A complete stage previously rendered no action at all, which
    // put that capability out of reach from the interface entirely.
    const run = vi.fn().mockResolvedValue(undefined);
    const completeStage = { ...fixturePipeline[1], status: "complete" as const };
    renderPipeline([completeStage], { mode: "detail", onRetry: run });

    await userEvent.click(screen.getByRole("button", { name: /run fraud pattern investigator again/i }));

    expect(run).toHaveBeenCalledWith(completeStage.id);
  });

  it("offers nothing while a stage is still running", async () => {
    const runningStage = { ...fixturePipeline[1], status: "running" as const };
    renderPipeline([runningStage], { mode: "detail", onRetry: vi.fn() });

    expect(screen.queryByRole("button", { name: /fraud pattern investigator/i })).not.toBeInTheDocument();
  });
});
