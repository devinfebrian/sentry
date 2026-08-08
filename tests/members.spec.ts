import { expect, test, type Page } from "@playwright/test";
import { requireCredentials, requireServiceRoleKey, storageStatePath } from "./env";

const { supabaseUrl, publishableKey } = requireCredentials("manager");

// Membership mutations touch state every other spec depends on, so this file
// never runs in parallel with itself.
test.describe.configure({ mode: "serial" });

async function accessToken(page: Page) {
  const token = await page.evaluate(() => {
    const key = Object.keys(window.localStorage).find((k) => k.startsWith("sb-") && k.includes("auth-token"));
    if (!key) return null;
    try {
      const parsed = JSON.parse(window.localStorage.getItem(key) ?? "null");
      return parsed?.access_token ?? parsed?.currentSession?.access_token ?? null;
    } catch {
      return null;
    }
  });
  expect(token, "signed-in session token").toBeTruthy();
  return token as string;
}

async function rest(token: string, path: string, init: RequestInit = {}) {
  const response = await fetch(`${supabaseUrl}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: publishableKey,
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

async function callRpc(token: string, name: string, args: Record<string, string>) {
  return rest(token, `rpc/${name}`, { method: "POST", body: JSON.stringify(args) });
}

async function openWorkspace(page: Page) {
  await page.goto("/workspace");
  await page.getByRole("heading", { name: "Team and settings" }).waitFor();
  return accessToken(page);
}

async function workspaceIdFor(token: string) {
  const membership = await rest(token, "sentinel_members?select=workspace_id&limit=1");
  return membership.body[0].workspace_id as string;
}

/** Decode the `sub` claim so seeding can attribute the reservation to the signed-in manager. */
function subjectOf(token: string) {
  const payload = token.split(".")[1] ?? "";
  const decoded = Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
  return JSON.parse(decoded).sub as string;
}

/**
 * Service-role requests. Only used to seed/tear down pending members directly, bypassing
 * the invite-member Edge Function entirely (see seedPendingMember below for why).
 */
async function adminAuth(path: string, init: RequestInit = {}) {
  const secretKey = requireServiceRoleKey();
  const response = await fetch(`${supabaseUrl}/auth/v1/${path}`, {
    ...init,
    headers: {
      apikey: secretKey,
      Authorization: `Bearer ${secretKey}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

async function adminRest(path: string, init: RequestInit = {}) {
  const secretKey = requireServiceRoleKey();
  const response = await fetch(`${supabaseUrl}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: secretKey,
      Authorization: `Bearer ${secretKey}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

type PendingMemberSeed = {
  email: string;
  userId: string;
  reservationId: string;
};

// Supabase Auth's address validator rejects @example.com outright (400
// email_address_invalid), so the invite path can never seed a pending member with it.
// @sentinel.test is tried first as the obviously-fake-but-accepted domain; if the Admin
// API also rejects it, @sentinel.com is the fallback because the seeded manager account
// already lives at that domain, so it is known-accepted.
const CANDIDATE_DOMAINS = ["sentinel.test", "sentinel.com"];

/**
 * Seed a pending member without sending any real invitation email. The brief's original
 * approach (inviting a `pending-*@example.com` address through the UI) can never work:
 * Supabase Auth's admin invite endpoint rejects the address before anything else runs.
 * Instead this creates the auth user directly via the Admin API with `email_confirm: true`
 * (so no email is sent), then inserts the sentinel_members and
 * sentinel_invitation_reservations rows the real invite-member function would have
 * produced, so the UI and RPCs under test behave exactly as they would after a real invite.
 */
async function seedPendingMember(workspaceId: string, managerId: string) {
  let userId: string | null = null;
  let email = "";
  let usedDomain = "";
  let lastError: unknown = null;

  for (const domain of CANDIDATE_DOMAINS) {
    const candidate = `pending-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}@${domain}`;
    const created = await adminAuth("admin/users", {
      method: "POST",
      body: JSON.stringify({ email: candidate, email_confirm: true }),
    });

    if (created.status >= 200 && created.status < 300 && created.body?.id) {
      userId = created.body.id as string;
      email = candidate;
      usedDomain = domain;
      break;
    }

    lastError = created.body;
  }

  if (!userId) {
    throw new Error(`Admin API rejected every candidate domain (${CANDIDATE_DOMAINS.join(", ")}): ${JSON.stringify(lastError)}`);
  }

  // Visible in the Playwright report so the domain that actually worked is on record.
  console.log(`[members.spec] seeded pending member @${usedDomain}`);

  // From here on, everything created must be torn down before rethrowing: a partial seed
  // (an orphan auth user, or an orphan pending sentinel_members row) would corrupt the
  // shared roster for every other spec, exactly what this file exists to avoid.
  try {
    const memberInsert = await adminRest("sentinel_members", {
      method: "POST",
      body: JSON.stringify({
        workspace_id: workspaceId,
        user_id: userId,
        role: "analyst",
        status: "pending",
        invited_email: email,
      }),
    });
    if (memberInsert.status >= 300) {
      throw new Error(`Failed to seed sentinel_members row: ${JSON.stringify(memberInsert.body)}`);
    }

    const reservationInsert = await adminRest("sentinel_invitation_reservations", {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({
        workspace_id: workspaceId,
        email: email.toLowerCase(),
        invited_by: managerId,
        status: "completed",
      }),
    });
    if (reservationInsert.status >= 300 || !reservationInsert.body?.[0]?.id) {
      throw new Error(`Failed to seed sentinel_invitation_reservations row: ${JSON.stringify(reservationInsert.body)}`);
    }

    return { email, userId, reservationId: reservationInsert.body[0].id as string } satisfies PendingMemberSeed;
  } catch (error) {
    // Deleting the auth user cascades away any sentinel_members row that made it in.
    // Also sweep by workspace+email in case a reservation was inserted but its id was
    // unreadable from the response, so nothing seeded here survives the throw.
    await adminAuth(`admin/users/${userId}`, { method: "DELETE" }).catch(() => {});
    await adminRest(`sentinel_invitation_reservations?workspace_id=eq.${workspaceId}&email=eq.${email.toLowerCase()}`, {
      method: "DELETE",
    }).catch(() => {});
    throw error;
  }
}

/**
 * Delete everything seedPendingMember created and assert both deletes actually happened.
 * sentinel_members cascades on auth.users delete, so the auth user is the one row that
 * disappears implicitly; the reservation row needs its own DELETE (service_role holds the
 * privilege as of the grant in 20260808000000_sentinel_member_management.sql).
 *
 * Both deletes are attempted regardless of whether the other succeeded, and failures are
 * collected rather than thrown immediately, so one failing delete never hides the other.
 */
async function cleanupPendingMember(seed: PendingMemberSeed) {
  const failures: string[] = [];

  const authDeleted = await adminAuth(`admin/users/${seed.userId}`, { method: "DELETE" });
  if (authDeleted.status >= 300) {
    failures.push(`auth user ${seed.userId}: ${authDeleted.status} ${JSON.stringify(authDeleted.body)}`);
  }

  const reservationDeleted = await adminRest(`sentinel_invitation_reservations?id=eq.${seed.reservationId}`, {
    method: "DELETE",
    headers: { Prefer: "return=representation" },
  });
  if (reservationDeleted.status >= 300 || !Array.isArray(reservationDeleted.body) || reservationDeleted.body.length !== 1) {
    failures.push(`reservation ${seed.reservationId}: ${reservationDeleted.status} ${JSON.stringify(reservationDeleted.body)}`);
  }

  if (failures.length > 0) {
    throw new Error(`cleanupPendingMember left data behind -- ${failures.join("; ")}`);
  }
}

/**
 * Run cleanup without letting a cleanup failure replace whatever the test itself threw:
 * a network hiccup or a non-JSON gateway body inside cleanupPendingMember must not mask a
 * genuine assertion failure. Logged loudly instead so leaked fixtures are still visible.
 */
async function cleanupPendingMemberQuietly(seed: PendingMemberSeed) {
  try {
    await cleanupPendingMember(seed);
  } catch (error) {
    console.error(`[members.spec] cleanup failed for ${seed.email}:`, error);
  }
}

test.describe("manager member management", () => {
  test.use({ storageState: storageStatePath("manager") });

  test("activates a pending member and records the event", async ({ page }) => {
    const token = await openWorkspace(page);
    const workspaceId = await workspaceIdFor(token);
    const managerId = subjectOf(token);
    const seed = await seedPendingMember(workspaceId, managerId);

    try {
      await page.reload();
      await page.getByRole("heading", { name: "Team and settings" }).waitFor();

      const row = page.getByRole("row", { name: new RegExp(seed.email) });
      await expect(row).toBeVisible();
      await row.getByRole("button", { name: /activate/i }).click();
      await expect(page.getByRole("status")).toContainText(/activated/i, { timeout: 30_000 });

      const members = await rest(token, `sentinel_manager_roster?select=user_id,status&invited_email=eq.${seed.email}`);
      expect(members.body[0].status).toBe("active");

      const memberUserId = members.body[0].user_id;
      const events = await rest(
        token,
        `sentinel_activity_events?select=event_type&event_type=eq.member-activated&metadata->>member_user_id=eq.${memberUserId}`,
      );
      expect(events.body.length).toBeGreaterThan(0);
    } finally {
      // Now that the auth user is ours (created directly via the Admin API rather than
      // through a real invite), we can and do delete it: the sentinel_members row cascades
      // on auth.users delete, and the reservation row is deleted explicitly.
      await cleanupPendingMemberQuietly(seed);
    }
  });

  test("refuses to demote the last active manager", async ({ page }) => {
    const token = await openWorkspace(page);
    const workspaceId = await workspaceIdFor(token);
    const self = await rest(token, "sentinel_manager_roster?select=user_id,role&role=eq.manager&status=eq.active");
    const managers = self.body as { user_id: string }[];
    test.skip(managers.length !== 1, "guard only applies with exactly one active manager");

    const managerId = managers[0].user_id;
    try {
      const refusal = await callRpc(token, "sentinel_set_member_role", {
        p_workspace_id: workspaceId,
        p_user_id: managerId,
        p_role: "analyst",
      });

      expect(refusal.status).toBe(400);
      expect(refusal.body.message).toMatch(/at least one manager/i);

      const after = await rest(token, `sentinel_manager_roster?select=role&user_id=eq.${managerId}`);
      expect(after.body[0]?.role).toBe("manager");
    } finally {
      // Insurance, not an expectation: if the last-manager guard in
      // sentinel_set_member_role ever regresses and actually demotes the sole manager, the
      // workspace becomes irrecoverable (nobody left who can invite or activate). Restore
      // the role directly via the service role so a regression here surfaces as a red test
      // instead of bricking the shared workspace for every other spec.
      await adminRest(`sentinel_members?workspace_id=eq.${workspaceId}&user_id=eq.${managerId}`, {
        method: "PATCH",
        body: JSON.stringify({ role: "manager" }),
      });
    }
  });

  test("rejects a pending invitation and frees the address for re-invitation", async ({ page }) => {
    const token = await openWorkspace(page);
    const workspaceId = await workspaceIdFor(token);
    const managerId = subjectOf(token);
    const seed = await seedPendingMember(workspaceId, managerId);

    try {
      await page.reload();
      await page.getByRole("heading", { name: "Team and settings" }).waitFor();

      const row = page.getByRole("row", { name: new RegExp(seed.email) });
      await row.getByRole("button", { name: /^reject$/i }).click();
      await row.getByRole("button", { name: /confirm reject/i }).click();
      await expect(page.getByRole("status")).toContainText(/rejected/i, { timeout: 30_000 });

      const gone = await rest(token, `sentinel_manager_roster?select=user_id&invited_email=eq.${seed.email}`);
      expect(gone.body).toEqual([]);

      // The regression that matters: a `failed` reservation is immediately re-claimable by
      // claimReservation (supabase/functions/invite-member/index.ts), which is what frees
      // the address for re-invitation. This spec can't drive a real re-invite through the
      // UI (Supabase Auth rejects every domain it could safely use here without sending a
      // real email), so instead it asserts directly, via the service role, that
      // sentinel_reject_invitation actually flipped the reservation row to `failed` --
      // proving the address is unblocked without depending on the invite path.
      const reservation = await adminRest(`sentinel_invitation_reservations?select=status&id=eq.${seed.reservationId}`);
      expect(reservation.body[0].status).toBe("failed");
    } finally {
      await cleanupPendingMemberQuietly(seed);
    }
  });
});

test.describe("analyst member management", () => {
  test.use({ storageState: storageStatePath("analyst") });

  test("is refused by every member management RPC", async ({ page }) => {
    await page.goto("/workspace");
    await page.getByRole("heading", { name: "Team and settings" }).waitFor();
    const token = await accessToken(page);
    const workspaceId = await workspaceIdFor(token);
    const self = await rest(token, "sentinel_members?select=user_id&limit=1");
    const selfId = self.body[0].user_id as string;

    for (const [name, args] of [
      ["sentinel_activate_member", { p_workspace_id: workspaceId, p_user_id: selfId }],
      ["sentinel_set_member_role", { p_workspace_id: workspaceId, p_user_id: selfId, p_role: "manager" }],
      ["sentinel_reject_invitation", { p_workspace_id: workspaceId, p_user_id: selfId }],
    ] as const) {
      const response = await callRpc(token, name, args);
      expect(response.status, `${name} must refuse an analyst`).toBeGreaterThanOrEqual(400);
      expect(JSON.stringify(response.body)).toMatch(/manager membership required/i);
    }
  });
});
