import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { fixtureCases } from "../../demo/fixtures";
import { CaseQueue } from "./CaseQueue";

describe("CaseQueue", () => {
  it("filters cases by owner and keeps table headers accessible", async () => {
    render(<MemoryRouter><CaseQueue cases={fixtureCases} /></MemoryRouter>);
    expect(screen.getByRole("columnheader", { name: /case \/ entity/i })).toBeInTheDocument();

    const owner = fixtureCases[0].owner;
    await userEvent.selectOptions(screen.getByRole("combobox", { name: /owner/i }), owner);

    const expected = fixtureCases.filter((item) => item.owner === owner).length;
    expect(screen.getAllByRole("row")).toHaveLength(expected + 1); // + the header row
  });

  it("filters cases by risk", async () => {
    render(<MemoryRouter><CaseQueue cases={fixtureCases} /></MemoryRouter>);
    await userEvent.selectOptions(screen.getByRole("combobox", { name: /risk/i }), "high");

    const expected = fixtureCases.filter((item) => item.risk === "high").length;
    expect(expected).toBeGreaterThan(0); // a filter test against zero matches proves nothing
    expect(screen.getAllByRole("row")).toHaveLength(expected + 1); // + the header row
  });

  it("filters cases by stage", async () => {
    render(<MemoryRouter><CaseQueue cases={fixtureCases} /></MemoryRouter>);
    await userEvent.selectOptions(screen.getByRole("combobox", { name: /stage/i }), "analysed");

    const expected = fixtureCases.filter((item) => item.stageId === "analysed").length;
    expect(expected).toBeGreaterThan(0);
    expect(expected).toBeLessThan(fixtureCases.length); // and one returning everything proves nothing either
    expect(screen.getAllByRole("row")).toHaveLength(expected + 1);
  });

  it("labels every stage rather than leaking a raw slug", () => {
    render(<MemoryRouter><CaseQueue cases={fixtureCases} /></MemoryRouter>);
    // Positive assertion first: an absence check is satisfied instantly by a page that has
    // not rendered, which is the trap recorded in the 2026-08-10 follow-ups.
    expect(screen.getAllByRole("row")).toHaveLength(fixtureCases.length + 1);
    expect(screen.getAllByText("Analysed").length).toBeGreaterThan(0);
    // Only then is the absence meaningful: a raw slug means stageLabels fell behind CaseStage.
    expect(screen.queryByText(/awaiting-|fraud-review|not-started/)).not.toBeInTheDocument();
  });

  it("sorts numeric age values and preserves selected case link", async () => {
    render(<MemoryRouter><CaseQueue cases={fixtureCases} /></MemoryRouter>);
    await userEvent.click(screen.getByRole("button", { name: /sort age/i }));
    expect(screen.getByRole("link", { name: /northstar ltd/i })).toHaveAttribute("href", expect.stringContaining("/cases/"));
  });
});
