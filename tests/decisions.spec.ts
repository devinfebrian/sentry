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

  test("refuses a case with nothing imported", async ({ page }) => {
    const token = await signedInToken(page);
    const analystId = subjectOf(token);
    const workspaceId = await workspaceIdFor(token);
    const seeded = await seedCase({ workspaceId, ownerId: analystId, withUpload: false });

    try {
      const response = await decide(token, {
        investigationId: seeded.id, workspaceId,
        action: "recommend-approve", rationale: "Looks fine to me.",
      });

      expect(response.status).toBe(400);
      expect(response.body.message).toMatch(/import data before deciding/i);

      const after = await rest(token, `sentinel_investigations?select=status&id=eq.${seeded.id}`);
      expect(after.body[0].status, "a refused decision must not move the case").toBe("open");
    } finally {
      await removeCase(seeded);
    }
  });

  test("refuses an empty rationale, and one over the cap", async ({ page }) => {
    const token = await signedInToken(page);
    const analystId = subjectOf(token);
    const workspaceId = await workspaceIdFor(token);
    const seeded = await seedCase({ workspaceId, ownerId: analystId, withUpload: true });

    try {
      const blank = await decide(token, {
        investigationId: seeded.id, workspaceId, action: "recommend-approve", rationale: "   ",
      });
      expect(blank.status).toBe(400);
      expect(blank.body.message).toMatch(/record why/i);

      const huge = await decide(token, {
        investigationId: seeded.id, workspaceId, action: "recommend-approve", rationale: "x".repeat(2001),
      });
      expect(huge.status).toBe(400);
      expect(huge.body.message).toMatch(/2000 characters or fewer/i);

      // The boundary itself is allowed, so the cap is a cap and not an off-by-one.
      const exact = await decide(token, {
        investigationId: seeded.id, workspaceId, action: "recommend-approve", rationale: "x".repeat(2000),
      });
      expect(exact.status, JSON.stringify(exact.body)).toBe(200);
    } finally {
      await removeCase(seeded);
    }
  });

  test("refuses an unknown action", async ({ page }) => {
    const token = await signedInToken(page);
    const analystId = subjectOf(token);
    const workspaceId = await workspaceIdFor(token);
    const seeded = await seedCase({ workspaceId, ownerId: analystId, withUpload: true });

    try {
      const response = await decide(token, {
        investigationId: seeded.id, workspaceId, action: "approve-please", rationale: "Fine.",
      });
      expect(response.status).toBe(400);
      expect(response.body.message).toMatch(/unknown decision action/i);
    } finally {
      await removeCase(seeded);
    }
  });

  test("refuses an investigation outside the caller's workspace", async ({ page }) => {
    const token = await signedInToken(page);
    const workspaceId = await workspaceIdFor(token);

    const response = await decide(token, {
      investigationId: crypto.randomUUID(), workspaceId,
      action: "recommend-approve", rationale: "Fine.",
    });

    // The brief assumed PostgREST maps P0002 to 404, matching P0001's mapping to 400. It
    // does not: P0002 falls outside PostgREST's default PL/pgSQL exception mapping and comes
    // back as 500, confirmed directly against this project with `code: "P0002"` still intact
    // in the body. The outcome that actually matters -- the case lookup failing closed with
    // the right message -- is unaffected, so the SQL is not the thing to change here.
    expect(response.status).toBe(500);
    expect(response.body.message).toMatch(/investigation not found/i);
  });

  test("refuses an analyst recommending on a case they do not own", async ({ page, browser }) => {
    const analystToken = await signedInToken(page);
    const workspaceId = await workspaceIdFor(analystToken);

    const managerContext = await browser.newContext({ storageState: storageStatePath("manager") });
    try {
      const managerPage = await managerContext.newPage();
      const managerId = subjectOf(await signedInToken(managerPage));
      const seeded = await seedCase({ workspaceId, ownerId: managerId, withUpload: true });

      try {
        const response = await decide(analystToken, {
          investigationId: seeded.id, workspaceId,
          action: "recommend-approve", rationale: "Not my case.",
        });
        expect(response.status).toBe(400);
        expect(response.body.message).toMatch(/assigned analyst or a manager/i);
      } finally {
        await removeCase(seeded);
      }
    } finally {
      await managerContext.close();
    }
  });

  test("refuses an analyst approving anything", async ({ page }) => {
    const token = await signedInToken(page);
    const analystId = subjectOf(token);
    const workspaceId = await workspaceIdFor(token);
    const seeded = await seedCase({ workspaceId, ownerId: analystId, withUpload: true });

    try {
      const recommended = await decide(token, {
        investigationId: seeded.id, workspaceId,
        action: "recommend-approve", rationale: "Ready for review.",
      });
      expect(recommended.status).toBe(200);

      const response = await decide(token, {
        investigationId: seeded.id, workspaceId, action: "approve", rationale: "And approved.",
      });
      expect(response.status).toBe(400);
      expect(response.body.message).toMatch(/manager membership required/i);

      const after = await rest(token, `sentinel_investigations?select=status&id=eq.${seeded.id}`);
      expect(after.body[0].status).toBe("review");
    } finally {
      await removeCase(seeded);
    }
  });

  test("refuses a second recommendation while one is awaiting review", async ({ page }) => {
    const token = await signedInToken(page);
    const analystId = subjectOf(token);
    const workspaceId = await workspaceIdFor(token);
    const seeded = await seedCase({ workspaceId, ownerId: analystId, withUpload: true });

    try {
      expect((await decide(token, {
        investigationId: seeded.id, workspaceId,
        action: "recommend-approve", rationale: "First call.",
      })).status).toBe(200);

      const second = await decide(token, {
        investigationId: seeded.id, workspaceId,
        action: "recommend-reject", rationale: "Changed my mind.",
      });
      expect(second.status).toBe(400);
      expect(second.body.message).toMatch(/already has a recommendation/i);
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

test.describe("deciding a recommended case", () => {
  test.use({ storageState: storageStatePath("manager") });

  test("refuses the manager who wrote the recommendation", async ({ page }) => {
    const token = await signedInToken(page);
    const managerId = subjectOf(token);
    const workspaceId = await workspaceIdFor(token);
    const seeded = await seedCase({ workspaceId, ownerId: managerId, withUpload: true });

    try {
      // A manager may recommend on any case; guard 9 is about who may then decide it.
      expect((await decide(token, {
        investigationId: seeded.id, workspaceId,
        action: "recommend-approve", rationale: "My own read of it.",
      })).status).toBe(200);

      const response = await decide(token, {
        investigationId: seeded.id, workspaceId, action: "approve", rationale: "And I agree with myself.",
      });

      expect(response.status).toBe(400);
      expect(response.body.message).toMatch(/another manager must decide/i);

      const after = await rest(token, `sentinel_investigations?select=status&id=eq.${seeded.id}`);
      expect(after.body[0].status, "a refused approval must leave the case in review").toBe("review");
    } finally {
      await removeCase(seeded);
    }
  });

  test("approves a case somebody else recommended, and can send a decided case back", async ({ page, browser }) => {
    const managerToken = await signedInToken(page);
    const workspaceId = await workspaceIdFor(managerToken);

    const analystContext = await browser.newContext({ storageState: storageStatePath("analyst") });
    try {
      const analystPage = await analystContext.newPage();
      const analystToken = await signedInToken(analystPage);
      const analystId = subjectOf(analystToken);
      const seeded = await seedCase({ workspaceId, ownerId: analystId, withUpload: true });

      try {
        expect((await decide(analystToken, {
          investigationId: seeded.id, workspaceId,
          action: "recommend-approve", rationale: "Settlement explains the outlier.",
        })).status).toBe(200);

        const approved = await decide(managerToken, {
          investigationId: seeded.id, workspaceId, action: "approve", rationale: "Agreed, closing it out.",
        });
        expect(approved.status, JSON.stringify(approved.body)).toBe(200);
        expect(approved.body.status).toBe("approved");

        // approved is reachable-from, not terminal.
        const sentBack = await decide(managerToken, {
          investigationId: seeded.id, workspaceId,
          action: "request-evidence", rationale: "Attach the settlement letter before we file this.",
        });
        expect(sentBack.status, JSON.stringify(sentBack.body)).toBe(200);
        expect(sentBack.body.status).toBe("open");

        const trail = await rest(
          managerToken,
          `sentinel_activity_events?select=event_type&investigation_id=eq.${seeded.id}&order=created_at.asc`,
        );
        const types = trail.body.map((row: { event_type: string }) => row.event_type);
        expect(types).toEqual(
          expect.arrayContaining(["case-recommended", "case-approved", "case-evidence-requested"]),
        );
      } finally {
        await removeCase(seeded);
      }
    } finally {
      await analystContext.close();
    }
  });
});
