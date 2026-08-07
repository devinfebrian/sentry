import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import type { CaseSummary, SentinelInvestigationService } from "../domain/types";
import { OverviewPage } from "./OverviewPage";

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

function serviceWithList(list: () => Promise<CaseSummary[]>): Pick<SentinelInvestigationService, "list"> {
  return { list: vi.fn(list) };
}

describe("OverviewPage", () => {
  it("renders persisted cases instead of fixture cases", async () => {
    const service = serviceWithList(async () => [importedCase]);

    render(<MemoryRouter><OverviewPage investigationService={service} /></MemoryRouter>);

    expect(await screen.findByRole("link", { name: /imported company/i })).toBeInTheDocument();
    expect(screen.getAllByText("Not assessed").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Analysis not started").length).toBeGreaterThan(0);
    expect(screen.queryByText("Northstar Ltd")).not.toBeInTheDocument();
  });

  it("shows loading state while persisted cases load", () => {
    const service = serviceWithList(() => new Promise<CaseSummary[]>(() => undefined));

    render(<MemoryRouter><OverviewPage investigationService={service} /></MemoryRouter>);

    expect(screen.getByRole("status", { name: /loading overview cases/i })).toBeInTheDocument();
  });

  it("shows retry action after persisted case loading fails", async () => {
    const service = {
      list: vi.fn()
        .mockRejectedValueOnce(new Error("network unavailable"))
        .mockResolvedValueOnce([importedCase]),
    };

    render(<MemoryRouter><OverviewPage investigationService={service} /></MemoryRouter>);

    expect(await screen.findByRole("heading", { name: /overview unavailable/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
  });

  it("shows an import next action when no persisted cases exist", async () => {
    const onImportData = vi.fn();
    const service = serviceWithList(async () => []);

    render(<MemoryRouter><OverviewPage investigationService={service} onImportData={onImportData} /></MemoryRouter>);

    expect(await screen.findByRole("heading", { name: /no investigations yet/i })).toBeInTheDocument();
    expect(within(screen.getByLabelText("Empty state")).getByRole("button", { name: /import data/i })).toBeInTheDocument();
  });
});
