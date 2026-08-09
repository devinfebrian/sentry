import { ActivityFeed } from "../components/activity/ActivityFeed";
import { Button } from "../components/ui/Button";
import { EmptyState } from "../components/ui/EmptyState";
import { ErrorState } from "../components/ui/ErrorState";
import { LoadingState } from "../components/ui/LoadingState";
import type { SentinelActivityService, SentinelInvestigationService } from "../domain/types";
import type { MemberNameLookup } from "../services/memberNames";
import { useActivityFeed } from "./useActivityFeed";

interface ActivityPageProps {
  activityService?: SentinelActivityService | null;
  investigationService?: Pick<SentinelInvestigationService, "list"> | null;
  memberNames?: MemberNameLookup | null;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Try again to reload workspace activity.";
}

export function ActivityPage({ activityService, investigationService, memberNames }: ActivityPageProps) {
  const { state, reload } = useActivityFeed({
    activity: activityService,
    memberNames,
    investigations: investigationService,
  });

  return (
    <div className="activity-page">
      <header className="page-heading page-heading-simple">
        <div>
          <span className="eyebrow">Operations / activity</span>
          <h1>Activity log</h1>
          <p>Every recorded action in this workspace, newest first.</p>
        </div>
      </header>

      {state.status === "loading" && <LoadingState label="Loading workspace activity" />}

      {state.status === "error" && (
        <ErrorState
          title="Activity unavailable"
          description={errorMessage(state.error)}
          action={<Button variant="secondary" onClick={reload}>Retry</Button>}
        />
      )}

      {state.status === "ready" && state.entries.length === 0 && (
        <EmptyState
          title="No activity yet"
          description="Importing financial data or inviting a member will start the record."
        />
      )}

      {state.status === "ready" && state.entries.length > 0 && (
        <section className="workspace-members" aria-labelledby="activity-log-title">
          <div className="section-header-lined">
            <div>
              <span className="section-kicker">Audit / workspace</span>
              <h2 id="activity-log-title">Recent activity</h2>
            </div>
          </div>
          <ActivityFeed entries={state.entries} names={state.names} caseReferences={state.caseReferences} />
        </section>
      )}
    </div>
  );
}
