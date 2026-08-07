import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { fixtureDecision } from "../../demo/fixtures";
import { DecisionRecord } from "./DecisionRecord";

describe("DecisionRecord", () => {
  it("requires rationale when analyst changes recommendation", async () => {
    const onDecision = vi.fn();
    render(<DecisionRecord decision={fixtureDecision} onDecision={onDecision} />);
    await userEvent.click(screen.getByRole("button", { name: /reject recommendation/i }));
    expect(screen.getByRole("textbox", { name: /rationale/i })).toBeRequired();
    expect(onDecision).not.toHaveBeenCalled();
  });

  it("appends immutable event after rationale submission", async () => {
    const onDecision = vi.fn();
    render(<DecisionRecord decision={fixtureDecision} onDecision={onDecision} />);
    await userEvent.click(screen.getByRole("button", { name: /reject recommendation/i }));
    await userEvent.type(screen.getByRole("textbox", { name: /rationale/i }), "Source mismatch remains unresolved.");
    await userEvent.click(screen.getByRole("button", { name: /save decision/i }));
    expect(onDecision).toHaveBeenCalledWith(expect.objectContaining({ recommendation: "reject" }), expect.objectContaining({ type: "rejection" }));
  });
});
