import { StatusBadge } from "../ui/StatusBadge";

/**
 * Shown when the findings read itself failed.
 *
 * Distinct from AnalysisNotStartedState on purpose: "not started" is a claim about the
 * investigation, and making it after a failed query states something we do not know.
 * An import that produced findings would look identical to a clean one, which is how a
 * broken query survived a full slice of work unnoticed.
 */
export function AnalysisUnavailableState() {
  return (
    <section className="state-panel" aria-labelledby="analysis-unavailable-title">
      <span className="state-kicker">Analysis status</span>
      <h3 id="analysis-unavailable-title">Analysis could not be loaded</h3>
      <p>
        This investigation may or may not have findings — the request to read them failed.
        Reload the page to try again.
      </p>
      <div role="status" aria-live="polite">
        <StatusBadge status="not-assessed" label="Risk: Unknown" tone="neutral" />
        <span>Stage: Analysis unavailable</span>
      </div>
    </section>
  );
}
