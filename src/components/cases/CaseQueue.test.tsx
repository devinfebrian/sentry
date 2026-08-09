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

  it("withholds the risk and stage filters while every case shares one value", () => {
    // Both could only ever return everything or nothing until analysis produces variety.
    // The columns stay: "Not assessed" is true, and they light up when analysis lands.
    render(<MemoryRouter><CaseQueue cases={fixtureCases} /></MemoryRouter>);

    expect(screen.queryByRole("combobox", { name: /risk/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: /stage/i })).not.toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: /owner/i })).toBeInTheDocument();
    expect(screen.getByRole("searchbox", { name: /search cases/i })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: /risk/i })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: /stage/i })).toBeInTheDocument();
  });

  it("sorts numeric age values and preserves selected case link", async () => {
    render(<MemoryRouter><CaseQueue cases={fixtureCases} /></MemoryRouter>);
    await userEvent.click(screen.getByRole("button", { name: /sort age/i }));
    expect(screen.getByRole("link", { name: /northstar ltd/i })).toHaveAttribute("href", expect.stringContaining("/cases/"));
  });
});
