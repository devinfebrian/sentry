import { useMemo, useState } from "react";
import type {
  ActivityEntry, CaseStatus, CaseSummary, DecisionAction, SentinelActivityService, SentinelDecisionService,
} from "../../domain/types";
import { useActivityFeed } from "../../pages/useActivityFeed";
import type { MemberNameLookup } from "../../services/memberNames";
import { MAX_RATIONALE_LENGTH } from "../../services/sentinelDecisions";
import { ActivityFeed } from "../activity/ActivityFeed";
import { Button } from "../ui/Button";
import { ErrorState } from "../ui/ErrorState";
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

// Exported so every place that renders a case's status — this panel and the workspace page
// heading above it — reads the same label and tone. Two badges deriving their own mapping
// from the same CaseStatus is exactly how they drift: the page heading used to run
// caseItem.status.replace("-", " ") (a no-op; no CaseStatus value has a hyphen) with its own
// ad hoc tone rule, so "review" showed as "review" there and "Pending approval" here, and
// "closed" painted tone "action" up top and "risk" down here.
export const statusLabels: Record<CaseStatus, string> = {
  open: "Open", review: "Pending approval", approved: "Approved", closed: "Closed",
};

export const statusTones: Record<CaseStatus, "neutral" | "action" | "confirm" | "risk"> = {
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
  const { state, reload } = useActivityFeed({
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
  // history below renders, and `decisions` comes back empty on two paths that are not the
  // same claim. One is a loaded feed capped at DEFAULT_ACTIVITY_LIMIT (50, newest first, see
  // sentinelActivity.ts) where the recommending event has aged off the read. The other, more
  // likely in ordinary operation, is the feed simply not having loaded yet, or having failed
  // to load — `activityService` absent, the `list()` call still in flight, or it having
  // failed — which `useActivityFeed` reports as its own `loading` or `error` state, not as an
  // empty feed. Both leave `lastRecommender` null, but only the first is safe ground for
  // "nobody has recommended, so Approve/Reject are fine": the second means this panel cannot
  // tell yet, and `available` below treats an unresolved feed on a review case as its own
  // case rather than folding it into "recommendedThis === false", so it does not hand out a
  // control that would always fail. `feedUnavailable` covers `loading` as well as `error`
  // (rather than only `error`) so this withholding starts the moment the panel mounts, not
  // only once a load has had the chance to fail — closing the window where Approve/Reject
  // rendered for the fraction of a second before the feed resolved. Either way this stays a
  // misleading-button risk, not a data-integrity one: guard 9 in sentinel_record_decision
  // reads the recommender from the table directly, not from this feed, so a write that
  // slipped past this panel's caution is still refused, and the database's own refusal is
  // what the alert shows.
  const feedUnavailable = state.status !== "ready";
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
      // Guard 8 lets request-evidence proceed from 'review' unconditionally; guard 9, the
      // separation-of-duties check, only gates approve/reject. So an unreadable recommender
      // costs this panel exactly the two actions that depend on knowing who it was.
      if (feedUnavailable) return ["request-evidence"];
      return recommendedThis ? ["request-evidence"] : ["approve", "reject", "request-evidence"];
    }
    return ["request-evidence"];
  })();

  const withheldReason = (() => {
    if (available.length > 0) return null;
    // Checked first and independently of status: with no decisionService, `available` is
    // empty for every status, including "open" — where the next branch would otherwise tell
    // the assigned analyst on their own open case that only the assigned analyst or a
    // manager can recommend on it, which is false. The actual reason is that recording is
    // unavailable, not that this viewer lacks standing.
    if (!decisionService) return "Decision recording is unavailable. Sign in again and retry.";
    if (caseItem.status === "open") return "Only the assigned analyst or a manager can recommend on this case.";
    if (!isManager) return "A manager decides this case once a recommendation is recorded.";
    return null;
  })();

  const selfRecommendedNote = caseItem.status === "review" && isManager && recommendedThis
    ? "You recommended this case. Another manager must decide it."
    : null;

  const recommenderUnknownNote = caseItem.status === "review" && isManager && feedUnavailable
    ? "The recommendation history could not be loaded, so this panel cannot confirm who recommended this case. Approve and reject are withheld until it loads."
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
      reload();
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
      {recommenderUnknownNote && <p className="decision-recommendation">{recommenderUnknownNote}</p>}
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
        {state.status === "error" && (
          <ErrorState
            title="Decision history could not be loaded"
            description="This case may have earlier decisions — the request to read them failed. Reload the page to try again."
          />
        )}
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
