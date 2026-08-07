import type { ReactNode } from "react";

interface ErrorStateProps {
  title: string;
  description: string;
  action?: ReactNode;
}

export function ErrorState({ title, description, action }: ErrorStateProps) {
  return (
    <section className="state-panel state-panel-error" role="alert">
      <span className="state-kicker">Action needed</span>
      <h2>{title}</h2>
      <p>{description}</p>
      {action}
    </section>
  );
}
