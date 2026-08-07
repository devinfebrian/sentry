import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

function readSource(relativePath: string) {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");
}

describe("production fixture boundary", () => {
  it.each(["../pages/OverviewPage.tsx", "../pages/CasesPage.tsx", "../pages/CaseWorkspacePage.tsx"])(
    "keeps fixture data out of %s",
    (pagePath) => {
      expect(readSource(pagePath)).not.toMatch(/(?:from|import)\s*["'][^"']*fixtures["']/);
    },
  );

  it("loads demo routes through a DEV-only dynamic boundary", () => {
    const appSource = readSource("./App.tsx");

    expect(appSource).toMatch(/import\.meta\.env\.DEV/);
    expect(appSource).toMatch(/import\(["']\.\.\/demo\/DemoRoutes["']\)/);
    expect(appSource).not.toMatch(/from\s+["']\.\.\/pages\/(?:EvidencePage|ReportsPage|OperationsPage)["']/);
  });
});
