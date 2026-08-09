import { useEffect, useRef, useState } from "react";
import type { EvidenceRecord, Finding, SentinelAnalysisService } from "../domain/types";

export type CaseAnalysisState =
  | { status: "loading" }
  | { status: "error"; error: unknown }
  | { status: "ready"; findings: Finding[]; evidence: EvidenceRecord[] };

/**
 * Findings for one case. A clean import genuinely produces none, so an empty result is a
 * ready state rather than an error — the caller keeps showing "Analysis not started",
 * which stays true until a rule has something to say.
 */
export function useCaseAnalysis(
  investigationId: string | undefined,
  analysis?: SentinelAnalysisService | null,
  /**
   * Bump to re-read after something has written findings — running an agent, for instance.
   * Neither the id nor the service changes in that case, so without this the hook would
   * keep showing the analysis as it stood before the run.
   */
  reloadToken = 0,
) {
  const [state, setState] = useState<CaseAnalysisState>({ status: "loading" });
  const requestIdRef = useRef(0);

  useEffect(() => {
    const requestId = ++requestIdRef.current;
    let active = true;
    const isCurrent = () => active && requestIdRef.current === requestId;

    if (!investigationId || !analysis) {
      setState({ status: "ready", findings: [], evidence: [] });
      return () => {
        active = false;
      };
    }

    setState({ status: "loading" });
    void Promise.resolve()
      .then(() => analysis.list(investigationId))
      .then(({ findings, evidence }) => {
        if (isCurrent()) setState({ status: "ready", findings, evidence });
      })
      .catch((error: unknown) => {
        if (isCurrent()) setState({ status: "error", error });
      });

    return () => {
      active = false;
    };
  }, [investigationId, analysis, reloadToken]);

  return state;
}
