# Case Risk and Stage Design

**Date:** 2026-08-10
**Status:** Approved
**Product:** Sentinel

## Goal

Give every investigation a risk level and a stage that come from what the agents actually found and actually did. `mapRow` in `src/services/sentinelInvestigations.ts` currently returns `risk: "not-assessed"` and `stageId: "not-started"` for every case unconditionally, so a case holding four findings from two agents still reads "Not assessed / Analysis not started" in the queue. The Risk and Stage filters are withheld for the same reason: every row shares one value, so either filter could only ever return everything or nothing.

This is the same class of defect the agent-run backfill closed a day earlier — a case disagreeing with itself, where the summary said analysis had not started while the findings list showed three. Here the queue disagrees with the case.

## Scope

Severity recorded on findings by both producers, a backfill for findings that predate the column, a database view deriving risk and stage per investigation, and the two filters restored in `CaseQueue`.

Out of scope: findings paging past `DEFAULT_FINDING_LIMIT`, the bounded Gemini 503 retry, the `invite-member` deploy, and writing `sentinel_evidence.state`. That last one is why the `evidence-review` and `reporting` stages are retired rather than derived — see **Stage vocabulary**.

## Why severity has to be recorded rather than inferred

Nothing in the schema expresses how bad a finding is. `sentinel_findings` carries `rule`, `agent`, `agent_key`, `summary`, and `confidence`, and confidence answers a different question: whether the pattern is real, not what it means if it is. Every deterministic finding is confidence `1` by construction, because a rule that fires has proved its case.

Deriving risk in the app from rule identity and confidence was considered and rejected. It would have the app assert a judgment no agent ever made, and it cannot rank the fraud-pattern agent's rule slugs at all — those are free text from the model, deliberately unconstrained since the `sentinel_findings_rule_check` was dropped in `20260809174332`.

Finding **count** was also considered and rejected on evidence. Live, 19 cases have had the deterministic rules run against them. 14 of those hold exactly three findings — one per rule — and the other 5 hold none, because the rules emit one summary finding per rule regardless of how many rows offend. A count threshold therefore only ever separates "the rules found something" from "the rules found nothing", which is a distinction the reader can already make, and it puts 14 cases on a single value — the condition that got the filters withheld in the first place.

## Severity as a magnitude, not a label

A fixed rule-to-severity table has the same flattening problem: every case running the same three rules lands on the same risk. But each rule already computes a magnitude it can prove and currently discards.

| Rule | Magnitude available | `high` | `medium` | `low` |
| --- | --- | --- | --- | --- |
| `duplicate-amount` | `group.length` | ≥ 3 rows | 2 rows | — |
| `outlier-amount` | `Math.round(entry.value / middle)` | ≥ 10× median | ≥ 4× median | — |
| `missing-amount` | `affected.length / rows.length` | — | ≥ 10% of import | < 10% |

The outlier rule compares the **rounded** multiple — the same number its summary prints. Comparing the raw ratio would let a finding at 9.6× read "10x the median" while being rated `medium`, and would put the live rule out of step with the backfill below, which reads that printed number. One value, used for the words and the rating, so the two cannot disagree.

The empty cells are structural rather than omissions. `outlierAmounts` returns early below `OUTLIER_MULTIPLE` (4) and `duplicateAmounts` filters to groups larger than one, so neither can reach `low`. `missing-amount` cannot reach `high` at any volume: an absent amount is a data-quality gap, not a fraud signal, and a rule that cannot distinguish a bad export from a concealed payment should not claim it can.

The measurement is a proven fact; the threshold is declared policy. Both live in `supabase/functions/_shared/analysis.ts` beside the rule that computes them, so a reader sees the number and the cut in one place.

## The column

One migration adds severity to findings:

```sql
alter table public.sentinel_findings
  add column severity text
  check (severity in ('low', 'medium', 'high'));
```

Nullable, and deliberately without a default. `null` means *no producer rated this finding*, which is a different statement from `low`. A default would make every row that predates the column claim a rating nobody gave it, and 2 of those rows are AI findings whose severity genuinely cannot be reconstructed.

The CHECK is the loud failure if a producer ever emits an unrecognised value, on the same reasoning as the `agent_key` CHECK: a value the database does not recognise would otherwise flow into the rollup and quietly skew a risk level.

`public.sentinel_record_analysis` gains `finding ->> 'severity'` in its insert column list and values list. The signature is unchanged, so no grant changes and no drop-and-recreate. Any verify check asserting on this function must use `oidvectortypes(proc.proargtypes)` — `pg_get_function_identity_arguments` returns parameter *names* on this server, so a check comparing it against a bare type list silently passes while testing nothing whenever it asserts absence.

## What each producer records

**The deterministic rules** (`_shared/analysis.ts`) assign severity from the table above. `AnalysisFinding` gains a required `severity` field, so a rule that forgets to set one fails to compile rather than writing `null`.

**The fraud-pattern agent** (`_shared/fraudPatterns.ts`) is asked for severity through `responseSchema` as a string enum of the three values. The prompt must draw the distinction explicitly, because a model left to itself collapses the two: confidence is whether the pattern is there, severity is what it means if it is. A pattern can be unmistakable and minor — the live `cross-entity-sequential-invoices` finding sits at confidence 0.98, and that number says nothing about consequence.

`validateFindings` treats severity as best-effort. A missing or unrecognised value leaves severity `null` and **keeps the finding**, unlike `rule`, `summary`, and `confidence`, whose absence drops it. The asymmetry is deliberate: a real finding with an unrated severity is still worth showing, while a finding with no rule or no summary is not a finding. Structured output constrains shape, never truth — the same reason every citation is checked against the parsed rows rather than trusted.

## Backfill

The same migration rates the findings that predate the column, scoped `where severity is null and agent_key = 'deterministic'` so a re-run seeds nothing and overwrites nothing.

- **`duplicate-amount`** — the group size *is* the count of supporting evidence rows, since `duplicateAmounts` emits one evidence row per member of the group. Exact.
- **`missing-amount`** — the affected count is likewise the evidence row count, and the denominator is `sentinel_uploads.row_count`. Exact.
- **`outlier-amount`** — evidence is always two rows (the outlier and the median for contrast), so the multiple is not recoverable from the evidence. It survives only inside the summary the code wrote itself, in a format that code controls: `substring(summary from '([0-9]+)x the median')`. Exact because the live rule rates on that same rounded multiple; **where the pattern does not match, severity stays `null`** rather than falling back to a guess.

The 2 fraud-pattern findings are left `null`. Nothing recorded their severity, nothing can reconstruct it, and inventing one to make the column look complete is the fabrication the last several slices existed to remove. They gain a real severity when that agent is next run.

This mirrors the agent-run backfill's discipline: read the record, derive only what the record proves, leave the rest null.

## The view

```sql
create view public.sentinel_investigation_queue
with (security_invoker = true) as ...
```

Following `sentinel_manager_roster`, which is the existing precedent in this schema for a `security_invoker` view. RLS therefore applies as the calling user, and no new grants are introduced beyond select on the view.

The aggregation belongs in SQL rather than the browser for a specific reason. Deriving risk client-side means reading workspace-wide findings, and that read is capped at `DEFAULT_FINDING_LIMIT = 100` with no paging — already a recorded follow-up, at 44 findings today and growing with every import. A case whose risk silently changed because its findings fell off the end of a capped read would be a worse bug than the one this slice fixes. Aggregating where the rows are removes the cap from the question entirely, and keeps `list()` and `getById()` at one round trip each.

Trigger-maintained columns on `sentinel_investigations` were the alternative: fastest to read and directly indexable for server-side filtering. Rejected because they introduce a cached value with two writers, where any path that misses an update leaves a case asserting a risk it no longer has.

**Risk** is the highest non-null severity across the investigation's findings, ordered `high > medium > low`, and `not-assessed` when no finding carries one.

That includes a case whose agents completed and found nothing. `low` is reserved for *a finding exists and it is minor* — a claim backed by a row. A clean case reads `Analysed / Not assessed`, and the pair is accurate: we looked, and nothing was rated. Letting `low` mean both "a minor finding exists" and "no findings exist" would make the value unreadable in a filter.

**Stage** is the first matching condition over the runs on the investigation's uploads, and both the order and the phrasing are part of the design:

| Stage | Condition |
| --- | --- |
| `awaiting-import` | the investigation has no uploads |
| `analysing` | any run is `running` |
| `analysis-failed` | any run is `failed` |
| `awaiting-analysis` | some upload has no complete deterministic run |
| `fraud-review` | every upload has a complete deterministic run, and some upload has no complete fraud-pattern run |
| `analysed` | every upload has a complete run for every agent |

The conditions are written over *uploads lacking a complete run* rather than over run rows in a non-complete state, because an upload can legitimately have no run row at all — `parse-upload` seeds the rows, so a case opened during a parse is briefly in exactly that position, and it is the moment `useAgentRuns` polls through. Phrased the other way, such a case would match no condition until `analysed` and claim to be finished. `awaiting-import` leads for the same reason: with no uploads, every "some upload…" condition is vacuously false.

`analysing` outranks `analysis-failed` deliberately. A retry sets the failed run row to `running`, so a case with work in flight is described as in flight rather than by the failure being retried; if the retry also fails, the case returns to `analysis-failed` on its own. Per-upload detail stays where it already lives, in the pipeline on the case page — the queue's job is one word about the whole case.

## Stage vocabulary

The four stages in the design spec are `financial-analysis`, `fraud-pattern`, `evidence-review`, and `reporting`. Only the first two have a producer. Nothing writes `sentinel_evidence.state`, so it is `unreviewed` from insert forever and no case can enter or leave `evidence-review`; the decision and report steps are fixture-backed demo data. Both are retired here rather than derived, and return when something can move a case through them.

The replacement vocabulary names the pipeline's state rather than the last agent to touch it, because the two largest live populations are both actionable and a last-agent naming collapses them. Against the current 50 cases:

| Stage | Cases |
| --- | --- |
| `awaiting-analysis` — has an upload, deterministic never ran | 19 |
| `fraud-review` — rules complete, the investigator was never asked | 17 |
| `awaiting-import` — no upload at all | 12 |
| `analysed` — both agents complete | 2 |

Four populated values, none dominant, each telling the analyst what the case needs. A furthest-completed-agent naming would put 31 of 50 into a single `not-started` bucket that mixes "no data" with "data nobody analysed".

The 19 in `awaiting-analysis` are the uploads parsed before agents existed, seeded `waiting` by the agent-run backfill. They are correctly described: analysis genuinely has not run for them.

## Application surface

`src/domain/types.ts` gains `Severity`, and `CaseSummary.stageId` narrows from `string` to a `CaseStage` union so an unhandled stage is a compile error rather than a raw slug rendered in a table cell. `Finding` gains `severity: Severity | null`.

`analysisStatus` is deleted. It is optional, only ever holds `"not-started"`, and exists solely so `CaseHeader` can gate step completion at `caseItem.analysisStatus !== "not-started"` — a condition that is currently always false. That gate becomes `stage === "analysed"` restricted to the summary and findings steps, which is the thing it was always trying to express: `analysed` means both agents finished, and says nothing about evidence review or a decision, so those two steps and report never read `Complete` regardless of stage. This is cleanup inside code the slice already changes, not a general refactor.

`sentinelInvestigations.ts` reads the view in `list()` and `getById()`. `create()` still inserts into `sentinel_investigations` — the view is read-only — and maps its result to `not-assessed` / `awaiting-import`, which is exactly true for an investigation with no uploads.

`CaseQueue.tsx` restores the Risk and Stage `<select>` elements, replacing the comment that explains why they are withheld. Existing `?risk=` and `?stage=` links keep resolving: an unrecognised value matches no case, which is the behaviour today. `stageLabels` is rewritten for the new vocabulary and `riskLabels` is unchanged.

The findings list renders each finding's severity. A case that says "High risk" with no way to see which finding caused it puts the reader back where this slice started.

## Error handling

A failed view read surfaces through the existing `AnalysisUnavailableState` path rather than degrading to an empty success state — an error path that falls back to an empty success state hides itself perfectly, which is the shape of a bug already recorded once here.

Null severity is a first-class value at every layer and is never coerced to `low`: not in the view's rollup, not in the service mapping, not in the UI. A finding with no severity renders as unrated.

## Testing

Unit tests at the threshold boundaries, where an off-by-one is invisible: exactly 3 duplicate rows, exactly 4× and exactly 10× the median, exactly 10% missing. `validateFindings` with severity absent, with a value outside the enum, and with a non-string — each keeping the finding and leaving severity null. `CaseQueue` filters returning real subsets rather than everything or nothing, which is the regression that would return this feature to its starting state. `sentinelInvestigations` mapping view rows, including a row with `risk = null`.

`supabase/verify_sentinel_case_risk_and_stage.sql` asserts the column and its CHECK, `security_invoker = true` on the view, and the backfill's resulting counts per rule. Function assertions use `oidvectortypes(proc.proargtypes)`.

One end-to-end test drives a case to `fraud-review` and filters on it. Assertions of absence must follow a positive assertion — `toHaveCount(0)` is satisfied instantly by a page that has not rendered — and the DOM is polled with an auto-waiting matcher after a single navigation, never with `reload()` inside `expect.poll`.

## Deployment

Both Edge Functions change: `_shared/analysis.ts` is in `parse-upload`'s import graph and `_shared/fraudPatterns.ts` is in `analyze-upload`'s. Both redeploy with **every file in their import graph** inlined, keeping the `functions/<name>/…` prefixes. Editing the source ships nothing; tests can be entirely green against a runtime serving a months-old build.

The migration is applied in exactly one `apply_migration` call, and the ledger is reconciled to 1:1 immediately afterwards — either by renaming the repo file to the stamped version, which is preferred while the file is new and unpushed, or by correcting the `schema_migrations` row. Repo and ledger are currently 1:1 across all fifteen migrations.
