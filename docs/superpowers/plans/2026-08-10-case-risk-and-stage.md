# Case Risk and Stage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every investigation a risk level and a stage derived from severities its agents recorded and runs they actually performed, and restore the Risk and Stage filters in the case queue.

**Architecture:** Both producers write a `severity` onto each finding. A migration adds the nullable column, teaches `sentinel_record_analysis` to persist it, rates the findings that predate it from magnitudes the database still holds, and adds a `security_invoker` view that rolls severity up to a risk level and reduces agent runs to a stage. The app reads the view instead of the table; nothing is derived in the browser.

**Tech Stack:** React 19 + TypeScript + Vite, Vitest (jsdom) for unit tests, Playwright for e2e, Supabase Postgres + Deno Edge Functions.

**Spec:** `docs/superpowers/specs/2026-08-10-case-risk-and-stage-design.md`

## Global Constraints

- **Severity values are exactly `'low' | 'medium' | 'high'`.** Enforced by a CHECK on `sentinel_findings.severity` and by the `Severity` union in TypeScript.
- **`null` severity means "no producer rated this finding".** It is never coerced to `'low'` — not in the view, not in the service, not in the UI.
- **Stage values are exactly `awaiting-import | analysing | analysis-failed | awaiting-analysis | fraud-review | analysed`.** No other value may reach `CaseSummary.stageId`.
- **Risk values are exactly `low | medium | high | not-assessed`** — the existing `RiskLevel` union, unchanged.
- **Deterministic severity thresholds:** duplicate group ≥ 3 rows → `high`, else `medium`. Outlier ≥ 10× median (rounded, see Task 1) → `high`, else `medium`. Missing amounts ≥ 10% of import rows → `medium`, else `low`.
- **Edge Function source changes ship nothing on their own.** Any task touching `supabase/functions/**` is not done until Task 7 redeploys, and the deploy must inline **every file in the import graph** with `functions/<name>/…` path prefixes.
- **Apply the migration in exactly one `apply_migration` call**, then reconcile `supabase_migrations.schema_migrations` to the repo filename immediately. Repo and ledger are 1:1 across fifteen migrations today; keep it that way.
- **Function assertions in SQL use `oidvectortypes(proc.proargtypes)`**, never `pg_get_function_identity_arguments` — the latter returns parameter names on this server and passes vacuously when asserting absence.
- **`src/lib/database.types.ts` is hand-curated and must not be regenerated.** Analysis relations stay out of it; the view gets a locally declared structural row type, as `sentinelAnalysis.ts` already does for findings.
- Run the full suite with `npx vitest run`. Run one file with `npx vitest run <path>`.

---

### Task 1: Severity in the deterministic rules

Each rule already computes a magnitude and throws it away. This keeps it.

One subtlety decides the whole task: **`outlier-amount` severity compares the *rounded* multiple, the same number the summary prints.** `outlierAmounts` writes `${Math.round(entry.value / middle)}x the median` into its summary. If severity compared the raw ratio, a finding at 9.6× would print "10x the median" and be rated `medium`, and the Task 3 backfill — which reads that printed number — would rate the identical finding `high`. Comparing the rounded value makes the summary and the severity incapable of disagreeing, and makes the backfill exact by construction rather than approximate.

**Files:**
- Modify: `supabase/functions/_shared/analysis.ts`
- Test: `supabase/functions/_shared/analysis.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `export type Severity = "low" | "medium" | "high"`, `AnalysisFinding.severity: Severity | null` (required property), and the exported constants `DUPLICATE_HIGH_ROWS = 3`, `OUTLIER_HIGH_MULTIPLE = 10`, `MISSING_MEDIUM_SHARE = 0.1`. Task 2 imports `Severity`; Task 3's thresholds must match these constants.

- [ ] **Step 1: Write the failing tests**

Append to `supabase/functions/_shared/analysis.test.ts`:

```ts
describe("severity", () => {
  const headers = ["entity", "amount"];
  const row = (sourceRow: number, entity: string, amount: number | string) => ({
    sourceRow,
    entity,
    values: { entity, amount },
  });

  it("rates a duplicate group of three or more as high, and a pair as medium", () => {
    const pair = analyseRows(headers, [row(2, "Acme", 100), row(3, "Acme", 100)]);
    expect(pair.find((f) => f.rule === "duplicate-amount")?.severity).toBe("medium");

    const triple = analyseRows(headers, [row(2, "Acme", 100), row(3, "Acme", 100), row(4, "Acme", 100)]);
    expect(triple.find((f) => f.rule === "duplicate-amount")?.severity).toBe("high");
  });

  it("rates an outlier at ten times the median as high and four times as medium", () => {
    // Median of 10, 10, 10 is 10. 40 is exactly OUTLIER_MULTIPLE; 100 is exactly ten times.
    const medium = analyseRows(headers, [row(2, "A", 10), row(3, "B", 10), row(4, "C", 10), row(5, "D", 40)]);
    expect(medium.find((f) => f.rule === "outlier-amount")?.severity).toBe("medium");

    const high = analyseRows(headers, [row(2, "A", 10), row(3, "B", 10), row(4, "C", 10), row(5, "D", 100)]);
    expect(high.find((f) => f.rule === "outlier-amount")?.severity).toBe("high");
  });

  it("rates outlier severity on the rounded multiple its summary prints", () => {
    // 96 over a median of 10 prints "10x the median". Severity must agree with the words.
    const finding = analyseRows(headers, [row(2, "A", 10), row(3, "B", 10), row(4, "C", 10), row(5, "D", 96)])
      .find((f) => f.rule === "outlier-amount");
    expect(finding?.summary).toContain("10x the median");
    expect(finding?.severity).toBe("high");
  });

  it("rates missing amounts by share of the import", () => {
    // 1 of 10 rows is exactly the 10% threshold.
    const atThreshold = analyseRows(headers, [
      row(2, "A", ""),
      ...Array.from({ length: 9 }, (_, index) => row(index + 3, `E${index}`, 50)),
    ]);
    expect(atThreshold.find((f) => f.rule === "missing-amount")?.severity).toBe("medium");

    // 1 of 20 rows is below it.
    const belowThreshold = analyseRows(headers, [
      row(2, "A", ""),
      ...Array.from({ length: 19 }, (_, index) => row(index + 3, `E${index}`, 50)),
    ]);
    expect(belowThreshold.find((f) => f.rule === "missing-amount")?.severity).toBe("low");
  });

  it("gives every deterministic finding a severity", () => {
    const findings = analyseRows(headers, [
      row(2, "Acme", 100), row(3, "Acme", 100), row(4, "Beta", 5), row(5, "Gamma", ""),
    ]);
    expect(findings.length).toBeGreaterThan(0);
    for (const finding of findings) expect(finding.severity).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run supabase/functions/_shared/analysis.test.ts`
Expected: FAIL — `severity` is `undefined` on every finding.

- [ ] **Step 3: Add the type and thresholds**

In `supabase/functions/_shared/analysis.ts`, after the `AnalysisRule` type (line 15):

```ts
/**
 * How much a finding matters, as distinct from how sure its producer is that it is real.
 * The rules are always certain — confidence 1 — so severity is the only thing that varies
 * between one duplicate pair and a group of nine.
 */
export type Severity = "low" | "medium" | "high";
```

After `OUTLIER_MULTIPLE` (line 20):

```ts
/** A duplicate group at least this large stops being a plausible double-entry. */
export const DUPLICATE_HIGH_ROWS = 3;

/**
 * A value at least this many times the median, measured on the *rounded* multiple the
 * summary prints. Comparing the raw ratio would let a finding read "10x the median" while
 * being rated medium, and would put this rule out of step with the backfill that reads
 * that printed number.
 */
export const OUTLIER_HIGH_MULTIPLE = 10;

/** Missing amounts at or above this share of the import are no longer an isolated slip. */
export const MISSING_MEDIUM_SHARE = 0.1;
```

- [ ] **Step 4: Add severity to the finding type**

Change `AnalysisFinding` (line 29-35) to:

```ts
export interface AnalysisFinding {
  rule: AnalysisRule;
  agent: string;
  summary: string;
  confidence: number;
  /**
   * Null only from a producer that did not state one — the AI agent when its response
   * omitted or mangled the field. The rules always set it, and the property is required so
   * a rule that forgets fails to compile.
   */
  severity: Severity | null;
  evidence: AnalysisEvidence[];
}
```

- [ ] **Step 5: Rate each rule**

In `duplicateAmounts`, inside the `.map((group) => {` block, add after `confidence: 1,`:

```ts
        severity: group.length >= DUPLICATE_HIGH_ROWS ? "high" : "medium",
```

In `outlierAmounts`, replace the `.map((entry) => ({` body's opening so the rounded multiple is computed once and used for both the summary and the severity:

```ts
    .map((entry) => {
      // One number, used for the words and for the rating, so they cannot disagree.
      const multiple = Math.round(entry.value / middle);
      return {
        rule: "outlier-amount" as const,
        agent: ANALYSIS_AGENT,
        summary: `${entry.row.entity} records ${amountLabel(entry.value)}, ${multiple}x the median of ${amountLabel(middle)}`,
        confidence: 1,
        severity: multiple >= OUTLIER_HIGH_MULTIPLE ? "high" as const : "medium" as const,
        evidence: [
          {
            sourceRow: entry.row.sourceRow,
            sourceLabel: rowLabel(entry.row),
            claim: `${header} = ${amountLabel(entry.value)}`,
            relevance: "supporting" as const,
          },
          // The typical row is what makes the outlier readable as an outlier.
          {
            sourceRow: typical.row.sourceRow,
            sourceLabel: rowLabel(typical.row),
            claim: `Median ${header} across this import is ${amountLabel(middle)}`,
            relevance: "context" as const,
          },
        ],
      };
    });
```

In `missingAmounts`, add after `confidence: 1,`:

```ts
    severity: affected.length / rows.length >= MISSING_MEDIUM_SHARE ? "medium" : "low",
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run supabase/functions/_shared/analysis.test.ts`
Expected: PASS, including the 14 pre-existing tests.

- [ ] **Step 7: Commit**

```bash
git add supabase/functions/_shared/analysis.ts supabase/functions/_shared/analysis.test.ts
git commit -m "Rate deterministic findings by the magnitude they already measured"
```

---

### Task 2: Severity from the fraud-pattern agent

The model is asked for severity and told plainly how it differs from confidence, because a model left to itself collapses the two.

**Files:**
- Modify: `supabase/functions/_shared/fraudPatterns.ts`
- Modify: `supabase/functions/analyze-upload/geminiModel.ts:53-95` (the `responseSchema`)
- Test: `supabase/functions/_shared/fraudPatterns.test.ts`

**Interfaces:**
- Consumes: `Severity` and `AnalysisFinding` from `_shared/analysis.ts` (Task 1).
- Produces: `validateFindings` returning findings whose `severity` is a `Severity` or `null`.

- [ ] **Step 1: Write the failing tests**

Append to `supabase/functions/_shared/fraudPatterns.test.ts`. Match the existing file's helper for building rows — if it defines a `rows` fixture, reuse it rather than redeclaring one.

```ts
describe("severity from the model", () => {
  const rows = [
    { sourceRow: 2, entity: "Acme", values: { entity: "Acme", amount: 9400 } },
    { sourceRow: 3, entity: "Acme", values: { entity: "Acme", amount: 9500 } },
  ];

  const response = (severity: unknown) => ({
    findings: [{
      rule: "round-number-clustering",
      summary: "Two payments sit just under the 10,000 approval threshold.",
      confidence: 0.9,
      severity,
      evidence: [{ sourceRow: 2, claim: "amount = 9400", relevance: "supporting" }],
    }],
  });

  it("keeps a severity the model stated", () => {
    expect(validateFindings(response("high"), rows)[0].severity).toBe("high");
  });

  it("keeps the finding and records no severity when the model omits it", () => {
    const findings = validateFindings(response(undefined), rows);
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBeNull();
  });

  it("keeps the finding and records no severity for a value outside the enum", () => {
    for (const bad of ["critical", "HIGH", 3, null, {}]) {
      const findings = validateFindings(response(bad), rows);
      expect(findings).toHaveLength(1);
      expect(findings[0].severity).toBeNull();
    }
  });

  it("still drops a finding missing a rule, summary, or confidence", () => {
    // Severity is best-effort; these three are not. The asymmetry is the point.
    expect(validateFindings({ findings: [{ ...response("high").findings[0], rule: null }] }, rows)).toHaveLength(0);
    expect(validateFindings({ findings: [{ ...response("high").findings[0], summary: "  " }] }, rows)).toHaveLength(0);
    expect(validateFindings({ findings: [{ ...response("high").findings[0], confidence: 0 }] }, rows)).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run supabase/functions/_shared/fraudPatterns.test.ts`
Expected: FAIL — `severity` is `undefined`, not `null` or `"high"`.

- [ ] **Step 3: Validate severity**

In `supabase/functions/_shared/fraudPatterns.ts`, change the import on line 2:

```ts
import type { AnalysisFinding, Severity } from "./analysis.ts";
```

Add `severity` to the `ModelFinding` interface (line 71-76):

```ts
interface ModelFinding {
  rule: string;
  summary: string;
  confidence: number;
  severity: string;
  evidence: ModelEvidence[];
}
```

Add this next to `clampConfidence`:

```ts
/**
 * Best-effort, unlike the fields above it. A finding whose severity is missing or outside
 * the enum is still a finding the analyst should see; it simply arrives unrated. Dropping a
 * real, well-evidenced finding over a bad enum value would lose more than it protects.
 */
function severityValue(value: unknown): Severity | null {
  return value === "low" || value === "medium" || value === "high" ? value : null;
}
```

In `validateFindings`, add to the `findings.push({...})` call after `confidence,`:

```ts
      severity: severityValue(finding.severity),
```

- [ ] **Step 4: Teach the prompt the distinction**

In the `systemPrompt` array, replace the line beginning `"Set confidence honestly:"` and keep the rest of that paragraph intact:

```ts
  "Set confidence honestly: near 1 when the pattern is unmistakable in the rows, lower when it is",
  "suggestive. Severity is a separate judgement and must not track confidence: confidence is whether",
  "the pattern is really there, severity is how much it would matter if it is. A pattern can be",
  "unmistakable and minor. Report an empty findings array when the rows show nothing worth an",
  "analyst's attention — a clean import is a normal and useful result, and is better than padding",
  "the list with weak observations.",
```

- [ ] **Step 5: Ask for it in the response schema**

In `supabase/functions/analyze-upload/geminiModel.ts`, add to the finding item's `properties`, after `confidence`:

```js
          severity: {
            type: "STRING",
            enum: ["low", "medium", "high"],
            description:
              "How much this matters if the pattern is real. Independent of confidence — a certain pattern can be minor.",
          },
```

Then add `"severity"` to that item's `required` and `propertyOrdering` arrays, between `"confidence"` and `"evidence"`.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run supabase/functions/_shared/fraudPatterns.test.ts supabase/functions/analyze-upload/geminiModel.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add supabase/functions/_shared/fraudPatterns.ts supabase/functions/_shared/fraudPatterns.test.ts supabase/functions/analyze-upload/geminiModel.ts
git commit -m "Ask the investigator how much a pattern matters, not just whether it is real"
```

---

### Task 3: The migration — column, RPC, backfill, view

One migration, one `apply_migration` call, because these four changes are one logical change and split calls produce ledger rows that can never reconcile against a single file.

**Files:**
- Create: `supabase/migrations/20260810120000_sentinel_case_risk_and_stage.sql`
- Create: `supabase/verify_sentinel_case_risk_and_stage.sql`

**Interfaces:**
- Consumes: the threshold values from Task 1 (3 rows, 10×, 10%). They must match exactly, or a re-run rates a finding differently than the backfill did.
- Produces: `public.sentinel_investigation_queue` with columns `id, workspace_id, reference, entity, owner_id, status, created_at, updated_at, risk, stage`. Task 4 reads exactly these.

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/20260810120000_sentinel_case_risk_and_stage.sql`:

```sql
-- A case can now report a risk it earned and a stage it reached.
--
-- Until now mapRow returned 'not-assessed' and 'not-started' for every investigation, so a
-- case holding four findings from two agents still read as unexamined. Both values now come
-- from what the producers recorded.
--
-- severity is nullable on purpose. null means no producer rated this finding — a different
-- statement from 'low' — and two AI findings predating this migration are exactly that.

alter table public.sentinel_findings
  add column severity text
  check (severity in ('low', 'medium', 'high'));

comment on column public.sentinel_findings.severity is
  'How much the finding matters, as opposed to confidence, which is whether it is real. Null means no producer rated it.';
```

Then the RPC. **Copy `public.sentinel_record_analysis` verbatim from `supabase/migrations/20260809174332_sentinel_multi_agent_analysis.sql:231-331`** and make exactly two changes inside it, leaving the signature, the `security definer`, the `set search_path`, the delete scoping, the evidence loop, the run completion, and the activity event untouched:

1. In the `insert into public.sentinel_findings (…)` column list, add `severity` after `confidence`.
2. In the matching `values (…)` list, add after the `coalesce((finding ->> 'confidence')::numeric, 1)` line:

```sql
      nullif(finding ->> 'severity', '')
```

The signature is unchanged, so `create or replace` preserves the existing grants — do **not** re-grant, and do **not** drop the function first.

Then the backfill and the view, appended to the same file:

```sql
/**
 * Rate the findings that predate the column, from magnitudes the record still holds.
 *
 * Nothing here is invented. A duplicate group's size *is* its supporting evidence count,
 * one evidence row per member. A missing-amount finding's affected count is likewise its
 * evidence count, over the upload's own row_count. The outlier multiple survives only in
 * the summary the rules themselves wrote, in a format those rules control — and where the
 * pattern does not match, severity stays null rather than falling back to a guess.
 *
 * Scoped to agent_key = 'deterministic': the two fraud-pattern findings on record were
 * never asked for a severity, and no column can reconstruct one. They stay null until that
 * agent next runs.
 *
 * Idempotent through `severity is null` — re-running rates nothing and overwrites nothing.
 */
update public.sentinel_findings as f
set severity = case f.rule
    when 'duplicate-amount' then
      case when evidence.count >= 3 then 'high' else 'medium' end
    when 'outlier-amount' then
      case
        when substring(f.summary from '([0-9]+)x the median') is null then null
        when (substring(f.summary from '([0-9]+)x the median'))::integer >= 10 then 'high'
        else 'medium'
      end
    when 'missing-amount' then
      case
        when coalesce(upload.row_count, 0) = 0 then null
        when evidence.count::numeric / upload.row_count >= 0.1 then 'medium'
        else 'low'
      end
  end
from public.sentinel_uploads as upload,
  lateral (
    select count(*) as count
    from public.sentinel_evidence as e
    where e.finding_id = f.id and e.relevance = 'supporting'
  ) as evidence
where upload.id = f.upload_id
  and f.severity is null
  and f.agent_key = 'deterministic';

/**
 * Risk and stage, derived where the rows are.
 *
 * security_invoker, following sentinel_manager_roster: RLS on the underlying tables applies
 * as the calling user, so this view adds no new reach.
 *
 * The aggregation lives here rather than in the browser because deriving risk client-side
 * means reading workspace-wide findings, and that read is capped at DEFAULT_FINDING_LIMIT
 * with no paging. A case whose risk changed because its findings fell off the end of a
 * capped read would be a worse bug than the one this migration fixes.
 */
create view public.sentinel_investigation_queue
with (security_invoker = true)
as
select
  i.id,
  i.workspace_id,
  i.reference,
  i.entity,
  i.owner_id,
  i.status,
  i.created_at,
  i.updated_at,
  -- Highest severity on record. Null severities are ignored rather than counted as low, so
  -- 'not-assessed' means nothing was rated — including a case whose agents found nothing.
  case
    when bool_or(severity_of.finding = 'high') then 'high'
    when bool_or(severity_of.finding = 'medium') then 'medium'
    when bool_or(severity_of.finding = 'low') then 'low'
    else 'not-assessed'
  end as risk,
  -- First match wins. Written over uploads *lacking* a complete run rather than over runs in
  -- a non-complete state, because an upload can legitimately have no run row yet — parse-upload
  -- seeds them, so a case opened during a parse sits in exactly that gap. Phrased the other
  -- way it would match nothing until 'analysed' and claim to be finished.
  case
    when pipeline.uploads = 0 then 'awaiting-import'
    when pipeline.running > 0 then 'analysing'
    when pipeline.failed > 0 then 'analysis-failed'
    when pipeline.awaiting_deterministic > 0 then 'awaiting-analysis'
    when pipeline.awaiting_fraud_pattern > 0 then 'fraud-review'
    else 'analysed'
  end as stage
from public.sentinel_investigations as i
left join lateral (
  select f.severity as finding
  from public.sentinel_findings as f
  where f.investigation_id = i.id
) as severity_of on true
left join lateral (
  select
    count(*) as uploads,
    count(*) filter (where runs.running > 0) as running,
    count(*) filter (where runs.failed > 0) as failed,
    count(*) filter (where runs.deterministic_complete = 0) as awaiting_deterministic,
    count(*) filter (where runs.fraud_pattern_complete = 0) as awaiting_fraud_pattern
  from public.sentinel_uploads as u
  cross join lateral (
    select
      count(*) filter (where r.status = 'running') as running,
      count(*) filter (where r.status = 'failed') as failed,
      count(*) filter (where r.agent_key = 'deterministic' and r.status = 'complete') as deterministic_complete,
      count(*) filter (where r.agent_key = 'fraud-pattern' and r.status = 'complete') as fraud_pattern_complete
    from public.sentinel_agent_runs as r
    where r.upload_id = u.id
  ) as runs
  where u.investigation_id = i.id
) as pipeline on true
group by i.id, i.workspace_id, i.reference, i.entity, i.owner_id, i.status, i.created_at, i.updated_at,
  pipeline.uploads, pipeline.running, pipeline.failed, pipeline.awaiting_deterministic,
  pipeline.awaiting_fraud_pattern;

revoke all on table public.sentinel_investigation_queue from public, anon, authenticated;
grant select on table public.sentinel_investigation_queue to authenticated;
```

- [ ] **Step 2: Write the verification script**

Create `supabase/verify_sentinel_case_risk_and_stage.sql`:

```sql
-- Verifies 20260810120000_sentinel_case_risk_and_stage.sql against a live database.
--
-- Signatures are matched with oidvectortypes(proargtypes), never
-- pg_get_function_identity_arguments, which returns parameter names on this server and so
-- passes vacuously whenever a check asserts absence.

do $$
declare
  unrated_deterministic integer;
  rated_fraud integer;
  distinct_stages integer;
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'sentinel_findings' and column_name = 'severity'
      and is_nullable = 'YES' and column_default is null
  ) then
    raise exception 'sentinel_findings.severity must exist, be nullable, and carry no default';
  end if;

  -- Scoped to the table: a same-named constraint elsewhere must not satisfy this.
  if not exists (
    select 1 from pg_constraint as con
    join pg_class as rel on rel.oid = con.conrelid
    join pg_namespace as ns on ns.oid = rel.relnamespace
    where ns.nspname = 'public' and rel.relname = 'sentinel_findings'
      and con.contype = 'c'
      and pg_get_constraintdef(con.oid) like '%severity%low%medium%high%'
  ) then
    raise exception 'sentinel_findings.severity must be constrained to low/medium/high';
  end if;

  if not exists (
    select 1 from pg_proc as proc
    join pg_namespace as ns on ns.oid = proc.pronamespace
    where ns.nspname = 'public' and proc.proname = 'sentinel_record_analysis'
      and oidvectortypes(proc.proargtypes) = 'uuid, uuid, uuid, text, jsonb, uuid'
      and pg_get_functiondef(proc.oid) like '%severity%'
  ) then
    raise exception 'sentinel_record_analysis must persist severity';
  end if;

  if not exists (
    select 1 from pg_class as rel
    join pg_namespace as ns on ns.oid = rel.relnamespace
    where ns.nspname = 'public' and rel.relname = 'sentinel_investigation_queue'
      and rel.relkind = 'v'
      and rel.reloptions @> array['security_invoker=true']
  ) then
    raise exception 'sentinel_investigation_queue must exist as a security_invoker view';
  end if;

  -- The backfill is total for the rules: every deterministic finding whose magnitude the
  -- record still holds must now carry a rating.
  select count(*) into unrated_deterministic
  from public.sentinel_findings
  where agent_key = 'deterministic' and severity is null
    and (rule <> 'outlier-amount' or summary ~ '[0-9]+x the median');
  if unrated_deterministic > 0 then
    raise exception 'deterministic findings left unrated by the backfill: %', unrated_deterministic;
  end if;

  -- And it invented nothing for the producer that never stated one.
  select count(*) into rated_fraud
  from public.sentinel_findings where agent_key = 'fraud-pattern' and severity is not null;
  if rated_fraud > 0 then
    raise exception 'fraud-pattern findings were rated without the agent stating a severity: %', rated_fraud;
  end if;

  if exists (
    select 1 from public.sentinel_investigation_queue
    where stage not in ('awaiting-import', 'analysing', 'analysis-failed',
                        'awaiting-analysis', 'fraud-review', 'analysed')
       or risk not in ('low', 'medium', 'high', 'not-assessed')
  ) then
    raise exception 'the view produced a risk or stage outside the permitted set';
  end if;

  -- The filters exist to narrow a list. One value across every case is the condition that
  -- got them withheld, and shipping back into it would be the same defect.
  select count(distinct stage) into distinct_stages from public.sentinel_investigation_queue;
  if distinct_stages < 2 then
    raise exception 'every case shares one stage; the Stage filter would be inert';
  end if;

  raise notice 'sentinel_case_risk_and_stage verified';
end;
$$;
```

- [ ] **Step 3: Apply the migration in one call**

Use `mcp__plugin_supabase_supabase__apply_migration` with `project_id: lehwqjzzuppjnddwxxow`, name `sentinel_case_risk_and_stage`, and the **entire file contents** as one call. Two calls produce two ledger rows that can never reconcile against one file.

- [ ] **Step 4: Reconcile the ledger to 1:1**

`apply_migration` ignores the filename and stamps its own timestamp. Run `list_migrations`, find the stamped version, and **rename the repo file to the stamped version** — preferred here because the file is new and unpushed, and it reaches 1:1 without touching `schema_migrations` at all. Confirm with `list_migrations` that sixteen versions match sixteen repo filenames.

- [ ] **Step 5: Run the verification script**

Run `supabase/verify_sentinel_case_risk_and_stage.sql` through `execute_sql`.
Expected: `NOTICE: sentinel_case_risk_and_stage verified`, no exception.

- [ ] **Step 6: Confirm the derivation against known live data**

Run through `execute_sql`:

```sql
select stage, risk, count(*) from public.sentinel_investigation_queue group by 1, 2 order by 3 desc;
```

Expected, from the distribution recorded in the spec: 19 `awaiting-analysis`, 17 `fraud-review`, 12 `awaiting-import`, 2 `analysed`. The 14 cases holding three deterministic findings should read `medium` risk — every live duplicate group is a pair, every live outlier is under 10×, and no live import has ≥10% missing amounts. **If any case reads `high`, stop and confirm the magnitude before continuing** — that is either a real high-severity finding or a threshold that does not mean what this plan assumed.

- [ ] **Step 7: Commit**

```bash
git add supabase/migrations/ supabase/verify_sentinel_case_risk_and_stage.sql
git commit -m "Record what a finding is worth, and roll it up to the case"
```

---

### Task 4: The app carries a real risk and stage

The type change breaks compilation across the service, the fixtures, and `CaseHeader` at once, so they move together — split any further and the build is red at a task boundary.

**Files:**
- Modify: `src/domain/types.ts`
- Modify: `src/services/sentinelInvestigations.ts`
- Modify: `src/demo/fixtures.ts:58-63`
- Modify: `src/components/cases/CaseHeader.tsx:38`
- Test: `src/services/sentinelInvestigations.test.ts`

**Interfaces:**
- Consumes: `sentinel_investigation_queue` and its ten columns (Task 3).
- Produces: `CaseStage` union, `Severity` in `src/domain/types.ts`, and `CaseSummary` with no `analysisStatus`. Tasks 5 and 6 depend on both.

- [ ] **Step 1: Write the failing test**

In `src/services/sentinelInvestigations.test.ts`, the row fixture and its type move to the view's shape. Replace the `InvestigationRow` alias (line 6) and `row` fixture (lines 14-24) with:

```ts
// The view, not the table. database.types.ts is hand-curated and analysis relations stay
// out of it, so this shape is declared structurally — the same convention sentinelAnalysis
// follows for findings.
type InvestigationRow = {
  id: string;
  workspace_id: string;
  reference: string;
  entity: string;
  owner_id: string | null;
  status: "open" | "review" | "approved" | "closed";
  created_at: string;
  updated_at: string;
  risk: "low" | "medium" | "high" | "not-assessed";
  stage: string;
};

const row: InvestigationRow = {
  id: "database-id-1",
  workspace_id: context.workspaceId,
  reference: "INV-AB12CD34",
  entity: "Northstar Ltd",
  owner_id: "owner-1",
  status: "open",
  created_at: "2026-08-05T08:00:00.000Z",
  updated_at: "2026-08-09T08:30:00.000Z",
  risk: "medium",
  stage: "fraud-review",
};
```

Then add:

```ts
it("carries the risk and stage the view derived", async () => {
  const { query } = fakeReadQuery(successResponse([row]), successResponse(row));
  const { client } = fakeReadClient(query);
  const [summary] = await createSentinelInvestigationService(client, context).list();

  expect(summary.risk).toBe("medium");
  expect(summary.stageId).toBe("fraud-review");
});

it("reads the queue view rather than the investigations table", async () => {
  const { query } = fakeReadQuery(successResponse([row]), successResponse(row));
  const { client, from } = fakeReadClient(query);
  await createSentinelInvestigationService(client, context).list();

  expect(from).toHaveBeenCalledWith("sentinel_investigation_queue");
});

it("reports a stage the view did not produce as awaiting-import rather than rendering a raw slug", async () => {
  // The view is constrained, but the client cannot prove that. An unknown value must land
  // somewhere honest instead of reaching a table cell.
  const { query } = fakeReadQuery(successResponse([{ ...row, stage: "something-new" }]), successResponse(row));
  const { client } = fakeReadClient(query);
  const [summary] = await createSentinelInvestigationService(client, context).list();

  expect(summary.stageId).toBe("awaiting-import");
});

it("creates a case as unassessed and awaiting import", async () => {
  const { query } = fakeInsertQuery(successResponse(row));
  const { client } = fakeInsertClient(query);
  const created = await createSentinelInvestigationService(client, context).create({ entity: "New Co", ownerId: "" });

  expect(created.risk).toBe("not-assessed");
  expect(created.stageId).toBe("awaiting-import");
});
```

Update `fakeReadClient` and `fakeInsertClient` so `from` accepts both relation names:

```ts
const from = vi.fn((_table: "sentinel_investigations" | "sentinel_investigation_queue") => ({ select, insert }));
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/services/sentinelInvestigations.test.ts`
Expected: FAIL — `risk` is `"not-assessed"` and `stageId` is `"not-started"`.

- [ ] **Step 3: Change the domain types**

In `src/domain/types.ts`, after `RiskLevel` (line 9):

```ts
/** How much a finding matters. Null where no producer rated it. */
export type Severity = "low" | "medium" | "high";

/**
 * What a case needs next, derived from its agent runs.
 *
 * The design spec's `evidence-review` and `reporting` are deliberately absent: nothing
 * writes sentinel_evidence.state, so no case can enter or leave evidence review, and the
 * decision and report steps are fixture-backed. They return when something can move a case
 * through them.
 */
export type CaseStage =
  | "awaiting-import"
  | "analysing"
  | "analysis-failed"
  | "awaiting-analysis"
  | "fraud-review"
  | "analysed";
```

In `CaseSummary`, change `stageId: string;` to `stageId: CaseStage;` and **delete** the `analysisStatus?: "not-started";` line.

In `Finding`, add after `confidence: number;`:

```ts
  severity: Severity | null;
```

- [ ] **Step 4: Read the view**

In `src/services/sentinelInvestigations.ts`:

Replace the `InvestigationRow` alias (line 5) with a locally declared view row, keeping the `InvestigationInsert` alias as it is — `create()` still writes to the table:

```ts
/**
 * The queue view's shape, declared here rather than in database.types.ts. That file is
 * hand-curated and analysis relations stay out of it by convention; regenerating it to pick
 * up this view would replace hand-narrowed unions elsewhere with bare strings.
 */
type InvestigationRow = {
  id: string;
  workspace_id: string;
  reference: string;
  entity: string;
  owner_id: string | null;
  status: "open" | "review" | "approved" | "closed";
  created_at: string;
  updated_at: string;
  risk: RiskLevel;
  stage: string;
};
```

Update the import on line 2 to pull in the new types:

```ts
import type { CaseStage, CaseSummary, RiskLevel, SentinelInvestigationService } from "../domain/types";
```

Change `SentinelInvestigationClient` so reads name the view and writes name the table:

```ts
export type SentinelInvestigationClient = {
  from(table: "sentinel_investigations" | "sentinel_investigation_queue"): {
    select(columns: "*"): InvestigationReadQuery;
    insert(values: InvestigationInsert): InvestigationInsertQuery;
  };
};
```

Add above `mapRow`:

```ts
const caseStages: readonly CaseStage[] = [
  "awaiting-import", "analysing", "analysis-failed", "awaiting-analysis", "fraud-review", "analysed",
];

/**
 * The view is constrained to these six, but the client cannot prove that. An unrecognised
 * value falls back to the stage that claims the least rather than reaching a table cell as
 * a raw slug.
 */
function toStage(value: string): CaseStage {
  return (caseStages as readonly string[]).includes(value) ? (value as CaseStage) : "awaiting-import";
}
```

Replace the two hardcoded lines in `mapRow` (lines 75-76, 80):

```ts
    risk: row.risk,
    stageId: toStage(row.stage),
```

and delete the `analysisStatus: "not-started",` line.

Change both reads to name the view:

```ts
        .from("sentinel_investigation_queue")
```

in `list()` (line 101) and `getById()` (line 113). Leave `create()` on `sentinel_investigations`.

`create()` maps an insert result that has no `risk` or `stage` columns, so give it the values that are true for a case with no uploads — replace `return mapRow(data);` with:

```ts
        // The insert returns the table row, which has no derived columns. A brand-new case
        // has no uploads and no findings, so this is what the view would say about it.
        return mapRow({ ...data, risk: "not-assessed", stage: "awaiting-import" });
```

- [ ] **Step 5: Update the fixtures and the case header**

In `src/demo/fixtures.ts`, the six case fixtures use the retired vocabulary. Replace the `stageId` values on lines 58-63 with, in order: `"analysed"`, `"awaiting-analysis"`, `"analysed"`, `"fraud-review"`, `"analysed"`, `"analysed"`. Leave every `risk` value as it is — the spread across low/medium/high is what makes the Task 5 filter test meaningful.

In `src/components/cases/CaseHeader.tsx:38`, replace the dead gate:

```tsx
          const complete = caseItem.stageId === "analysed" && index < currentIndex;
```

- [ ] **Step 6: Run the full suite**

Run: `npx vitest run`
Expected: PASS. Any file still setting `analysisStatus` on a `CaseSummary` fixture is now a type error — remove the property; do not re-add it to the type. The files that set it are `src/app/App.test.tsx`, `src/pages/CasesPage.test.tsx`, `src/pages/CaseWorkspacePage.test.tsx`, and `src/pages/OverviewPage.test.tsx`, and those fixtures also need their `stageId` moved onto the new union.

- [ ] **Step 7: Verify the build type-checks**

Run: `npm run build`
Expected: success. `tsc -b` catches any `stageId` still holding a retired slug, which Vitest alone would not.

- [ ] **Step 8: Commit**

```bash
git add src/domain/types.ts src/services/sentinelInvestigations.ts src/services/sentinelInvestigations.test.ts src/demo/fixtures.ts src/components/cases/CaseHeader.tsx src/app/App.test.tsx src/pages/
git commit -m "Read the case queue from the view that knows the answer"
```

---

### Task 5: Restore the Risk and Stage filters

**Files:**
- Modify: `src/components/cases/CaseQueue.tsx:14-21,76-82`
- Test: `src/components/cases/CaseQueue.test.tsx:20-31`

**Interfaces:**
- Consumes: `CaseStage` and `CaseSummary` from Task 4.
- Produces: nothing later tasks depend on.

- [ ] **Step 1: Replace the withholding test with a filtering test**

In `src/components/cases/CaseQueue.test.tsx`, delete the `withholds the risk and stage filters while every case shares one value` test entirely and add:

```ts
it("filters cases by risk", async () => {
  render(<MemoryRouter><CaseQueue cases={fixtureCases} /></MemoryRouter>);
  await userEvent.selectOptions(screen.getByRole("combobox", { name: /risk/i }), "high");

  const expected = fixtureCases.filter((item) => item.risk === "high").length;
  expect(expected).toBeGreaterThan(0); // a filter test against zero matches proves nothing
  expect(screen.getAllByRole("row")).toHaveLength(expected + 1); // + the header row
});

it("filters cases by stage", async () => {
  render(<MemoryRouter><CaseQueue cases={fixtureCases} /></MemoryRouter>);
  await userEvent.selectOptions(screen.getByRole("combobox", { name: /stage/i }), "analysed");

  const expected = fixtureCases.filter((item) => item.stageId === "analysed").length;
  expect(expected).toBeGreaterThan(0);
  expect(expected).toBeLessThan(fixtureCases.length); // and one returning everything proves nothing either
  expect(screen.getAllByRole("row")).toHaveLength(expected + 1);
});

it("keeps the columns readable for every stage a case can reach", () => {
  render(<MemoryRouter><CaseQueue cases={fixtureCases} /></MemoryRouter>);
  // A raw slug in a table cell means stageLabels has fallen behind CaseStage.
  expect(screen.queryByText(/awaiting-|fraud-pattern|not-started/)).not.toBeInTheDocument();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/components/cases/CaseQueue.test.tsx`
Expected: FAIL — no combobox named "risk" or "stage" exists.

- [ ] **Step 3: Rewrite the stage labels**

In `src/components/cases/CaseQueue.tsx`, replace `stageLabels` (lines 15-21):

```tsx
const stageLabels: Record<CaseStage, string> = {
  "awaiting-import": "Awaiting import",
  analysing: "Analysing",
  "analysis-failed": "Analysis failed",
  "awaiting-analysis": "Awaiting analysis",
  "fraud-review": "Fraud review",
  analysed: "Analysed",
};
```

Update the import on line 4:

```tsx
import type { CaseStage, CaseSummary, RiskLevel } from "../../domain/types";
```

`Record<CaseStage, string>` is what keeps the labels honest: adding a stage without a label becomes a compile error, so line 101's `?? item.stageId` fallback can go — replace it with `{stageLabels[item.stageId]}`.

- [ ] **Step 4: Restore the two selects**

Replace the withholding comment and the single filter field (lines 76-82) with:

```tsx
        <div className="queue-filters">
          <div className="filter-field"><label htmlFor="risk-filter">Risk</label><select id="risk-filter" value={risk} onChange={(event) => updateParam("risk", event.target.value)}><option value="all">All risk levels</option>{(Object.keys(riskLabels) as RiskLevel[]).map((level) => <option value={level} key={level}>{riskLabels[level]}</option>)}</select></div>
          <div className="filter-field"><label htmlFor="stage-filter">Stage</label><select id="stage-filter" value={stage} onChange={(event) => updateParam("stage", event.target.value)}><option value="all">All stages</option>{(Object.keys(stageLabels) as CaseStage[]).map((value) => <option value={value} key={value}>{stageLabels[value]}</option>)}</select></div>
          <div className="filter-field"><label htmlFor="owner-filter">Owner</label><select id="owner-filter" value={owner} onChange={(event) => updateParam("owner", event.target.value)}><option value="all">All owners</option>{owners.map((item) => <option value={item} key={item}>{item}</option>)}</select></div>
        </div>
```

The filtering logic on lines 58-59 and the `?risk=` / `?stage=` URL params already work and need no change — that is why saved links keep resolving.

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run src/components/cases/CaseQueue.test.tsx`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/components/cases/CaseQueue.tsx src/components/cases/CaseQueue.test.tsx
git commit -m "Give the queue back the two filters it had nothing to filter on"
```

---

### Task 6: Show which finding earned the risk

A case reading "High risk" with no way to see why puts the reader back where this started.

**Files:**
- Modify: `src/services/sentinelAnalysis.ts:14-23,49-51,98-107`
- Modify: `src/components/evidence/FindingPanel.tsx:15`
- Test: `src/services/sentinelAnalysis.test.ts`

**Interfaces:**
- Consumes: `Finding.severity` from Task 4, `sentinel_findings.severity` from Task 3.
- Produces: nothing later tasks depend on.

- [ ] **Step 1: Write the failing test**

Add to `src/services/sentinelAnalysis.test.ts`, following the file's existing fake-client helpers:

```ts
it("carries each finding's severity, and null where no producer rated it", async () => {
  const rows = [
    { id: "f1", investigation_id: "inv-1", rule: "outlier-amount", agent: "Financial analysis", summary: "s", confidence: 1, severity: "high", created_at: "2026-08-10T00:00:00.000Z", sentinel_evidence: [] },
    { id: "f2", investigation_id: "inv-1", rule: "round-number-clustering", agent: "Fraud pattern investigator", summary: "s", confidence: 0.9, severity: null, created_at: "2026-08-10T00:00:01.000Z", sentinel_evidence: [] },
  ];
  const { findings } = await serviceReading(rows).list("inv-1");

  expect(findings[0].severity).toBe("high");
  expect(findings[1].severity).toBeNull();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/services/sentinelAnalysis.test.ts`
Expected: FAIL — `severity` is `undefined`.

- [ ] **Step 3: Select and map the column**

In `src/services/sentinelAnalysis.ts`, add to `FindingRow` after `confidence: number;`:

```ts
  severity: "low" | "medium" | "high" | null;
```

Add `severity` to `ANALYSIS_COLUMNS` (line 50), after `confidence`:

```ts
  "id, investigation_id, rule, agent, summary, confidence, severity, created_at, "
```

Add to the `findings.push({...})` call after `confidence: row.confidence,`:

```ts
          severity: row.severity,
```

- [ ] **Step 4: Render it**

In `src/components/evidence/FindingPanel.tsx`, replace the `finding-panel-top` div (line 15):

```tsx
      <div className="finding-panel-top"><span className="numeric">{finding.id}</span>{finding.severity && <StatusBadge status={finding.severity} label={`${finding.severity[0].toUpperCase()}${finding.severity.slice(1)} severity`} tone={finding.severity === "high" ? "risk" : finding.severity === "low" ? "confirm" : "warning"} />}<StatusBadge status="confidence" label={`${Math.round(finding.confidence * 100)}% confidence`} tone="action" /></div>
```

An unrated finding renders no badge at all rather than a "not rated" chip — the confidence badge beside it already tells the reader what the producer did say.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/services/sentinelAnalysis.test.ts src/components/evidence/`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/services/sentinelAnalysis.ts src/services/sentinelAnalysis.test.ts src/components/evidence/FindingPanel.tsx
git commit -m "Show the severity behind a case's risk"
```

---

### Task 7: Deploy, prove it in a browser, and record what is left

Everything in Tasks 1 and 2 is inert until this runs. `npx vitest` imports the local modules, so those tests can be entirely green while the live Deno runtime serves a build that has never heard of severity.

**Files:**
- Modify: `tests/workspace.spec.ts`
- Create: `docs/superpowers/follow-ups/2026-08-10-case-risk-and-stage.md`

**Interfaces:**
- Consumes: everything above.
- Produces: nothing.

- [ ] **Step 1: Deploy both Edge Functions**

`_shared/analysis.ts` is in `parse-upload`'s import graph and `_shared/fraudPatterns.ts` is in `analyze-upload`'s. Deploy both with `deploy_edge_function`, inlining every file in each graph with `functions/<name>/…` prefixes. A partial file list fails with `Entrypoint path does not exist`.

- `parse-upload`: `functions/parse-upload/index.ts`, `functions/parse-upload/spreadsheet.ts`, `functions/parse-upload/processing.ts`, and `functions/_shared/` `auth.ts`, `cors.ts`, `auth-policy.ts`, `supabase-key.ts`, `parser.ts`, `analysis.ts`, `agentKeys.ts`, `analysisRuns.ts`.
- `analyze-upload`: `functions/analyze-upload/index.ts`, `functions/analyze-upload/agents.ts`, `functions/analyze-upload/geminiModel.ts`, and `functions/_shared/` `auth.ts`, `cors.ts`, `auth-policy.ts`, `supabase-key.ts`, `agentKeys.ts`, `fraudPatterns.ts`, `analysisRuns.ts`, `analysis.ts`, `parser.ts`.

- [ ] **Step 2: Confirm the deploy actually landed**

Run `list_edge_functions` and check `entrypoint_path` advanced to a new build directory for both — a version counter can move without a deploy, as it did when `GEMINI_API_KEY` was set. Then `get_edge_function` each one and confirm the returned `functions/_shared/analysis.ts` contains `DUPLICATE_HIGH_ROWS`.

- [ ] **Step 3: Prove the round trip on real data**

Re-run the deterministic agent on one already-parsed upload through the app's **Retry stage** control, then:

```sql
select rule, severity, count(*) from public.sentinel_findings
where upload_id = '<the upload you re-ran>' group by 1, 2;
```

Expected: every row rated, and the ratings equal to what the backfill had assigned that upload. **A disagreement means the live thresholds and the backfill thresholds have diverged** — fix before continuing, because it would mean a finding's rating depends on when it was written.

- [ ] **Step 4: Add end-to-end coverage**

Append to `tests/workspace.spec.ts`, following the file's existing sign-in and navigation helpers:

```ts
test("the queue reports a stage and filters on it", async ({ page }) => {
  await page.goto("/cases");

  // Assert something positive first: toHaveCount(0) is satisfied instantly by a page that
  // has not rendered, which is how an earlier walkthrough reported zero findings against a
  // database holding three.
  await expect(page.getByRole("columnheader", { name: /stage/i })).toBeVisible();
  await expect(page.getByRole("row").filter({ hasText: "Fraud review" }).first()).toBeVisible();

  await page.getByRole("combobox", { name: /stage/i }).selectOption("awaiting-import");
  await expect(page.getByRole("row").filter({ hasText: "Fraud review" })).toHaveCount(0);
  await expect(page.getByRole("row").filter({ hasText: "Awaiting import" }).first()).toBeVisible();
});
```

Run: `npx playwright test tests/workspace.spec.ts --workers=1`
Expected: PASS. Use `--workers=1`: cross-file isolation in this suite is incidental rather than guaranteed, and all prior evidence was gathered serially.

- [ ] **Step 5: Record the follow-ups**

Write `docs/superpowers/follow-ups/2026-08-10-case-risk-and-stage.md` in the form the two existing notes use — **Should fix soon**, **Known gaps, accepted**, **Traps worth not rediscovering**, **Closed since the last note**. Items known before implementation begins, to be confirmed or corrected against what actually happened:

- The 2 fraud-pattern findings stay unrated until that agent is re-run; a case whose only findings are theirs reads `not-assessed` while showing findings. Narrower than the contradiction this slice fixed, but the same family.
- `missing-amount` severity divides by the rows the agent saw. Re-run through `analyze-upload`, that is capped at `ANALYSIS_ROW_LIMIT` (10,000), so an import larger than that yields a different share than the inline pass computed — the same divergence already recorded for finding counts.
- The outlier backfill reads a number out of a summary string. It is exact today because the rules write that string, and it silently stops matching if the summary is ever reworded. The live rule and the backfill were deliberately aligned on the rounded multiple to make this safe; note that the coupling exists.
- Whether `invite-member` is still serving its v6 build. It was at the time of writing, and it is not this slice's job, but the note should say so rather than let it drop.

- [ ] **Step 6: Run everything**

Run: `npx vitest run` then `npm run build` then `npx playwright test --workers=1`
Expected: all green. Report actual output; do not claim completion from a partial run.

- [ ] **Step 7: Commit and open the PR**

```bash
git add tests/workspace.spec.ts docs/superpowers/follow-ups/
git commit -m "Cover risk and stage end to end, and record what is left"
git push -u origin case-risk-and-stage
gh pr create --title "A risk and stage a case can actually earn" --body "..."
```

---

## Self-Review

**Spec coverage.** Severity column and CHECK → Task 3. RPC persistence → Task 3. Deterministic thresholds → Task 1. Fraud-pattern schema, prompt, and best-effort validation → Task 2. Backfill with its three derivations and the null fallbacks → Task 3. The view, `security_invoker`, risk rollup, stage precedence → Task 3. Domain types, `analysisStatus` removal, service reading the view → Task 4. Filters restored → Task 5. Severity visible on findings → Task 6. Verify script, e2e, both deploys, ledger reconciliation → Tasks 3 and 7.

**One spec correction, made in Task 1.** The spec's backfill reads the *rounded* multiple out of the summary while implying the live rule compares the raw ratio. Those disagree between 9.5× and 10×: a finding printing "10x the median" would be rated `medium` live and `high` by the backfill. Task 1 compares the rounded multiple in both places. The spec has been updated to match — this is a change to the design, not just the plan.

**Type consistency.** `Severity` is defined once in `_shared/analysis.ts` (Deno side) and once in `src/domain/types.ts` (app side); the two never import each other, matching how `AGENT_KEYS` is deliberately mirrored rather than shared. `CaseStage` is defined in `src/domain/types.ts` and consumed by `sentinelInvestigations.ts` and `CaseQueue.tsx` under that name throughout. The view's column is `stage`; the domain field stays `stageId`; `toStage` is the only bridge.
