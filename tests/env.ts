import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export type TestRole = "manager" | "analyst";

export const storageStatePath = (role: TestRole) => resolve(projectRoot, `playwright/.auth/${role}.json`);

export const fixturePath = (name: string) => resolve(projectRoot, "tests/fixtures", name);

/**
 * Load .env into process.env for the Playwright process. Vite injects VITE_* into the app
 * on its own, but the test credentials are intentionally unprefixed so they never reach
 * the browser bundle, which means the runner has to read them itself. Values written on
 * Windows carry a trailing \r, so line endings are normalised here.
 */
export function loadTestEnv() {
  let contents: string;
  try {
    contents = readFileSync(resolve(projectRoot, ".env"), "utf8");
  } catch {
    return; // .env is optional; requireCredentials reports precisely what is missing.
  }

  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator < 0) continue;
    const key = trimmed.slice(0, separator).trim();
    // Real environment variables win, so CI can override .env.
    if (!(key in process.env)) process.env[key] = trimmed.slice(separator + 1).trim();
  }
}

const SETUP_HELP = [
  "Authenticated E2E requires a dedicated Sentinel test project.",
  "Add these to .env (they must NOT use the VITE_ prefix, which would bundle them into the browser):",
  "  VITE_SUPABASE_URL, VITE_SUPABASE_PUBLISHABLE_KEY",
  "  SENTINEL_TEST_MANAGER_EMAIL, SENTINEL_TEST_MANAGER_PASSWORD",
  "  SENTINEL_TEST_ANALYST_EMAIL, SENTINEL_TEST_ANALYST_PASSWORD",
  "  SUPABASE_SECRET_KEY (service role, used only to seed/clean up members.spec.ts fixtures)",
  "Both accounts need a confirmed auth user and an active sentinel_members row.",
].join("\n");

/**
 * Fail loudly when credentials are absent. Skipping instead would let the suite report
 * green while silently proving nothing about authenticated behaviour.
 */
export function requireCredentials(role: TestRole) {
  loadTestEnv();
  const prefix = `SENTINEL_TEST_${role.toUpperCase()}`;
  const required = ["VITE_SUPABASE_URL", "VITE_SUPABASE_PUBLISHABLE_KEY", `${prefix}_EMAIL`, `${prefix}_PASSWORD`];
  const missing = required.filter((key) => !process.env[key]?.trim());

  if (missing.length > 0) {
    throw new Error(`Missing ${role} test credentials: ${missing.join(", ")}\n\n${SETUP_HELP}`);
  }

  return {
    email: process.env[`${prefix}_EMAIL`]!.trim(),
    password: process.env[`${prefix}_PASSWORD`]!.trim(),
    supabaseUrl: process.env.VITE_SUPABASE_URL!.trim(),
    publishableKey: process.env.VITE_SUPABASE_PUBLISHABLE_KEY!.trim(),
  };
}

/**
 * Service-role key for tests that must seed or clean up data no user-level session can
 * touch (e.g. creating a pending member without sending a real invitation email). This
 * name is intentionally unprefixed, like the rest of this file's credentials, so it never
 * reaches the browser bundle via Vite's VITE_ prefix convention.
 */
export function requireServiceRoleKey() {
  loadTestEnv();
  const key = process.env.SUPABASE_SECRET_KEY?.trim();
  if (!key) {
    throw new Error(`Missing service-role credential: SUPABASE_SECRET_KEY\n\n${SETUP_HELP}`);
  }
  return key;
}
