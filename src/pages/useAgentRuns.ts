import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentRun, SentinelAgentRunService } from "../domain/types";

export type AgentRunsState =
  | { status: "loading" }
  | { status: "error"; error: unknown }
  | { status: "ready"; runs: AgentRun[] };

export interface UseAgentRunsResult {
  state: AgentRunsState;
  /** Re-reads the runs. Used after a retry so the stage reflects what actually happened. */
  refresh: () => void;
}

type Scope = "investigation" | "workspace";

// Mirrors useUploadStatus deliberately. The two watch the same parse from different angles,
// and a reader whose upload panel is ticking should not have a frozen pipeline beside it.
const FIRST_POLL_MS = 1_500;
const POLL_BACKOFF = 1.5;
const MAX_POLL_MS = 8_000;
/** Past this, stop asking and let the reader decide whether to keep waiting. */
export const POLL_GIVE_UP_MS = 120_000;

/**
 * Whether anything is expected to change without the reader doing something.
 *
 * Only two situations qualify. A run is `running`, so it will settle on its own. Or a case
 * has no runs at all, because the parse has not finished seeding them — landing on the
 * summary straight after an import is exactly that moment, and it used to sit on "Analysis
 * not started" until the page was reloaded.
 *
 * `waiting` is deliberately not included. It is a resting state: the AI agent sits there
 * until somebody asks for it, so polling on it would never stop. Neither is an empty
 * workspace view, where no runs means nothing has been imported rather than a parse in
 * flight.
 */
function isSettling(runs: AgentRun[], scope: Scope) {
  if (runs.some((run) => run.status === "running")) return true;
  return scope === "investigation" && runs.length === 0;
}

/**
 * Agent runs for one investigation, or for the whole workspace when no id is given.
 *
 * An empty result is a ready state, not an error: an investigation with no upload has no
 * runs, and saying "no agent has run yet" is true. A failed read is kept distinct from that
 * — the caller must be able to tell "nothing has run" from "we could not find out".
 */
export function useAgentRuns(
  investigationId: string | undefined,
  service?: SentinelAgentRunService | null,
  options: { scope?: Scope } = {},
): UseAgentRunsResult {
  const [state, setState] = useState<AgentRunsState>({ status: "loading" });
  const [reloadKey, setReloadKey] = useState(0);
  const requestIdRef = useRef(0);
  const scope = options.scope ?? "investigation";

  const refresh = useCallback(() => setReloadKey((current) => current + 1), []);

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

    if (!service || (scope === "investigation" && !investigationId)) {
      setState({ status: "ready", runs: [] });
      return stop;
    }

    setState({ status: "loading" });

    const read = () => service.list(scope === "workspace" ? undefined : investigationId);

    const schedule = (delay: number, elapsed: number) => {
      timer = setTimeout(() => {
        if (cancelled || !isCurrent()) return;
        void read()
          .then((runs) => {
            if (cancelled || !isCurrent()) return;
            setState({ status: "ready", runs });

            const nextElapsed = elapsed + delay;
            if (isSettling(runs, scope) && nextElapsed < POLL_GIVE_UP_MS) {
              schedule(Math.min(delay * POLL_BACKOFF, MAX_POLL_MS), nextElapsed);
            }
          })
          .catch(() => {
            // A poll that fails is not the same as a read that failed. The first read
            // already succeeded, so the runs on screen are real; replacing them with an
            // error because one refresh dropped would lose information the reader has.
          });
      }, delay);
    };

    void read()
      .then((runs) => {
        if (cancelled || !isCurrent()) return;
        setState({ status: "ready", runs });
        if (isSettling(runs, scope)) schedule(FIRST_POLL_MS, 0);
      })
      .catch((error: unknown) => {
        if (cancelled || !isCurrent()) return;
        setState({ status: "error", error });
      });

    return stop;
  }, [investigationId, service, scope, reloadKey]);

  return { state, refresh };
}
