import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import type { CaseSummary, SentinelInvestigationService } from "../domain/types";
import { CasesPage } from "./CasesPage";

const importedCase: CaseSummary = {
  id: "INV-IMPORTED1",
  databaseId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  entity: "Imported Company",
  owner: "test-user",
  risk: "not-assessed",
  stageId: "awaiting-import",
  status: "open",
  ageDays: 0,
  lastActivity: "2026-08-06T10:00:00.000Z",
};

function serviceWithList(list: () => Promise<CaseSummary[]>): Pick<SentinelInvestigationService, "list"> {
  return { list: vi.fn(list) };
}

describe("CasesPage", () => {
  it("renders persisted entity content and not fixture content", async () => {
    const service = serviceWithList(async () => [importedCase]);

    render(<MemoryRouter><CasesPage investigationService={service} /></MemoryRouter>);

    expect(await screen.findByRole("link", { name: /imported company/i })).toBeInTheDocument();
    expect(screen.getAllByText("Not assessed").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Awaiting import").length).toBeGreaterThan(0);
    expect(screen.queryByText("Northstar Ltd")).not.toBeInTheDocument();
  });

  it("shows loading state while persisted cases load", () => {
    const service = serviceWithList(() => new Promise<CaseSummary[]>(() => undefined));

    render(<MemoryRouter><CasesPage investigationService={service} /></MemoryRouter>);

    expect(screen.getByRole("status", { name: /loading cases/i })).toBeInTheDocument();
  });

  it("retries persisted case loading after an error", async () => {
    const service = {
      list: vi.fn()
        .mockRejectedValueOnce(new Error("network unavailable"))
        .mockResolvedValueOnce([importedCase]),
    };

    render(<MemoryRouter><CasesPage investigationService={service} /></MemoryRouter>);

    expect(await screen.findByRole("heading", { name: /cases unavailable/i })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /retry/i }));
    expect(await screen.findByRole("link", { name: /imported company/i })).toBeInTheDocument();
  });

  it("opens the new investigation dialog from the page action", async () => {
    // This button rendered with no onClick until now — the primary action on the page did
    // nothing when clicked.
    const onImportData = vi.fn();
    const service = serviceWithList(async () => [importedCase]);

    render(<MemoryRouter><CasesPage investigationService={service} onImportData={onImportData} /></MemoryRouter>);

    await screen.findByRole("table");
    await userEvent.click(screen.getByRole("button", { name: /new investigation/i }));

    expect(onImportData).toHaveBeenCalledTimes(1);
  });

  it("shows an import next action when no persisted cases exist", async () => {
    const onImportData = vi.fn();
    const service = serviceWithList(async () => []);

    render(<MemoryRouter><CasesPage investigationService={service} onImportData={onImportData} /></MemoryRouter>);

    await screen.findByRole("heading", { name: /no investigations yet/i });
    await userEvent.click(within(screen.getByLabelText("Empty state")).getByRole("button", { name: /import data/i }));
    expect(onImportData).toHaveBeenCalledTimes(1);
  });

  it("ignores a stale list response after service changes", async () => {
    let resolveStale!: (cases: CaseSummary[]) => void;
    const staleService = { list: vi.fn(() => new Promise<CaseSummary[]>((resolve) => { resolveStale = resolve; })) };
    const currentService = serviceWithList(async () => [importedCase]);
    const { rerender } = render(<MemoryRouter><CasesPage investigationService={staleService} /></MemoryRouter>);

    rerender(<MemoryRouter><CasesPage investigationService={currentService} /></MemoryRouter>);
    expect(await screen.findByRole("link", { name: /imported company/i })).toBeInTheDocument();

    resolveStale([{ ...importedCase, entity: "Stale Company" }]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByText("Stale Company")).not.toBeInTheDocument();
  });
});
