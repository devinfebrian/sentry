import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "../auth/AuthProvider";
import { SignInPage } from "./SignInPage";

const authMocks = vi.hoisted(() => ({
  configured: true,
  getSession: vi.fn(),
  onAuthStateChange: vi.fn(),
  signInWithPassword: vi.fn(),
  signOut: vi.fn(),
  from: vi.fn(),
  unsubscribe: vi.fn(),
}));

vi.mock("../lib/supabase", () => ({
  get isSupabaseConfigured() {
    return authMocks.configured;
  },
  supabase: {
    auth: {
      getSession: authMocks.getSession,
      onAuthStateChange: authMocks.onAuthStateChange,
      signInWithPassword: authMocks.signInWithPassword,
      signOut: authMocks.signOut,
    },
    from: authMocks.from,
  },
}));

const sessionUser = { id: "user-1", email: "analyst@example.com" };
const session = {
  access_token: "access-token",
  refresh_token: "refresh-token",
  expires_in: 3600,
  expires_at: 1_900_000_000,
  token_type: "bearer",
  user: sessionUser,
} as never;

function membershipQuery(status: "active" | "pending" = "active") {
  const query = {
    select: vi.fn(),
    eq: vi.fn(),
    maybeSingle: vi.fn().mockResolvedValue({
      data: { role: "analyst", workspace_id: "workspace-1", status },
      error: null,
    }),
  };
  query.select.mockReturnValue(query);
  query.eq.mockReturnValue(query);
  return query;
}

function renderSignIn(initialEntries: Array<string | { pathname: string; state?: unknown }> = ["/sign-in"]) {
  return render(
    <MemoryRouter initialEntries={initialEntries}>
      <AuthProvider>
        <Routes>
          <Route path="/sign-in" element={<SignInPage />} />
          <Route path="/" element={<p>Protected home</p>} />
          <Route path="/cases" element={<p>Protected workspace</p>} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );
}

describe("SignInPage", () => {
  beforeEach(() => {
    authMocks.configured = true;
    authMocks.getSession.mockResolvedValue({ data: { session: null }, error: null });
    authMocks.onAuthStateChange.mockImplementation(() => ({ data: { subscription: { unsubscribe: authMocks.unsubscribe } } }));
    authMocks.signInWithPassword.mockResolvedValue({ data: { session: null, user: null }, error: null });
    authMocks.signOut.mockResolvedValue({ error: null });
    authMocks.from.mockReturnValue(membershipQuery());
    vi.clearAllMocks();
  });

  it("renders labeled credentials and invite-only copy without sign-up control", async () => {
    renderSignIn();

    expect(await screen.findByRole("heading", { name: /sign in/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/email/i)).toBeVisible();
    expect(screen.getByLabelText(/password/i)).toBeVisible();
    expect(screen.getByText(/invite-only/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /sign up|create account/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /sign up|create account/i })).not.toBeInTheDocument();
  });

  it("shows invalid credentials as a polite live error", async () => {
    authMocks.signInWithPassword.mockResolvedValue({
      data: { session: null, user: null },
      error: { message: "Invalid login credentials" },
    });
    renderSignIn();

    await userEvent.type(await screen.findByLabelText(/email/i), "analyst@example.com");
    await userEvent.type(await screen.findByLabelText(/password/i), "wrong-password");
    await userEvent.click(screen.getByRole("button", { name: /sign in/i }));

    const error = await screen.findByText(/could not sign you in/i);
    expect(error).toHaveAttribute("aria-live", "polite");
    expect(error).not.toHaveTextContent(/invalid login credentials/i);
  });

  it("redirects to intended workspace after successful sign-in", async () => {
    authMocks.signInWithPassword.mockResolvedValue({ data: { session, user: sessionUser }, error: null });
    authMocks.from.mockReturnValue(membershipQuery());
    renderSignIn([{ pathname: "/sign-in", state: { from: { pathname: "/cases" } } }]);

    await userEvent.type(await screen.findByLabelText(/email/i), "analyst@example.com");
    await userEvent.type(await screen.findByLabelText(/password/i), "correct-password");
    await userEvent.click(screen.getByRole("button", { name: /sign in/i }));

    expect(await screen.findByText("Protected workspace")).toBeInTheDocument();
    await waitFor(() => expect(authMocks.signInWithPassword).toHaveBeenCalledWith({
      email: "analyst@example.com",
      password: "correct-password",
    }));
  });

  it("shows configuration error and makes no auth calls when Supabase is absent", async () => {
    authMocks.configured = false;
    renderSignIn();

    expect(await screen.findByText(/supabase is not configured/i)).toBeInTheDocument();
    expect(authMocks.getSession).not.toHaveBeenCalled();
    expect(authMocks.onAuthStateChange).not.toHaveBeenCalled();
    expect(authMocks.signInWithPassword).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: /sign up|create account/i })).not.toBeInTheDocument();
  });

  it("announces membership query failures as a polite live error", async () => {
    const query = membershipQuery();
    query.maybeSingle.mockRejectedValue(new Error("membership request failed"));
    authMocks.getSession.mockResolvedValue({ data: { session }, error: null });
    authMocks.from.mockReturnValue(query);

    renderSignIn();

    const error = await screen.findByText(/membership could not be loaded/i);
    expect(error).toHaveAttribute("aria-live", "polite");
  });

  it("redirects authenticated active sessions to intended route without showing sign-in", async () => {
    authMocks.getSession.mockResolvedValue({ data: { session }, error: null });
    authMocks.from.mockReturnValue(membershipQuery());

    renderSignIn([{ pathname: "/sign-in", state: { from: { pathname: "/cases" } } }]);

    expect(await screen.findByText("Protected workspace")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /sign in/i })).not.toBeInTheDocument();
  });

  it("redirects authenticated users without membership to protected access state", async () => {
    authMocks.getSession.mockResolvedValue({ data: { session }, error: null });
    const query = membershipQuery("pending");
    authMocks.from.mockReturnValue(query);

    renderSignIn([{ pathname: "/sign-in", state: { from: { pathname: "/cases" } } }]);

    expect(await screen.findByText("Protected workspace")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /sign in/i })).not.toBeInTheDocument();
  });
});
