import type { ActivityEvent } from "../../domain/types";
import { StatusBadge } from "../ui/StatusBadge";

export function ActivityLog({ events }: { events: ActivityEvent[] }) {
  return <ol className="activity-list">{events.map((event) => <li className="activity-row" key={event.id}><span className="activity-type"><StatusBadge status={event.type} label={event.type.replaceAll("-", " ")} tone={event.type === "approval" ? "confirm" : "action"} /></span><span><strong>{event.actor}</strong> {event.rationale}</span><time>{event.timestamp}</time></li>)}</ol>;
}
