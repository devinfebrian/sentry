import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

function readSource(relativePath: string) {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");
}

describe("production fixture boundary", () => {
  it.each([
    "../pages/OverviewPage.tsx",
    "../pages/CasesPage.tsx",
    "../pages/CaseWorkspacePage.tsx",
    "../pages/OperationsPage.tsx",
  ])(
    "keeps fixture data out of %s",
    (pagePath) => {
      expect(readSource(pagePath)).not.toMatch(/(?:from|import)\s*["'][^"']*fixtures["']/);
    },
  );

  it("loads demo routes through a DEV-only dynamic boundary", () => {
    const appSource = readSource("./App.tsx");

    expect(appSource).toMatch(/import\.meta\.env\.DEV/);
    expect(appSource).toMatch(/import\(["']\.\.\/demo\/DemoRoutes["']\)/);
    /**
     * This previously froze the path `../pages/OperationsPage`, which the fixture-backed
     * pages occupied before they moved under demo/. A real, fixture-free page lives there
     * now, so the guard checks the property it was always about: App.tsx reaches demo/ only
     * through the dynamic DEV import above, never through a static one that would bundle
     * fixtures into production.
     */
    expect(appSource).not.toMatch(/from\s+["'][^"']*\/demo\//);
  });
});
