export const routes = {
  overview: "/",
  cases: "/cases",
  evidence: "/evidence",
  reports: "/reports",
  operations: "/operations",
  activity: "/activity",
  workspace: "/workspace",
} as const;

export const navigation = [
  { label: "Overview", path: routes.overview, group: "workspace" },
  { label: "Cases", path: routes.cases, group: "workspace" },
  { label: "Evidence", path: routes.evidence, group: "workspace" },
  { label: "Reports", path: routes.reports, group: "workspace" },
  { label: "Agent pipeline", path: routes.operations, group: "operations" },
  // A real path, not a query string: NavigationRail matches on pathname alone, so
  // "/operations?view=activity" could never highlight and Agent pipeline won at both.
  { label: "Activity log", path: routes.activity, group: "operations" },
  { label: "Team and settings", path: routes.workspace, group: "settings" },
] as const;
