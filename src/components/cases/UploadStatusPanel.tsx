import { useState } from "react";
import type { SentinelUploadService } from "../../domain/types";
import { useUploadStatus } from "../../pages/useUploadStatus";
import { Button } from "../ui/Button";
import { ErrorState } from "../ui/ErrorState";
import { LoadingState } from "../ui/LoadingState";
import { StatusBadge } from "../ui/StatusBadge";

interface UploadStatusPanelProps {
  investigationId: string | undefined;
  uploadService?: Pick<SentinelUploadService, "getLatestForInvestigation" | "getStatus" | "listRows" | "retryParsing"> | null;
}

function parsedLabel(count: number) {
  return `${count} ${count === 1 ? "record" : "records"} imported`;
}

/**
 * Answers the one question the case page could not previously answer: did my upload work?
 * Sits above the analysis panel, because source data being real does not make agent output
 * real — the two states are reported separately and honestly.
 */
export function UploadStatusPanel({ investigationId, uploadService }: UploadStatusPanelProps) {
  const { state, reload } = useUploadStatus(investigationId, uploadService);
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState("");

  if (state.status === "none") return null;

  if (state.status === "loading") return <LoadingState label="Loading source data" />;

  if (state.status === "error") {
    return (
      <ErrorState
        title="Source data unavailable"
        description={state.error instanceof Error ? state.error.message : "Try again to reload this upload."}
        action={<Button variant="secondary" onClick={reload}>Retry</Button>}
      />
    );
  }

  const { upload, rows, timedOut } = state;

  const handleRetry = async () => {
    if (retrying || !uploadService) return;
    setRetrying(true);
    setRetryError("");
    try {
      await uploadService.retryParsing(upload.id);
      reload();
    } catch (caught) {
      setRetryError(caught instanceof Error ? caught.message : "Unable to retry parsing this upload.");
    } finally {
      setRetrying(false);
    }
  };

  if (upload.status === "failed") {
    return (
      <ErrorState
        title="Source data could not be parsed"
        description={upload.errorMessage ?? "The parser could not read this upload."}
        action={
          <div className="state-panel-actions">
            <Button variant="secondary" type="button" disabled={retrying} onClick={() => void handleRetry()}>
              {retrying ? "Retrying" : "Retry parsing"}
            </Button>
            {retryError && <p className="sign-out-warning" role="alert">{retryError}</p>}
          </div>
        }
      />
    );
  }

  if (upload.status !== "parsed") {
    return (
      <section className="state-panel" aria-labelledby="upload-status-title">
        <span className="state-kicker">Source data</span>
        <h3 id="upload-status-title">{timedOut ? "Still parsing" : "Parsing source data"}</h3>
        {timedOut ? (
          <>
            <p>This upload has been parsing for a while. It may still finish on its own.</p>
            <div className="state-panel-actions">
              <Button variant="secondary" type="button" onClick={reload}>Check again</Button>
            </div>
          </>
        ) : (
          <LoadingState label={upload.status === "processing" ? "Parsing source data" : "Waiting for the parser"} />
        )}
      </section>
    );
  }

  return (
    <section className="state-panel" aria-labelledby="upload-status-title">
      <div className="section-header-lined">
        <div>
          <span className="section-kicker">Source data</span>
          <h3 id="upload-status-title">{parsedLabel(upload.rowCount)}</h3>
        </div>
        <StatusBadge status="parsed" label="Parsed" tone="confirm" />
      </div>

      {upload.warnings.length > 0 && (
        <div className="import-warning" role="status">
          <p>{upload.warnings.length} row warning(s) were skipped.</p>
          <ul>{upload.warnings.map((warning, index) => <li key={`${warning}-${index}`}>{warning}</li>)}</ul>
        </div>
      )}

      {rows.length > 0 && (
        <div className="import-preview">
          <div className="import-preview-head">
            <span className="section-kicker">Preview</span>
            <span className="numeric">First {rows.length} of {upload.rowCount}</span>
          </div>
          <div className="import-preview-table">
            {rows.map((row) => (
              <div className="import-preview-row" key={row.sourceRow}>
                <span>{row.entity}</span>
                <span className="numeric">Row {row.sourceRow}</span>
                <span>
                  {Object.entries(row.values)
                    .filter(([key]) => key !== "entity")
                    .slice(0, 1)
                    .map(([, value]) => String(value))}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
