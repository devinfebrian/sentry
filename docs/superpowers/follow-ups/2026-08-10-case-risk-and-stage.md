# Follow-ups: case risk and stage

**Date:** 2026-08-10
**Covers:** `36aa29b..3e1def2` — giving every investigation a risk level derived from finding
severities and a stage derived from agent runs, replacing the two hardcoded values, plus its
end-to-end coverage

Findings that were reviewed, triaged, and deliberately not fixed. Each was seen and
consciously deferred; none is an unknown. Grouped by whether it is worth acting on.

## Should fix soon

**The 2 fraud-pattern findings stay unrated until that agent is re-run.** The backfill in
`20260810060036_sentinel_case_risk_and_stage.sql` is scoped to `agent_key = 'deterministic'`
on purpose — the two pre-existing fraud-pattern findings were never asked for a severity, and
no column on record can reconstruct one. A case whose only findings are theirs therefore reads
`not-assessed` on the queue while its findings panel shows findings, which is the same family
of contradiction this slice fixed for stage, just narrower: one finding disagreeing with its
own case instead of a whole case disagreeing with itself. It clears the moment that agent next
runs and writes a severity through `analyze-upload`; nothing here needs a second migration.

**`missing-amount` severity divides by the rows the agent saw, not the rows the upload has.**
The backfill's denominator is `upload.row_count`, correct for the pre-agent findings it rates
because the old inline pass in `parse-upload` read every persisted row. A future re-run through
`analyze-upload` is capped at `ANALYSIS_ROW_LIMIT` (10,000; see
`supabase/functions/analyze-upload/index.ts:27`), so an import larger than that computes a
different share on re-run than the backfill computed at write time. This is the same
divergence already recorded in the 2026-08-10 multi-agent-analysis note for finding counts —
now it also touches the rating, not just how many findings there are.

## Known gaps, accepted

**Risk has only two live values: `high` on 14 cases, `not-assessed` on 36.** Confirmed against
the live view: all 14 `analysed` cases trace back to the same fixture CSV
(`tests/fixtures/sentinel-findings.csv`) imported repeatedly through the walkthrough tests, so
every one of them rolls up to the same maximum severity — `outlier-amount` at 25,000 against a
median of 2,510, 9.96x, which rounds to 10x and rates `high`. The Stage filter got all four of
its live values because stage comes from *how far analysis got*, which varies naturally across
50 imports at different points in the pipeline. Risk comes from *what analysis found*, and
every import here found the same thing. This is a property of the test data, not of the
rollup rule: a fixture with a `low` or `medium` outlier, or a clean import with zero findings
at all (still `not-assessed`, correctly), would exercise the missing values. Nothing in the
rule needs to change for that to happen.

**Rounding promotes severity in the 9.5x–10x window.** `OUTLIER_HIGH_MULTIPLE` in
`supabase/functions/_shared/analysis.ts` rates on `Math.round(entry.value / middle)`, the same
number the summary prints, so the rating can never contradict its own sentence — that
alignment was a design correction made in Task 1 (the spec, before this slice, implied
comparing the raw ratio, which would have let a finding read "10x the median" while rating
`medium`). The consequence is that a raw ratio anywhere from 9.5x up prints and rates as `10x`.
The live fixture sits exactly on that boundary at 9.96x. Correct by design and now proven
against real data; worth recording only because the next person to touch this rule should know
the rounding is load-bearing, not incidental.

**`AnalysisNotStartedState`'s `stage` prop is optional and silently omitted on two routes.**
`src/components/cases/AnalysisNotStartedState.tsx` takes `stage?: CaseStage` and renders
`{stage && <span>Stage: …</span>}` — nothing at all when it is absent. The two callers:
`CaseWorkspacePage.tsx` always passes `caseItem.stageId`, because it is rendering one specific
case that has a stage. `AnalysisNotStartedPage.tsx`, wired to the case-independent `/evidence`
and `/reports` routes in `App.tsx`, never passes it, because those routes exist before any case
is selected and there is no stage to show. That is the right behavior today. The gap is in the
type: the prop's optionality is a statement about `AnalysisNotStartedPage`'s situation, but it
also lets any future per-case caller that forgets to pass `stage` compile cleanly and render a
blank line instead of failing loudly, the same shape of bug `CASE_STAGE_LABELS`'s
`Record<CaseStage, string>` typing was built to catch one layer down.

**Whether `invite-member` is still serving its v6 build.** Unresolved from the two prior notes
and not re-checked in this slice — the deploy tooling available to this task was scoped to
Steps 4 and 5 only, with the two Edge Function deploys this slice does need (`parse-upload`,
`analyze-upload`) gated on human approval and out of reach here, so checking an unrelated
function's version was out of scope too. It is not this slice's job to fix, but the note should
keep saying so rather than let it drop a third time.

## Traps worth not rediscovering

**Assert something positive before asserting an absence, always.** `toHaveCount(0)` passes
instantly against a page that has not rendered yet — that is how an earlier walkthrough in this
project reported zero findings against a database holding three. The new
`"the queue reports a stage and filters on it"` test in `tests/workspace.spec.ts` checks a
`Fraud review` row is visible *before* filtering to `awaiting-import` and checking `Fraud
review` rows are gone; the second assertion is only meaningful because the first one already
proved the table renders and the label text is real.

**Do not poll the DOM with `reload()` inside `expect.poll`.** Recorded in the 2026-08-10
multi-agent-analysis note and reconfirmed rather than rediscovered here: `count()` does not
auto-wait, so each poll iteration re-navigates before React finishes rendering the previous
one, and the poll spins forever. The new test navigates to `/cases` once and asserts with
`toBeVisible`/`toHaveCount`, which do auto-wait, instead of polling.

**Option values and visible labels are not interchangeable in this UI, and the queue now has
both risk and stage filters that look alike.** `CaseQueue.tsx`'s stage `<select>` renders
`<option value={value}>{CASE_STAGE_LABELS[value]}</option>` — the DOM value is the slug
(`awaiting-import`) and the visible text is the label (`Awaiting import`). `selectOption` needs
the slug; row-text assertions need the label. Mixing them selects nothing and matches nothing,
silently, since neither Playwright call throws for a bad option value here.

## Closed since the last note

Recorded so nobody re-opens them: the case queue no longer says "Not assessed" and "Not
started" for every investigation — `sentinel_investigation_queue` derives both from
`sentinel_findings.severity` and `sentinel_agent_runs`, closing the gap the 2026-08-10
multi-agent-analysis note flagged under "Risk and stage are still hardcoded." The Risk and
Stage filters, dead since the analysis slice because there was nothing but one value to filter
on, are restored and functional — Stage confirmed against all four of its live values by the
new end-to-end test, Risk confirmed to work correctly even though the current fixture data only
exercises two of its four (see Known gaps, accepted, above).
