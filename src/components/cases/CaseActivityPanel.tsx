import type { SentinelActivityService } from "../../domain/types";
import { useActivityFeed } from "../../pages/useActivityFeed";
import type { MemberNameLookup } from "../../services/memberNames";
import { ActivityFeed } from "../activity/ActivityFeed";
import { LoadingState } from "../ui/LoadingState";

interface CaseActivityPanelProps {
  investigationId: string | undefined;
  activityService?: SentinelActivityService | null;
  memberNames?: MemberNameLookup | null;
}

/**
 * What has happened to this case. The same feed as the workspace log, narrowed to one
 * investigation and without links back to the case you are already on.
 *
 * Failures stay quiet: this sits below the upload panel and the analysis notice, and a
 * missing history is not worth an error banner in the middle of a case.
 */
export function CaseActivityPanel({ investigationId, activityService, memberNames }: CaseActivityPanelProps) {
  const { state } = useActivityFeed({ activity: activityService, memberNames, investigationId });

  if (!investigationId || !activityService) return null;
  if (state.status === "loading") return <LoadingState label="Loading case activity" />;
  if (state.status === "error" || state.entries.length === 0) return null;

  return (
    <section className="state-panel" aria-labelledby="case-activity-title">
      <div className="section-header-lined">
        <div>
          <span className="section-kicker">Audit / this case</span>
          <h3 id="case-activity-title">Case activity</h3>
        </div>
      </div>
      <ActivityFeed entries={state.entries} names={state.names} showCaseLinks={false} />
    </section>
  );
}
