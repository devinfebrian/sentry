# Sentinel Member Management Design

**Date:** 2026-08-07
**Status:** Approved
**Product:** Sentinel

## Goal

Let a workspace manager act on the roster: approve a pending member, change a member's role, and reject a pending invitation. Today `invite-member` creates a `pending` membership and nothing in the product ever moves it to `active`, so an invited analyst is permanently blocked at `MEMBERSHIP_PENDING_ERROR` and the workspace cannot onboard anyone.

## Scope

Activation, role change, and rejection of a pending invitation. Offboarding an active member is out of scope: it raises separate questions about investigations the departing member owns and whether removal is deletion or a revoked status.

## Authority and privilege

`authenticated` holds `update (role, status)` on `sentinel_members` plus the manager UPDATE policy, so activation and role change are already reachable from the browser. Rejection is not: it must clear the invitation reservation, and `sentinel_invitation_reservations` grants nothing to `authenticated` and has RLS enabled with no policies. Audit is not reachable either: `sentinel_activity_events` grants insert to `service_role` alone.

All three actions therefore run as `SECURITY DEFINER` functions rather than direct client writes. This also puts the last-manager guard inside a transaction, which an Edge Function could not do without inventing a locking scheme — counting managers and then writing is a read-then-write race, and two concurrent demotions would each observe a safe count and together leave the workspace with none.

## Database layer

One migration extends the `sentinel_activity_events` event_type CHECK with `member-activated`, `member-role-changed`, and `member-invite-rejected`. The existing partial unique index is scoped `where event_type = 'member-invited'` and is unaffected. Member events pass `investigation_id => null`, so the `sentinel_validate_activity_event_scope` trigger short-circuits.

The same migration adds three functions, each `security definer`, `set search_path = public, pg_temp`, revoked from `public` and `anon`, and granted execute to `authenticated`. Each re-derives authority from `private.sentinel_is_manager(p_workspace_id)` and raises `42501 Manager membership required.` if false; no argument is ever trusted as authorization. Parameters take the `p_` prefix used by the existing `private` helpers, which avoids the positional `$1`/`$2` workaround `sentinel_finalize_upload` needed for column-name ambiguity. Definer functions run as the table owner, which is how they reach `sentinel_activity_events` and `sentinel_invitation_reservations` despite the grants above.

Each function returns the resulting membership as `jsonb` — `{workspace_id, user_id, role, status}`, and `null` for a rejection. The service ignores the return value and refetches the roster instead; the payload exists so end-to-end tests can assert the outcome without a second query.

`sentinel_activate_member(p_workspace_id, p_user_id)` locks the member row `for update`, returns current state without writing an event if the member is already active, and otherwise sets `status = 'active'` and inserts `member-activated`.

`sentinel_set_member_role(p_workspace_id, p_user_id, p_role)` validates the role against `analyst|manager`, locks the row, and no-ops when the role is unchanged. A manager-to-analyst change first runs the last-manager guard. It then updates and inserts `member-role-changed` carrying `{from, to}`.

`sentinel_reject_invitation(p_workspace_id, p_user_id)` raises `P0001 Only pending invitations can be rejected.` for any other status. It captures the member's `invited_email`, deletes the member row, and inserts `member-invite-rejected`. When `invited_email` is non-null it also sets the reservation matched on `(workspace_id, lower(email))` — the same key as the unique index — to `failed` and bumps `updated_at`; a null `invited_email` means no reservation was ever created for this membership, so the update is skipped. `failed` rather than deletion because `claimReservation` already treats a failed reservation as immediately re-claimable, so re-inviting the address works with the grants that exist.

The guard reads:

```sql
select count(*) into manager_count
from (
  select 1 from public.sentinel_members
  where workspace_id = p_workspace_id
    and role = 'manager' and status = 'active'
  order by user_id
  for update
) as locked;

if manager_count <= 1 then
  raise exception using errcode = 'P0001',
    message = 'Workspace must keep at least one manager.';
end if;
```

`for update` cannot sit beside an aggregate, hence the subquery. `order by user_id` gives concurrent callers a consistent lock order so they serialize instead of deadlocking. The rows stay locked for the remainder of the transaction, so the count cannot go stale before the update lands.

## Service layer

`SentinelMemberService` gains `activate(userId)`, `setRole(userId, role)`, and `rejectInvitation(userId)`. `SentinelMemberClient` gains a narrowly typed `rpc` member beside `from` and `functions`, preserving the structural-fake pattern the service tests use. The service supplies `p_workspace_id` from its context; a client naming the wrong workspace simply fails the authority check.

Errors are keyed on SQLSTATE. `P0001` messages are authored as finished user-facing sentences and are surfaced verbatim rather than wrapped by `mapError`, matching how `processing.ts` already keys off `P0001` for lease loss. `P0002` becomes "Member not found. Reload the roster and try again." `42501` becomes the generic manager-required message; the interface never permits it and it exists as a backstop for a stale role in context. Everything else goes through the existing `mapError(operation, error)`.

`WorkspacePage.tsx` already carries load state, invite state, a request-id guard, and succeeded-but-refresh-failed recovery at 220 lines; three more actions with per-action pending and error state would push it past readable. The roster moves to `src/pages/useWorkspaceMembers.ts`, owning load, refresh, and a shared `mutate(action)` that runs a mutation then refetches, reusing the existing recovery rather than reimplementing it per action. `WorkspacePage` keeps layout and copy.

## Interface

The members table gains an Actions column rendered only for managers; an analyst sees the table unchanged rather than a column of blanks. A `pending` row offers Activate and Reject. An `active` analyst offers Make manager, an `active` manager offers Make analyst.

Activate and role change are reversible and fire immediately. Reject deletes the membership row and uses an inline two-step confirm within the row — the button becomes Confirm reject with a cancel beside it. No modal: `ImportDialog` is weighted for file intake, and inline keeps focus where the manager is already working.

The roster is in memory, so the client counts active managers and disables Make analyst with a short inline reason at a count of one. The server remains the authority; the client check avoids a pointless round trip and an alarming error, and is not the guard.

Pending state is per row: only the acted-on row disables and shows a busy label. Success and failure report into the existing `role="status"` notice and `role="alert"` regions below the table rather than spawning per-row live regions, matching invite and avoiding competing announcements.

The hook sorts pending members first, then active, `created_at` within each group. The current `created_at` ordering scatters pending members through the list, and approving them is the reason a manager opens the page. `.member-identity` is applied in JSX with no rule in `global.css`; it gains one alongside the new column's table styling.

## Failure handling

Every mutation failure shows its message and then refetches the roster best-effort. Almost every failure here means the client's view is stale — another manager activated the member, or demoted the other manager — and correcting the view is the manager's next need. Best-effort so a failed refetch cannot mask the original error.

Activating an already-active member succeeds and writes no event, so double-clicks and concurrent managers are harmless. Setting a role to its current value is a no-op. A member who accepts between render and click produces `P0001 Only pending invitations can be rejected.` A mutation that succeeds while the refetch fails reuses the invite wording: the action is reported as done, with a note that the list could not be refreshed.

## Known limitation

After reject then re-invite of the same address, `reconcileInvitationEvent` finds the pre-existing `member-invited` event — the partial unique index keys on workspace and `metadata.member_user_id` — and skips inserting a new one. The log reads invited, rejected, then nothing for the second invite. Correcting this means changing `invite-member`'s idempotency model and is deliberately deferred to a follow-up.

## Verification

Unit tests cover the service and interface; the SQL is only genuinely proven end to end.

`sentinelMembers.test.ts` extends the structural fake with `rpc` and proves each method calls the right function with the right arguments, `P0001` surfaces verbatim, `P0002` maps to the reload message, `42501` maps to manager-required, and unknown errors go through `mapError`. `WorkspacePage.test.tsx` proves managers see actions and analysts do not, reject requires the confirm step, Make analyst is disabled at one manager, per-row busy state, and both announcement paths. `useWorkspaceMembers.test.ts` proves sort order and the mutate-then-refresh contract.

`tests/members.spec.ts` proves activation writes `member-activated`, a promote/demote round trip writes two `member-role-changed` events, last-manager demotion is refused with the role unchanged in the database, rejection removes the member and sets the reservation to `failed` so the same address can be re-invited successfully, and an analyst calling each RPC directly over REST is refused.

These tests mutate membership in a workspace shared by every other spec, so the file runs under `test.describe.configure({ mode: "serial" })` with role restoration. The last-manager test asserts only a refusal against the single seeded manager, requiring no setup and leaving nothing to clean up. Tests needing a pending member invite their own unique address rather than touching the seeded pair.

Focused tests run RED before implementation, then GREEN; full Vitest and the TypeScript build follow.
