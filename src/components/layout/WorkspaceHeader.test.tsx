import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { Session, User } from "@supabase/supabase-js";
import { AuthContext, type AuthContextValue } from "../../auth/AuthProvider";
import { WorkspaceHeader } from "./WorkspaceHeader";

function renderHeader(email: string | undefined, onOpenNavigation = vi.fn()) {
  const auth = {
    session: { user: { id: "u1", email } } as Session,
    user: { id: "u1", email } as User,
    role: "analyst",
    workspaceId: "w1",
    loading: false,
    configurationError: null,
    membershipError: null,
    membershipStatus: "active",
    signIn: async () => null,
    signOut: async () => null,
    refreshMembership: async () => undefined,
  } as AuthContextValue;

  render(
    <AuthContext.Provider value={auth}>
      <WorkspaceHeader onOpenNavigation={onOpenNavigation} />
    </AuthContext.Provider>,
  );
  return { onOpenNavigation };
}

describe("WorkspaceHeader", () => {
  it("names the signed-in user rather than a hardcoded person", () => {
    renderHeader("everydayplaylist25@gmail.com");

    expect(screen.getByText("everydayplaylist25")).toBeInTheDocument();
    expect(screen.queryByText(/maya chen/i)).not.toBeInTheDocument();
  });

  it("derives initials from a separated local part", () => {
    renderHeader("ada.lovelace@example.com");

    expect(screen.getByText("AL")).toBeInTheDocument();
  });

  it("falls back without a session email instead of rendering blank", () => {
    renderHeader(undefined);

    expect(screen.getByText("Signed in")).toBeInTheDocument();
    expect(screen.getByText("--")).toBeInTheDocument();
  });

  it("announces who is signed in for assistive technology", () => {
    renderHeader("manager@sentinel.com");

    expect(screen.getByLabelText("Signed in as manager@sentinel.com")).toBeInTheDocument();
  });

  it("offers no controls that do nothing", () => {
    // Search even advertised a "/" shortcut that was never wired.
    renderHeader("manager@sentinel.com");

    expect(screen.queryByRole("button", { name: /search/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /help/i })).not.toBeInTheDocument();
    // The identity is a label, not a button — there is no profile screen to open.
    expect(screen.queryByRole("button", { name: /signed in as/i })).not.toBeInTheDocument();
  });

  it("still opens the mobile navigation", async () => {
    const { onOpenNavigation } = renderHeader("manager@sentinel.com");

    await userEvent.click(screen.getByRole("button", { name: "Open navigation" }));

    expect(onOpenNavigation).toHaveBeenCalledOnce();
  });
});
