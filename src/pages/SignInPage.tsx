import { useState, type FormEvent } from "react";
import { Navigate, useLocation, useNavigate } from "react-router-dom";
import { ErrorState } from "../components/ui/ErrorState";
import { LoadingState } from "../components/ui/LoadingState";
import { MEMBERSHIP_PENDING_ERROR, useAuth } from "../auth/AuthProvider";

interface SignInLocationState {
  from?: {
    pathname?: string;
    search?: string;
    hash?: string;
  };
}

export function SignInPage() {
  const { loading, configurationError, membershipError, membershipStatus, session, role, workspaceId, signIn } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [authError, setAuthError] = useState<string | null>(null);
  const from = (location.state as SignInLocationState | null)?.from;
  const destinationPath = from?.pathname && from.pathname !== "/sign-in" ? from.pathname : "/";
  const destination = `${destinationPath}${from?.search ?? ""}${from?.hash ?? ""}`;
  const accessError = membershipError ?? (session && (!role || !workspaceId) ? MEMBERSHIP_PENDING_ERROR : null);
  const visibleError = authError ?? accessError;

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setAuthError(null);

    const error = await signIn(email, password);
    if (error) {
      setAuthError(error);
      return;
    }

    navigate(destination, { replace: true });
  };

  if (loading) return <LoadingState label="Checking your session" />;
  if (session && membershipStatus !== "error") return <Navigate to={destination} replace />;

  return (
    <div style={{ display: "grid", minHeight: "100vh", placeItems: "center", padding: 24 }}>
      <main className="state-panel" style={{ width: "min(100%, 440px)" }}>
        <span className="state-kicker">Sentinel access</span>
        <h1>Sign in</h1>
        <p>Invite-only workspace for controlled financial investigations.</p>

        {configurationError && (
          <ErrorState
            title="Authentication unavailable"
            description={configurationError}
          />
        )}

        <form onSubmit={handleSubmit}>
          <label htmlFor="sign-in-email">Email</label>
          <input
            id="sign-in-email"
            name="email"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            style={{ width: "100%", minHeight: "var(--control-height)" }}
          />
          <label htmlFor="sign-in-password">Password</label>
          <input
            id="sign-in-password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            style={{ width: "100%", minHeight: "var(--control-height)" }}
          />
          <button className="button button-primary" type="submit" disabled={Boolean(configurationError)}>
            Sign in
          </button>
          {visibleError && (
            <p role="alert" aria-live="polite">
              {visibleError}
            </p>
          )}
        </form>
      </main>
    </div>
  );
}
