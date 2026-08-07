import type { ReactNode } from "react";

interface EmptyStateProps {
  title: string;
  description: string;
  action?: ReactNode;
}

export function EmptyState({ title, description, action }: EmptyStateProps) {
  return (
    <section className="state-panel" aria-label="Empty state">
      <span className="state-kicker">Nothing here yet</span>
      <h2>{title}</h2>
      <p>{description}</p>
      {action}
    </section>
  );
}
