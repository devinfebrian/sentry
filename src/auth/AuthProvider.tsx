import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import type { Session, User } from "@supabase/supabase-js";
import { isSupabaseConfigured, supabase } from "../lib/supabase";
import type { SentinelMemberRole } from "../domain/types";

type MemberRole = SentinelMemberRole;
export type MembershipStatus = "unknown" | "active" | "pending" | "missing" | "error";
type SessionSyncResult = "active" | "pending" | "missing" | "error" | "signed-out" | "stale";

interface SessionSyncState {
  generation: number;
  pendingKey: string | null | undefined;
  pending: Promise<SessionSyncResult> | null;
  completedKey: string | null | undefined;
  completedResult: SessionSyncResult | null;
}

export interface AuthContextValue {
  session: Session | null;
  user: User | null;
  role: MemberRole | null;
  workspaceId: string | null;
  loading: boolean;
  configurationError: string | null;
  membershipError: string | null;
  membershipStatus: MembershipStatus;
  signIn: (email: string, password: string) => Promise<string | null>;
  signOut: () => Promise<void>;
}

export const CONFIGURATION_ERROR = "Supabase is not configured. Add the public project URL and publishable key.";
export const MEMBERSHIP_QUERY_ERROR = "Workspace membership could not be loaded. Check your connection and try again.";
export const MEMBERSHIP_PENDING_ERROR = "Workspace access is pending. Ask a workspace manager for an active membership.";
export const MEMBERSHIP_MISSING_ERROR = "Workspace access denied. No active membership was found for this account.";

const INVALID_CREDENTIALS_ERROR = "Could not sign you in. Check your email and password.";
const GENERIC_SIGN_IN_ERROR = "Could not sign you in. Try again.";

const defaultAuthContext: AuthContextValue = {
  session: null,
  user: null,
  role: null,
  workspaceId: null,
  loading: false,
  configurationError: null,
  membershipError: null,
  membershipStatus: "unknown",
  signIn: async () => GENERIC_SIGN_IN_ERROR,
  signOut: async () => undefined,
};

export const AuthContext = createContext<AuthContextValue>(defaultAuthContext);

function mapSignInError(error: unknown) {
  const message = error instanceof Error ? error.message : typeof error === "object" && error !== null && "message" in error
    ? String(error.message)
    : "";

  return /invalid login credentials|invalid password|user not found/i.test(message)
    ? INVALID_CREDENTIALS_ERROR
    : GENERIC_SIGN_IN_ERROR;
}

function sessionKey(nextSession: Session | null) {
  return nextSession ? `${nextSession.user.id}:${nextSession.access_token}` : null;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const client = supabase;
  const mountedRef = useRef(false);
  const syncState = useRef<SessionSyncState>({
    generation: 0,
    pendingKey: undefined,
    pending: null,
    completedKey: undefined,
    completedResult: null,
  });
  const [session, setSession] = useState<Session | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [role, setRole] = useState<MemberRole | null>(null);
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [configurationError, setConfigurationError] = useState<string | null>(null);
  const [membershipError, setMembershipError] = useState<string | null>(null);
  const [membershipStatus, setMembershipStatus] = useState<MembershipStatus>("unknown");

  const synchronizeSession = (nextSession: Session | null, force = false): Promise<SessionSyncResult> => {
    const key = sessionKey(nextSession);
    const state = syncState.current;

    if (state.pending && state.pendingKey === key) return state.pending;
    if (!force && state.completedKey === key && state.completedResult) return Promise.resolve(state.completedResult);
    if (!mountedRef.current) return Promise.resolve("stale");

    const generation = ++state.generation;
    state.completedKey = undefined;
    state.completedResult = null;
    setLoading(true);
    setSession(nextSession);
    setUser(nextSession?.user ?? null);
    setRole(null);
    setWorkspaceId(null);
    setMembershipError(null);
    setMembershipStatus("unknown");

    if (!nextSession) {
      state.completedKey = key;
      state.completedResult = "signed-out";
      setLoading(false);
      return Promise.resolve("signed-out");
    }

    if (!client) return Promise.resolve("error");

    const promise = (async () => {
      try {
        const { data, error } = await client
          .from("sentinel_members")
          .select("role, workspace_id, status")
          .eq("user_id", nextSession.user.id)
          .maybeSingle();

        if (!mountedRef.current || generation !== state.generation) return "stale";
        if (error) {
          setRole(null);
          setWorkspaceId(null);
          setMembershipError(MEMBERSHIP_QUERY_ERROR);
          setMembershipStatus("error");
          return "error";
        }
        if (!data) {
          setMembershipStatus("missing");
          return "missing";
        }
        if (data.status === "pending") {
          setMembershipStatus("pending");
          return "pending";
        }

        setRole(data.role);
        setWorkspaceId(data.workspace_id);
        setMembershipStatus("active");
        return "active";
      } catch {
        if (!mountedRef.current || generation !== state.generation) return "stale";
        setRole(null);
        setWorkspaceId(null);
        setMembershipError(MEMBERSHIP_QUERY_ERROR);
        setMembershipStatus("error");
        return "error";
      }
    })();

    state.pendingKey = key;
    state.pending = promise;
    void promise.then((result) => {
      if (state.pending === promise) {
        state.pendingKey = undefined;
        state.pending = null;
      }
      if (mountedRef.current && generation === state.generation) {
        state.completedKey = key;
        state.completedResult = result;
        setLoading(false);
      }
    });

    return promise;
  };

  useEffect(() => {
    if (!isSupabaseConfigured || !client) {
      setLoading(false);
      setConfigurationError(CONFIGURATION_ERROR);
      return;
    }

    mountedRef.current = true;
    let sessionEventReceived = false;
    const scheduleSessionSync = (nextSession: Session | null) => {
      window.setTimeout(() => {
        if (mountedRef.current) void synchronizeSession(nextSession);
      }, 0);
    };
    const { data: authListener } = client.auth.onAuthStateChange((_event, nextSession) => {
      sessionEventReceived = true;
      scheduleSessionSync(nextSession);
    });

    void client.auth.getSession()
      .then(({ data, error }) => {
        if (sessionEventReceived) return;
        void synchronizeSession(error ? null : data.session);
      })
      .catch(() => {
        if (!sessionEventReceived) void synchronizeSession(null);
      });

    return () => {
      mountedRef.current = false;
      syncState.current.generation += 1;
      authListener.subscription.unsubscribe();
    };
  }, []);

  const signIn = async (email: string, password: string) => {
    if (!isSupabaseConfigured || !client) return CONFIGURATION_ERROR;

    const { data, error } = await client.auth.signInWithPassword({ email, password });
    if (error || !data.session) return mapSignInError(error);

    const syncResult = await synchronizeSession(data.session, true);
    if (syncResult === "active") return null;
    if (syncResult === "pending") return MEMBERSHIP_PENDING_ERROR;
    if (syncResult === "missing") return MEMBERSHIP_MISSING_ERROR;
    if (syncResult === "error") return MEMBERSHIP_QUERY_ERROR;
    return GENERIC_SIGN_IN_ERROR;
  };

  const signOut = async () => {
    if (!isSupabaseConfigured || !client) return;

    const { error } = await client.auth.signOut();
    if (error) return;
    await synchronizeSession(null);
  };

  return (
    <AuthContext.Provider value={{ session, user, role, workspaceId, loading, configurationError, membershipError, membershipStatus, signIn, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
