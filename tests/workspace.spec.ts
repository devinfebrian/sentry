import { expect, test, type Page } from "@playwright/test";
import { fixturePath, requireCredentials, requireServiceRoleKey, storageStatePath } from "./env";

const { supabaseUrl, publishableKey } = requireCredentials("analyst");

/**
 * Read the Supabase session the app itself stored. Using the signed-in user's own token
 * keeps every API assertion inside the same RLS context the browser has, so these checks
 * verify real user-facing permissions rather than a privileged back door.
 */
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

async function restRequest(token: string, path: string, init: RequestInit = {}) {
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

async function api(page: Page, path: string, init: RequestInit = {}) {
  return restRequest(await accessToken(page), path, init);
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

type SeededDecidableCase = { id: string; reference: string };

/**
 * One upload row and no sentinel_agent_runs rows lands the queue's derived stage on
 * "awaiting-analysis" -- anything past "awaiting-import" is what DecisionPanel requires
 * before it mounts (see CaseWorkspacePage.test.tsx's "analysis has not started" case).
 * Mirrors decisions.spec.ts's seedCase(withUpload: true), returning the reference too since
 * this test navigates by URL rather than by REST id.
 */
async function seedDecidableCase(options: { workspaceId: string; ownerId: string }): Promise<SeededDecidableCase> {
  const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`.toUpperCase();
  const reference = `INV-E2E${suffix}`;
  const created = await adminRest("sentinel_investigations", {
    method: "POST",
    body: JSON.stringify({
      workspace_id: options.workspaceId,
      reference,
      entity: "Handoff walkthrough fixture",
      owner_id: options.ownerId,
      created_by: options.ownerId,
      status: "open",
    }),
  });
  expect(created.status, `seed investigation: ${JSON.stringify(created.body)}`).toBe(201);
  const id = created.body[0].id as string;

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

  return { id, reference };
}

/**
 * Events must go first, and specifically through the purge RPC, not a REST DELETE.
 * sentinel_activity_events is append-only by grant omission -- service_role has only INSERT
 * on it, so a direct DELETE always 403s. That 403 was previously swallowed silently: the
 * investigation still got removed afterward, and because investigation_id is `on delete set
 * null`, its events survived as orphans instead of being removed. sentinel_purge_investigation_
 * events is the one path narrow enough to be granted to service_role without reopening the
 * audit trail to authenticated, so it runs first, scoped to every event this investigation's
 * fixtures produced (not only case-* -- seeding it also fires the foundation triggers that
 * write investigation-created and upload-created), and its result is checked -- a cleanup
 * that fails silently is exactly how that bug went unnoticed. The two DELETEs after it are
 * checked for the same reason. Mirrors decisions.spec.ts's removeCase.
 */
async function removeSeededCase(id: string) {
  const purged = await adminRest("rpc/sentinel_purge_investigation_events", {
    method: "POST",
    body: JSON.stringify({ p_investigation_id: id }),
  });
  expect(purged.status, `purge investigation events: ${JSON.stringify(purged.body)}`).toBeLessThan(300);

  const uploadsRemoved = await adminRest(`sentinel_uploads?investigation_id=eq.${id}`, { method: "DELETE" });
  expect(uploadsRemoved.status, `delete seeded uploads: ${JSON.stringify(uploadsRemoved.body)}`).toBeLessThan(300);

  const investigationRemoved = await adminRest(`sentinel_investigations?id=eq.${id}`, { method: "DELETE" });
  expect(investigationRemoved.status, `delete seeded investigation: ${JSON.stringify(investigationRemoved.body)}`).toBeLessThan(300);
}

function importDialog(page: Page) {
  return page.getByRole("dialog", { name: "Import financial data" });
}

async function openImportDialog(page: Page) {
  await page.goto("/");
  await page.getByRole("heading", { name: "Overview" }).waitFor();
  await page.getByRole("button", { name: "New investigation" }).first().click();
  const dialog = importDialog(page);
  await expect(dialog).toBeVisible();
  return dialog;
}

test.describe("analyst workspace", () => {
  test.use({ storageState: storageStatePath("analyst") });

  test("imports a CSV, creates a persisted investigation, and keeps the source file private", async ({ page }) => {
    test.slow(); // Upload, Edge Function parse, and row persistence in one flow.
    const dialog = await openImportDialog(page);

    await dialog.getByLabel("Financial data file").setInputFiles(fixturePath("sentinel-upload.csv"));
    await expect(dialog.getByText(/Preview \/ 3 records/i)).toBeVisible();

    await dialog.getByRole("button", { name: "Import data" }).click();

    // The dialog closes and routes to the new case only on a non-failed parser result.
    await page.waitForURL(/\/cases\/INV-[A-Z0-9]+\/summary/, { timeout: 60_000 });
    const reference = new URL(page.url()).pathname.split("/")[2];
    expect(reference).toMatch(/^INV-[A-Z0-9]+$/);
    await expect(page.getByText(new RegExp(`Investigation ${reference} created`, "i"))).toBeVisible();

    // Survives a reload: the investigation is persisted, not client state.
    await page.reload();
    await expect(page.getByText(reference).first()).toBeVisible();
    // Target the unique reference, not the entity name: other tests share this workspace.
    await page.goto("/cases");
    const caseLink = page.getByRole("link", { name: new RegExp(reference) });
    await expect(caseLink).toBeVisible({ timeout: 20_000 });
    await expect(caseLink).toContainText("Northwind Traders");

    const investigations = await api(page, `sentinel_investigations?select=id,reference,entity&reference=eq.${reference}`);
    expect(investigations.status).toBe(200);
    expect(investigations.body).toHaveLength(1);
    const investigationId = investigations.body[0].id;

    const uploads = await api(page, `sentinel_uploads?select=id,status,storage_path&investigation_id=eq.${investigationId}`);
    expect(uploads.status).toBe(200);
    expect(uploads.body).toHaveLength(1);
    const upload = uploads.body[0];
    expect(["processing", "parsed"]).toContain(upload.status);

    // Rows are written by the Edge Function, so allow for the parse to land.
    await expect.poll(async () => {
      const rows = await api(page, `sentinel_import_rows?select=id,source_row&upload_id=eq.${upload.id}`);
      return Array.isArray(rows.body) ? rows.body.length : 0;
    }, { timeout: 60_000, message: "parsed rows persisted" }).toBe(3);

    // Retrying must not duplicate rows for the same upload.
    const finalRows = await api(page, `sentinel_import_rows?select=source_row&upload_id=eq.${upload.id}`);
    const sourceRows = finalRows.body.map((row: { source_row: number }) => row.source_row).sort();
    expect(sourceRows).toEqual([2, 3, 4]);

    // The parse result has to reach the analyst, not just the database — the case page
    // used to say "Analysis not started" forever with no sign the upload had worked.
    await page.goto(`/cases/${reference}/summary`);
    await expect(page.getByText("3 records imported")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("Northwind Traders").first()).toBeVisible();
    // This used to assert "Analysis not started", which stopped being true when the parse
    // began seeding agent runs. The half that still matters is the AI agent: it is seeded,
    // nothing has asked it to run, and the pipeline has to say so rather than imply work.
    await expect(page.getByRole("heading", { name: "Agent pipeline" })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("listitem").filter({ hasText: "Fraud pattern investigator" }))
      .toContainText("Waiting");

    // The original file must not be readable without authentication.
    const publicResponse = await fetch(`${supabaseUrl}/storage/v1/object/public/sentinel-imports/${upload.storage_path}`);
    expect(publicResponse.ok, "original upload must not be publicly fetchable").toBe(false);

    const anonymousResponse = await fetch(
      `${supabaseUrl}/storage/v1/object/sentinel-imports/${upload.storage_path}`,
      { headers: { apikey: publishableKey } },
    );
    expect(anonymousResponse.ok, "original upload must require an authenticated session").toBe(false);
  });

  test("analyses an import and shows the findings with their evidence", async ({ page }) => {
    test.slow(); // Upload, parse, analysis, and three page loads.
    const dialog = await openImportDialog(page);

    await dialog.getByLabel("Financial data file").setInputFiles(fixturePath("sentinel-findings.csv"));
    await dialog.getByLabel("Investigation name").fill(`Analysis Walkthrough ${Date.now().toString(36)}`);
    await dialog.getByRole("button", { name: "Import data" }).click();

    await page.waitForURL(/\/cases\/INV-[A-Z0-9]+\/summary/, { timeout: 60_000 });
    const reference = new URL(page.url()).pathname.split("/")[2];

    // Wait for the panels themselves. Asserting the absence of "Analysis not started"
    // passes on a page that has not rendered yet, which once reported zero findings
    // against a database holding three.
    await page.goto(`/cases/${reference}/findings`);
    const panels = page.locator(".finding-panel");
    await expect(panels).toHaveCount(3, { timeout: 60_000 });
    await expect(page.getByRole("heading", { name: /analysis not started/i })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: /analysis could not be loaded/i })).toHaveCount(0);

    // One assertion per rule: each states an observation about the fixture's rows.
    await expect(panels.filter({ hasText: "2 rows record 2,500 for Northwind Traders" })).toHaveCount(1);
    await expect(panels.filter({ hasText: /Whale Holdings records 25,000, 10x the median/ })).toHaveCount(1);
    await expect(panels.filter({ hasText: "1 row has no amount recorded" })).toHaveCount(1);

    // Evidence points back at the source rows, including the median row as context.
    await page.goto(`/cases/${reference}/evidence`);
    await expect(page.getByRole("row").filter({ hasText: "Row 11 — Whale Holdings" })).toHaveCount(1);
    await expect(page.getByRole("row").filter({ hasText: "Median amount across this import" })).toHaveCount(1);
    await expect(page.getByRole("row").filter({ hasText: "Row 12 — Ghost Vendor" })).toHaveCount(1);

    await page.goto("/activity");
    await expect(page.getByText(/analysis completed/i).first()).toBeVisible({ timeout: 30_000 });
  });

  test("shows the agent pipeline and re-runs a finished agent without disturbing its findings", async ({ page }) => {
    test.slow(); // Upload, parse, run seeding, and a second analysis pass.
    const dialog = await openImportDialog(page);

    await dialog.getByLabel("Financial data file").setInputFiles(fixturePath("sentinel-findings.csv"));
    await dialog.getByLabel("Investigation name").fill(`Pipeline Walkthrough ${Date.now().toString(36)}`);
    await dialog.getByRole("button", { name: "Import data" }).click();

    await page.waitForURL(/\/cases\/INV-[A-Z0-9]+\/summary/, { timeout: 60_000 });
    const reference = new URL(page.url()).pathname.split("/")[2];

    const investigations = await api(page, `sentinel_investigations?select=id&reference=eq.${reference}`);
    const investigationId = investigations.body[0].id;

    // Wait on the API, then navigate once. Polling the DOM with reload() spins: count() does
    // not auto-wait, so each iteration re-navigated before React had rendered the previous
    // one and read zero forever.
    await expect.poll(async () => {
      const runs = await api(page, `sentinel_agent_runs?select=agent_key&investigation_id=eq.${investigationId}`);
      return Array.isArray(runs.body) ? runs.body.length : 0;
    }, { timeout: 90_000, message: "the parse seeds one run per agent" }).toBe(2);

    await page.goto(`/cases/${reference}/summary`);
    await expect(page.getByRole("heading", { name: "Agent pipeline" })).toBeVisible({ timeout: 30_000 });

    const stages = page.getByRole("listitem");
    await expect(stages.filter({ hasText: "Financial analysis" })).toContainText("Complete");
    // Seeded, seen, and untouched: nothing runs a model without being asked.
    await expect(stages.filter({ hasText: "Fraud pattern investigator" })).toContainText("Waiting");
    await expect(page.getByRole("button", { name: /^run fraud pattern investigator$/i })).toBeVisible();

    async function findingRules(agentKey: string) {
      const response = await api(
        page,
        `sentinel_findings?select=rule&investigation_id=eq.${investigationId}&agent_key=eq.${agentKey}`,
      );
      return (response.body as { rule: string }[]).map((row) => row.rule).sort();
    }

    const before = await findingRules("deterministic");
    expect(before).toEqual(["duplicate-amount", "missing-amount", "outlier-amount"]);

    /**
     * The capability the agent-scoped delete exists for. A completed stage rendered no
     * action at all until now, which put re-running an agent out of reach from the
     * interface even though the database supported it.
     *
     * Driven through the deterministic agent on purpose: it exercises the same
     * analyze-upload path, CORS included, with no model call, no quota, and no chance of a
     * provider outage making this test flake.
     */
    const runAgain = page.getByRole("button", { name: /run financial analysis again/i });
    await expect(runAgain).toBeVisible();
    await runAgain.click();
    await expect(runAgain).toBeEnabled({ timeout: 60_000 });

    // Replaced, not duplicated, and no other producer's work touched.
    await expect.poll(async () => (await findingRules("deterministic")).length, {
      timeout: 30_000,
      message: "re-run replaces the deterministic findings rather than accumulating them",
    }).toBe(3);
    expect(await findingRules("deterministic")).toEqual(before);
    expect(await findingRules("fraud-pattern")).toEqual([]);

    // One run row per producer per upload, updated in place by the re-run.
    const runs = await api(
      page,
      `sentinel_agent_runs?select=agent_key,status,output_count&investigation_id=eq.${investigationId}`,
    );
    const byAgent = (runs.body as { agent_key: string; status: string; output_count: number }[])
      .sort((left, right) => left.agent_key.localeCompare(right.agent_key));
    expect(byAgent).toHaveLength(2);
    expect(byAgent[0]).toMatchObject({ agent_key: "deterministic", status: "complete", output_count: 3 });
    expect(byAgent[1]).toMatchObject({ agent_key: "fraud-pattern", status: "waiting" });
  });

  test("the queue reports a stage and filters on it", async ({ page }) => {
    await page.goto("/cases");

    // Assert something positive first: toHaveCount(0) is satisfied instantly by a page that
    // has not rendered, which is how an earlier walkthrough reported zero findings against a
    // database holding three.
    await expect(page.getByRole("columnheader", { name: /stage/i })).toBeVisible();
    // Data rows carry the case link as a row header (`th[scope="row"]`); the queue's own
    // column header row does not, so this isolates cases from the header without depending
    // on row order.
    const dataRows = page.getByRole("row").filter({ has: page.locator("th[scope='row']") });
    await expect(dataRows.first()).toBeVisible();

    // Read the stage off a case that is actually in the workspace rather than assuming a
    // fraud-review case and an awaiting-import case both already exist — the backlog this
    // test runs against is shared with every other test and with whatever a human ran the
    // fraud-pattern agent across, so neither is guaranteed. What the filter promises is
    // narrower and does not need either: select a stage, and every rendered row shows it.
    const stageLabel = (await dataRows.first().locator("td").nth(1).innerText()).trim();
    expect(stageLabel, "the queue's first row must show a stage label").toBeTruthy();

    const stageFilter = page.getByRole("combobox", { name: /stage/i });
    const stageValue = await stageFilter
      .locator("option")
      .filter({ hasText: new RegExp(`^${stageLabel}$`) })
      .first()
      .getAttribute("value");
    expect(stageValue, `"${stageLabel}" must be one of the filter's own options`).toBeTruthy();

    await stageFilter.selectOption(stageValue!);

    // Re-read the whole column together, and retry the whole read, rather than reading once
    // right after selectOption(). Two failure modes live here, and both come from the same
    // root cause: this suite runs fullyParallel against a workspace shared with every other
    // spec plus the decision-handoff test's own seed and delete, so the table this test reads
    // can keep changing under it.
    //   1. selectOption() only waits for the <select>'s DOM value to change and its change
    //      event to fire -- not for CaseQueue's own re-render in response -- and a row already
    //      visible under the *previous*, unfiltered view satisfies a bare toBeVisible() with
    //      nothing left to wait for, so that check alone does not prove the filtered render has
    //      landed. Read too early and the "filtered" rows are still the old unfiltered set.
    //   2. Counting the rows once and then re-querying by index in a loop afterwards -- N
    //      sequential awaited round trips against a live DOM -- leaves a window after the count
    //      for a concurrent seed or delete to shift row order out from under a stale index,
    //      surfacing as "element(s) not found".
    // allTextContents() sidesteps #2 by reading the whole column in one call, so there is no
    // window between reads for a row to have moved. expect.poll sidesteps #1 by re-running that
    // one-call read on every attempt until the filtered table has actually settled, rather than
    // trusting the first read to already reflect it -- and only fails for real once a mismatch
    // survives every retry, which is what a genuine product bug would do.
    //
    // td:nth-of-type(2) is the stage column: the row's first cell is a th[scope="row"] (the
    // case link), not a td, so the stage column's position among the row's td siblings (2nd) is
    // one less than its position among all cells -- nth-of-type counts only same-tag siblings,
    // so it lands on the right cell without depending on the th's presence.
    await expect.poll(async () => {
      const labels = await dataRows.locator("td:nth-of-type(2)").allTextContents();
      return labels.length > 0 && labels.every((label) => label.trim() === stageLabel);
    }, { message: "every filtered row must show the selected stage" }).toBe(true);
  });

  test("rejects an unsupported file extension with a readable error", async ({ page }) => {
    const dialog = await openImportDialog(page);

    await dialog.getByLabel("Financial data file").setInputFiles(fixturePath("unsupported-extension.txt"));

    await expect(dialog.getByRole("alert")).toHaveText(/choose a csv, xls, or xlsx financial data file/i);
    // Clicking anyway must keep the reason on screen and must not start an import.
    await dialog.getByRole("button", { name: "Import data" }).click();
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("alert")).toHaveText(/choose a csv, xls, or xlsx financial data file/i);
  });

  test("rejects a spreadsheet with no numeric value column", async ({ page }) => {
    const dialog = await openImportDialog(page);

    await dialog.getByLabel("Financial data file").setInputFiles(fixturePath("missing-numeric-header.csv"));

    await expect(dialog.getByRole("alert")).toHaveText(/missing numeric transaction or value column/i);
    await dialog.getByRole("button", { name: "Import data" }).click();
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("alert")).toHaveText(/missing numeric transaction or value column/i);
  });

  test("cannot see manager invitation controls", async ({ page }) => {
    await page.goto("/workspace");
    await page.getByRole("heading", { name: "Team and settings" }).waitFor();
    await expect(page.getByRole("table")).toBeVisible();

    await expect(page.getByRole("textbox", { name: /email/i })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /send invitation/i })).toHaveCount(0);
    await expect(page.getByText(/only workspace managers can invite/i)).toBeVisible();
  });

  test("is refused by the invite-member function", async ({ page }) => {
    await page.goto("/workspace");
    await page.getByRole("heading", { name: "Team and settings" }).waitFor();
    const token = await accessToken(page);

    const response = await fetch(`${supabaseUrl}/functions/v1/invite-member`, {
      method: "POST",
      headers: { apikey: publishableKey, Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ email: "should-not-be-invited@example.com", role: "analyst" }),
    });

    expect(response.status).toBe(403);
    await expect.poll(async () => (await response.json()).error).toMatch(/manager membership required/i);
  });

  test("cannot read another member's invited address", async ({ page }) => {
    await page.goto("/workspace");
    await page.getByRole("heading", { name: "Team and settings" }).waitFor();

    // The manager roster view is the only route to addresses and is manager-gated.
    const roster = await api(page, "sentinel_manager_roster?select=user_id,invited_email");
    expect(roster.status).toBe(200);
    expect(roster.body).toEqual([]);

    // The column grant on the base table excludes invited_email for every authenticated user.
    const denied = await api(page, "sentinel_members?select=user_id,invited_email");
    expect(denied.status).toBe(403);
  });

  test("cannot modify an investigation owned by another member", async ({ page, browser }) => {
    // Build the target through the manager's own session so the case is genuinely owned by
    // someone else. Reusing an existing manager-owned case keeps the fixture from growing.
    const managerContext = await browser.newContext({ storageState: storageStatePath("manager") });
    try {
      const managerPage = await managerContext.newPage();
      await managerPage.goto("/cases");
      await managerPage.getByRole("heading", { name: "Cases" }).waitFor();
      const managerToken = await accessToken(managerPage);
      const managerId = subjectOf(managerToken);

      const owned = await restRequest(managerToken, `sentinel_investigations?select=id,entity&owner_id=eq.${managerId}&limit=1`);
      let target = owned.body?.[0] as { id: string; entity: string } | undefined;

      if (!target) {
        const membership = await restRequest(managerToken, `sentinel_members?select=workspace_id&user_id=eq.${managerId}`);
        const workspaceId = membership.body[0].workspace_id;
        const created = await restRequest(managerToken, "sentinel_investigations", {
          method: "POST",
          headers: { Prefer: "return=representation" },
          body: JSON.stringify({
            workspace_id: workspaceId,
            reference: `INV-MGROWNED${Date.now().toString(36).toUpperCase()}`,
            entity: "Manager Owned Entity",
            owner_id: managerId,
            status: "open",
            created_by: managerId,
          }),
        });
        expect(created.status, `manager should be able to create a case: ${JSON.stringify(created.body)}`).toBe(201);
        target = created.body[0];
      }

      const originalEntity = target!.entity;
      await page.goto("/cases");
      await page.getByRole("heading", { name: "Cases" }).waitFor();

      const response = await api(page, `sentinel_investigations?id=eq.${target!.id}`, {
        method: "PATCH",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify({ entity: "Tampered By Analyst" }),
      });

      // RLS either refuses outright or matches no row; either way the value must survive.
      expect(response.body ?? []).toEqual([]);
      const after = await restRequest(managerToken, `sentinel_investigations?select=entity&id=eq.${target!.id}`);
      expect(after.body[0].entity).toBe(originalEntity);
    } finally {
      await managerContext.close();
    }
  });
});

test.describe("manager workspace", () => {
  test.use({ storageState: storageStatePath("manager") });

  test("sees the workspace roster with member addresses", async ({ page }) => {
    await page.goto("/workspace");
    await page.getByRole("heading", { name: "Team and settings" }).waitFor();

    const table = page.getByRole("table", { name: "Workspace members" });
    await expect(table).toBeVisible();
    await expect(table.getByRole("row")).not.toHaveCount(1); // header plus at least one member
    await expect(table.getByText(/@/).first()).toBeVisible();
  });

  test("sees invitation controls and validates the address before sending", async ({ page }) => {
    await page.goto("/workspace");
    await page.getByRole("heading", { name: "Team and settings" }).waitFor();

    const email = page.getByRole("textbox", { name: /email/i });
    await expect(email).toBeVisible();
    await expect(page.getByRole("button", { name: /send invitation/i })).toBeVisible();
    await expect(page.getByText(/only workspace managers can invite/i)).toHaveCount(0);

    // Client-side guard: no request leaves the browser for a malformed address.
    let invited = false;
    await page.route("**/functions/v1/invite-member", (route) => {
      invited = true;
      return route.abort();
    });
    await email.fill("not-an-email");
    await page.getByRole("button", { name: /send invitation/i }).click();

    await expect(page.getByRole("alert")).toHaveText(/enter a valid email address/i);
    expect(invited).toBe(false);
  });
});

test.describe("unauthenticated access", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("redirects protected routes to sign in", async ({ page }) => {
    for (const path of ["/", "/cases", "/workspace"]) {
      await page.goto(path);
      await page.waitForURL(/\/sign-in/, { timeout: 30_000 });
      await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
    }
  });

  test("exposes no Sentinel object to an anonymous caller", async () => {
    // The publishable key is public by design, so every Sentinel table and view must be
    // unreadable without a session. A 200 carrying rows here would be a data leak.
    const objects = [
      "sentinel_workspaces",
      "sentinel_members",
      "sentinel_investigations",
      "sentinel_uploads",
      "sentinel_import_rows",
      "sentinel_activity_events",
      "sentinel_manager_roster",
      "sentinel_invitation_reservations",
      "sentinel_findings",
      "sentinel_evidence",
      "sentinel_agent_runs",
    ];

    for (const object of objects) {
      const response = await fetch(`${supabaseUrl}/rest/v1/${object}?select=*&limit=1`, {
        headers: { apikey: publishableKey },
      });
      const body = await response.text();
      expect(response.ok, `${object} must not be readable anonymously (got ${response.status})`).toBe(false);
      expect(body, `${object} must not return rows anonymously`).not.toMatch(/^\s*\[\s*\{/);
    }
  });
});

test.describe("responsive shell", () => {
  test.use({ storageState: storageStatePath("analyst") });

  test("exposes the mobile drawer and returns focus", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");
    const menuButton = page.getByRole("button", { name: "Open navigation" });
    await menuButton.click();
    await expect(page.getByRole("dialog", { name: "Workspace navigation" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(menuButton).toBeFocused();
  });
});

test.describe("deciding a case", () => {
  test.use({ storageState: storageStatePath("analyst") });

  test("an analyst recommends and a manager approves", async ({ page, browser }) => {
    await page.goto("/cases");
    await page.getByRole("heading", { name: "Cases" }).waitFor();
    const analystToken = await accessToken(page);
    const analystId = subjectOf(analystToken);
    const workspaceId = (await restRequest(analystToken, "sentinel_members?select=workspace_id&limit=1")).body[0].workspace_id;

    // Seeded rather than borrowed: a decision advances status and appends events, so running
    // this against a case from the shared backlog would leave it decided for every later run.
    const seeded = await seedDecidableCase({ workspaceId, ownerId: analystId });

    try {
      await page.goto(`/cases/${seeded.reference}/decision`);
      // The decision step's static page heading (from stepCopy) always reads "Decision
      // record" whether or not DecisionPanel mounted, so it cannot tell "seeded case with a
      // real panel" apart from "case still on the not-built placeholder". The panel's own
      // <section aria-labelledby="decision-panel-title"> gets an implicit ARIA "region" role
      // from having an accessible name; only a mounted panel provides that role.
      await expect(page.getByRole("region", { name: "Decision record" })).toBeVisible();

      await page.getByRole("button", { name: /recommend approve/i }).click();
      await page.getByRole("textbox", { name: /rationale/i })
        .fill("Outlier is the annual settlement, confirmed against the ledger.");
      await page.getByRole("button", { name: /^record decision$/i }).click();

      // Assert the positive before any absence: this proves the panel re-rendered on real
      // data, which is what makes the missing-button check below mean anything. The page
      // heading badge above the panel now shares the same statusLabels mapping (the Important-1
      // fix for the two badges drifting), so "Pending approval" legitimately renders twice on
      // this page; scoping to the panel's own region keeps this assertion pinned to the one
      // element it means to check, same as the "Approved" assertion further down.
      await expect(
        page.getByRole("region", { name: "Decision record" }).getByText("Pending approval", { exact: true }),
      ).toBeVisible();
      await expect(page.getByText("Outlier is the annual settlement, confirmed against the ledger.")).toBeVisible();
      await expect(page.getByRole("button", { name: /recommend approve/i })).toHaveCount(0);

      const managerContext = await browser.newContext({ storageState: storageStatePath("manager") });
      try {
        const managerPage = await managerContext.newPage();
        await managerPage.goto(`/cases/${seeded.reference}/decision`);
        await expect(managerPage.getByRole("region", { name: "Decision record" })).toBeVisible();
        await expect(managerPage.getByText("Outlier is the annual settlement, confirmed against the ledger.")).toBeVisible();

        await managerPage.getByRole("button", { name: /^approve$/i }).click();
        await managerPage.getByRole("textbox", { name: /rationale/i }).fill("Ledger checks out. Approved.");
        await managerPage.getByRole("button", { name: /^record decision$/i }).click();

        // The decision history's own feed narrates the same event in lowercase prose
        // ("approved this case"), which getByText's case-insensitive substring match would
        // also catch, so the status badge is targeted through the region to keep this
        // assertion pinned to the one element it means to check.
        await expect(
          managerPage.getByRole("region", { name: "Decision record" }).getByText("Approved", { exact: true }),
        ).toBeVisible();

        // The workspace feed carries it too, with both sets of words.
        await managerPage.goto("/activity");
        await expect(managerPage.getByText("Ledger checks out. Approved.")).toBeVisible();
      } finally {
        await managerContext.close();
      }
    } finally {
      await removeSeededCase(seeded.id);
    }
  });
});
