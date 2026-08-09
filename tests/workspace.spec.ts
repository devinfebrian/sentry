import { expect, test, type Page } from "@playwright/test";
import { fixturePath, requireCredentials, storageStatePath } from "./env";

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
    // Agent output genuinely has not run, and must still say so.
    await expect(page.getByRole("heading", { name: /analysis not started/i })).toBeVisible();

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
