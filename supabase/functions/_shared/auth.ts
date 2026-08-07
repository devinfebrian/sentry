import { HttpError } from "./cors.ts";
import { getBearerToken } from "./auth-policy.ts";
import { resolveSupabaseKey } from "./supabase-key.ts";

export { canInviteMembers, getBearerToken, isActiveMembership, normalizeEmail, parseInvitePayload, parseUploadRequest, PolicyError } from "./auth-policy.ts";
export { resolveSupabaseKey } from "./supabase-key.ts";

export interface AuthenticatedUser {
  id: string;
  email: string | null;
}

export type SupabaseClientLike = Record<string, any>;

interface DenoEnvLike {
  env?: {
    get(name: string): string | undefined;
  };
}

function readEnv(name: string) {
  const deno = (globalThis as typeof globalThis & { Deno?: DenoEnvLike }).Deno;
  return deno?.env?.get(name);
}

function requireEnv(name: string) {
  const value = readEnv(name);
  if (!value) {
    throw new HttpError("Server authentication is unavailable.", 500);
  }
  return value;
}

async function loadSupabase() {
  return import("npm:@supabase/supabase-js@2");
}

export async function createUserClient(token: string): Promise<SupabaseClientLike> {
  const { createClient } = await loadSupabase();
  const key = resolveSupabaseKey("SUPABASE_PUBLISHABLE_KEYS", ["SUPABASE_PUBLISHABLE_KEY", "SUPABASE_ANON_KEY"]);

  return createClient(requireEnv("SUPABASE_URL"), key, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
}

export async function requireUser(request: Request) {
  const token = getBearerToken(request.headers.get("Authorization"));
  if (!token) {
    throw new HttpError("Authentication required.", 401);
  }

  const client = await createUserClient(token);
  const { data, error } = await client.auth.getUser(token);
  if (error || !data?.user?.id) {
    throw new HttpError("Authentication required.", 401);
  }

  const user: AuthenticatedUser = { id: data.user.id, email: data.user.email ?? null };
  return { client, user };
}

export async function createAdminClient(): Promise<SupabaseClientLike> {
  const { createClient } = await loadSupabase();
  const secret = resolveSupabaseKey("SUPABASE_SECRET_KEYS", ["SUPABASE_SERVICE_ROLE_KEY"]);

  return createClient(requireEnv("SUPABASE_URL"), secret, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
