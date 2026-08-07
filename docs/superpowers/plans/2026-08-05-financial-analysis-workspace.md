# Financial Analysis Workspace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a responsive FinAI finance workspace that supports CSV/XLSX investigation intake, four-agent pipeline visibility, evidence review, accountable decisions, and report export.

**Architecture:** Build a frontend-first React application with typed domain fixtures and service seams for future agent and persistence APIs. Keep product areas split into shell, overview/operations, case/evidence/decision, and reporting modules. Use CSS custom properties for the approved Swiss editorial ledger system; keep data behavior independent from visual components.

**Tech Stack:** React, TypeScript, Vite, React Router, CSS custom properties, IBM Plex Sans, IBM Plex Mono, Vitest, Testing Library, Playwright, and SheetJS (`xlsx`) for CSV/XLSX parsing.

## Global Constraints

- Primary user is a finance analyst.
- First-release data entry uses CSV/XLSX uploads.
- ERP integrations and manual transaction-entry workflows are out of scope.
- Primary UI font is IBM Plex Sans.
- Numeric font is IBM Plex Mono.
- Use bold for headings, regular for body, and medium for labels.
- Minimum body size is `14px`.
- Desktop grid: 12 columns, max content width `1440px`.
- Mobile grid: 4 columns.
- Desktop content padding: `32px`.
- Mobile content padding: `20px`.
- Desktop grid gap: `24px`.
- Mobile grid gap: `16px`.
- Default radius: `2px`; use spacing and rules to group content.
- Touch targets: minimum `44px`.
- Meet WCAG 2.2 AA for text, controls, focus, and status communication.
- Target minimum contrast of `4.5:1` for body and labels and `3:1` for large text and controls.
- Pair every semantic color with text and/or icon.
- Respect `prefers-reduced-motion`; no required information depends on animation.
- Agent completion does not automatically approve a decision.
- Approval and overrides create immutable activity-log entries.

---

## File Map

### Project setup and styling

- Create: `package.json` - scripts and runtime/test dependencies.
- Create: `vite.config.ts` - Vite and Vitest configuration.
- Create: `index.html` - app entry document and font preloads if self-hosted.
- Create: `src/main.tsx` - React entry point.
- Create: `src/styles/tokens.css` - colors, type scale, spacing, grid, focus, and motion tokens.
- Create: `src/styles/global.css` - reset, typography defaults, tables, buttons, and responsive primitives.

### Domain and data seams

- Create: `src/domain/types.ts` - shared types for cases, agent stages, evidence, decisions, reports, and activity events.
- Create: `src/data/fixtures.ts` - realistic local data for overview, cases, evidence, decisions, and reports.
- Create: `src/services/agentRuns.ts` - typed read/retry interface for agent pipeline state.
- Create: `src/services/importData.ts` - CSV/XLSX file validation and normalization.

### Application shell and routes

- Create: `src/app/App.tsx` - route tree and app-level state providers.
- Create: `src/app/routes.ts` - route constants and route metadata.
- Create: `src/components/layout/AppShell.tsx` - responsive shell and navigation drawer behavior.
- Create: `src/components/layout/NavigationRail.tsx` - desktop rail and mobile drawer content.
- Create: `src/components/layout/WorkspaceHeader.tsx` - workspace identity, search, help, profile, and mobile menu button.

### Reusable UI

- Create: `src/components/ui/Button.tsx` - primary, secondary, quiet, and destructive actions.
- Create: `src/components/ui/StatusBadge.tsx` - icon/text/status color treatment.
- Create: `src/components/ui/EmptyState.tsx` - explanation plus one next action.
- Create: `src/components/ui/ErrorState.tsx` - failure explanation plus recovery action.
- Create: `src/components/ui/LoadingState.tsx` - non-motion layout-preserving loading treatment.
- Create: `src/components/ui/ToastRegion.tsx` - polite live announcements.

### Product modules

- Create: `src/components/operations/AgentPipeline.tsx` - four-stage pipeline summary/detail.
- Create: `src/components/operations/AgentStage.tsx` - one stage’s status, progress, counts, timestamps, and retry.
- Create: `src/components/cases/CaseQueue.tsx` - searchable, sortable, filterable case table.
- Create: `src/components/cases/CaseHeader.tsx` - case identity, status, risk, owner, and next action.
- Create: `src/components/evidence/EvidenceLedger.tsx` - source-linked evidence table and row detail.
- Create: `src/components/evidence/FindingPanel.tsx` - agent finding, confidence, and evidence links.
- Create: `src/components/decisions/DecisionRecord.tsx` - recommendation, rationale, approvals, and actions.
- Create: `src/components/reports/ReportComposer.tsx` - section navigation, editable content, preview, and export.
- Create: `src/components/reports/ReportPreview.tsx` - print/export-friendly report preview.

### Pages

- Create: `src/pages/OverviewPage.tsx` - actions, queue metrics, agent pipeline summary, active cases.
- Create: `src/pages/CasesPage.tsx` - case queue.
- Create: `src/pages/CaseWorkspacePage.tsx` - ordered case step rail and Summary/Findings/Evidence/Decision/Report views.
- Create: `src/pages/EvidencePage.tsx` - cross-case evidence ledger.
- Create: `src/pages/ReportsPage.tsx` - reports list and report composer entry.
- Create: `src/pages/OperationsPage.tsx` - full agent pipeline and activity log.
- Create: `src/pages/WorkspacePage.tsx` - team/settings placeholder with explicit out-of-scope messaging.

### Tests

- Create: `src/domain/types.test.ts` - fixture/type invariants.
- Create: `src/services/importData.test.ts` - file acceptance, parsing, and validation.
- Create: `src/components/operations/AgentPipeline.test.tsx` - stage rendering, failed state, retry, live status.
- Create: `src/components/cases/CaseQueue.test.tsx` - filtering, sorting, keyboard interaction.
- Create: `src/components/evidence/EvidenceLedger.test.tsx` - source link and row detail behavior.
- Create: `src/components/decisions/DecisionRecord.test.tsx` - approval, rationale, and immutable event behavior.
- Create: `src/components/reports/ReportComposer.test.tsx` - section order, editing, and export behavior.
- Create: `src/components/layout/AppShell.test.tsx` - navigation drawer, focus return, and status semantics.
- Create: `src/app/App.test.tsx` - route transitions, import rejection, and page states.
- Create: `tests/workspace.spec.ts` - Playwright smoke flow across overview, case workspace, and mobile layout.

---

## Task 1: Scaffold Application and Design Tokens

**Files:**
- Create: `package.json`
- Create: `vite.config.ts`
- Create: `index.html`
- Create: `src/main.tsx`
- Create: `src/styles/tokens.css`
- Create: `src/styles/global.css`
- Test: `vite.config.ts` through `npm run build` and `npm run test`

**Interfaces:**
- Produces: runnable Vite app at `/`, CSS variables used by every later component, and scripts `dev`, `build`, `test`, `test:e2e`.

- [ ] **Step 1: Create the React TypeScript Vite project files**

Use npm scripts with these commands and dependency groups:

```json
{
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:e2e": "playwright test"
  }
}
```

Add runtime dependencies `react`, `react-dom`, `react-router-dom`, `@fontsource/ibm-plex-sans`, `@fontsource/ibm-plex-mono`, and `xlsx`. Add dev dependencies `typescript`, `vite`, `@vitejs/plugin-react`, `vitest`, `jsdom`, `@testing-library/react`, `@testing-library/jest-dom`, `@testing-library/user-event`, `@playwright/test`, and `eslint`.

- [ ] **Step 2: Add the approved token values**

`src/styles/tokens.css` must define:

```css
:root {
  --color-paper: #f6f7f5;
  --color-surface: #ffffff;
  --color-ink: #17212b;
  --color-slate: #607080;
  --color-rule: #cbd3d8;
  --color-action: #2457a6;
  --color-risk: #b9433c;
  --color-confirm: #2d765d;
  --font-ui: "IBM Plex Sans", sans-serif;
  --font-numeric: "IBM Plex Mono", monospace;
  --text-display: 700 36px/40px var(--font-ui);
  --text-section: 700 24px/28px var(--font-ui);
  --text-card: 700 18px/24px var(--font-ui);
  --text-body-large: 400 16px/24px var(--font-ui);
  --text-body: 400 14px/21px var(--font-ui);
  --text-label: 500 13px/18px var(--font-ui);
  --text-caption: 500 12px/16px var(--font-ui);
  --text-metric: 500 28px/32px var(--font-numeric);
  --text-number: 400 14px/20px var(--font-numeric);
  --space-page: 32px;
  --space-grid: 24px;
  --control-height: 44px;
  --focus-ring: 0 0 0 2px var(--color-paper), 0 0 0 4px var(--color-action);
}

@media (max-width: 720px) {
  :root {
    --space-page: 20px;
    --space-grid: 16px;
  }
}
```

- [ ] **Step 3: Add reset, typography, focus, and reduced-motion styles**

Set `body` background to Paper, color to Ink, font to UI, and `font-size: 14px`. Define `:focus-visible` using `--focus-ring`. Set `@media (prefers-reduced-motion: reduce)` to disable transitions and animations. Define numeric utility class that uses IBM Plex Mono and `font-variant-numeric: tabular-nums`.

- [ ] **Step 4: Run scaffold verification**

Run: `npm run build`

Expected: Vite production build succeeds with no TypeScript errors.

Run: `npm run test`

Expected: Vitest starts with zero test failures.

---

## Task 2: Define Domain Types, Fixtures, and Service Seams

**Files:**
- Create: `src/domain/types.ts`
- Create: `src/data/fixtures.ts`
- Create: `src/services/agentRuns.ts`
- Create: `src/services/importData.ts`
- Test: `src/domain/types.test.ts`
- Test: `src/services/importData.test.ts`

**Interfaces:**
- Produces: `AgentStage`, `CaseSummary`, `EvidenceRecord`, `Finding`, `DecisionRecord`, `ReportSection`, `ActivityEvent`, `AgentRunService`, and `ImportResult` used by all UI modules.

- [ ] **Step 1: Write failing type and fixture tests**

```ts
import { describe, expect, it } from "vitest";
import { fixtureCases, fixturePipeline } from "../data/fixtures";

describe("fixtures", () => {
  it("contains all four ordered agent stages", () => {
    expect(fixturePipeline.map((stage) => stage.order)).toEqual([1, 2, 3, 4]);
    expect(fixturePipeline.map((stage) => stage.name)).toEqual([
      "Financial analysis investigator",
      "Fraud pattern investigator",
      "Evidence review and decision",
      "Reporting",
    ]);
  });

  it("links active cases to a stage", () => {
    expect(fixtureCases.every((item) => item.stageId.length > 0)).toBe(true);
  });
});
```

- [ ] **Step 2: Define exact domain types**

Use discriminated unions so status color and action behavior cannot drift:

```ts
export type AgentStatus = "waiting" | "running" | "review" | "complete" | "blocked" | "failed";
export type RiskLevel = "low" | "medium" | "high";
export type EvidenceState = "unreviewed" | "reviewed" | "supports" | "contradicts" | "needs-source";

export interface AgentStage {
  id: string;
  order: 1 | 2 | 3 | 4;
  name: string;
  status: AgentStatus;
  completed: number;
  total: number;
  startedAt?: string;
  completedAt?: string;
  failureReason?: string;
}

export interface CaseSummary {
  id: string;
  entity: string;
  owner: string;
  risk: RiskLevel;
  stageId: string;
  status: "open" | "review" | "approved" | "closed";
  ageDays: number;
  lastActivity: string;
}

export interface EvidenceRecord {
  id: string;
  caseId: string;
  source: string;
  claim: string;
  agent: string;
  confidence: number;
  state: EvidenceState;
  timestamp: string;
  relevance: "supporting" | "contradictory" | "context";
}

export interface ActivityEvent {
  id: string;
  caseId: string;
  type: "approval" | "rejection" | "evidence-request" | "agent-retry";
  actor: string;
  timestamp: string;
  rationale: string;
}
```

Add these exact interfaces using the same naming and status vocabulary:

```ts
export interface Finding {
  id: string;
  caseId: string;
  agent: string;
  summary: string;
  confidence: number;
  evidenceIds: string[];
  contradictoryEvidenceIds: string[];
}

export interface DecisionRecord {
  id: string;
  caseId: string;
  recommendation: "approve" | "reject" | "request-evidence";
  rationale: string;
  unresolvedQuestions: string[];
  approver?: string;
  decidedAt?: string;
  history: ActivityEvent[];
  isApproved: boolean;
}

export interface ReportSection {
  id: "executive-summary" | "scope" | "methods" | "findings" | "evidence" | "decision" | "limitations";
  title: string;
  content: string;
  isEditable: boolean;
}

export interface ImportRow {
  entity: string;
  values: Record<string, string | number>;
  sourceRow: number;
}

export interface ImportResult {
  rows: ImportRow[];
  warnings: string[];
}
```

`DecisionRecord` must include `recommendation`, `rationale`, `approver`, `history`, and `isApproved`.

- [ ] **Step 3: Implement deterministic fixtures**

Create at least 6 cases, 4 pipeline stages, 12 evidence rows, 4 findings, one pending decision, and one report. Use finance-specific names and values from the design preview, not lorem ipsum.

- [ ] **Step 4: Implement service contracts with fixture-backed behavior**

```ts
export interface AgentRunService {
  listStages(): Promise<AgentStage[]>;
  retryStage(stageId: string): Promise<AgentStage>;
}

export const agentRunService: AgentRunService = {
  async listStages() { return fixturePipeline; },
  async retryStage(stageId) {
    const stage = fixturePipeline.find((item) => item.id === stageId);
    if (!stage) throw new Error("Agent stage not found");
    return { ...stage, status: "running" };
  },
};
```

Keep this adapter independent of components so a future API client replaces fixture behavior without redesigning UI contracts.

- [ ] **Step 5: Implement CSV/XLSX normalization**

`importData(file: File): Promise<ImportResult>` accepts `.csv`, `.xlsx`, and `.xls`, rejects other extensions, rejects empty files, reads the first sheet, maps headers case-insensitively, and requires `entity` plus at least one numeric transaction/value column. Return `{ rows, warnings }` or throw a user-facing error with recovery text.

- [ ] **Step 6: Run domain tests**

Run: `npm run test -- src/domain/types.test.ts src/services/importData.test.ts`

Expected: PASS for ordered stages, fixture links, accepted file types, rejected file types, empty sheets, and required headers.

---

## Task 3: Build Responsive Shell and Shared UI Primitives

**Files:**
- Create: `src/app/routes.ts`
- Create: `src/app/App.tsx`
- Create: `src/components/layout/AppShell.tsx`
- Create: `src/components/layout/NavigationRail.tsx`
- Create: `src/components/layout/WorkspaceHeader.tsx`
- Create: `src/components/ui/Button.tsx`
- Create: `src/components/ui/StatusBadge.tsx`
- Create: `src/components/ui/EmptyState.tsx`
- Create: `src/components/ui/ErrorState.tsx`
- Create: `src/components/ui/LoadingState.tsx`
- Create: `src/components/ui/ToastRegion.tsx`
- Modify: `src/main.tsx`
- Test: `src/components/layout/AppShell.test.tsx`

**Interfaces:**
- Consumes: domain types and design tokens from Tasks 1-2.
- Produces: `AppShell`, `Button`, `StatusBadge`, `EmptyState`, `ErrorState`, `LoadingState`, and `ToastRegion` components with accessible props.

- [ ] **Step 1: Write failing shell tests**

```tsx
it("renders navigation and opens mobile drawer", async () => {
  render(<AppShell><div>Content</div></AppShell>);
  expect(screen.getByRole("navigation")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: /open navigation/i }));
  expect(screen.getByRole("dialog", { name: /workspace navigation/i })).toBeVisible();
});

it("status badge exposes text, not color alone", () => {
  render(<StatusBadge status="high" label="High risk" />);
  expect(screen.getByText("High risk")).toBeVisible();
});
```

- [ ] **Step 2: Implement route metadata and shell**

Use route metadata with labels and paths:

```ts
export const routes = {
  overview: "/",
  cases: "/cases",
  evidence: "/evidence",
  reports: "/reports",
  operations: "/operations",
  workspace: "/workspace",
} as const;
```

Render desktop rail at widths above `720px`; render a dialog-backed drawer below `720px`. Drawer close returns focus to menu button. Header includes visible text labels for Search, Help, profile, and menu.

- [ ] **Step 3: Implement shared primitives**

`Button` supports `primary`, `secondary`, `quiet`, and `destructive`; all variants preserve `44px` height and visible focus. `StatusBadge` maps status to icon, text label, and semantic token. Empty/error/loading states preserve content hierarchy and include an action where appropriate. Toast region uses `aria-live="polite"`.

- [ ] **Step 4: Mount app and run tests**

Run: `npm run test -- src/components/layout/AppShell.test.tsx`

Expected: PASS for desktop navigation semantics, mobile drawer semantics, focus return, and text-based status communication.

---

## Task 4: Build Overview and Agent Pipeline

**Files:**
- Create: `src/components/operations/AgentPipeline.tsx`
- Create: `src/components/operations/AgentStage.tsx`
- Create: `src/pages/OverviewPage.tsx`
- Create: `src/pages/OperationsPage.tsx`
- Test: `src/components/operations/AgentPipeline.test.tsx`

**Interfaces:**
- Consumes: `AgentStage`, `CaseSummary`, `AgentRunService`, `StatusBadge`, and shell routes.
- Produces: overview summary pipeline and full operations pipeline with retry behavior.

- [ ] **Step 1: Write failing pipeline tests**

```tsx
it("renders all four stages in order with progress", () => {
  render(<AgentPipeline stages={fixturePipeline} mode="summary" />);
  expect(screen.getAllByRole("listitem").map((item) => item.textContent)).toEqual(
    expect.arrayContaining([
      expect.stringContaining("Financial analysis investigator"),
      expect.stringContaining("Fraud pattern investigator"),
      expect.stringContaining("Evidence review and decision"),
      expect.stringContaining("Reporting"),
    ]),
  );
  expect(screen.getByText("18 / 22 complete")).toBeVisible();
});

it("offers retry for failed stage and announces new status", async () => {
  const retry = vi.fn().mockResolvedValue({ ...fixturePipeline[1], status: "running" });
  render(<AgentPipeline stages={[{ ...fixturePipeline[1], status: "failed", failureReason: "Source unavailable" }]} onRetry={retry} mode="detail" />);
  await userEvent.click(screen.getByRole("button", { name: /retry fraud pattern investigator/i }));
  expect(retry).toHaveBeenCalledWith(fixturePipeline[1].id);
  expect(screen.getByRole("status")).toHaveTextContent(/running/i);
});
```

- [ ] **Step 2: Implement `AgentStage`**

Show order, name, status text, progress bar with accessible `aria-valuenow`, completion count, and timestamps. Failed state includes failure reason and Retry button. Review state uses `Review queue`, not generic warning text. Do not use color without visible status text.

- [ ] **Step 3: Implement `AgentPipeline` summary/detail modes**

Summary mode shows four compact columns and `View full pipeline`. Detail mode stacks stages as an ordered sequence and includes active case links plus activity log heading. Use `aria-live="polite"` only around changed status text.

- [ ] **Step 4: Implement Overview content**

Render page context, `New investigation`, `Import data`, queue metrics, pipeline summary, and active case links. Numeric values use IBM Plex Mono and right alignment. `Import data` opens the file picker and sends the selected file to `importData` from Task 2.

- [ ] **Step 5: Implement Operations page**

Render full pipeline, failed/retry states, timestamps, input/output counts, and activity log. Retry keeps decision approval separate and does not set a decision to approved.

- [ ] **Step 6: Run pipeline tests**

Run: `npm run test -- src/components/operations/AgentPipeline.test.tsx`

Expected: PASS for four-stage order, progress semantics, retry callback, failure text, live status, summary/detail layout, and accessible numeric values.

---

## Task 5: Build Case Queue, Case Workspace, and Ordered Step Rail

**Files:**
- Create: `src/components/cases/CaseQueue.tsx`
- Create: `src/components/cases/CaseHeader.tsx`
- Create: `src/pages/CasesPage.tsx`
- Create: `src/pages/CaseWorkspacePage.tsx`
- Test: `src/components/cases/CaseQueue.test.tsx`

**Interfaces:**
- Consumes: `CaseSummary`, `fixtureCases`, `StatusBadge`, `Button`, and `AgentPipeline` links.
- Produces: filterable case queue and case workspace route `/cases/:caseId/:step` with steps `summary`, `findings`, `evidence`, `decision`, `report`.

- [ ] **Step 1: Write failing queue tests**

```tsx
it("filters cases by risk and keeps table headers accessible", async () => {
  render(<CaseQueue cases={fixtureCases} />);
  expect(screen.getByRole("columnheader", { name: /risk/i })).toBeInTheDocument();
  await userEvent.selectOptions(screen.getByRole("combobox", { name: /risk/i }), "high");
  expect(screen.getAllByRole("row")).toHaveLength(2); // header plus one high-risk case
});

it("sorts numeric age values and preserves selected case link", async () => {
  render(<CaseQueue cases={fixtureCases} />);
  await userEvent.click(screen.getByRole("button", { name: /sort age/i }));
  expect(screen.getByRole("link", { name: /northstar ltd/i })).toHaveAttribute("href", expect.stringContaining("/cases/"));
});
```

- [ ] **Step 2: Implement `CaseQueue`**

Use a semantic table with `scope="col"`, sort buttons, risk/status/stage/owner filters, date range field, and empty state. Preserve filters in URL search params so back navigation restores queue state. Use horizontal scroll below mobile breakpoint rather than shrinking below readable text size.

- [ ] **Step 3: Implement `CaseHeader` and step rail**

Show case ID, entity, owner, risk, overall state, and one next action. Render ordered steps in this exact order: Summary, Findings, Evidence, Decision, Report. Current step uses text and `aria-current="step"`; completed steps expose completion text.

- [ ] **Step 4: Implement route pages**

`CasesPage` renders queue. `CaseWorkspacePage` loads case by route param and renders step-specific content placeholders only where later tasks provide the module, with explicit loading and missing-case error states.

- [ ] **Step 5: Run queue tests**

Run: `npm run test -- src/components/cases/CaseQueue.test.tsx`

Expected: PASS for filter semantics, sortable table headers, URL state, keyboard operation, step order, and mobile overflow behavior.

---

## Task 6: Build Findings, Evidence Ledger, and Decision Record

**Files:**
- Create: `src/components/evidence/EvidenceLedger.tsx`
- Create: `src/components/evidence/FindingPanel.tsx`
- Create: `src/components/decisions/DecisionRecord.tsx`
- Create: `src/pages/EvidencePage.tsx`
- Test: `src/components/evidence/EvidenceLedger.test.tsx`
- Test: `src/components/decisions/DecisionRecord.test.tsx`

**Interfaces:**
- Consumes: `EvidenceRecord`, `Finding`, `DecisionRecord`, `ActivityEvent`, `CaseHeader`, and ordered step rail.
- Produces: source-linked evidence review and decision actions that append immutable activity events.

- [ ] **Step 1: Write failing evidence and decision tests**

```tsx
it("shows source, agent, confidence, reviewer state, and relevance", () => {
  render(<EvidenceLedger records={fixtureEvidence} />);
  expect(screen.getByRole("columnheader", { name: /source/i })).toBeInTheDocument();
  expect(screen.getByText(/fraud pattern investigator/i)).toBeVisible();
  expect(screen.getByText(/needs source/i)).toBeVisible();
});

it("requires rationale when analyst changes recommendation", async () => {
  const onDecision = vi.fn();
  render(<DecisionRecord decision={fixtureDecision} onDecision={onDecision} />);
  await userEvent.click(screen.getByRole("button", { name: /reject recommendation/i }));
  expect(screen.getByRole("textbox", { name: /rationale/i })).toBeRequired();
  expect(onDecision).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Implement `EvidenceLedger`**

Render semantic table rows with source, claim/transaction, agent, confidence, state, timestamp, and relevance. Selecting row opens an inline or dialog source context while preserving selected row and scroll position. Status text and icon must remain visible without color.

- [ ] **Step 3: Implement `FindingPanel`**

Show finding summary, confidence, originating agent, source evidence links, and contradictory evidence when available. Never render an agent conclusion without at least one source link or an explicit `Needs source` state.

- [ ] **Step 4: Implement `DecisionRecord`**

Show recommendation, rationale, supporting/contradictory evidence, unresolved questions, approver, timestamp, and revision history. `Approve decision`, `Request more evidence`, and `Reject recommendation` are explicit actions. If selected action changes recommendation, require rationale and append an `ActivityEvent`; do not mutate prior history entries.

- [ ] **Step 5: Implement Evidence page and case step integration**

`EvidencePage` provides cross-case ledger search/filter. Case workspace Evidence and Decision steps use the same components with case-scoped data.

- [ ] **Step 6: Run evidence and decision tests**

Run: `npm run test -- src/components/evidence/EvidenceLedger.test.tsx src/components/decisions/DecisionRecord.test.tsx`

Expected: PASS for source traceability, row detail, text/icon states, rationale validation, immutable event append, and separation between agent completion and decision approval.

---

## Task 7: Build Report Composer, Preview, and Export

**Files:**
- Create: `src/components/reports/ReportComposer.tsx`
- Create: `src/components/reports/ReportPreview.tsx`
- Create: `src/pages/ReportsPage.tsx`
- Test: `src/components/reports/ReportComposer.test.tsx`

**Interfaces:**
- Consumes: `ReportSection`, `EvidenceRecord`, `DecisionRecord`, and `Button`.
- Produces: editable structured report, print-friendly preview, and explicit PDF export action.

- [ ] **Step 1: Write failing report tests**

```tsx
it("renders required report sections in order", () => {
  render(<ReportComposer sections={fixtureReportSections} />);
  expect(screen.getAllByRole("heading").map((heading) => heading.textContent)).toEqual([
    "Executive summary",
    "Scope",
    "Methods",
    "Findings",
    "Evidence",
    "Decision",
    "Limitations",
  ]);
});

it("labels export action with format", () => {
  render(<ReportComposer sections={fixtureReportSections} />);
  expect(screen.getByRole("button", { name: /export pdf/i })).toBeVisible();
});
```

- [ ] **Step 2: Implement report section navigation and editing**

Render fixed section list on desktop, stacked list on mobile, editable fields with labels, and unsaved-change indicator. Keep report content tied to reviewed evidence and decision data; show limitations section even when empty with a next action.

- [ ] **Step 3: Implement `ReportPreview`**

Use a semantic article with report title, case metadata, executive summary, findings, evidence references, decision, approval history, and limitations. Keep preview readable at desktop and mobile widths.

- [ ] **Step 4: Implement export**

Use browser print styles for PDF export, set document title to case/report name, and announce export start/completion through `ToastRegion`. Do not promise a file if print/export fails; show recovery text.

- [ ] **Step 5: Run report tests**

Run: `npm run test -- src/components/reports/ReportComposer.test.tsx`

Expected: PASS for section order, editable labels, preview content, explicit PDF action, and export announcement.

---

## Task 8: Wire Routes, Import Flow, and Complete Page States

**Files:**
- Modify: `src/app/App.tsx`
- Modify: `src/pages/OverviewPage.tsx`
- Modify: `src/pages/CasesPage.tsx`
- Modify: `src/pages/CaseWorkspacePage.tsx`
- Modify: `src/pages/EvidencePage.tsx`
- Modify: `src/pages/ReportsPage.tsx`
- Modify: `src/pages/OperationsPage.tsx`
- Create: `src/components/import/ImportDialog.tsx`
- Create: `src/components/activity/ActivityLog.tsx`
- Test: `src/app/App.test.tsx`

**Interfaces:**
- Consumes: all routes and modules from Tasks 3-7.
- Produces: connected workflow from overview through report and consistent loading/empty/error states.

- [ ] **Step 1: Write failing route and import tests**

```tsx
it("navigates from overview to a case and preserves case step order", async () => {
  render(<App />);
  await userEvent.click(screen.getByRole("link", { name: /northstar ltd/i }));
  expect(screen.getByRole("navigation", { name: /case steps/i })).toHaveTextContent("SummaryFindingsEvidenceDecisionReport");
});

it("rejects unsupported imports with recovery text", async () => {
  render(<ImportDialog open onClose={vi.fn()} onImported={vi.fn()} />);
  const file = new File(["data"], "notes.txt", { type: "text/plain" });
  await userEvent.upload(screen.getByLabelText(/financial data file/i), file);
  expect(screen.getByRole("alert")).toHaveTextContent(/csv, xls, or xlsx/i);
});
```

- [ ] **Step 2: Wire all routes**

Mount Overview at `/`, Cases at `/cases`, case workspace at `/cases/:caseId/:step`, Evidence at `/evidence`, Reports at `/reports`, Operations at `/operations`, and Workspace at `/workspace`. Redirect unknown case steps to `summary` and unknown routes to `/` with a visible not-found state.

- [ ] **Step 3: Implement `ImportDialog`**

Use dialog semantics, file input label `Financial data file`, accepted extensions `.csv,.xlsx,.xls`, validation from `importData`, preview first five normalized rows, warning list, and `Import data` confirmation. Close returns focus to the triggering action.

- [ ] **Step 4: Implement activity log**

Render immutable agent retry and decision events with actor, timestamp, rationale, and event type. Use semantic list markup and plain text labels.

- [ ] **Step 5: Add explicit page states**

Every page must provide loading, empty, error, and populated branches. Empty branches name what is missing and provide one next action. Error branches preserve available data when possible and expose retry.

- [ ] **Step 6: Run application tests**

Run: `npm run test -- src/app/App.test.tsx`

Expected: PASS for route transitions, case step order, unknown route handling, import rejection, focus return, and complete state branches.

---

## Task 9: Accessibility, Responsive QA, and End-to-End Verification

**Files:**
- Create: `playwright.config.ts`
- Create: `tests/workspace.spec.ts`
- Modify: `src/styles/global.css`
- Modify: component files where automated checks identify violations

**Interfaces:**
- Consumes: complete app from Tasks 1-8.
- Produces: repeatable browser verification for desktop and mobile workflows.

- [ ] **Step 1: Write end-to-end smoke tests**

```ts
import { test, expect } from "@playwright/test";

test("analyst can inspect pipeline and open evidence", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: /overview/i })).toBeVisible();
  await expect(page.getByText("Financial analysis investigator")).toBeVisible();
  await page.getByRole("link", { name: /northstar ltd/i }).click();
  await page.getByRole("link", { name: /^evidence$/i }).click();
  await expect(page.getByRole("table")).toBeVisible();
  await expect(page.getByText(/source/i)).toBeVisible();
});

test("mobile shell exposes drawer and readable pipeline", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.getByRole("button", { name: /open navigation/i }).click();
  await expect(page.getByRole("dialog", { name: /workspace navigation/i })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: /open navigation/i })).toBeFocused();
});
```

- [ ] **Step 2: Add Playwright configuration**

Configure Chromium, start command `npm run dev -- --host 127.0.0.1`, base URL `http://127.0.0.1:5173`, and trace collection on first retry.

- [ ] **Step 3: Run static and unit verification**

Run: `npm run build`

Expected: PASS with no TypeScript or bundling errors.

Run: `npm run test`

Expected: PASS with all unit and component tests.

- [ ] **Step 4: Run end-to-end verification**

Run: `npm run test:e2e`

Expected: PASS for desktop pipeline/evidence flow and mobile drawer/focus return.

- [ ] **Step 5: Perform manual accessibility pass**

Verify with keyboard only: open/close drawer, navigate every link, sort/filter table, open evidence detail, complete decision action, edit report, and export. Verify focus remains visible, status text is announced, table headers are associated, and no action depends on color or hover.

- [ ] **Step 6: Perform responsive visual pass**

Check widths `1440px`, `1024px`, `768px`, and `390px`. Confirm navigation, 12/4-column grids, agent stage stacking, table scroll/readability, report preview stacking, `44px` targets, and no horizontal page overflow outside intentionally scrollable tables.

---

## Plan Self-Review

### Spec coverage

- Product goal and finance analyst workflow: Tasks 2, 4, 5, 6, 7, and 8.
- Four-agent pipeline: Tasks 2 and 4.
- CSV/XLSX intake: Tasks 2 and 8.
- Editorial ledger visual system: Tasks 1, 3, 5, and 6.
- Case queue and ordered case workspace: Task 5.
- Evidence traceability: Task 6.
- Accountable decision and immutable activity log: Tasks 6 and 8.
- Structured report and PDF export: Task 7.
- Responsive/mobile behavior: Tasks 3, 5, 7, and 9.
- WCAG 2.2 AA, focus, live status, reduced motion, and keyboard behavior: Tasks 1, 3, 4, 6, 8, and 9.
- Out-of-scope ERP integrations, manual transaction entry, native mobile app, prompt authoring, billing, and collaboration cursors: Global Constraints and Task 2/8 boundaries.

### Placeholder scan

No `TBD`, `TODO`, vague future step, or unnamed interface remains. Fixture-backed services are explicitly defined as the current implementation seam, not an unfinished task.

### Type consistency

`AgentStage`, `CaseSummary`, `EvidenceRecord`, `ActivityEvent`, and `AgentRunService` are defined in Task 2 and consumed with the same names in later tasks. Routes and case steps are defined in Tasks 3 and 5, then wired in Task 8 without alternate names.
