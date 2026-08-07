# Financial Analysis Workspace Design

**Date:** 2026-08-05
**Status:** Approved design
**Product:** FinAI financial analysis workspace

## Goal

Give finance departments one reviewable workspace for importing financial data, running four analysis agents, reviewing evidence, approving decisions, and producing audit-ready reports.

## Users and First-Release Scope

Primary user is a finance analyst. Finance managers need assignment, approval, and operational visibility. Audit and compliance users need traceable evidence and decision history.

First-release data entry uses CSV/XLSX uploads. ERP integrations and manual transaction entry are out of scope for this design cycle.

The product covers one connected workflow:

1. Analyst creates an investigation and imports financial data.
2. Four agents process the investigation:
   - Financial analysis investigator
   - Fraud pattern investigator
   - Evidence review and decision
   - Reporting
3. Analyst reviews findings and linked evidence.
4. Manager or authorized reviewer approves, rejects, or requests more evidence.
5. Analyst exports the structured report.

## Product Direction

### Editorial Ledger

The interface follows an editorial ledger direction: quiet, rigorous, report-like, and optimized for review. Swiss grid structure, hairline rules, restrained density, and strong typographic hierarchy make work legible without turning the product into a command center.

The evidence ledger is the signature element. Every important finding links to a source row, originating agent, timestamp, confidence, reviewer, and decision relevance. This makes the interface feel like a financial record rather than a generic analytics dashboard.

Operational monitoring remains present but secondary. The agent pipeline is a first-class Operations destination and a compact overview module, while evidence and decisions remain the center of case work.

## Information Architecture

```text
FinAI / workspace
|
|-- Overview
|   |-- Agent pipeline summary
|   |-- Active case links
|   |-- Queue metrics
|
|-- Cases
|   |-- Case queue
|   |-- New investigation
|   |-- Case workspace
|       |-- Summary
|       |-- Findings
|       |-- Evidence
|       |-- Decision
|       |-- Report
|
|-- Evidence
|   |-- Evidence ledger
|   |-- Source and claim search
|
|-- Reports
|   |-- Report list
|   |-- Report composer
|
|-- Operations
|   |-- Agent pipeline
|   |-- Activity log
|
|-- Workspace
    |-- Team and settings
```

## Primary Shell

Desktop shell uses a `216px` navigation rail and flexible main content. Header includes workspace identity, search, help, and user profile. Navigation groups are Overview, Cases, Evidence, Reports, Operations, and Workspace.

```text
+--------------------------------------------------------------------+
| FinAI / workspace                         Search  Help  Profile   |
+---------------+----------------------------------------------------+
| Overview       | Page title + workspace context                   |
| Cases          |                                                    |
| Evidence       | Main content: queue, pipeline, ledger, report      |
| Reports        |                                                    |
| Operations     |                                                    |
| Workspace      |                                                    |
+---------------+----------------------------------------------------+
```

Overview includes a compact AgentPipeline module with all four stages, current run state, progress, completion count, and linked active cases. A `View full pipeline` action opens the detailed Operations view.

## Core Screens

### Overview

Purpose: orient analyst or manager within seconds.

Content order:

1. Page context and actions: `New investigation`, `Import data`.
2. Agent pipeline summary.
3. Queue metrics: open cases, high risk, evidence ready.
4. Active case links with stage, risk, and next action.

### Case Queue

Purpose: select the next investigation.

Use a horizontal-rule table with sortable columns for case/entity, owner, stage, risk, age, and last activity. Filters cover status, risk, owner, stage, and date range. Preserve query state when returning from a case.

### Case Workspace

Purpose: move from raw input to defensible decision.

Case header shows case ID, entity, owner, risk, overall state, and next action. Content uses a clearly ordered step rail for Summary, Findings, Evidence, Decision, and Report. Agent output never appears without source links or explicit confidence.

### Agent Pipeline

Purpose: make automation observable and controllable.

Display four stages in sequence with status, progress, started/completed timestamps, input/output counts, and current case links. Supported visible states are `Waiting`, `Running`, `Review queue`, `Complete`, `Blocked`, and `Failed`. Failed stages expose a plain-language reason and `Retry` action; never hide failure behind color.

### Evidence Ledger

Purpose: let analyst validate claims quickly.

Each row includes source, claim or transaction, agent, confidence, reviewer state, timestamp, and decision relevance. Selecting a row opens source context without losing ledger position. Evidence states use text plus icon: `Unreviewed`, `Reviewed`, `Supports`, `Contradicts`, `Needs source`.

### Decision Record

Purpose: preserve accountable approval.

Show recommendation, rationale, supporting and contradictory evidence, unresolved questions, approver, decision timestamp, and revision history. Primary actions are `Approve decision`, `Request more evidence`, and `Reject recommendation`. Approval requires rationale when changing the agent recommendation.

### Report Composer

Purpose: turn reviewed work into an exportable record.

Use structured sections for executive summary, scope, methods, findings, evidence, decision, and limitations. Show report preview beside section navigation on desktop; stack on mobile. Export action names format and state explicitly, such as `Export PDF`.

## Visual System

### Typography

Primary UI font is IBM Plex Sans. Numeric font is IBM Plex Mono. Load both with local or self-hosted font assets when possible.

| Role | Size / line height | Weight | Font |
|---|---:|---:|---|
| Display page title | 36 / 40 px | 700 | IBM Plex Sans |
| Section title | 24 / 28 px | 700 | IBM Plex Sans |
| Card title | 18 / 24 px | 700 | IBM Plex Sans |
| Body large | 16 / 24 px | 400 | IBM Plex Sans |
| Body | 14 / 21 px | 400 | IBM Plex Sans |
| Label | 13 / 18 px | 500 | IBM Plex Sans |
| Caption | 12 / 16 px | 500 | IBM Plex Sans |
| Numeric metric | 28 / 32 px | 500 | IBM Plex Mono |
| Numeric table value | 14 / 20 px | 400 | IBM Plex Mono |

Use bold for headings, regular for body, and medium for labels. Use sentence case by default. Numeric columns are right-aligned. Minimum body size is `14px`.

### Color Tokens

| Token | Hex | Role |
|---|---|---|
| Paper | `#F6F7F5` | App background |
| Surface | `#FFFFFF` | Tables, cards, panels |
| Ink | `#17212B` | Headings and primary text |
| Slate | `#607080` | Secondary text |
| Rule | `#CBD3D8` | Grid lines and dividers |
| Action blue | `#2457A6` | Links, focus, primary actions |
| Risk red | `#B9433C` | High-risk state only |
| Confirm green | `#2D765D` | Complete and clear state |

No gradients. No decorative color blocks. Blue indicates interaction, never risk. Red and green states always include text or an icon. Avoid adding colors unless a new semantic state cannot be expressed by existing tokens.

### Grid and Spacing

- Desktop grid: 12 columns, max content width `1440px`.
- Mobile grid: 4 columns.
- Desktop content padding: `32px`.
- Mobile content padding: `20px`.
- Desktop grid gap: `24px`.
- Mobile grid gap: `16px`.
- Default control and table row height: `44-52px`.
- Default radius: `2px`; use spacing and rules to group content.
- Touch targets: minimum `44px`.

Use hairline rules for tables and section boundaries. Do not box every item. White space separates workflow stages and prevents evidence-heavy screens from becoming walls of data.

## Component Inventory

- `AppShell`: navigation, workspace header, search, profile.
- `CaseQueue`: sortable and filterable investigation table.
- `AgentPipeline`: four stages, progress, run state, failure, retry.
- `CaseHeader`: ID, entity, owner, risk, state, next action.
- `EvidenceLedger`: source, claim, confidence, reviewer, timestamp, relevance.
- `FindingPanel`: agent finding, confidence, evidence links.
- `DecisionRecord`: recommendation, rationale, approval history, override.
- `ReportComposer`: sections, preview, export.
- `StatusBadge`: text, icon, semantic color.
- `EmptyState`: explains state and provides next action.
- `ErrorState`: explains cause, recovery, and retry/contact action.
- `LoadingState`: preserves layout while work is pending.
- `Toast` and inline validation: accessible state announcements.

## Accessibility and Responsive Behavior

- Meet WCAG 2.2 AA for text, controls, focus, and status communication.
- Target minimum contrast of `4.5:1` for body and labels and `3:1` for large text and controls.
- Pair every semantic color with text and/or icon.
- Use visible `2px` blue focus outline with `2px` offset.
- All actions and data tables are keyboard reachable and operable.
- Status updates from agent runs use an `aria-live` region without stealing focus.
- Tables expose header relationships and announce sort direction.
- Dialogs trap focus and return focus to trigger on close.
- Respect `prefers-reduced-motion`; no required information depends on animation.
- On mobile, navigation becomes a drawer, pipeline stages stack into a vertical sequence, tables become horizontally scrollable or transform into labeled rows, and report preview stacks below controls.

## Interaction and State Rules

- Primary actions use explicit verbs: `New investigation`, `Import data`, `Retry`, `Approve decision`, `Export PDF`.
- Empty states explain why there is no content and give one next action.
- Errors name the failed stage, preserve available work, and expose recovery.
- Agent completion does not automatically approve a decision.
- An analyst can inspect evidence before approving or requesting more evidence.
- Approval and overrides create immutable activity-log entries.
- Destructive or irreversible actions require confirmation with consequence text.

## Out of Scope

- ERP integrations.
- Manual transaction-entry workflows.
- Multi-organization billing and plan management.
- Native mobile application.
- Agent prompt authoring UI.
- Real-time collaboration cursors.

## Design Success Criteria

- Analyst can create a case from CSV/XLSX and identify agent progress without leaving Overview.
- Analyst can trace every material finding to source evidence and agent metadata.
- Manager can approve, reject, or request evidence with a recorded rationale.
- Report output reflects reviewed evidence, decision, limitations, and approval history.
- All core flows remain usable by keyboard and at mobile widths.
- Visual system remains recognizable through typography, ledger rules, and restrained semantic color.
