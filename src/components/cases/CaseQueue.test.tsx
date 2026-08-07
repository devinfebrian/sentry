import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { fixtureCases } from "../../demo/fixtures";
import { CaseQueue } from "./CaseQueue";

describe("CaseQueue", () => {
  it("filters cases by risk and keeps table headers accessible", async () => {
    render(<MemoryRouter><CaseQueue cases={fixtureCases} /></MemoryRouter>);
    expect(screen.getByRole("columnheader", { name: /case \/ entity/i })).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByRole("combobox", { name: /risk/i }), "high");
    expect(screen.getAllByRole("row")).toHaveLength(3);
  });

  it("sorts numeric age values and preserves selected case link", async () => {
    render(<MemoryRouter><CaseQueue cases={fixtureCases} /></MemoryRouter>);
    await userEvent.click(screen.getByRole("button", { name: /sort age/i }));
    expect(screen.getByRole("link", { name: /northstar ltd/i })).toHaveAttribute("href", expect.stringContaining("/cases/"));
  });
});
