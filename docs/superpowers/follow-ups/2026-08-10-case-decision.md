# Follow-ups: case decision

**Date:** 2026-08-10
**Covers:** `4f16f12..1fdbd33` — the decision RPC and its nine guards, the rationale column
finally written to, `DecisionPanel`, and end-to-end coverage of the analyst-recommends /
manager-approves handoff.

**Verified before writing this note:** `npx tsc -b` — clean, 0 errors. `npm test` — 555/555
tests passed across 48/48 files. `npm run test:e2e` — 38/38 passed.

Findings that were reviewed, triaged, and deliberately not fixed. Each was seen and
consciously deferred; none is an unknown. Grouped by whether it is worth acting on.

## Should fix soon

**No test exercises `reject` or the `case-rejected` event type.** All nine database guard
tests in `tests/decisions.spec.ts` and the one browser walkthrough in `tests/workspace.spec.ts`
drive `approve`. `reject` shares guards 7, 8, and 9 with `approve` and differs only in its
status write (`review → closed` instead of `review → approved`), so the untested surface is
narrow — but a regression that swapped the two destination statuses would pass every test that
exists today.

**Three of `tests/decisions.spec.ts`'s refusal tests don't assert the status is unchanged.**
The unknown-action test, the analyst-recommending-on-a-case-they-don't-own test, and the
second-recommendation-while-one-is-pending test all check the error but not that
`sentinel_investigations.status` stayed put, unlike the other five refusal tests in the same
file. A guard that raised the right error but still wrote the status before rolling back — or
failed to roll back at all — would still pass these three.

**`seedCase`'s own assertions can leak an investigation.** In `tests/decisions.spec.ts`,
`seedCase` inserts the investigation, asserts `201`, then (when `withUpload` is set) inserts
the upload and asserts `201` again — all before returning. If that second assertion fails, the
function throws before the caller's `const seeded = await seedCase(...)` completes, so the
`try { … } finally { removeCase(seeded) }` guarding every test never runs, because `seeded` was
never assigned. The already-created investigation row is never cleaned up. Narrow (only a
mid-seed failure triggers it) but a real leak path, distinct from the deliberate one below.

**`removeCase`'s two teardown `DELETE`s aren't checked.** The purge RPC call inside it is
asserted (`expect(purged.status).toBeLessThan(300)`, added in Task 2's fix round — see Traps,
below), but the `sentinel_uploads` and `sentinel_investigations` `DELETE`s after it are fired
and ignored. A failed teardown on either still leaks silently, the same shape of bug the purge
assertion was added to close, just not closed all the way.

**`removeCase`'s purge assertion runs inside a `finally` block.** If an earlier assertion in a
test body already failed, the `finally` still runs the purge, and a purge failure there
produces a second error whose stack doesn't obviously connect to the first. Not wrong, just a
debugging tax the next person pays.

**`workspaceIdFor` selects with `limit 1` and no `order by`.** Works today because the
underlying query rarely returns more than one row in this environment; Postgres makes no
ordering promise without one, so a second matching row would make the result silently
nondeterministic rather than fail loudly.

**`tests/decisions.spec.ts:4` calls `requireCredentials("manager")` inside a `describe` block
that signs in and runs as the analyst.** Both credential sets resolve from the same `.env`, so
nothing breaks, but the call names the wrong role and would mislead the next reader before it
misled a test run.

**`sentinel_record_decision` writes `updated_at = now()` explicitly**, duplicating
`private.sentinel_touch_investigation_activity`, whose own comment claims ownership of that
column. Two writers agreeing today isn't a guarantee they keep agreeing after either one
changes independently.

**Guard 9's read of the latest `case-recommended` event has no supporting index.** There is no
index on `(investigation_id, event_type, created_at)` on `sentinel_activity_events`, so every
`approve`/`reject` seq-scans the audit log for that one row. Free at today's row count; the
table is append-only and only grows, and it now has two readers of this shape (guard 9 and the
activity feed's decision filter).

**`DecisionPanel.test.tsx`'s "lets a manager reopen a decided case, and nothing else" doesn't
check Reject.** It asserts Approve is absent once a case is `approved`, but never asserts Reject
is absent too — so "and nothing else" in the test's own name is only half proven. The same shape
as the three refusal tests above: a passing test whose title promises full coverage while
checking only one of two alternatives. Cheap to close — one more `queryByRole` assertion — not
done here because it wasn't required for Task 5's exit criteria.

**A failed submit's `role="alert"` and the activity feed's `ErrorState` can both be on screen at
once.** If the decision submit fails while the feed is independently in its own error state, two
`alert` regions render simultaneously, with no coordination between them and no defined order
for which a screen reader announces first. Not incorrect — both messages are true — just noisy.
Worth folding into one region, or ordering the announcement, if it's ever reported as confusing
in practice; not observed to be, yet.

**The two fraud-pattern findings are still unrated.** `select count(*) from sentinel_findings
where severity is null` returns `2` against the live database — unchanged from the number the
2026-08-10 risk-and-stage note recorded. This slice never touches `sentinel_findings` or
re-runs an agent, so there was no mechanism here that could have changed it, and none did. It
still clears the way that note said: the next time the fraud-pattern agent runs against the
uploads that produced them.

## Known gaps, accepted

**The one-manager deadlock.** Guard 9 refuses `approve`/`reject` when the actor is the same
person who wrote the case's latest `case-recommended` event. A workspace with exactly one
manager can therefore never decide that manager's own recommended cases — there is no second
manager to hand it to. Accepted rather than special-cased: separation of duties is not
satisfiable by one person, and a button that is always refused by the database is worse than no
button. The panel says so in words instead — "You recommended this case. Another manager must
approve it." — so the person reading it understands why, rather than clicking and being told no
by a system that could have said so up front.

**`approved` and `closed` are not terminal.** `request-evidence`, manager-only, accepts a case
in `review`, `approved`, or `closed` and sends it back to `open`. Freezing the two end states
was considered and rejected: a review system that cannot correct itself records its own
mistakes as permanent, and nothing is actually lost by allowing the reversal — the activity feed
keeps every prior decision whether or not a later one supersedes it, so "approved, then reopened
for more evidence" is still fully readable in the history. The two-role split still applies on
the way back in — only a manager can call `request-evidence`, an analyst cannot self-service a
reopen.

**During the activity feed's `loading` state, Approve and Reject render before the recommender
is known.** This is the same misleading-button shape Task 5 spent a fix round closing for the
feed's *error* state — while the feed hasn't resolved, `lastRecommender` is null, so a manager
who wrote the recommendation could, for that window, see Approve/Reject with no explanation of
why they can't act on their own recommendation, which is exactly the outcome the error-state fix
exists to prevent. Seen during that same review and deliberately left open rather than folded
into the same fix, because the two states aren't the same risk: `error` is a stable end state
that can sit in front of a manager indefinitely with nothing to self-correct it, where `loading`
is transient and clears itself the moment the feed resolves — in practice a fraction of a second
against the live database, not a state a person reads and acts on. Guard 9 still refuses the
write server-side regardless of what the panel renders, so the worst case during this window is
an extra round trip and a refusal message, not a bypass of separation of duties. What would
change the decision: evidence that the window is wide enough in practice to be seen and acted on
— a slow connection, a large feed — at which point the fix is the one already built for the
error path, withholding Approve/Reject until the recommender is known rather than only until the
load fails.

**`invite-member` is still serving its `_6` build.** Checked against the live project
(`lehwqjzzuppjnddwxxow`) via `list_edge_functions`: `entrypoint_path` still reads
`.../user_fn_..._4035ee81-7ae9-4062-8415-f55962a3ddef_6/source/functions/invite-member/index.ts`
— the same build the three prior notes named, deployed 2026-08-06. `version` reads `7`, the
same reading the multi-agent-analysis note already recorded and diagnosed: a `GEMINI_API_KEY`
secret write bumps the function's version counter without redeploying it, so `version` is not
the field to trust here — `entrypoint_path` and `updated_at` are, and neither has moved since
that note. This is the fourth note to say so. It stays out of scope by design: the case-decision
spec lists the `invite-member` deploy explicitly alongside the Gemini 503 retry as work this
slice is not doing.

## Traps worth not rediscovering

**A policy quoted from the migration that created it may have been replaced since.** The plan
asserted "`review` is only reachable through a recommendation" and justified skipping a
defensive check in guard 9 by quoting the two update policies from
`20260805_sentinel_foundation.sql`. Both the citation and the conclusion were false by the time
this slice started: `20260806044722_sentinel_rls_performance_hardening.sql` — a full migration
earlier — had merged the two update policies into one granting `authenticated` a direct
`UPDATE` on `sentinel_investigations` (any manager unconditionally, the assigned analyst while
status is `open`/`review`). In practice this meant a manager could `PATCH` status straight to
`'review'` and then call `approve` alone, with no `case-recommended` event ever existing to
refuse against — or `PATCH` straight to `'approved'` with no audit event at all. Caught in
Task 1's review, not by the plan. Closed two ways at once, deliberately redundant rather than
picking one: guard 9 fails closed (refuses when no recommender row is found, instead of
assuming the precondition already guarantees one), and `update (status)` is revoked from
`authenticated` outright, so the direct-PATCH surface guard 9 now defends against doesn't exist
either. The generalizable lesson: a sentence of the form "the policy says X" is only as current
as the date it was last checked against the schema, and this schema's policies get merged and
rewritten by later migrations (see 2026-08-06) without every doc that quotes them noticing.

**`P0002` does not map to a 404 in PostgREST — it surfaces as a bare 500.** `P0002` is the
standard plpgsql `no_data_found` SQLSTATE, and PostgREST's default SQLSTATE-to-HTTP-status table
has no entry for it, so a caller sees a server error for what is really a routine not-found.
`PT404` is PostgREST's own convention instead: the `PT` prefix plus a three-digit code sets the
HTTP status directly, bypassing SQLSTATE mapping entirely. Both the plan and the original spec
specified `P0002` for guard 2; Task 2's review caught the mismatch — this RPC is called straight
from the browser, where the status code is part of the contract, not an implementation detail —
and the migration, `sentinelDecisions.ts`'s `mapRpcError`, and (in this task) both docs now say
`PT404`.

**A test that counts filtered rows and then loops by index breaks against any concurrent
writer.** `tests/workspace.spec.ts`'s stage-filter test counted the visible rows after applying
a filter and then indexed into them across several `await`s — safe only while nothing else
writes to the queue between the count and the last index read. This branch's decision fixtures
seed and delete cases from other spec files running in parallel (`playwright.config.ts` sets
`fullyParallel: true`), which turned a latent race into a reliable failure the first time this
branch's full suite ran together — the agent that hit it first misdiagnosed it as
"pre-existing, unrelated," which the controller verified was wrong by bisecting against `main`
and against this branch in isolation. Hardened to one `allTextContents()` call inside
`expect.poll`, reading the whole row set at once instead of a count plus separate indexed reads.
Fixing it surfaced a second, independent race in the same test: Playwright's `selectOption()`
resolves before React has re-rendered from the resulting change event, so a bare `toBeVisible()`
called immediately after selecting an option can be satisfied by the stale pre-filter DOM rather
than the filtered one. Both are closed by the same `expect.poll`, which keeps retrying until the
polled text matches the post-filter expectation — something only a real re-render can produce.

**The append-only audit table has no DELETE grant for anyone, including `service_role`.**
`sentinel_activity_events`'s foundation grant is INSERT-only to `service_role`, nothing to
`authenticated`, on purpose — no session, not even one holding the service-role key, can rewrite
or erase the audit trail. A REST `DELETE` against it from test teardown therefore 403s, and
because the original teardown never checked the response, it did so silently: `case-*` events
from every run of the decisions suite piled up in the live workspace, unnoticed, the same class
of bug as an unchecked-response leak elsewhere in this project's test suites.
`sentinel_purge_case_decision_events` is the fix, and it is deliberately narrow — a `security
definer` function, grantable to `service_role` only, that deletes only `case-%`-prefixed events
for one named investigation, leaving the append-only guarantee against `authenticated` exactly
as tight as before. Both `tests/decisions.spec.ts` and `tests/workspace.spec.ts` now assert its
call succeeds (`expect(purged.status).toBeLessThan(300)`) instead of firing a DELETE and moving
on.

**A brief's named test locator can be wrong even when the brief is right about what to test.**
Task 6's brief asked for a test asserting on the text "Decision record" — but that string is the
decision step's static title, rendered whether or not `DecisionPanel` is actually wired in, so a
test that located it could never fail against the bug it existed to catch. Replaced with
`role="region"` on the panel's own section, which only exists once the panel is genuinely
rendered — a passing test locator is not itself evidence the locator proves anything.

## Closed since the last note

**`sentinel_activity_events.rationale` is written to for the first time.** Flagged in the
2026-08-08 member-management note as a column that "exists but nothing has ever written to it,
so every line is synthesised," and left there as "worth either populating or dropping." This
slice populates it: an analyst's or manager's own words, trimmed and bounded to 2000 characters
by a check constraint, stored verbatim in a real column rather than folded into an unvalidated
`metadata` key.

**`ActivityEventType` is no longer behind the database's `event_type` CHECK.**
`analysis-completed` and `analysis-failed` were added to the SQL constraint during the
multi-agent-analysis slice but never to the TypeScript union; both are now present, alongside
the four new decision event types, closing that drift while this slice was already touching the
file for its own reasons.

**`sentinel_investigations.status` stops being a constant.** Every investigation has read
`open` since `create()` first wrote it once and nothing moved it since — the same shape of bug
the risk-and-stage slice closed for stage and the multi-agent-analysis slice closed for the
pipeline: a column that looks like derived state but never actually derives. Status now
advances through `open → review → approved | closed` under the nine guards recorded above, and
back to `open` on `request-evidence`. The `CaseHeader` badge now reports something earned.
