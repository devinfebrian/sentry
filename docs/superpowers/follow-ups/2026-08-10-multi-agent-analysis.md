# Follow-ups: multi-agent analysis and the fraud-pattern investigator

**Date:** 2026-08-10
**Covers:** `2226608..afc8f64` — the multi-producer analysis schema, `analyze-upload`, the
Gemini-backed fraud investigator, the real agent pipeline, and its end-to-end coverage

Findings that were reviewed, triaged, and deliberately not fixed. Each was seen and
consciously deferred; none is an unknown. Grouped by whether it is worth acting on.

## Should fix soon

**Transient Gemini 503s cost the analyst a manual retry.** Two of five live calls during
this slice came back `503`, and one of those was a re-run of a request that had just
succeeded. The design absorbs it — the run goes `failed` with `the model returned HTTP 503`
and **Retry stage** works — but the analyst clicks, waits 12–28 seconds, and gets nothing.
A bounded retry on 503/429 inside `geminiModel.ts` would close it. The reason it was not
added: a single call already runs 12–28 seconds against the Edge Function wall clock, and a
retry inside the request risks trading a visible failure for a timeout. If it is added,
measure the ceiling first.

**`invite-member` is still serving its v6 build.** Unchanged from the 2026-08-08 note and
still true: `display_name` seeding and the active-member message are merged, tested, and not
live. Setting the `GEMINI_API_KEY` secret bumped the function's version counter to 7, which
is misleading — `entrypoint_path` still points at the `_6` build and `updated_at` never
moved. A version bump from secret propagation is not a deploy.

## Known gaps, accepted

**The pipeline does not poll; the upload panel does.** `useUploadStatus` polls with backoff,
`useAgentRuns` reads once on mount. Right after an import the upload panel updates live while
the pipeline appears only on navigation or reload. Noticed once per import, and the e2e test
works around it by waiting on the API before navigating. Worth fixing when someone touches
that page next.

**Agent runs are not backfilled.** Run rows only exist from this migration forward, so the 23
uploads parsed before it show no pipeline at all and their case summaries still read "Analysis
not started" despite holding findings. A backfill would have to invent `started_at`,
`completed_at`, and an `input_count` nobody recorded. Fabricating those to make old cases look
tidy is exactly the kind of thing the last several slices existed to remove.

**One upload has a one-stage pipeline.** `a8070faa` was used to verify `analyze-upload`
against the live database before any fresh import existed, so it has a `fraud-pattern` run and
no `deterministic` one. Truthful, and it will look odd to anyone who opens it.

**A stage's `total` counts uploads, not rows.** Deliberate — a run either finishes or it does
not, so per-run progress would have to be invented. It does mean the percentage moves in
coarse steps on an investigation with few uploads.

**Findings reads are still capped at `DEFAULT_FINDING_LIMIT` with no paging**, and a second
producer fills that faster than one did. Unchanged from the analysis slice, now closer.

**Deterministic rules read at most `ANALYSIS_ROW_LIMIT` (10,000) rows on a re-run**, where the
inline pass saw every parsed row in memory. The run records `input_count`, so the number shown
is the number the agent actually saw, but a >10k-row import is analysed differently through
`analyze-upload` than it was through `parse-upload`.

## Traps worth not rediscovering

**`pg_get_function_identity_arguments` returns parameter *names* on this server.** It gives
`p_upload_id uuid, p_workspace_id uuid, …`, not `uuid, uuid, …`. Any verify check comparing it
against a bare type list never matches — which is silent when the check asserts *presence*
(it fails loudly and you fix it) and **dangerous when it asserts absence**, because it passes
while testing nothing. The "single-producer `sentinel_record_analysis` must be dropped" check
did exactly that on its first run. Use `oidvectortypes(proc.proargtypes)`.

**`src/lib/database.types.ts` is hand-curated and partial.** It covers six tables, has an
empty `Functions: {}`, and deliberately omits `sentinel_findings`, `sentinel_evidence`, and
now `sentinel_agent_runs` — those are reached through structurally-typed service clients
instead. Regenerating it with `supabase gen types` replaces hand-narrowed unions
(`role: "analyst" | "manager"`) with bare `string`, because CHECK constraints are not enums,
and breaks four call sites in `AuthProvider`, `sentinelInvestigations`, and `sentinelMembers`.
Do not regenerate it to pick up a new table; the convention is that analysis tables stay out.

**Hosted Edge Functions set `DENO_DEPLOYMENT_ID`, so the localhost CORS defaults do not
apply.** `environmentAllowedOrigins()` falls through to `[]` when `SENTINEL_ALLOWED_ORIGINS`
is unset on a deployed function, and every browser call fails preflight. The secret is set on
this project and includes the loopback origins, which is why dev-server testing works — it is
load-bearing, not incidental.

**A Node script with no `Origin` header bypasses CORS entirely.** The first live verification
of `analyze-upload` drove it from Node and proved nothing about the browser path. Confirm
CORS with an `OPTIONS` preflight carrying the real origin, or with a browser.

**Model availability is not what `ListModels` says.** Both pro tiers return HTTP 429 with
`limit: 0` on this account, which is a tier exclusion rather than a temporary limit — retrying
never clears it, and the message names a different model than the one requested.
`gemini-2.5-flash` returns 404 despite being listed. Probe with a real request before pinning
a default.

**Structured output constrains shape, never truth.** Gemini's `responseSchema` cannot express
numeric bounds and cannot make a model cite a row that exists. `confidence` is clamped and
every citation is checked against the parsed rows in `validateFindings`; across five live runs
zero citations were fabricated, but the check is what makes that a guarantee rather than an
observation.

**`count()` does not auto-wait in Playwright.** Polling the DOM with `reload()` inside
`expect.poll` spins forever: each iteration re-navigates before React has rendered the
previous one. Wait on the API, then navigate once and assert with an auto-waiting matcher.

## Closed since the last note

Recorded so nobody re-opens them: `analyze-upload` was listed on 2026-08-08 as the one
deliberately deferred piece of the analysis slice and now exists; the swallowed analysis
failure in `parse-upload` is now a visible failed run with a reason; and the stale
`database.types.ts` concern is resolved in the opposite direction from what was assumed — the
file is curated on purpose.
