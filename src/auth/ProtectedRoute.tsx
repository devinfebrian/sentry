import type { ReactNode } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { Button } from "../components/ui/Button";
import { ErrorState } from "../components/ui/ErrorState";
import { LoadingState } from "../components/ui/LoadingState";
import { MEMBERSHIP_PENDING_ERROR, useAuth } from "./AuthProvider";
import { SignOutButton } from "./SignOutButton";

export function ProtectedRoute({ children }: { children: ReactNode }) {
  const { loading, session, role, workspaceId, configurationError, membershipError, membershipStatus, refreshMembership } = useAuth();
  const location = useLocation();

  /**
   * Every blocked state here is one a manager can clear from their own tab, and nothing
   * about this user's session changes when they do. Checking again is the only way out
   * short of a reload.
   */
  const recheckThenSignOut = (
    <div className="state-panel-actions">
      <Button variant="primary" type="button" onClick={() => void refreshMembership()}>Check again</Button>
      <SignOutButton />
    </div>
  );

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
        action={recheckThenSignOut}
      />
    );
  }

  if (session && membershipStatus === "pending") {
    return (
      <ErrorState
        title="Workspace access pending"
        description={MEMBERSHIP_PENDING_ERROR}
        action={recheckThenSignOut}
      />
    );
  }

  if (session && membershipStatus !== "active") {
    return (
      <ErrorState
        title="Workspace access denied"
        description="No active workspace membership was found for this account. Ask a workspace manager for access."
        action={recheckThenSignOut}
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
        action={recheckThenSignOut}
      />
    );
  }

  return <>{children}</>;
}
