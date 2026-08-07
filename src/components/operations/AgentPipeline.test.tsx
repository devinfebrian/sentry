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
});
