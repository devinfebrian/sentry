import { expect, test as setup } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { requireCredentials, storageStatePath, type TestRole } from "./env";

async function signIn(page: Parameters<Parameters<typeof setup>[1]>[0]["page"], role: TestRole) {
  const { email, password } = requireCredentials(role);

  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();

  // Landing anywhere outside /sign-in means the membership check passed. A pending or
  // missing membership keeps the guard on screen, so assert we actually left the page
  // rather than storing a useless signed-out state.
  await page.waitForURL((url) => !url.pathname.startsWith("/sign-in"), { timeout: 30_000 });
  await expect(page.getByRole("heading", { name: "Team and settings" })
    .or(page.getByRole("heading", { name: "Overview" })).first()).toBeVisible({ timeout: 30_000 });

  const target = storageStatePath(role);
  mkdirSync(dirname(target), { recursive: true });
  await page.context().storageState({ path: target });
}

setup("authenticate as manager", async ({ page }) => {
  await signIn(page, "manager");
});

setup("authenticate as analyst", async ({ page }) => {
  await signIn(page, "analyst");
});
