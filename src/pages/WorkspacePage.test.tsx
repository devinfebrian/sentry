import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import type { SentinelMember } from "../domain/types";
import { WorkspacePage } from "./WorkspacePage";

const manager: SentinelMember = {
  userId: "22222222-2222-4222-8222-222222222222",
  email: "manager@example.com",
  role: "manager",
  status: "active",
  joinedAt: "2026-08-01T09:00:00.000Z",
  isSelf: true,
};

const analyst: SentinelMember = {
  userId: "33333333-3333-4333-8333-333333333333",
  email: "analyst@example.com",
  role: "analyst",
  status: "pending",
  joinedAt: "2026-08-04T09:00:00.000Z",
  isSelf: false,
};

function memberService(
  overrides: Partial<{
    list: () => Promise<SentinelMember[]>;
    invite: (email: string) => Promise<void>;
    activate: (userId: string) => Promise<void>;
    setRole: (userId: string, role: "analyst" | "manager") => Promise<void>;
    rejectInvitation: (userId: string) => Promise<void>;
  }> = {},
) {
  return {
    list: vi.fn(overrides.list ?? (async () => [manager, analyst])),
    invite: vi.fn(overrides.invite ?? (async () => undefined)),
    activate: vi.fn(overrides.activate ?? (async () => undefined)),
    setRole: vi.fn(overrides.setRole ?? (async () => undefined)),
    rejectInvitation: vi.fn(overrides.rejectInvitation ?? (async () => undefined)),
  };
}

function renderPage(props: Parameters<typeof WorkspacePage>[0]) {
  return render(<MemoryRouter><WorkspacePage {...props} /></MemoryRouter>);
}

describe("WorkspacePage", () => {
  it("shows the member roster and invite form to a manager", async () => {
    renderPage({ memberService: memberService(), role: "manager" });

    expect(await screen.findByRole("table", { name: /workspace members/i })).toBeInTheDocument();
    expect(screen.getByText("manager@example.com")).toBeInTheDocument();
    expect(screen.getByText("analyst@example.com")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: /email/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /send invitation/i })).toBeInTheDocument();
  });

  it("hides invite controls from an analyst", async () => {
    renderPage({ memberService: memberService({ list: async () => [analyst] }), role: "analyst" });

    expect(await screen.findByText("analyst@example.com")).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: /email/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /send invitation/i })).not.toBeInTheDocument();
    expect(screen.getByText(/only workspace managers can invite/i)).toBeInTheDocument();
  });

  it("rejects an invalid email without calling the service", async () => {
    const service = memberService();
    renderPage({ memberService: service, role: "manager" });

    await screen.findByRole("table", { name: /workspace members/i });
    await userEvent.type(screen.getByRole("textbox", { name: /email/i }), "not-an-email");
    await userEvent.click(screen.getByRole("button", { name: /send invitation/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/enter a valid email address/i);
    expect(service.invite).not.toHaveBeenCalled();
  });

  it("announces success, clears the field, and reloads the roster", async () => {
    const service = memberService();
    renderPage({ memberService: service, role: "manager" });

    await screen.findByRole("table", { name: /workspace members/i });
    const email = screen.getByRole("textbox", { name: /email/i });
    await userEvent.type(email, "new.analyst@example.com");
    await userEvent.click(screen.getByRole("button", { name: /send invitation/i }));

    expect(await screen.findByRole("status")).toHaveTextContent(/new\.analyst@example\.com/i);
    expect(service.invite).toHaveBeenCalledWith("new.analyst@example.com");
    expect(email).toHaveValue("");
    expect(service.list).toHaveBeenCalledTimes(2);
  });

  it("surfaces a failed invitation and keeps the typed email", async () => {
    const service = memberService({
      invite: async () => {
        throw new Error("Invitation already pending.");
      },
    });
    renderPage({ memberService: service, role: "manager" });

    await screen.findByRole("table", { name: /workspace members/i });
    const email = screen.getByRole("textbox", { name: /email/i });
    await userEvent.type(email, "analyst@example.com");
    await userEvent.click(screen.getByRole("button", { name: /send invitation/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/invitation already pending/i);
    expect(email).toHaveValue("analyst@example.com");
    expect(service.list).toHaveBeenCalledTimes(1);
  });

  it("does not report a failed invitation when only the roster refresh fails", async () => {
    const service = {
      list: vi.fn<() => Promise<SentinelMember[]>>()
        .mockResolvedValueOnce([manager])
        .mockRejectedValueOnce(new Error("network unavailable")),
      invite: vi.fn(async () => undefined),
      activate: vi.fn(async () => undefined),
      setRole: vi.fn(async () => undefined),
      rejectInvitation: vi.fn(async () => undefined),
    };
    renderPage({ memberService: service, role: "manager" });

    await screen.findByRole("table", { name: /workspace members/i });
    await userEvent.type(screen.getByRole("textbox", { name: /email/i }), "new.analyst@example.com");
    await userEvent.click(screen.getByRole("button", { name: /send invitation/i }));

    expect(await screen.findByRole("status")).toHaveTextContent(/invitation sent to new\.analyst@example\.com/i);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows a loading state while members load", () => {
    renderPage({ memberService: memberService({ list: () => new Promise<SentinelMember[]>(() => undefined) }), role: "manager" });

    expect(screen.getByRole("status", { name: /loading workspace members/i })).toBeInTheDocument();
  });

  it("retries member loading after an error", async () => {
    const service = {
      list: vi.fn<() => Promise<SentinelMember[]>>()
        .mockRejectedValueOnce(new Error("network unavailable"))
        .mockResolvedValueOnce([manager]),
      invite: vi.fn(async () => undefined),
      activate: vi.fn(async () => undefined),
      setRole: vi.fn(async () => undefined),
      rejectInvitation: vi.fn(async () => undefined),
    };
    renderPage({ memberService: service, role: "manager" });

    expect(await screen.findByRole("heading", { name: /members unavailable/i })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /retry/i }));
    expect(await screen.findByRole("table", { name: /workspace members/i })).toBeInTheDocument();
  });

  it("reports an unavailable service instead of loading forever", async () => {
    renderPage({ memberService: null, role: "manager" });

    expect(await screen.findByRole("heading", { name: /members unavailable/i })).toBeInTheDocument();
    // No service to call, so the invite form must not render as a dead control.
    expect(screen.queryByRole("button", { name: /send invitation/i })).not.toBeInTheDocument();
  });

  it("withholds invite controls until the directory finishes loading", () => {
    renderPage({ memberService: memberService({ list: () => new Promise<SentinelMember[]>(() => undefined) }), role: "manager" });

    expect(screen.queryByRole("button", { name: /send invitation/i })).not.toBeInTheDocument();
  });

  it("ignores a stale list response after the service changes", async () => {
    let resolveStale!: (members: SentinelMember[]) => void;
    const staleService = {
      list: vi.fn(() => new Promise<SentinelMember[]>((resolve) => { resolveStale = resolve; })),
      invite: vi.fn(async () => undefined),
      activate: vi.fn(async () => undefined),
      setRole: vi.fn(async () => undefined),
      rejectInvitation: vi.fn(async () => undefined),
    };
    const currentService = memberService({ list: async () => [manager] });
    const { rerender } = render(<MemoryRouter><WorkspacePage memberService={staleService} role="manager" /></MemoryRouter>);

    rerender(<MemoryRouter><WorkspacePage memberService={currentService} role="manager" /></MemoryRouter>);
    expect(await screen.findByText("manager@example.com")).toBeInTheDocument();

    resolveStale([{ ...analyst, email: "stale@example.com" }]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByText("stale@example.com")).not.toBeInTheDocument();
  });

  it("falls back to the user id when a member has no invited email", async () => {
    const seeded: SentinelMember = { ...manager, email: null };
    renderPage({ memberService: memberService({ list: async () => [seeded] }), role: "manager" });

    const table = await screen.findByRole("table", { name: /workspace members/i });
    expect(within(table).getByText(seeded.userId)).toBeInTheDocument();
  });
});

describe("member actions", () => {
  const secondManager: SentinelMember = {
    userId: "44444444-4444-4444-8444-444444444444",
    email: "second@example.com",
    role: "manager",
    status: "active",
    joinedAt: "2026-08-02T09:00:00.000Z",
    isSelf: false,
  };

  function rowFor(email: string) {
    return within(screen.getByRole("row", { name: new RegExp(email) }));
  }

  it("hides the actions column from an analyst", async () => {
    renderPage({ memberService: memberService({ list: async () => [analyst] }), role: "analyst" });

    await screen.findByText("analyst@example.com");
    expect(screen.queryByRole("columnheader", { name: /actions/i })).not.toBeInTheDocument();
  });

  it("activates a pending member and announces it", async () => {
    const service = memberService();
    renderPage({ memberService: service, role: "manager" });

    await screen.findByRole("table", { name: /workspace members/i });
    await userEvent.click(rowFor("analyst@example.com").getByRole("button", { name: /activate/i }));

    expect(service.activate).toHaveBeenCalledWith(analyst.userId);
    expect(await screen.findByRole("status")).toHaveTextContent(/activated/i);
  });

  it("promotes an active analyst to manager", async () => {
    const service = memberService({
      list: async () => [{ ...analyst, status: "active" as const }, manager],
    });
    renderPage({ memberService: service, role: "manager" });

    await screen.findByRole("table", { name: /workspace members/i });
    await userEvent.click(rowFor("analyst@example.com").getByRole("button", { name: /make manager/i }));

    expect(service.setRole).toHaveBeenCalledWith(analyst.userId, "manager");
  });

  it("disables demotion when only one active manager remains", async () => {
    renderPage({ memberService: memberService(), role: "manager" });

    await screen.findByRole("table", { name: /workspace members/i });
    expect(rowFor("manager@example.com").getByRole("button", { name: /make analyst/i })).toBeDisabled();
  });

  it("enables demotion of a non-self manager once a second manager exists", async () => {
    const service = memberService({ list: async () => [manager, secondManager] });
    renderPage({ memberService: service, role: "manager" });

    await screen.findByRole("table", { name: /workspace members/i });
    expect(rowFor("second@example.com").getByRole("button", { name: /make analyst/i })).toBeEnabled();
  });

  it("disables a manager's own demotion even when a second active manager exists", async () => {
    const service = memberService({ list: async () => [manager, secondManager] });
    renderPage({ memberService: service, role: "manager" });

    await screen.findByRole("table", { name: /workspace members/i });
    expect(rowFor("manager@example.com").getByRole("button", { name: /make analyst/i })).toBeDisabled();
    expect(rowFor("manager@example.com").getByText(/you cannot change your own role/i)).toBeInTheDocument();
    expect(rowFor("second@example.com").getByRole("button", { name: /make analyst/i })).toBeEnabled();
  });

  it("requires a confirm step before rejecting an invitation", async () => {
    const service = memberService();
    renderPage({ memberService: service, role: "manager" });

    await screen.findByRole("table", { name: /workspace members/i });
    await userEvent.click(rowFor("analyst@example.com").getByRole("button", { name: /^reject$/i }));

    expect(service.rejectInvitation).not.toHaveBeenCalled();
    await userEvent.click(rowFor("analyst@example.com").getByRole("button", { name: /confirm reject/i }));
    expect(service.rejectInvitation).toHaveBeenCalledWith(analyst.userId);
  });

  it("abandons the reject confirmation on cancel", async () => {
    const service = memberService();
    renderPage({ memberService: service, role: "manager" });

    await screen.findByRole("table", { name: /workspace members/i });
    await userEvent.click(rowFor("analyst@example.com").getByRole("button", { name: /^reject$/i }));
    await userEvent.click(rowFor("analyst@example.com").getByRole("button", { name: /cancel/i }));

    expect(rowFor("analyst@example.com").getByRole("button", { name: /^reject$/i })).toBeInTheDocument();
    expect(service.rejectInvitation).not.toHaveBeenCalled();
  });

  it("reports a refused action in the alert region", async () => {
    const service = memberService({
      activate: async () => {
        throw new Error("Member not found. Reload the roster and try again.");
      },
    });
    renderPage({ memberService: service, role: "manager" });

    await screen.findByRole("table", { name: /workspace members/i });
    await userEvent.click(rowFor("analyst@example.com").getByRole("button", { name: /activate/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/reload the roster/i);
  });

  function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((res) => {
      resolve = res;
    });
    return { promise, resolve };
  }

  it("keeps a second row's buttons enabled while another row's action is in flight", async () => {
    const gate = deferred<void>();
    const service = memberService({
      list: async () => [manager, secondManager, analyst],
      activate: () => gate.promise,
    });
    renderPage({ memberService: service, role: "manager" });

    await screen.findByRole("table", { name: /workspace members/i });
    await userEvent.click(rowFor("analyst@example.com").getByRole("button", { name: /activate/i }));

    expect(rowFor("analyst@example.com").getByRole("button", { name: /activate/i })).toBeDisabled();
    expect(rowFor("second@example.com").getByRole("button", { name: /make analyst/i })).toBeEnabled();

    gate.resolve();
    await screen.findByRole("status");
  });

  it("disables the acted-on row's buttons, including Cancel, while a reject is in flight", async () => {
    const gate = deferred<void>();
    const service = memberService({ rejectInvitation: () => gate.promise });
    renderPage({ memberService: service, role: "manager" });

    await screen.findByRole("table", { name: /workspace members/i });
    await userEvent.click(rowFor("analyst@example.com").getByRole("button", { name: /^reject$/i }));
    await userEvent.click(rowFor("analyst@example.com").getByRole("button", { name: /confirm reject/i }));

    expect(rowFor("analyst@example.com").getByRole("button", { name: /confirm reject/i })).toBeDisabled();
    expect(rowFor("analyst@example.com").getByRole("button", { name: /cancel/i })).toBeDisabled();

    gate.resolve();
    await screen.findByRole("status");
  });

  it("refetches the roster after a row action fails, so a stale row can be corrected", async () => {
    const service = memberService({
      activate: async () => {
        throw new Error("Member not found. Reload the roster and try again.");
      },
    });
    renderPage({ memberService: service, role: "manager" });

    await screen.findByRole("table", { name: /workspace members/i });
    expect(service.list).toHaveBeenCalledTimes(1);

    await userEvent.click(rowFor("analyst@example.com").getByRole("button", { name: /activate/i }));
    await screen.findByRole("alert");

    expect(service.list).toHaveBeenCalledTimes(2);
  });

  it("disables Send invitation while a row action is in flight", async () => {
    const gate = deferred<void>();
    const service = memberService({ activate: () => gate.promise });
    renderPage({ memberService: service, role: "manager" });

    await screen.findByRole("table", { name: /workspace members/i });
    await userEvent.click(rowFor("analyst@example.com").getByRole("button", { name: /activate/i }));

    expect(screen.getByRole("button", { name: /send invitation/i })).toBeDisabled();

    gate.resolve();
    await screen.findByRole("status");
  });

  it("disables row action buttons, including the reject confirm, while an invite is in flight", async () => {
    const gate = deferred<void>();
    const service = memberService({ invite: () => gate.promise });
    renderPage({ memberService: service, role: "manager" });

    await screen.findByRole("table", { name: /workspace members/i });
    await userEvent.type(screen.getByRole("textbox", { name: /email/i }), "new.analyst@example.com");
    await userEvent.click(screen.getByRole("button", { name: /send invitation/i }));

    expect(rowFor("analyst@example.com").getByRole("button", { name: /activate/i })).toBeDisabled();
    expect(rowFor("analyst@example.com").getByRole("button", { name: /^reject$/i })).toBeDisabled();
    expect(service.rejectInvitation).not.toHaveBeenCalled();

    gate.resolve();
    await screen.findByRole("status");
  });
});
