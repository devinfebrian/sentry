interface LoadingStateProps {
  label?: string;
}

export function LoadingState({ label = "Loading workspace data" }: LoadingStateProps) {
  return (
    <div className="loading-state" role="status" aria-label={label} aria-live="polite">
      <span className="loading-line" aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}
