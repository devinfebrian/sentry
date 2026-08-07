export const routes = {
  overview: "/",
  cases: "/cases",
  evidence: "/evidence",
  reports: "/reports",
  operations: "/operations",
  workspace: "/workspace",
} as const;

export const navigation = [
  { label: "Overview", path: routes.overview, group: "workspace" },
  { label: "Cases", path: routes.cases, group: "workspace" },
  { label: "Evidence", path: routes.evidence, group: "workspace" },
  { label: "Reports", path: routes.reports, group: "workspace" },
  { label: "Agent pipeline", path: routes.operations, group: "operations" },
  { label: "Activity log", path: `${routes.operations}?view=activity`, group: "operations" },
  { label: "Team and settings", path: routes.workspace, group: "settings" },
] as const;
