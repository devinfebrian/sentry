# Case Decision Design

**Date:** 2026-08-10
**Status:** Approved
**Product:** Sentinel

## Goal

Let a case be decided by the people reviewing it, and let the decision be recorded where it
cannot be quietly rewritten.

`sentinel_investigations.status` has carried a four-value union since the foundation
migration — `open | review | approved | closed` — and every investigation ever created holds
`open`. `create()` in `src/services/sentinelInvestigations.ts` writes it once at line 171 and
nothing in the application has ever moved it since. The status `StatusBadge` on the case
workspace page (`CaseWorkspacePage.tsx`) therefore reads "open" on every case in the workspace,
forever. (`CaseHeader`'s own badge is unrelated — it renders risk, not status.)

This is the same defect the last two slices removed, one layer over: a column that looks like
state but is a constant, and a badge that reports it as though it were earned. Risk and stage
stopped lying about what the agents found and did; status is what is left lying about what the
humans decided.

## Scope

A decision RPC, four new activity event types, the rationale column finally written to, a
`DecisionPanel` replacing `StepNotBuiltState` on the decision step, and end-to-end coverage of
the two-role handoff.

Out of scope: the report step, a Status column or filter on the queue, evidence-state writes,
the bounded Gemini 503 retry, and the `invite-member` deploy. The last two remain open from
the 2026-08-10 follow-up notes and are not this slice's job.

## The workflow the schema already encodes

The foundation migration wrote two update policies on `sentinel_investigations` on 2026-08-05:
one unconditional for managers, one bounding an assigned analyst to
`owner_id = auth.uid() and status in ('open', 'review')` on both sides of the check. Neither had
been exercised by anything in the application. `20260806044722_sentinel_rls_performance_hardening.sql`
then merged the two into the single policy below, a full migration before this slice was
planned — the substance is unchanged, but citing the two original policies as the ones
currently live would now be wrong, so this describes the merged policy as it actually reads:

```sql
create policy "sentinel investigations can update"
  on public.sentinel_investigations
  for update
  to authenticated
  using (
    private.sentinel_is_manager(workspace_id)
    or (
      private.sentinel_is_active_member(workspace_id)
      and owner_id = (select auth.uid())
      and status in ('open', 'review')
    )
  )
  with check ( -- same condition, repeated
    private.sentinel_is_manager(workspace_id)
    or (
      private.sentinel_is_active_member(workspace_id)
      and owner_id = (select auth.uid())
      and status in ('open', 'review')
    )
  );
```

The analyst branch bounds the status on **both** sides. An assigned analyst can move a case
between `open` and `review` and can do nothing else with it — writing `approved` or `closed`
fails the `with check` regardless of what the UI offers. The manager branch has no such bound.

So the two-role review chain is not a new idea being introduced here. It was declared on
2026-08-05, merged into its current single-policy form on 2026-08-06, and left unused until
this slice, which is the thing that finally exercises it. It is also, as shipped, not the
*only* thing standing between `authenticated` and a direct status write — see Guard 9, below.

```
                  ┌──────────────── request more evidence ──────────────┐
                  │                     (manager)                       │
                  ▼                                                     │
   ┌──────────┐  analyst recommends   ┌──────────┐  manager approves  ┌──────────┐
   │   open   │ ────────────────────▶ │  review  │ ─────────────────▶ │ approved │
   └──────────┘  approve | reject     └──────────┘                    └──────────┘
                                            │      manager rejects    ┌──────────┐
                                            └───────────────────────▶ │  closed  │
                                                                      └──────────┘
```

`approved` and `closed` are reachable-from, not terminal. A manager can request more evidence
on a decided case and send it back to `open`. This was chosen deliberately over freezing
terminal states: a review system that cannot correct itself records its own mistakes as
permanent, and the audit trail preserves the original decision either way.

## Where a decision lives

No new table. A decision is one activity event plus, in the same transaction, a status write.

`sentinel_activity_events` already carries `workspace_id`, `investigation_id`, `actor_id`,
`event_type`, `metadata jsonb`, `created_at` — and a `rationale text` column, declared at
`20260805_sentinel_foundation.sql:106`, that nothing has ever written to. The comment at the
top of `src/services/activityMessages.ts` says so outright: "`sentinel_activity_events.rationale`
exists but nothing has ever written to it, so every line is synthesised." The analyst's words
go there, in a real column with a real constraint, rather than into an unvalidated jsonb key.

| Written | Value |
| --- | --- |
| `sentinel_investigations.status` | the new status; skipped when the action does not move it |
| `sentinel_activity_events.event_type` | one of the four new types below |
| `sentinel_activity_events.actor_id` | `auth.uid()` |
| `sentinel_activity_events.rationale` | the actor's words, verbatim and trimmed |
| `sentinel_activity_events.metadata` | `{ from_status, to_status, recommendation }` |

Four types join the `event_type` CHECK, which `20260809174332` last extended to eleven:

`case-recommended`, `case-approved`, `case-rejected`, `case-evidence-requested`.

### What this buys

The revision history the decision step is built around is the event stream filtered to the
case. `useActivityFeed(investigationId)` already loads exactly that for `CaseActivityPanel`,
and `/activity` already renders it workspace-wide. A decision becomes visible in three places
for the cost of writing it in one.

A dedicated `sentinel_decisions` table was considered and rejected. It would give rationale a
column of its own — but the rationale column already exists — and would create a second
history surface that the activity feed would have to be taught about separately, so the same
fact would be stored twice and could disagree with itself. Decision columns directly on
`sentinel_investigations` were rejected for the sharper version of the same reason: they hold
only the latest decision, so the history would come from activity events regardless.

## Stage, risk, and status are three axes

`CaseStage`'s doc comment in `src/domain/types.ts` records that `evidence-review` and
`reporting` are absent because "nothing can move a case through them," and notes they return
when something can. This slice is that something — and stage still does not gain them.

| Axis | Derived from | Values |
| --- | --- | --- |
| Stage | `sentinel_agent_runs` | `awaiting-import` → `analysing` → … → `analysed` |
| Risk | `sentinel_findings.severity` | `not-assessed` \| `low` \| `medium` \| `high` |
| Status | decisions | `open` → `review` → `approved` \| `closed` |

Folding decisions into stage was considered and rejected. Stage means *how far analysis got*
and derives from agent runs alone; a stage that also read status would derive from two
unrelated inputs, and the rule verified end to end one day earlier would have to be rewritten
to accommodate a concept it has nothing to do with. "Analysed / High risk / Pending approval"
is three honest facts about three different things, not a case disagreeing with itself.

`sentinel_investigation_queue` therefore needs no change. It already selects `i.status`
through to the client, and its risk and stage derivation is untouched.

## The RPC

```sql
create or replace function public.sentinel_record_decision(
  p_investigation_id uuid,
  p_workspace_id     uuid,
  p_action           text,
  p_rationale        text
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
```

Five actions: `recommend-approve`, `recommend-reject`, `approve`, `reject`,
`request-evidence`. Returns `{ status, event_id }`.

`security definer` is forced rather than chosen. `sentinel_activity_events` has a SELECT
policy and no INSERT policy for `authenticated` — every audit write in this system goes
through a definer function or an edge function holding the service role. The consequence is
that RLS does not enforce the two-role split from inside this function, so the function
enforces it itself, in the guards below, matching the policies rather than inventing a second
rule.

**The actor is `auth.uid()` and is not a parameter.** `sentinel_record_analysis` takes
`p_actor_id` because an edge function calls it with the service role and has no session to
read. This one is called straight from the browser. Accepting an actor id would let any active
member forge an audit entry under a colleague's name, in the one table whose entire value is
that its entries cannot be forged.

### Guards

Evaluated in order; each raises and rolls back.

| # | Refuses | Code |
| --- | --- | --- |
| 1 | actor is not an active member of `p_workspace_id` | `P0001` |
| 2 | investigation not found in that workspace | `PT404` |
| 3 | `p_action` is not one of the five | `P0001` |
| 4 | `btrim(p_rationale)` is empty, or longer than 2000 characters | `P0001` |
| 5 | the case has no uploads | `P0001` |
| 6 | `recommend-*` by someone who is neither the case owner nor a manager | `P0001` |
| 7 | `approve` / `reject` / `request-evidence` by a non-manager | `P0001` |
| 8 | the action's status precondition is unmet | `P0001` |
| 9 | `approve` / `reject` where the latest `case-recommended` actor is `auth.uid()` | `P0001` |

Error style follows `sentinel_set_display_name`: `P0001` carries a message written for a human
and surfaced to the UI verbatim, `PT404` means not found. `PT404` — PostgREST's own
explicit-status convention, the `PT` prefix plus a three-digit code, rather than a Postgres
SQLSTATE — is deliberate: `P0002`, the standard plpgsql `no_data_found` code, has no entry in
PostgREST's default SQLSTATE-to-HTTP-status table and would surface as a bare 500 to a caller
that reached this RPC straight from the browser, where the status code is part of the contract.

**Guard 5** is the "no decision before analysis" rule. `awaiting-import` in the queue view is
exactly `pipeline.uploads is null or pipeline.uploads = 0`, so the guard is an `exists` against
`sentinel_uploads` on the same condition rather than a second definition of the same idea.
Approving a case with nothing in it would put an "Approved" badge on an empty investigation —
the same family of contradiction the last two slices existed to remove.

**Guard 6** mirrors the analyst update policy's `owner_id = auth.uid()` rather than inventing
a parallel rule. A manager may recommend on any case; an analyst may recommend only on their
own.

**Guard 9** is the separation-of-duties rule and the reason a two-role chain means anything.
Without it a manager who owns a case clicks twice and the review is theatre. It fails closed: it
looks up the latest `case-recommended` actor and refuses the action if none is found, rather than
trusting that `review` implies a recommendation exists. That trust would have been misplaced —
the policy above grants `authenticated` a direct `UPDATE` on `status`, so a manager could `PATCH`
it straight to `'review'` (or straight to `'approved'`) with no `case-recommended` event ever
written, which guard 8's status precondition cannot rule out from inside a function with no
visibility into how `status` reached its current value. The direct-PATCH path is closed a second
way at the same time, deliberately redundant with guard 9 rather than relied on instead of it:
`update (status) on sentinel_investigations` is revoked from `authenticated` in the same
migration that adds this function, so the write guard 9 defends against no longer exists either.

### Status preconditions (guard 8)

| Action | Requires | Writes |
| --- | --- | --- |
| `recommend-approve`, `recommend-reject` | `open` | `review` |
| `approve` | `review` | `approved` |
| `reject` | `review` | `closed` |
| `request-evidence` | `review`, `approved`, `closed` | `open` |

### The one-manager deadlock

Guard 9 means a workspace with a single manager cannot decide that manager's own cases. This
is accepted, and it is a true statement about the workspace rather than a defect: one person
cannot separate duties from themselves. The UI states it plainly — "You recommended this case.
Another manager must approve it." — instead of offering a button that always fails.

## The panel

`DecisionPanel`, new, in `src/components/decisions/`. The existing `DecisionRecord.tsx` is
untouched: it is fixture-backed and serves the `/demo` routes, and the two coexist in one
folder the way `AnalysisNotStartedState` and `StepNotBuiltState` already do.

The edit in `src/pages/CaseWorkspacePage.tsx` is narrow. `StepNotBuiltState` stops covering
`decision` and covers `report` alone; `DecisionPanel` takes the decision step. The
`awaiting-import` case still falls through to `AnalysisNotStartedState` via the existing
`analysisHasBegun` condition, which needs no edit — a case with no uploads has never started,
and that remains the honest thing to say on this step.

What the panel renders is decided by role, ownership, and status:

| Situation | Rendered |
| --- | --- |
| owner or manager, status `open` | Recommend approve / Recommend reject, plus a required rationale |
| manager, status `review`, someone else recommended | Approve / Reject / Request more evidence, plus a required rationale |
| manager, status `review`, they recommended | the recommendation read-only, and why they cannot act on it |
| manager, status `approved` or `closed` | Request more evidence, plus a required rationale |
| anyone else | current state and history, read-only |

Beneath it, always, the revision history: the case's decision events in reverse order, each
with actor, relative time, and the verbatim rationale.

### Plumbing

Two small additions the panel cannot work without.

`CaseSummary` gains `ownerId`. It carries `owner: string`, a resolved display name, and no
identifier, so nothing on the page can currently answer "am I the owner of this case." The
queue view already returns `owner_id`; this is one line in `mapRow` and one field on the
interface.

`role` threads from `App.tsx:49` into `CaseWorkspacePage`, the way it already reaches
`WorkspacePage` at line 123.

### Data flow

Reads reuse what exists. History comes from `useActivityFeed(investigationId)` — the same hook
`CaseActivityPanel` calls — filtered to the four decision types in the client. No new read
path and no new endpoint.

Writes go through a new `src/services/sentinelDecisions.ts` exposing
`record(investigationId, action, rationale)`, one concern per service module like the rest of
that folder. On success the page re-reads the case and the feed.

There is no optimistic update. The resulting status is the RPC's answer, not the client's
guess: guard 9 in particular can refuse an action the UI believed was permitted, because the
UI's view of who recommended is a render old. On failure the `P0001` message renders in a
`role="alert"` region.

`describeActivity` in `src/services/activityMessages.ts` gains four cases so the workspace feed
reads as sentences rather than falling to its `default` branch, and `ActivityEventType` in
`src/domain/types.ts` gains the four types. That union is currently two behind the database —
`analysis-completed` and `analysis-failed` are in the CHECK and not in the union — and this
slice closes that drift while it is in the file.

`ACTIVITY_COLUMNS` in `src/services/sentinelActivity.ts:20` gains `rationale`, which it omits
today because nothing ever wrote it, and `ActivityEntry` gains the matching optional field.

## Testing

**Unit.** Four new `describeActivity` sentences, one test each. `DecisionPanel` gets a test per
row of the table above, including the read-only self-recommendation state. `sentinelDecisions`
gets a call-shape test.

**Database.** Each of the nine guards gets a direct test against the RPC over REST, using the
service-role harness in `tests/`. These are the deliverable of this slice, not a supplement to
it: a UI that hides a button proves nothing about whether the database refuses the write, and
guards 5 and 9 are the two whose absence would be invisible from the interface.

**End to end**, in `tests/workspace.spec.ts`. `tests/env.ts` already provisions two real
identities — `SENTINEL_TEST_MANAGER_*` and `SENTINEL_TEST_ANALYST_*` — with separate storage
states, so the handoff is testable without new fixtures. One test: sign in as the analyst,
recommend on an analysed case, sign in as the manager, approve, and assert that the case header
badge and the activity feed both changed.

That test asserts something positive before it asserts an absence, per the rule recorded in the
2026-08-10 follow-up note: it confirms the recommendation is visible before confirming the
analyst's buttons are gone, because `toHaveCount(0)` passes instantly against a page that has
not rendered.

## Risks

**The e2e test writes real decisions into the live workspace and the rows outlive the run.**
The same property that made the last slice's own test run reintroduce the bug it fixed. A
decision is not idempotent the way re-running an agent is — `sentinel_record_analysis` replaces
one producer's findings, but decision events append and status advances. The test must pick or
create a case it is willing to leave decided, and the plan should say which.

**Guard 9 depends on the latest `case-recommended` event, which is the only ordering-sensitive
read in the function.** Two recommendations racing on one case could interleave. The status
precondition makes this narrow — the second write finds status `review` and fails guard 8 —
but the plan should confirm the row is locked for the transaction rather than assume the
precondition covers it.
