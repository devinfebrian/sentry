import { useMemo, useState } from "react";
import type {
  ActivityEntry, CaseStatus, CaseSummary, DecisionAction, SentinelActivityService, SentinelDecisionService,
} from "../../domain/types";
import { useActivityFeed } from "../../pages/useActivityFeed";
import type { MemberNameLookup } from "../../services/memberNames";
import { MAX_RATIONALE_LENGTH } from "../../services/sentinelDecisions";
import { ActivityFeed } from "../activity/ActivityFeed";
import { Button } from "../ui/Button";
import { LoadingState } from "../ui/LoadingState";
import { StatusBadge } from "../ui/StatusBadge";

interface DecisionPanelProps {
  caseItem: CaseSummary;
  viewerId: string | null;
  role: "analyst" | "manager" | null;
  decisionService?: Pick<SentinelDecisionService, "record"> | null;
  activityService?: SentinelActivityService | null;
  memberNames?: MemberNameLookup | null;
  onDecided: () => void;
}

const DECISION_TYPES = new Set<ActivityEntry["type"]>([
  "case-recommended", "case-approved", "case-rejected", "case-evidence-requested",
]);

const statusLabels: Record<CaseStatus, string> = {
  open: "Open", review: "Pending approval", approved: "Approved", closed: "Closed",
};

const statusTones: Record<CaseStatus, "neutral" | "action" | "confirm" | "risk"> = {
  open: "neutral", review: "action", approved: "confirm", closed: "risk",
};

const actionLabels: Record<DecisionAction, string> = {
  "recommend-approve": "Recommend approve",
  "recommend-reject": "Recommend reject",
  approve: "Approve",
  reject: "Reject",
  "request-evidence": "Request more evidence",
};

/**
 * What this viewer may do about this case, and what everyone has already done.
 *
 * Every rule here is also a guard in sentinel_record_decision. This decides which buttons
 * exist; the database decides which writes land. Where the two disagree the database wins,
 * and the refusal it wrote is what the alert shows — which is why nothing here is optimistic.
 */
export function DecisionPanel({
  caseItem, viewerId, role, decisionService, activityService, memberNames, onDecided,
}: DecisionPanelProps) {
  const { state } = useActivityFeed({
    activity: activityService, memberNames, investigationId: caseItem.databaseId,
  });
  const [pending, setPending] = useState<DecisionAction | null>(null);
  const [rationale, setRationale] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const decisions = useMemo(
    () => (state.status === "ready" ? state.entries.filter((entry) => DECISION_TYPES.has(entry.type)) : []),
    [state],
  );

  // Newest-first: `decisions` is already ordered that way because the feed itself is. This
  // is the panel's own read of "who recommended," derived from the same activity feed the
  // history below renders — and that feed is capped at DEFAULT_ACTIVITY_LIMIT (50, newest
  // first, see sentinelActivity.ts). On a case with more than 50 events since its
  // recommendation, that event falls off the read and this comes back null, so the panel
  // would offer Approve to the person who recommended. That is a misleading button, not a
  // hole: guard 9 in sentinel_record_decision reads the recommender from the table directly,
  // not from this feed, so the write still fails and the database's refusal is what the
  // reviewer sees. Fixing the display would mean an unbounded read on every render of a
  // panel that already has the correct backstop.
  const lastRecommender = decisions.find((entry) => entry.type === "case-recommended")?.actorId ?? null;
  const isOwner = Boolean(viewerId) && caseItem.ownerId === viewerId;
  const isManager = role === "manager";
  const recommendedThis = Boolean(viewerId) && lastRecommender === viewerId;

  const available: DecisionAction[] = (() => {
    if (!decisionService) return [];
    if (caseItem.status === "open") {
      return isOwner || isManager ? ["recommend-approve", "recommend-reject"] : [];
    }
    if (!isManager) return [];
    if (caseItem.status === "review") {
      return recommendedThis ? ["request-evidence"] : ["approve", "reject", "request-evidence"];
    }
    return ["request-evidence"];
  })();

  const withheldReason = (() => {
    if (available.length > 0) return null;
    if (caseItem.status === "open") return "Only the assigned analyst or a manager can recommend on this case.";
    if (!isManager) return "A manager decides this case once a recommendation is recorded.";
    return null;
  })();

  const selfRecommendedNote = caseItem.status === "review" && isManager && recommendedThis
    ? "You recommended this case. Another manager must decide it."
    : null;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!pending || !decisionService) return;
    const trimmed = rationale.trim();
    if (!trimmed) {
      setError("Record why you are making this decision.");
      return;
    }

    setBusy(true);
    setError(null);
    try {
      await decisionService.record(caseItem.databaseId, pending, trimmed);
      setPending(null);
      setRationale("");
      onDecided();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to record decision.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="decision-record" aria-labelledby="decision-panel-title">
      <div className="decision-record-heading">
        <div>
          <span className="section-kicker">Decision / accountable review</span>
          <h2 id="decision-panel-title">Decision record</h2>
        </div>
        <StatusBadge
          status={caseItem.status}
          label={statusLabels[caseItem.status]}
          tone={statusTones[caseItem.status]}
        />
      </div>

      {selfRecommendedNote && <p className="decision-recommendation">{selfRecommendedNote}</p>}
      {withheldReason && <p className="decision-recommendation">{withheldReason}</p>}

      {available.length > 0 && (
        <div className="decision-actions">
          {available.map((action) => (
            <Button
              key={action}
              variant={action === "approve" || action === "recommend-approve" ? "primary"
                : action === "reject" || action === "recommend-reject" ? "destructive" : "secondary"}
              onClick={() => { setPending(action); setError(null); }}
            >
              {actionLabels[action]}
            </Button>
          ))}
        </div>
      )}

      {pending && (
        <form className="decision-form" onSubmit={submit}>
          <label htmlFor="decision-rationale">Rationale</label>
          <textarea
            id="decision-rationale"
            value={rationale}
            maxLength={MAX_RATIONALE_LENGTH}
            onChange={(event) => setRationale(event.target.value)}
            placeholder="Record why this decision is the right one on the evidence."
          />
          <div>
            <Button variant="primary" type="submit" disabled={busy}>Record decision</Button>
            <Button variant="quiet" type="button" onClick={() => { setPending(null); setError(null); }}>Cancel</Button>
          </div>
        </form>
      )}

      {error && <div role="alert">{error}</div>}

      <div className="decision-history">
        <div className="section-header-lined">
          <div>
            <span className="section-kicker">Audit trail</span>
            <h3>Revision history</h3>
          </div>
          <span className="section-meta">Immutable events</span>
        </div>
        {state.status === "loading" && <LoadingState label="Loading decision history" />}
        {state.status === "ready" && decisions.length === 0 && <p>No decision has been recorded yet.</p>}
        {decisions.length > 0 && (
          <ActivityFeed
            entries={decisions}
            names={state.status === "ready" ? state.names : undefined}
            showCaseLinks={false}
          />
        )}
      </div>
    </section>
  );
}
