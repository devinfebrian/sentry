import { Link } from "react-router-dom";
import type { ActivityEntry } from "../../domain/types";
import { formatRelative } from "../../lib/datetime";
import { describeActivity, describeActor } from "../../services/activityMessages";
import type { MemberNames } from "../../services/memberNames";
import { StatusBadge } from "../ui/StatusBadge";

interface ActivityFeedProps {
  entries: ActivityEntry[];
  names?: MemberNames;
  /** Investigation links are noise on a page already scoped to one case. */
  showCaseLinks?: boolean;
  /** Maps investigation ids to their reference, so links read INV-… not a UUID. */
  caseReferences?: ReadonlyMap<string, string>;
}

/** Parse failures are the only events a reader needs to act on. */
function toneFor(type: ActivityEntry["type"]) {
  if (type === "parse-failed" || type === "member-invite-rejected") return "risk" as const;
  if (type === "parse-completed" || type === "member-activated") return "confirm" as const;
  return "action" as const;
}

/**
 * The workspace's audit trail, rendered. Distinct from ActivityLog in this folder, which is
 * a fixture-backed decision history for the Decision step and shares none of these types.
 */
export function ActivityFeed({ entries, names, showCaseLinks = true, caseReferences }: ActivityFeedProps) {
  return (
    <ol className="activity-list">
      {entries.map((entry) => {
        const reference = entry.investigationId ? caseReferences?.get(entry.investigationId) : undefined;
        return (
          <li className="activity-row" key={entry.id}>
            <span className="activity-type">
              <StatusBadge status={entry.type} label={entry.type.replaceAll("-", " ")} tone={toneFor(entry.type)} />
            </span>
            <span className="activity-detail">
              <strong>{describeActor(entry, names)}</strong> {describeActivity(entry, names)}
              {showCaseLinks && reference && (
                <>
                  {" "}
                  <Link className="text-link" to={`/cases/${reference}/summary`}>{reference}</Link>
                </>
              )}
            </span>
            <time dateTime={entry.occurredAt}>{formatRelative(entry.occurredAt)}</time>
          </li>
        );
      })}
    </ol>
  );
}
