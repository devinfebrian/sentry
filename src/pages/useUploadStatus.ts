import { useCallback, useEffect, useRef, useState } from "react";
import type { ImportRow, SentinelUpload, SentinelUploadService } from "../domain/types";

export type UploadStatusState =
  | { status: "loading" }
  | { status: "error"; error: unknown }
  | { status: "none" }
  | { status: "ready"; upload: SentinelUpload; rows: ImportRow[]; timedOut: boolean };

type UploadStatusService = Pick<SentinelUploadService, "getLatestForInvestigation" | "getStatus" | "listRows">;

/** Enough to show the shape of the data without pulling an import into the browser. */
export const PREVIEW_ROW_LIMIT = 10;

const FIRST_POLL_MS = 1_500;
const POLL_BACKOFF = 1.5;
const MAX_POLL_MS = 8_000;
/** Past this, stop asking and let the reader decide whether to keep waiting. */
export const POLL_GIVE_UP_MS = 120_000;

/** Statuses the parser still owns, and which therefore still change on their own. */
const PENDING_STATUSES = new Set<SentinelUpload["status"]>(["created", "uploading", "uploaded", "processing"]);

function isPending(upload: SentinelUpload) {
  return PENDING_STATUSES.has(upload.status);
}

/**
 * Watches the upload behind an investigation until the parser finishes with it.
 *
 * Polls rather than subscribing: a parse of a typical file settles in seconds, and polling
 * needs no Realtime publication or reconnection handling. The interval backs off so a slow
 * parse does not turn into a request flood, and gives up rather than polling forever.
 */
export function useUploadStatus(investigationId: string | undefined, uploads?: UploadStatusService | null) {
  const [state, setState] = useState<UploadStatusState>({ status: "loading" });
  const [reloadKey, setReloadKey] = useState(0);
  const requestIdRef = useRef(0);

  useEffect(() => {
    const requestId = ++requestIdRef.current;
    const isCurrent = () => requestIdRef.current === requestId;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancelled = false;

    const stop = () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    };

    if (!investigationId || !uploads) {
      setState(investigationId ? { status: "none" } : { status: "loading" });
      return stop;
    }

    setState({ status: "loading" });

    // Rows are read once, on arrival at `parsed`. Re-reading them on every poll would
    // repeat a bounded-but-real query for data that cannot change afterwards.
    const settle = async (upload: SentinelUpload) => {
      const rows = upload.status === "parsed" ? await uploads.listRows(upload.id, PREVIEW_ROW_LIMIT) : [];
      if (!cancelled && isCurrent()) setState({ status: "ready", upload, rows, timedOut: false });
    };

    const poll = (uploadId: string, delay: number, elapsed: number) => {
      timer = setTimeout(() => {
        void (async () => {
          try {
            const next = await uploads.getStatus(uploadId);
            if (cancelled || !isCurrent()) return;

            if (!isPending(next)) {
              await settle(next);
              return;
            }

            setState({ status: "ready", upload: next, rows: [], timedOut: false });
            const nextElapsed = elapsed + delay;
            if (nextElapsed >= POLL_GIVE_UP_MS) {
              setState({ status: "ready", upload: next, rows: [], timedOut: true });
              return;
            }
            poll(uploadId, Math.min(delay * POLL_BACKOFF, MAX_POLL_MS), nextElapsed);
          } catch (error) {
            if (!cancelled && isCurrent()) setState({ status: "error", error });
          }
        })();
      }, delay);
    };

    void (async () => {
      try {
        const upload = await uploads.getLatestForInvestigation(investigationId);
        if (cancelled || !isCurrent()) return;

        if (!upload) {
          setState({ status: "none" });
          return;
        }
        if (isPending(upload)) {
          setState({ status: "ready", upload, rows: [], timedOut: false });
          poll(upload.id, FIRST_POLL_MS, 0);
          return;
        }
        await settle(upload);
      } catch (error) {
        if (!cancelled && isCurrent()) setState({ status: "error", error });
      }
    })();

    return stop;
  }, [investigationId, uploads, reloadKey]);

  const reload = useCallback(() => setReloadKey((current) => current + 1), []);

  return { state, reload };
}
