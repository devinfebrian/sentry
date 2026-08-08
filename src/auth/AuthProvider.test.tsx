import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider, useAuth } from "./AuthProvider";

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
const sessionTemplate = {
  access_token: "access-token",
  refresh_token: "refresh-token",
  expires_in: 3600,
  expires_at: 1_900_000_000,
  token_type: "bearer",
};
const session = {
  ...sessionTemplate,
  user: sessionUser,
} as never;

/**
 * The provider reads ordered rows rather than maybeSingle(), so a user holding more than
 * one workspace membership resolves instead of erroring. `rows` overrides the default
 * single-row result for the multi-membership cases.
 */
function membershipQuery(
  role: "manager" | "analyst" = "analyst",
  status: "active" | "pending" = "active",
  rows?: { role: string; workspace_id: string; status: string; created_at: string }[],
) {
  const query = {
    select: vi.fn(),
    eq: vi.fn(),
    order: vi.fn().mockResolvedValue({
      data: rows ?? [{ role, workspace_id: "workspace-1", status, created_at: "2026-08-01T00:00:00.000Z" }],
      error: null,
    }),
  };
  query.select.mockReturnValue(query);
  query.eq.mockReturnValue(query);
  return query;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

function AuthProbe() {
  const auth = useAuth();
  const membershipError = (auth as typeof auth & { membershipError?: string | null }).membershipError;
  const membershipStatus = (auth as typeof auth & { membershipStatus?: string }).membershipStatus;
  const [signInError, setSignInError] = useState<string | null>(null);

  return (
    <div>
      <output data-testid="loading">{String(auth.loading)}</output>
      <output data-testid="configuration-error">{String(auth.configurationError)}</output>
      <output data-testid="user">{auth.user?.id ?? "none"}</output>
      <output data-testid="access-token">{auth.session?.access_token ?? "none"}</output>
      <output data-testid="role">{auth.role ?? "none"}</output>
      <output data-testid="workspace">{auth.workspaceId ?? "none"}</output>
      <output data-testid="membership-error">{membershipError ?? "none"}</output>
      <output data-testid="membership-status">{membershipStatus ?? "unknown"}</output>
      <output data-testid="sign-in-error">{signInError ?? "none"}</output>
      <button
        type="button"
        onClick={async () => setSignInError((await auth.signIn("analyst@example.com", "password")) ?? null)}
      >
        Sign in
      </button>
      <button type="button" onClick={() => void auth.signOut()}>
        Sign out
      </button>
    </div>
  );
}

function renderProvider() {
  return render(
    <AuthProvider>
      <AuthProbe />
    </AuthProvider>,
  );
}

describe("AuthProvider", () => {
  beforeEach(() => {
    authMocks.configured = true;
    authMocks.getSession.mockResolvedValue({ data: { session: null }, error: null });
    authMocks.onAuthStateChange.mockImplementation(() => ({ data: { subscription: { unsubscribe: authMocks.unsubscribe } } }));
    authMocks.signInWithPassword.mockResolvedValue({ data: { session: null, user: null }, error: null });
    authMocks.signOut.mockResolvedValue({ error: null });
    authMocks.from.mockReturnValue(membershipQuery());
    vi.clearAllMocks();
  });

  it("keeps auth loading while initial session is unresolved", async () => {
    let resolveSession!: (value: unknown) => void;
    authMocks.getSession.mockReturnValue(new Promise((resolve) => { resolveSession = resolve; }));

    renderProvider();

    expect(screen.getByTestId("loading")).toHaveTextContent("true");

    await act(async () => resolveSession({ data: { session: null }, error: null }));
    await waitFor(() => expect(screen.getByTestId("loading")).toHaveTextContent("false"));
  });

  it("reports missing Supabase configuration without making auth calls", () => {
    authMocks.configured = false;

    renderProvider();

    expect(screen.getByTestId("configuration-error")).toHaveTextContent(/not configured/i);
    expect(screen.getByTestId("loading")).toHaveTextContent("false");
    expect(authMocks.getSession).not.toHaveBeenCalled();
    expect(authMocks.onAuthStateChange).not.toHaveBeenCalled();
    expect(authMocks.from).not.toHaveBeenCalled();
  });

  it("maps invalid credentials to user-facing sign-in error", async () => {
    authMocks.signInWithPassword.mockResolvedValue({
      data: { session: null, user: null },
      error: { message: "Invalid login credentials" },
    });
    renderProvider();

    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByTestId("sign-in-error")).toHaveTextContent(/could not sign you in/i);
    expect(screen.getByTestId("sign-in-error")).not.toHaveTextContent(/invalid login credentials/i);
  });

  it("loads active manager and analyst memberships", async () => {
    for (const role of ["manager", "analyst"] as const) {
      cleanup();
      authMocks.getSession.mockResolvedValue({ data: { session }, error: null });
      authMocks.from.mockReturnValue(membershipQuery(role));

      renderProvider();

      await waitFor(() => expect(screen.getByTestId("role")).toHaveTextContent(role));
      expect(screen.getByTestId("workspace")).toHaveTextContent("workspace-1");
      expect(authMocks.from).toHaveBeenCalledWith("sentinel_members");

      authMocks.getSession.mockResolvedValue({ data: { session: null }, error: null });
    }
  });

  it("distinguishes pending membership from missing membership", async () => {
    authMocks.getSession.mockResolvedValue({ data: { session }, error: null });
    const pendingQuery = membershipQuery("analyst", "pending");
    authMocks.from.mockReturnValue(pendingQuery);
    renderProvider();

    await waitFor(() => expect(screen.getByTestId("membership-status")).toHaveTextContent("pending"));
    expect(screen.getByTestId("role")).toHaveTextContent("none");
    expect(pendingQuery.eq).toHaveBeenCalledWith("user_id", "user-1");
    expect(pendingQuery.eq).not.toHaveBeenCalledWith("status", "active");

    cleanup();
    const missingQuery = membershipQuery();
    missingQuery.order.mockResolvedValue({ data: [], error: null });
    authMocks.from.mockReturnValue(missingQuery);
    renderProvider();

    await waitFor(() => expect(screen.getByTestId("membership-status")).toHaveTextContent("missing"));
    expect(screen.getByTestId("role")).toHaveTextContent("none");
  });

  it("sets session after successful sign-in and clears it on sign-out", async () => {
    authMocks.signInWithPassword.mockResolvedValue({ data: { session, user: sessionUser }, error: null });
    authMocks.from.mockReturnValue(membershipQuery("manager"));
    renderProvider();

    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() => expect(screen.getByTestId("user")).toHaveTextContent("user-1"));
    expect(screen.getByTestId("role")).toHaveTextContent("manager");

    await userEvent.click(screen.getByRole("button", { name: "Sign out" }));
    await waitFor(() => expect(screen.getByTestId("user")).toHaveTextContent("none"));
    expect(screen.getByTestId("role")).toHaveTextContent("none");
    expect(authMocks.signOut).toHaveBeenCalledOnce();
  });

  it("defers membership synchronization outside the Supabase auth callback", async () => {
    let authChange!: (event: string, nextSession: unknown) => void;
    authMocks.onAuthStateChange.mockImplementation((callback: typeof authChange) => {
      authChange = callback;
      return { data: { subscription: { unsubscribe: authMocks.unsubscribe } } };
    });
    renderProvider();

    await act(async () => authChange("SIGNED_IN", session));

    expect(authMocks.from).not.toHaveBeenCalled();
    await waitFor(() => expect(authMocks.from).toHaveBeenCalledWith("sentinel_members"));
    await waitFor(() => expect(screen.getByTestId("user")).toHaveTextContent("user-1"));
  });

  it("unsubscribes auth callbacks and ignores events after unmount", async () => {
    let authChange!: (event: string, nextSession: unknown) => void;
    authMocks.onAuthStateChange.mockImplementation((callback: typeof authChange) => {
      authChange = callback;
      return { data: { subscription: { unsubscribe: authMocks.unsubscribe } } };
    });
    const rendered = renderProvider();

    rendered.unmount();
    expect(authMocks.unsubscribe).toHaveBeenCalledOnce();

    authChange("SIGNED_IN", session);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(authMocks.from).not.toHaveBeenCalled();
  });

  it("surfaces membership query rejection without clearing authenticated session", async () => {
    const query = membershipQuery();
    query.order.mockRejectedValue(new Error("membership request failed"));
    authMocks.getSession.mockResolvedValue({ data: { session }, error: null });
    authMocks.from.mockReturnValue(query);

    renderProvider();

    await waitFor(() => expect(screen.getByTestId("membership-error")).toHaveTextContent(/membership could not be loaded/i));
    expect(screen.getByTestId("user")).toHaveTextContent("user-1");
    expect(screen.getByTestId("role")).toHaveTextContent("none");
  });

  it("keeps latest session and loading state when an older membership response resolves late", async () => {
    const firstMembership = deferred<{ data: { role: "analyst"; workspace_id: string; status: string }[]; error: null }>();
    const secondMembership = deferred<{ data: { role: "manager"; workspace_id: string; status: string }[]; error: null }>();
    const firstSession = { ...sessionTemplate, user: { ...sessionUser, id: "user-1" } } as never;
    const secondSession = { ...sessionTemplate, user: { ...sessionUser, id: "user-2" }, access_token: "access-token-2" } as never;
    let authChange!: (event: string, nextSession: unknown) => void;
    authMocks.onAuthStateChange.mockImplementation((callback: typeof authChange) => {
      authChange = callback;
      return { data: { subscription: { unsubscribe: authMocks.unsubscribe } } };
    });
    const firstQuery = membershipQuery();
    firstQuery.order.mockReturnValue(firstMembership.promise);
    const secondQuery = membershipQuery("manager");
    secondQuery.order.mockReturnValue(secondMembership.promise);
    authMocks.from
      .mockImplementationOnce(() => firstQuery)
      .mockImplementationOnce(() => secondQuery);
    renderProvider();

    await act(async () => authChange("SIGNED_IN", firstSession));
    await waitFor(() => expect(authMocks.from).toHaveBeenCalledTimes(1));
    await act(async () => authChange("SIGNED_IN", secondSession));
    await waitFor(() => expect(authMocks.from).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByTestId("loading")).toHaveTextContent("true"));

    await act(async () => firstMembership.resolve({ data: [{ role: "analyst", workspace_id: "workspace-1", status: "active" }], error: null }));
    expect(screen.getByTestId("loading")).toHaveTextContent("true");

    await act(async () => secondMembership.resolve({ data: [{ role: "manager", workspace_id: "workspace-2", status: "active" }], error: null }));
    await waitFor(() => expect(screen.getByTestId("role")).toHaveTextContent("manager"));
    expect(screen.getByTestId("workspace")).toHaveTextContent("workspace-2");
    expect(screen.getByTestId("loading")).toHaveTextContent("false");
  });

  it("keeps the workspace mounted when only the access token rotates", async () => {
    // Supabase auto-refreshes the access token roughly hourly. ProtectedRoute unmounts
    // the entire workspace whenever loading flips true, so a rotation must not be
    // mistaken for a new session: no reset, no re-query, nothing torn down.
    let authChange!: (event: string, nextSession: unknown) => void;
    authMocks.onAuthStateChange.mockImplementation((callback: typeof authChange) => {
      authChange = callback;
      return { data: { subscription: { unsubscribe: authMocks.unsubscribe } } };
    });
    authMocks.getSession.mockResolvedValue({ data: { session }, error: null });
    authMocks.from.mockReturnValue(membershipQuery("manager"));
    renderProvider();

    await waitFor(() => expect(screen.getByTestId("role")).toHaveTextContent("manager"));
    const queriesBeforeRotation = authMocks.from.mock.calls.length;

    const rotated = { ...sessionTemplate, user: sessionUser, access_token: "access-token-rotated" } as never;
    await act(async () => {
      authChange("TOKEN_REFRESHED", rotated);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(screen.getByTestId("loading")).toHaveTextContent("false");
    expect(screen.getByTestId("role")).toHaveTextContent("manager");
    expect(screen.getByTestId("workspace")).toHaveTextContent("workspace-1");
    expect(authMocks.from).toHaveBeenCalledTimes(queriesBeforeRotation);
    // The rotated token still has to reach consumers, or the context holds a stale one.
    expect(screen.getByTestId("access-token")).toHaveTextContent("access-token-rotated");
  });

  it("resolves to the active membership when the user belongs to two workspaces", async () => {
    // A manager of another workspace can invite someone who is already active here, so a
    // second row is reachable. maybeSingle() used to error on it and lock the user out of
    // every workspace while blaming their connection.
    authMocks.getSession.mockResolvedValue({ data: { session }, error: null });
    authMocks.from.mockReturnValue(membershipQuery("analyst", "active", [
      { role: "analyst", workspace_id: "workspace-pending", status: "pending", created_at: "2026-07-01T00:00:00.000Z" },
      { role: "manager", workspace_id: "workspace-active", status: "active", created_at: "2026-08-01T00:00:00.000Z" },
    ]));
    renderProvider();

    await waitFor(() => expect(screen.getByTestId("membership-status")).toHaveTextContent("active"));
    expect(screen.getByTestId("role")).toHaveTextContent("manager");
    expect(screen.getByTestId("workspace")).toHaveTextContent("workspace-active");
    expect(screen.getByTestId("membership-error")).toHaveTextContent("none");
  });

  it("falls back to the oldest membership when none is active", async () => {
    authMocks.getSession.mockResolvedValue({ data: { session }, error: null });
    authMocks.from.mockReturnValue(membershipQuery("analyst", "pending", [
      { role: "analyst", workspace_id: "workspace-oldest", status: "pending", created_at: "2026-07-01T00:00:00.000Z" },
      { role: "analyst", workspace_id: "workspace-newer", status: "pending", created_at: "2026-08-01T00:00:00.000Z" },
    ]));
    renderProvider();

    await waitFor(() => expect(screen.getByTestId("membership-status")).toHaveTextContent("pending"));
    expect(screen.getByTestId("membership-error")).toHaveTextContent("none");
  });

  it("synchronizes sign-in membership once when auth event also reports the session", async () => {
    let authChange!: (event: string, nextSession: unknown) => void;
    authMocks.onAuthStateChange.mockImplementation((callback: typeof authChange) => {
      authChange = callback;
      return { data: { subscription: { unsubscribe: authMocks.unsubscribe } } };
    });
    authMocks.signInWithPassword.mockImplementation(async () => {
      authChange("SIGNED_IN", session);
      return { data: { session, user: sessionUser }, error: null };
    });
    authMocks.from.mockReturnValue(membershipQuery("manager"));
    renderProvider();

    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() => expect(screen.getByTestId("role")).toHaveTextContent("manager"));
    expect(authMocks.from).toHaveBeenCalledTimes(1);
  });
});
