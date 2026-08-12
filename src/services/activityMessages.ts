import type { ActivityEntry } from "../domain/types";
import type { MemberNames } from "./memberNames";
import { resolveOwner } from "./sentinelInvestigations";

/**
 * Turns a recorded event into the sentence a reader sees.
 *
 * `sentinel_activity_events.rationale` exists but nothing has ever written to it, so every
 * line is synthesised from the event type and the metadata the triggers and RPCs record.
 * Pure on purpose: the mapping is the substance of the activity log, and it should be
 * provable without rendering anything.
 */

function text(metadata: Record<string, unknown>, key: string) {
  const value = metadata[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function count(metadata: Record<string, unknown>, key: string) {
  const value = metadata[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function records(total: number) {
  return `${total} ${total === 1 ? "record" : "records"}`;
}

/** The member an event is *about*, as opposed to the actor who caused it. */
function subject(metadata: Record<string, unknown>, names?: MemberNames) {
  const memberId = text(metadata, "member_user_id");
  return memberId ? resolveOwner(memberId, names) : "a member";
}

export function describeActivity(entry: ActivityEntry, names?: MemberNames): string {
  const { metadata } = entry;

  switch (entry.type) {
    case "investigation-created": {
      // The reference is deliberately left out when the entity is known: the feed already
      // renders it as the link beside this sentence, and printing both reads as a stutter.
      const entity = text(metadata, "entity");
      if (entity) return `opened a case for ${entity}`;
      const reference = text(metadata, "reference");
      return reference ? `opened ${reference}` : "opened an investigation";
    }
    case "upload-created": {
      const name = text(metadata, "original_name");
      return name ? `uploaded ${name}` : "uploaded a file";
    }
    case "parse-started":
      return "started parsing the upload";
    case "parse-completed": {
      const rows = count(metadata, "rowCount");
      const warnings = count(metadata, "warningCount") ?? 0;
      if (rows === null) return "finished parsing the upload";
      return warnings > 0
        ? `parsed ${records(rows)}, ${warnings} skipped`
        : `parsed ${records(rows)}`;
    }
    case "parse-failed":
      return "could not parse the upload";
    case "member-invited":
      return `invited ${subject(metadata, names)}`;
    case "member-activated":
      return `activated ${subject(metadata, names)}`;
    case "member-role-changed": {
      const from = text(metadata, "from");
      const to = text(metadata, "to");
      const who = subject(metadata, names);
      return from && to ? `changed ${who} from ${from} to ${to}` : `changed the role of ${who}`;
    }
    case "member-invite-rejected":
      return `rejected the invitation for ${subject(metadata, names)}`;
    case "case-recommended": {
      const recommendation = text(metadata, "recommendation");
      if (recommendation === "approve") return "recommended approving this case";
      if (recommendation === "reject") return "recommended rejecting this case";
      return "recorded a recommendation";
    }
    case "case-approved":
      return "approved this case";
    case "case-rejected":
      return "rejected this case";
    case "case-evidence-requested":
      return "asked for more evidence";
    default:
      // The event_type CHECK constraint can gain a value before this map does. Degrading
      // to the raw type keeps the feed readable instead of blank or thrown.
      return String(entry.type).replaceAll("-", " ");
  }
}

/** Who caused the event. Falls back the same way an unknown case owner does. */
export function describeActor(entry: ActivityEntry, names?: MemberNames): string {
  return entry.actorId ? resolveOwner(entry.actorId, names) : "The system";
}
