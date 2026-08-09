import { useCallback, useEffect, useRef, useState } from "react";
import type { ActivityEntry, SentinelActivityService, SentinelInvestigationService } from "../domain/types";
import type { MemberNameLookup, MemberNames } from "../services/memberNames";

export type ActivityFeedState =
  | { status: "loading" }
  | { status: "error"; error: unknown }
  | { status: "ready"; entries: ActivityEntry[]; names?: MemberNames; caseReferences: ReadonlyMap<string, string> };

interface UseActivityFeedOptions {
  activity?: SentinelActivityService | null;
  memberNames?: MemberNameLookup | null;
  /** Omitted for a case-scoped feed, where links back to the same case are noise. */
  investigations?: Pick<SentinelInvestigationService, "list"> | null;
  investigationId?: string;
}

/**
 * Loads a feed and the two lookups it needs to read as sentences rather than identifiers.
 *
 * Events carry an investigation UUID but routes are keyed by reference, so linking needs
 * the investigation list. All three loads run concurrently, and the two lookups are best
 * effort — losing a name or a link should not cost you the feed.
 */
export function useActivityFeed({ activity, memberNames, investigations, investigationId }: UseActivityFeedOptions) {
  const [state, setState] = useState<ActivityFeedState>({ status: "loading" });
  const [reloadKey, setReloadKey] = useState(0);
  const requestIdRef = useRef(0);

  useEffect(() => {
    const requestId = ++requestIdRef.current;
    let active = true;
    const isCurrent = () => active && requestIdRef.current === requestId;

    setState({ status: "loading" });
    if (!activity) {
      setState({ status: "error", error: new Error("Workspace activity is unavailable. Sign in again and retry.") });
      return () => {
        active = false;
      };
    }

    void (async () => {
      try {
        const [entries, names, cases] = await Promise.all([
          activity.list(investigationId ? { investigationId } : undefined),
          memberNames ? memberNames().catch(() => undefined) : Promise.resolve(undefined),
          investigations ? investigations.list().catch(() => []) : Promise.resolve([]),
        ]);
        if (!isCurrent()) return;

        const caseReferences = new Map(
          cases
            .filter((item): item is typeof item & { databaseId: string } => Boolean(item.databaseId))
            .map((item) => [item.databaseId, item.id]),
        );
        setState({ status: "ready", entries, names, caseReferences });
      } catch (error) {
        if (isCurrent()) setState({ status: "error", error });
      }
    })();

    return () => {
      active = false;
    };
  }, [activity, memberNames, investigations, investigationId, reloadKey]);

  const reload = useCallback(() => setReloadKey((current) => current + 1), []);

  return { state, reload };
}
