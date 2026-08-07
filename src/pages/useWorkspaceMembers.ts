import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SentinelMember, SentinelMemberService } from "../domain/types";

export type RosterState =
  | { status: "loading" }
  | { status: "error"; error: unknown }
  | { status: "ready"; members: SentinelMember[] };

export interface MutationResult {
  ok: boolean;
  message: string;
}

type RosterService = Pick<SentinelMemberService, "list"> & Partial<SentinelMemberService>;

const UNAVAILABLE_ERROR = "Workspace member directory is unavailable. Sign in again and retry.";
const REFRESH_FAILED_SUFFIX = "The member list could not be refreshed — reload to see it.";

/** Pending members first: approving them is why a manager opens this page. */
function sortMembers(members: SentinelMember[]) {
  return [...members].sort((left, right) => {
    if (left.status !== right.status) return left.status === "pending" ? -1 : 1;
    return left.joinedAt.localeCompare(right.joinedAt);
  });
}

export function useWorkspaceMembers(memberService?: RosterService | null) {
  const [state, setState] = useState<RosterState>({ status: "loading" });
  const [retryKey, setRetryKey] = useState(0);
  const requestIdRef = useRef(0);

  useEffect(() => {
    const requestId = ++requestIdRef.current;
    let active = true;
    const isCurrent = () => active && requestIdRef.current === requestId;

    setState({ status: "loading" });
    if (!memberService) {
      setState({ status: "error", error: new Error(UNAVAILABLE_ERROR) });
      return () => {
        active = false;
      };
    }

    void Promise.resolve()
      .then(() => memberService.list())
      .then((members) => {
        if (isCurrent()) setState({ status: "ready", members: sortMembers(members) });
      })
      .catch((error: unknown) => {
        if (isCurrent()) setState({ status: "error", error });
      });

    return () => {
      active = false;
    };
  }, [memberService, retryKey]);

  const retry = useCallback(() => setRetryKey((current) => current + 1), []);

  /**
   * Runs a mutation then refetches. The refetch only runs after the action itself
   * succeeds: a failed action never touched the roster, so there is nothing new to
   * reload, and the action's own failure message is what the caller needs to hear.
   */
  const mutate = useCallback(async (action: () => Promise<void>, successMessage: string): Promise<MutationResult> => {
    if (!memberService) return { ok: false, message: UNAVAILABLE_ERROR };

    const requestId = requestIdRef.current;
    try {
      await action();
    } catch (caught) {
      return { ok: false, message: caught instanceof Error ? caught.message : "Unable to update member." };
    }

    try {
      const members = await memberService.list();
      if (requestIdRef.current === requestId) setState({ status: "ready", members: sortMembers(members) });
    } catch {
      // The action succeeded; only the refresh failed. Say so rather than reporting
      // the action itself as failed.
      return { ok: true, message: `${successMessage} ${REFRESH_FAILED_SUFFIX}` };
    }

    return { ok: true, message: successMessage };
  }, [memberService]);

  const members = state.status === "ready" ? state.members : [];
  const activeManagerCount = useMemo(
    () => members.filter((member) => member.role === "manager" && member.status === "active").length,
    [members],
  );

  return { state, members, activeManagerCount, retry, mutate };
}
