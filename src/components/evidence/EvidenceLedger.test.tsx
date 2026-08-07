import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { fixtureEvidence } from "../../demo/fixtures";
import { EvidenceLedger } from "./EvidenceLedger";

describe("EvidenceLedger", () => {
  it("shows source, agent, confidence, reviewer state, and relevance", () => {
    render(<MemoryRouter><EvidenceLedger records={fixtureEvidence} /></MemoryRouter>);
    expect(screen.getByRole("columnheader", { name: /source/i })).toBeInTheDocument();
    expect(screen.getAllByText(/fraud pattern investigator/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/needs source/i).length).toBeGreaterThan(0);
  });

  it("opens source detail without leaving ledger", async () => {
    render(<MemoryRouter><EvidenceLedger records={fixtureEvidence.slice(0, 1)} /></MemoryRouter>);
    await userEvent.click(screen.getByRole("button", { name: /q2 ledger/i }));
    expect(screen.getByRole("dialog")).toHaveTextContent("Q2 ledger / row 1842");
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
