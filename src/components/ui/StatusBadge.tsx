import type { ReactNode } from "react";

type BadgeTone = "neutral" | "action" | "risk" | "confirm" | "warning";

interface StatusBadgeProps {
  status: string;
  label: string;
  tone?: BadgeTone;
  icon?: ReactNode;
}

export function StatusBadge({ status, label, tone = "neutral", icon }: StatusBadgeProps) {
  return (
    <span className={`status-badge status-${tone}`} data-status={status}>
      <span className="status-badge-mark" aria-hidden="true">{icon ?? ""}</span>
      <span>{label}</span>
    </span>
  );
}
