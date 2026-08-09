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
  options: { scope?: "investigation" | "workspace" } = {},
): UseAgentRunsResult {
  const [state, setState] = useState<AgentRunsState>({ status: "loading" });
  const [reloadKey, setReloadKey] = useState(0);
  const requestIdRef = useRef(0);
  const scope = options.scope ?? "investigation";

  const refresh = useCallback(() => setReloadKey((current) => current + 1), []);

  useEffect(() => {
    const requestId = ++requestIdRef.current;
    let active = true;
    const isCurrent = () => active && requestIdRef.current === requestId;

    if (!service || (scope === "investigation" && !investigationId)) {
      setState({ status: "ready", runs: [] });
      return () => {
        active = false;
      };
    }

    setState({ status: "loading" });
    void Promise.resolve()
      .then(() => service.list(scope === "workspace" ? undefined : investigationId))
      .then((runs) => {
        if (isCurrent()) setState({ status: "ready", runs });
      })
      .catch((error: unknown) => {
        if (isCurrent()) setState({ status: "error", error });
      });

    return () => {
      active = false;
    };
  }, [investigationId, service, scope, reloadKey]);

  return { state, refresh };
}
