import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { AppShell } from "./AppShell";
import { StatusBadge } from "../ui/StatusBadge";

function renderShell() {
  return render(
    <MemoryRouter>
      <AppShell><div>Content</div></AppShell>
    </MemoryRouter>,
  );
}

describe("AppShell", () => {
  it("renders navigation and opens mobile drawer", async () => {
    renderShell();
    expect(screen.getByRole("navigation", { name: "Main navigation" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /open navigation/i }));
    expect(screen.getByRole("dialog", { name: /workspace navigation/i })).toBeVisible();
  });

  it("returns focus to menu button after closing drawer", async () => {
    renderShell();
    const menuButton = screen.getByRole("button", { name: /open navigation/i });
    await userEvent.click(menuButton);
    await userEvent.click(screen.getByRole("button", { name: "Close navigation" }));
    await waitFor(() => expect(menuButton).toHaveFocus());
  });

  it("status badge exposes text, not color alone", () => {
    render(<StatusBadge status="high" label="High risk" tone="risk" />);
    expect(screen.getByText("High risk")).toBeVisible();
  });
});
