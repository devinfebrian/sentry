import type { ReactNode } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { ErrorState } from "../components/ui/ErrorState";
import { LoadingState } from "../components/ui/LoadingState";
import { MEMBERSHIP_PENDING_ERROR, useAuth } from "./AuthProvider";

export function ProtectedRoute({ children }: { children: ReactNode }) {
  const { loading, session, role, workspaceId, configurationError, membershipError, membershipStatus, signOut } = useAuth();
  const location = useLocation();

  if (loading) return <LoadingState label="Checking your session" />;

  if (configurationError) {
    return (
      <ErrorState
        title="Authentication unavailable"
        description={configurationError}
      />
    );
  }

  if (session && membershipError) {
    return (
      <ErrorState
        title="Workspace access unavailable"
        description={membershipError}
        action={<button className="button button-secondary" type="button" onClick={() => void signOut()}>Sign out</button>}
      />
    );
  }

  if (session && membershipStatus === "pending") {
    return (
      <ErrorState
        title="Workspace access pending"
        description={MEMBERSHIP_PENDING_ERROR}
        action={<button className="button button-secondary" type="button" onClick={() => void signOut()}>Sign out</button>}
      />
    );
  }

  if (session && membershipStatus !== "active") {
    return (
      <ErrorState
        title="Workspace access denied"
        description="No active workspace membership was found for this account. Ask a workspace manager for access."
        action={<button className="button button-secondary" type="button" onClick={() => void signOut()}>Sign out</button>}
      />
    );
  }

  if (!session) {
    return (
      <Navigate
        to="/sign-in"
        replace
        state={{ from: { pathname: location.pathname, search: location.search, hash: location.hash } }}
      />
    );
  }

  if (!role || !workspaceId) {
    return (
      <ErrorState
        title="Workspace access denied"
        description="Active workspace membership could not be confirmed for this account."
        action={<button className="button button-secondary" type="button" onClick={() => void signOut()}>Sign out</button>}
      />
    );
  }

  return <>{children}</>;
}
