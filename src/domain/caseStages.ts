import type { CaseStage } from "./types";

/**
 * Display copy for each case stage.
 *
 * Typed as `Record<CaseStage, string>` so adding a stage without adding a label is a compile
 * error — the alternative is a `?? item.stageId` fallback that quietly leaks raw slugs into
 * the UI instead of failing the build.
 *
 * Shared by CaseQueue and OverviewPage, which both render a case's stage. One copy so the two
 * cannot drift the way `not-assessed` / `not-started` did.
 */
export const CASE_STAGE_LABELS: Record<CaseStage, string> = {
  "awaiting-import": "Awaiting import",
  analysing: "Analysing",
  "analysis-failed": "Analysis failed",
  "awaiting-analysis": "Awaiting analysis",
  "fraud-review": "Fraud review",
  analysed: "Analysed",
};
