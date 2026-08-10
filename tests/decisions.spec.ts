import { expect, test, type Page } from "@playwright/test";
import { requireCredentials, requireServiceRoleKey, storageStatePath } from "./env";

const { supabaseUrl, publishableKey } = requireCredentials("manager");

// Decisions advance status and append events. Unlike re-running an agent, they are not
// idempotent, so this file never races itself over a shared fixture.
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

function subjectOf(token: string) {
  const payload = token.split(".")[1] ?? "";
  const decoded = Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
  return JSON.parse(decoded).sub as string;
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

async function adminRest(path: string, init: RequestInit = {}) {
  const secretKey = requireServiceRoleKey();
  const response = await fetch(`${supabaseUrl}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: secretKey,
      Authorization: `Bearer ${secretKey}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
      ...(init.headers ?? {}),
    },
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

async function decide(token: string, args: { investigationId: string; workspaceId: string; action: string; rationale: string }) {
  return rest(token, "rpc/sentinel_record_decision", {
    method: "POST",
    body: JSON.stringify({
      p_investigation_id: args.investigationId,
      p_workspace_id: args.workspaceId,
      p_action: args.action,
      p_rationale: args.rationale,
    }),
  });
}

type SeededCase = { id: string; workspaceId: string };

/**
 * A disposable case, seeded with the service role so its owner and upload state are exactly
 * what the test needs rather than whatever the shared backlog happens to hold.
 *
 * withUpload seeds an upload row and nothing else. Guard 5 asks whether the case has an
 * upload at all, so a parsed file would be more setup proving the same thing.
 */
async function seedCase(options: { workspaceId: string; ownerId: string; withUpload: boolean }): Promise<SeededCase> {
  const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`.toUpperCase();
  const created = await adminRest("sentinel_investigations", {
    method: "POST",
    body: JSON.stringify({
      workspace_id: options.workspaceId,
      reference: `INV-DEC${suffix}`,
      entity: "Decision guard fixture",
      owner_id: options.ownerId,
      created_by: options.ownerId,
      status: "open",
    }),
  });
  expect(created.status, `seed investigation: ${JSON.stringify(created.body)}`).toBe(201);
  const id = created.body[0].id as string;

  if (options.withUpload) {
    const uploadId = crypto.randomUUID();
    const upload = await adminRest("sentinel_uploads", {
      method: "POST",
      body: JSON.stringify({
        id: uploadId,
        workspace_id: options.workspaceId,
        investigation_id: id,
        // The storage_path CHECK requires workspace/investigation/upload/filename.
        storage_path: `${options.workspaceId}/${id}/${uploadId}/seed.csv`,
        original_name: "seed.csv",
        extension: "csv",
        byte_size: 128,
        status: "parsed",
        row_count: 3,
        uploaded_by: options.ownerId,
      }),
    });
    expect(upload.status, `seed upload: ${JSON.stringify(upload.body)}`).toBe(201);
  }

  return { id, workspaceId: options.workspaceId };
}

/**
 * Events must go first. sentinel_activity_events.investigation_id is `on delete set null`,
 * so deleting the case first would orphan its events into the workspace feed rather than
 * remove them.
 */
async function removeCase(seeded: SeededCase) {
  await adminRest(`sentinel_activity_events?investigation_id=eq.${seeded.id}`, { method: "DELETE" });
  await adminRest(`sentinel_uploads?investigation_id=eq.${seeded.id}`, { method: "DELETE" });
  await adminRest(`sentinel_investigations?id=eq.${seeded.id}`, { method: "DELETE" });
}

async function signedInToken(page: Page) {
  await page.goto("/cases");
  await page.getByRole("heading", { name: "Cases" }).waitFor();
  return accessToken(page);
}

async function workspaceIdFor(token: string) {
  const membership = await rest(token, "sentinel_members?select=workspace_id&limit=1");
  return membership.body[0].workspace_id as string;
}

test.describe("recording a decision", () => {
  test.use({ storageState: storageStatePath("analyst") });

  test("an analyst's recommendation moves the case to review and records their words", async ({ page }) => {
    const token = await signedInToken(page);
    const analystId = subjectOf(token);
    const workspaceId = await workspaceIdFor(token);
    const seeded = await seedCase({ workspaceId, ownerId: analystId, withUpload: true });

    try {
      const response = await decide(token, {
        investigationId: seeded.id,
        workspaceId,
        action: "recommend-approve",
        rationale: "Outlier amount is explained by the annual settlement.",
      });

      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.body.status).toBe("review");
      expect(response.body.event_id).toBeTruthy();

      const investigation = await rest(token, `sentinel_investigations?select=status&id=eq.${seeded.id}`);
      expect(investigation.body[0].status).toBe("review");

      const events = await rest(
        token,
        `sentinel_activity_events?select=event_type,actor_id,rationale,metadata&investigation_id=eq.${seeded.id}&event_type=eq.case-recommended`,
      );
      expect(events.body).toHaveLength(1);
      expect(events.body[0].actor_id).toBe(analystId);
      expect(events.body[0].rationale).toBe("Outlier amount is explained by the annual settlement.");
      expect(events.body[0].metadata).toMatchObject({
        from_status: "open",
        to_status: "review",
        recommendation: "approve",
      });
    } finally {
      await removeCase(seeded);
    }
  });
});

test.describe("guarding status against the direct-PATCH surface", () => {
  test.use({ storageState: storageStatePath("manager") });

  test("a manager cannot PATCH status directly", async ({ page }) => {
    // 20260806044722_sentinel_rls_performance_hardening.sql's merged policy still lets a
    // manager UPDATE sentinel_investigations directly. sentinel_record_decision must be the
    // only path that moves status, so the column grant that made that true is asserted here
    // on its own -- independent of the RPC, which the next test exercises.
    const token = await signedInToken(page);
    const managerId = subjectOf(token);
    const workspaceId = await workspaceIdFor(token);
    const seeded = await seedCase({ workspaceId, ownerId: managerId, withUpload: true });

    try {
      // The outcome is what matters, not the status code: a column-privilege refusal (403)
      // and a request PostgREST accepts but that touches zero rows both look different on
      // the wire, and either one is a pass -- the only failure is the row actually changing.
      await rest(token, `sentinel_investigations?id=eq.${seeded.id}`, {
        method: "PATCH",
        body: JSON.stringify({ status: "approved" }),
      });

      const after = await rest(token, `sentinel_investigations?select=status&id=eq.${seeded.id}`);
      expect(after.body[0].status).toBe("open");
    } finally {
      await removeCase(seeded);
    }
  });

  test("approve is refused when no recommendation exists", async ({ page }) => {
    // The regression test for the actual attack: with the direct-PATCH surface still open,
    // a manager could PATCH status to 'review' and then call approve with no
    // case-recommended event on the trail. Guard 9 must refuse that even though guard 8's
    // status precondition is satisfied. The service role is used here only to construct the
    // state -- it bypasses the column revoke, which is exactly what makes building a
    // 'review' case with no recommendation possible at all now that the manager's own
    // session cannot.
    const token = await signedInToken(page);
    const managerId = subjectOf(token);
    const workspaceId = await workspaceIdFor(token);
    const seeded = await seedCase({ workspaceId, ownerId: managerId, withUpload: true });

    try {
      const forced = await adminRest(`sentinel_investigations?id=eq.${seeded.id}`, {
        method: "PATCH",
        body: JSON.stringify({ status: "review" }),
      });
      expect(forced.status, `force status to review: ${JSON.stringify(forced.body)}`).toBe(200);

      const response = await decide(token, {
        investigationId: seeded.id,
        workspaceId,
        action: "approve",
        rationale: "Approving without any recommendation on record.",
      });

      expect(response.status, JSON.stringify(response.body)).toBeGreaterThanOrEqual(400);
      expect(JSON.stringify(response.body)).toMatch(/no recommendation to decide/i);

      const after = await rest(token, `sentinel_investigations?select=status&id=eq.${seeded.id}`);
      expect(after.body[0].status).toBe("review");
    } finally {
      await removeCase(seeded);
    }
  });
});
