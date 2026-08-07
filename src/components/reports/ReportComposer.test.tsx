import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { fixtureReportSections } from "../../demo/fixtures";
import { ReportComposer } from "./ReportComposer";

describe("ReportComposer", () => {
  it("renders required report sections in order", () => {
    const { container } = render(<ReportComposer sections={fixtureReportSections} />);
    const editPanel = container.querySelector(".report-edit-panel");
    expect(within(editPanel as HTMLElement).getAllByRole("heading", { level: 3 }).map((heading) => heading.textContent)).toEqual([
      "Executive summary",
      "Scope",
      "Methods",
      "Findings",
      "Evidence",
      "Decision",
      "Limitations",
    ]);
  });

  it("marks edits and labels export action with format", async () => {
    const onExport = vi.fn();
    render(<ReportComposer sections={fixtureReportSections} onExport={onExport} />);
    expect(screen.getByRole("button", { name: /export pdf/i })).toBeVisible();
    await userEvent.type(screen.getByRole("textbox", { name: /executive summary/i }), " Updated.");
    expect(screen.getByRole("status")).toHaveTextContent(/unsaved changes/i);
    await userEvent.click(screen.getByRole("button", { name: /export pdf/i }));
    expect(onExport).toHaveBeenCalledWith(expect.arrayContaining([expect.objectContaining({ id: "executive-summary" })]));
  });
});
