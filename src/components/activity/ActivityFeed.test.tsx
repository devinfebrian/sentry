import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import type { ActivityEntry, ActivityEventType } from "../../domain/types";
import { ActivityFeed } from "./ActivityFeed";

const names = new Map([["actor-1", "ada.lovelace"], ["member-1", "grace.hopper"]]);
const caseReferences = new Map([["inv-uuid-1", "INV-ABC123"]]);

function entry(overrides: Partial<ActivityEntry> & { type: ActivityEventType }): ActivityEntry {
  return {
    id: "event-1",
    investigationId: "inv-uuid-1",
    actorId: "actor-1",
    metadata: {},
    occurredAt: new Date(Date.now() - 12 * 60_000).toISOString(),
    ...overrides,
  };
}

function renderFeed(entries: ActivityEntry[], props: Partial<Parameters<typeof ActivityFeed>[0]> = {}) {
  render(
    <MemoryRouter>
      <ActivityFeed entries={entries} names={names} caseReferences={caseReferences} {...props} />
    </MemoryRouter>,
  );
}

describe("ActivityFeed", () => {
  it("reads as a sentence naming the actor and what they did", () => {
    renderFeed([entry({ type: "parse-completed", metadata: { rowCount: 3, warningCount: 0 } })]);

    const row = screen.getByRole("listitem");
    expect(within(row).getByText("ada.lovelace")).toBeInTheDocument();
    expect(row).toHaveTextContent("parsed 3 records");
  });

  it("shows a relative time rather than a raw timestamp", () => {
    renderFeed([entry({ type: "parse-started" })]);

    expect(screen.getByText("12 min ago")).toBeInTheDocument();
  });

  it("links an event to the investigation it belongs to, by reference", () => {
    // Events carry the investigation UUID, but routes are keyed by reference.
    renderFeed([entry({ type: "upload-created", metadata: { original_name: "ledger.csv" } })]);

    const link = screen.getByRole("link", { name: "INV-ABC123" });
    expect(link).toHaveAttribute("href", "/cases/INV-ABC123/summary");
  });

  it("omits the link for a member event that belongs to no investigation", () => {
    renderFeed([entry({ type: "member-activated", investigationId: null, metadata: { member_user_id: "member-1" } })]);

    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(screen.getByRole("listitem")).toHaveTextContent("activated grace.hopper");
  });

  it("omits links entirely on a case-scoped feed", () => {
    // Linking back to the case you are already reading is noise.
    renderFeed([entry({ type: "parse-started" })], { showCaseLinks: false });

    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("omits the link when the investigation has no known reference", () => {
    renderFeed([entry({ type: "parse-started", investigationId: "unmapped-uuid" })]);

    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("renders one row per event", () => {
    renderFeed([
      entry({ type: "parse-started", id: "a" }),
      entry({ type: "parse-completed", id: "b", metadata: { rowCount: 1 } }),
    ]);

    expect(screen.getAllByRole("listitem")).toHaveLength(2);
  });

  it("quotes the actor's rationale when the event carries one", () => {
    renderFeed([entry({
      type: "case-approved",
      rationale: "Settlement letter is attached and matches the amount.",
    })]);

    const row = screen.getByRole("listitem");
    expect(row).toHaveTextContent("approved this case");
    expect(within(row).getByText("Settlement letter is attached and matches the amount."))
      .toBeInTheDocument();
  });

  it("renders no rationale element for an event that has none", () => {
    const { container } = render(
      <MemoryRouter>
        <ActivityFeed entries={[entry({ type: "parse-started" })]} names={names} />
      </MemoryRouter>,
    );

    expect(container.querySelector(".activity-rationale")).toBeNull();
  });
});
