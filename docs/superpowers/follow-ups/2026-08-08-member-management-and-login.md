# Follow-ups: member management and the login path

**Date:** 2026-08-08
**Covers:** `83e3ec4..e173e8d` — the member-management feature (8 tasks) and the login-path audit (6 fixes)

Findings that were reviewed, triaged, and deliberately not fixed. Each was seen by at least
one reviewer and consciously deferred; none is an unknown. Grouped by whether it is worth
acting on.

## Applying migrations — read this before using `apply_migration`

`mcp__plugin_supabase_supabase__apply_migration` **ignores the filename and stamps its own
timestamp** into `supabase_migrations.schema_migrations`. The repo file and the remote row
will therefore never match on their own, and once the remote version sorts after the local
one, `supabase db push` hard-fails on ordering with an error that makes force-applying look
like the fix.

Two rules, both learned the hard way — this has now happened twice:

1. **Apply one logical migration in exactly one call.** Two calls produce two rows that can
   never reconcile against a single file.
2. **Reconcile immediately afterwards.** Delete the stamped row(s) and insert one whose
   `version` equals the repo filename prefix, then confirm with `list_migrations`. Touch
   only `schema_migrations` — never the schema itself, which is already correct.

Repaired this way for `20260808000000` and again for `20260809000000`. Repo and ledger are
currently 1:1 across all ten migrations; keep them that way.

## Should fix soon

**Playwright cross-file isolation is incidental, not guaranteed.**
`playwright.config.ts` sets `fullyParallel: true`. `tests/members.spec.ts` declares
`test.describe.configure({ mode: "serial" })`, but that only serialises *within* the file.
It happens to be safe today because no spec asserts on member counts — `workspace.spec.ts`
uses `not.toHaveCount(1)` and an empty-roster check. That is one assertion away from
flaking. All evidence for the feature was gathered at `--workers=1`.

**Role change has no UI-level end-to-end coverage.**
`Make manager` / `Make analyst` are exercised only through direct REST calls in
`tests/members.spec.ts`. The buttons themselves, and the `runAction` → `mutate` →
refetch path behind them, are covered by unit tests but never driven in a real browser.

**The schema verification script is loosely scoped.**
`supabase/verify_sentinel_member_management.sql` looks functions up by name without a
signature filter, so a same-named function with different arguments would satisfy it, and
its `pg_constraint` lookup matches on `conname` without scoping to the table. The
privilege assertions *are* signature-qualified and the `service_role` DELETE check landed,
so the residue is low-risk.

**Manual check never performed.**
The login-path fix for token rotation is proven by unit test — no re-query, no `loading`
flip — but nobody has confirmed in a real browser that an open Import dialog with a
previewed file survives an actual refresh. To verify: `npm run dev`, sign in, select a
file in the Import dialog, then force a token refresh (devtools, or shorten the JWT
expiry in Supabase Auth settings).

## Known gaps, accepted

**Reject-then-reinvite writes no second `member-invited` event.**
After a pending invitation is rejected and the same address invited again, the audit log
reads invited → rejected → nothing. The reservation is `failed` so `claimReservation`
re-claims it, but `reservation.auth_user_id` is still populated from the first invite, so
the flow skips `findAuthUserByEmail` and reaches the **direct** insert at
`supabase/functions/invite-member/index.ts:358`, whose
`if (eventError && eventError.code !== "23505")` silently swallows the partial-unique-index
violation. Note the design spec attributes this to `reconcileInvitationEvent` — that is
wrong; the line above is the real one. Fixing it means changing `invite-member`'s
idempotency model.

**Three `authenticated_security_definer_function_executable` advisor warnings.**
One per member-management RPC. Inherent to the chosen design — `SECURITY DEFINER`
functions in `public` granted to `authenticated` — and the in-body
`private.sentinel_is_manager()` re-derivation is exactly the mitigation the lint asks for.
Suppress or accept explicitly rather than re-triaging each audit.

**Deleting an `auth.users` row cascades the membership away** with no audit event and no
last-manager check. Admin-only, outside the product surface.

**A promoted analyst's live session keeps `role: "analyst"` until reload.** `AuthProvider`
syncs role once per session key. Self-corrects on token refresh, and the new
`refreshMembership()` gives a manual path.

## Fine to leave

- **Advisory lock key collisions.** `hashtext(...)` returns `int4` into the global
  single-key `pg_advisory_xact_lock(bigint)` namespace, so two workspaces could collide.
  Correctness-safe — collisions only over-serialise — and no other advisory lock exists in
  the schema to deadlock against.
- **`App.tsx` uses `as unknown as` to cast the Supabase client** to each service's
  structural type, bypassing compile-time checking on `rpc()`. Pre-existing pattern applied
  uniformly to all three service clients.
- **`mutate()` does not serialise concurrent calls** — it reads `requestIdRef` but never
  increments it, so the last resolver wins. Genuinely gated today by `busyUserId` plus the
  disabled invite controls.
- **`activeManagerCount`'s memo never memoises** while the roster is loading, because
  `members` is a fresh `[]` each render. Cost is a filter over zero items; it would matter
  only if `members` ever entered a dependency array.
- **The last-manager hint is effectively dead copy.** After the self-demotion guard landed,
  a non-self manager row implies a second active manager exists, so
  *"Workspace must keep at least one manager."* is near-unreachable in the UI. The server
  guard remains load-bearing. Relatedly,
  `disables demotion when only one active manager remains` now passes for two reasons and
  no longer isolates the `activeManagerCount` guard.
- **The last-manager hint has no `aria-describedby`** tying it to its button. The button is
  disabled and therefore unfocusable, so the text is read as row content.
- **Non-`Error` invite rejections say "Unable to update member."** where they used to say
  "Unable to invite member." `invite()` only ever throws `Error`, so the path is
  unreachable.

## From the identity and activity slice

- **Owner names cost an extra round trip per page.** `loadOwnerNames` in `src/app/App.tsx`
  calls `memberService.list()` on every `list()` and `getById()`, uncached, so opening a
  case queries the roster again. The roster is a handful of rows, so this is cheap today
  and would become worth memoising on a larger workspace.
- **Seeded display names are email fragments.** A member invited as
  `everydayplaylist25@gmail.com` shows up as `everydayplaylist25` until they rename
  themselves. Identifying, but not what anyone would choose to be called.
- **Unknown owners still render a UUID fragment.** `Member 5e2de68d` beats a full UUID and
  loses to a name. It only appears when an owner is missing from the roster.
- **`formatRelative` does not tick.** "12 min ago" is computed at render, so it goes stale
  on a page left open until something else forces a re-render.
- **The last-manager hint is now doubly unreachable.** Noted previously because a non-self
  manager row implies a second manager; the self-demotion guard closed the remaining path.
  The server guard stays load-bearing, but the copy is effectively dead.

## From the activity log slice

- **Bounded at 50 events with no pagination.** `DEFAULT_ACTIVITY_LIMIT` caps the feed, and
  the workspace already renders a full page of them. There is no way to reach older
  activity, which an audit trail will eventually need.
- **No filtering by type or actor.** Deliberate for now — the feed is short enough to scan.
  It stops being scannable somewhere in the low hundreds.
- **Deleted members render as `Member 14310c77`.** A rejected invitation removes the
  `sentinel_members` row, so the roster can no longer name them, but their events remain.
  The fallback is correct; an audit trail that forgets who it is about is not ideal.
- **`rationale` is still never written.** The column exists on `sentinel_activity_events`
  and every line is synthesised instead. Worth either populating or dropping.
- **The feed re-reads the roster per mount.** The lookup is cached per service instance, so
  it is one query per page rather than per read — but nothing invalidates it after a rename
  except a full remount. `MemberNameLookup.invalidate()` exists and has no caller.

## Closed since triage

Recorded so nobody re-opens them: the migration-history desync, the self-demotion empty
state, row actions being dead during an in-flight invite, the stale `database.types.ts`,
`sortMembers`' locale-sensitive comparison, the `.data-table` min-width predating the fifth
column, and `cleanupPendingMember`'s `finally` masking assertion failures — all fixed in
`b1af828` and the commits around it.
