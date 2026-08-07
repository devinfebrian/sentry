import { useEffect, useRef, useState } from "react";
import type { ImportPreview } from "../../services/importParser";
import { previewImport } from "../../workers/importPreview";
import type { ImportFailed, ImportOutcome } from "../../services/importWorkflow";
import { Button } from "../ui/Button";

interface ImportDialogProps {
  open: boolean;
  onClose: () => void;
  onImported: (file: File, preview: ImportPreview) => Promise<ImportOutcome>;
  returnFocusRef?: React.RefObject<HTMLElement | null>;
}

/** The dialog is only ever doing one of these, so they are one value rather than three flags. */
type Phase = "idle" | "reading" | "importing" | "retrying";

/** A file is only useful alongside its preview, so they are selected and cleared together. */
type Selection = { file: File; preview: ImportPreview };

export function ImportDialog({ open, onClose, onImported, returnFocusRef }: ImportDialogProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const closeRef = useRef<() => void>(() => undefined);
  const previewControllerRef = useRef<AbortController | null>(null);
  const previewRequestIdRef = useRef(0);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [error, setError] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [failure, setFailure] = useState<ImportFailed | null>(null);
  const reading = phase === "reading";
  const busy = phase === "importing" || phase === "retrying";

  const cancelPreview = () => {
    previewRequestIdRef.current += 1;
    previewControllerRef.current?.abort();
    previewControllerRef.current = null;
  };

  const close = () => {
    if (busy) return;
    cancelPreview();
    onClose();
    window.requestAnimationFrame(() => returnFocusRef?.current?.focus());
  };
  closeRef.current = close;

  useEffect(() => {
    if (!open) {
      cancelPreview();
      return;
    }
    setSelection(null);
    setError("");
    setFailure(null);
    window.requestAnimationFrame(() => inputRef.current?.focus());
    return cancelPreview;
  }, [open]);

  useEffect(() => {
    if (!open) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeRef.current();
        return;
      }
      if (event.key !== "Tab") return;

      const dialog = dialogRef.current;
      if (!dialog) return;
      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(
        "button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex=\"-1\"])",
      ));
      if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const current = document.activeElement;
      if (event.shiftKey && (current === first || !dialog.contains(current))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (current === last || !dialog.contains(current))) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [open]);

  if (!open) return null;

  const handleFile = async (file: File | undefined) => {
    if (!file) return;
    cancelPreview();
    const requestId = previewRequestIdRef.current;
    const controller = new AbortController();
    previewControllerRef.current = controller;
    setPhase("reading");
    setSelection(null);
    setError("");
    setFailure(null);
    try {
      const preview = await previewImport(file, { signal: controller.signal });
      if (requestId !== previewRequestIdRef.current || controller.signal.aborted) return;
      setSelection({ file, preview });
    } catch (caught) {
      if (requestId !== previewRequestIdRef.current || controller.signal.aborted) return;
      setSelection(null);
      setError(caught instanceof Error ? caught.message : "Unable to read selected financial data.");
    } finally {
      if (requestId === previewRequestIdRef.current) {
        setPhase("idle");
        if (previewControllerRef.current === controller) previewControllerRef.current = null;
      }
    }
  };

  /** Both entry points end the same way, so settling an outcome lives in one place. */
  const settle = (outcome: ImportOutcome) => {
    if (outcome.status === "failed") {
      setFailure(outcome);
      setError(outcome.errorMessage);
      return;
    }
    setFailure(null);
    cancelPreview();
    onClose();
  };

  const handleImport = async () => {
    if (reading || busy) return;

    // The action stays clickable so a click always produces feedback. A disabled primary
    // button silently swallows the event, which reads as "nothing happens".
    if (failure) {
      setError(failure.errorMessage);
      return;
    }
    if (!selection) {
      // Preserve a parser reason if one is already showing; only add guidance when silent.
      setError((current) => current || "Choose a CSV or spreadsheet file before importing.");
      return;
    }

    setPhase("importing");
    setError("");
    try {
      settle(await onImported(selection.file, selection.preview));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to import selected financial data.");
    } finally {
      setPhase("idle");
    }
  };

  const handleRetry = async () => {
    if (!failure || busy) return;
    setPhase("retrying");
    setError("");
    try {
      settle(await failure.retry());
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to retry parser for this upload.");
    } finally {
      setPhase("idle");
    }
  };

  return (
    <div className="import-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
      <section ref={dialogRef} className="import-dialog" role="dialog" aria-modal="true" aria-labelledby="import-dialog-title" tabIndex={-1}>
        <button className="drawer-close" type="button" onClick={close} disabled={busy}>Close</button>
        <span className="section-kicker">New investigation / data intake</span>
        <h2 id="import-dialog-title">Import financial data</h2>
        <p>Select a CSV or spreadsheet. FinAI reads the first worksheet and previews normalized rows before creating a case.</p>
        <label className="import-file-label" htmlFor="financial-data-file">Financial data file</label>
        <input ref={inputRef} id="financial-data-file" type="file" accept=".csv,.xlsx,.xls" disabled={busy} onChange={(event) => void handleFile(event.target.files?.[0])} />
        {reading && <div className="loading-state" role="status" aria-live="polite">Previewing first worksheet</div>}
        {phase === "importing" && <div className="loading-state" role="status" aria-live="polite">Creating investigation and starting parser</div>}
        {phase === "retrying" && <div className="loading-state" role="status" aria-live="polite">Retrying parser for existing upload</div>}
        {error && <div className="import-error" role="alert">{error}</div>}
         {failure && <p role="status">Upload {failure.uploadId} retained. Retry without creating another investigation.</p>}
        {selection && <div className="import-preview"><div className="import-preview-head"><span className="section-kicker">Preview / {selection.preview.rows.length} records</span><span className="numeric">First 5 rows</span></div><div className="import-preview-table">{selection.preview.rows.slice(0, 5).map((row) => <div className="import-preview-row" key={`${row.entity}-${row.sourceRow}`}><span>{row.entity}</span><span className="numeric">Row {row.sourceRow}</span><span>{Object.entries(row.values).filter(([key]) => key !== "entity").slice(0, 1).map(([, value]) => String(value))}</span></div>)}</div>{selection.preview.warnings.length > 0 && <div className="import-warning" role="status" aria-live="polite"><p>{selection.preview.warnings.length} row warning(s) will be skipped.</p><ul>{selection.preview.warnings.map((warning, index) => <li key={`${warning}-${index}`}>{warning}</li>)}</ul></div>}</div>}
        {!selection && !reading && <p className="import-hint" id="import-data-hint">Choose a CSV, XLS, or XLSX file to enable import.</p>}
          <div className="import-dialog-actions"><Button variant="quiet" type="button" onClick={close} disabled={busy}>Cancel</Button>{failure && <Button variant="secondary" type="button" disabled={busy} onClick={() => void handleRetry()}>{failure.retryLabel ?? "Retry parsing"}</Button>}<Button variant="primary" type="button" aria-describedby={!selection && !reading ? "import-data-hint" : undefined} disabled={reading || busy} onClick={() => void handleImport()}>Import data</Button></div>
      </section>
    </div>
  );
}
