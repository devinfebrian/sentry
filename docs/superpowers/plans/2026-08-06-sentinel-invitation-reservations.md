# Sentinel Invitation Reservations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Harden manager invitations against concurrent duplicate Auth invites and retry failures.

**Architecture:** A service-role-only reservation table uses a unique workspace/email expression index as the concurrency arbiter. The Edge Function reserves before Auth, persists the Auth user ID before membership work, retries failed membership with that ID, and repairs the guarded activity event by member user ID.

**Tech Stack:** Supabase Postgres migration, Supabase Edge Function TypeScript, Vitest, Deno-compatible imports, Vite TypeScript build.

## Lease Hardening Addendum

- Use fixed `RESERVATION_LEASE_MS = 15 * 60 * 1000` based on `updated_at`.
- Reservation reads and `InvitationReservation` include `updated_at`.
- Conditional claims filter by `id`, prior `status`, and prior `updated_at`; return `{ claimed, reservation }`.
- Claim losers return generic `409` before Auth or membership work.
- Fresh reserved rows remain pending; stale reserved rows reclaim with or without stored `auth_user_id`.
- Hosted configured origins require HTTPS; HTTP remains limited to local default origins.
- Before Auth invite, query `auth.admin.listUsers({ page: 1, perPage: 100 })` and recover normalized email matches.
- Hosted route tests import function after environment stubbing and preserve local OPTIONS coverage.

## Global Constraints

- TDD order is mandatory: write focused failing tests, run RED, then write minimal production code and run GREEN.
- Immediate failed-reservation retry: preserve stored `auth_user_id`; call Auth only when reservation has no Auth ID.
- Never delete users, expose email/account existence, or log sensitive data.
- No remote push, deploy, or commit.
- Hosted CORS requires `SENTINEL_ALLOWED_ORIGINS`; wildcard is rejected; localhost defaults remain local-only.

---

### Task 1: Reservation schema and function test fixtures

**Files:**
- Modify: `supabase/migrations/20260806145323_sentinel_invitation_reservations.sql`
- Modify: `supabase/functions/invite-member/index.test.ts`

**Interfaces:**
- Produces table fields `id`, `workspace_id`, `email`, `auth_user_id`, `invited_by`, `status`, `created_at`, `updated_at`.
- Test adapters expose reservation `insert`, `select`, and `update` operations with PostgREST-like chaining.

- [ ] **Step 1: Add schema-contract assertions and reservation test adapter.**
  Assert migration text contains the table, required FKs, status check, lowercase unique index, RLS, revokes, and service-role grants. Extend mock admin client with reservation insert/select/update behavior needed by later tests.
- [ ] **Step 2: Run schema and invite tests to verify RED.**
  Run `npx vitest run supabase/functions/invite-member/index.test.ts supabase/functions/_shared/cors.test.ts`. Expected: new reservation tests fail because current flow has no reservation calls and migration is empty.
- [ ] **Step 3: Write migration SQL.**
  Create the table with `gen_random_uuid()` identity, workspace `on delete cascade`, Auth FKs, normalized email check, status check/default, timestamps, unique `(workspace_id, lower(email))`, workspace/status and Auth lookup indexes, RLS enablement, revokes for `public, anon, authenticated`, and service-role `select, insert, update` grants.
- [ ] **Step 4: Run schema assertions.**
  Run `npx vitest run supabase/functions/invite-member/index.test.ts`. Migration contract assertions pass while invite behavior tests remain RED until Task 3.

### Task 2: CORS hosted configuration contract

**Files:**
- Modify: `supabase/functions/_shared/cors.ts`
- Modify: `supabase/functions/_shared/cors.test.ts`
- Create: `supabase/functions/.env.example`

**Interfaces:**
- `allowedOriginsFrom(value?, localDevelopment?)` returns normalized configured origins, localhost defaults only when local, and no origins when hosted config is absent/invalid.
- `environmentAllowedOrigins()` derives local/hosted mode from Edge runtime environment.

- [ ] **Step 1: Add failing configured-hosted and unconfigured-hosted route tests.**
  Stub `Deno.env.get` for a hosted deployment with `SENTINEL_ALLOWED_ORIGINS=https://app.example`; assert that origin receives `204` and CORS headers. Stub hosted deployment without the secret; assert `https://app.example` receives `403`. Assert `*` never allows an origin.
- [ ] **Step 2: Run CORS tests to verify RED.**
  Run `npx vitest run supabase/functions/_shared/cors.test.ts`. Expected: current fallback accepts localhost in hosted mode and cannot prove configured hosted behavior.
- [ ] **Step 3: Implement explicit local/hosted origin selection.**
  Keep localhost defaults only when no hosted marker exists. Parse configured origins through existing URL normalization, return no allowed origins for hosted missing/invalid config, and preserve wildcard rejection.
- [ ] **Step 4: Add hosted secret documentation.**
  Document `SENTINEL_ALLOWED_ORIGINS=https://...` and exact command `supabase secrets set SENTINEL_ALLOWED_ORIGINS=... --project-ref ...` in `supabase/functions/.env.example`, noting localhost defaults are local-only and wildcard is rejected.
- [ ] **Step 5: Run CORS GREEN.**
  Run `npx vitest run supabase/functions/_shared/cors.test.ts`. Expected: all configured, unconfigured, localhost, and wildcard tests pass.

### Task 3: Reservation-first invite state machine

**Files:**
- Modify: `supabase/functions/invite-member/index.ts`
- Modify: `supabase/functions/invite-member/index.test.ts`

**Interfaces:**
- `reserveInvitation(admin, workspaceId, email, actorId)` inserts or reloads one reservation after a `23505` unique conflict.
- `transitionFailedReservation(admin, reservationId)` changes only `failed` rows to `reserved` and returns the current row.
- `reconcileInvitationEvent(client, admin, workspaceId, actorId, memberUserId)` remains the event repair boundary.

- [ ] **Step 1: Add failing reservation-before-Auth test.**
  Assert reservation insert happens after manager authorization and before `inviteUserByEmail`, with normalized email and inviter ID; assert Auth response ID is persisted before membership insert.
- [ ] **Step 2: Run single test to verify RED.**
  Run `npx vitest run supabase/functions/invite-member/index.test.ts -t "reserves before Auth"`. Expected: reservation insert is never called.
- [ ] **Step 3: Add failing unique-conflict test.**
  Make reservation insert return `23505`, reload a reserved row without Auth ID, and assert generic `409`, no Auth invite, no membership insert, and no sensitive response data.
- [ ] **Step 4: Run unique-conflict test to verify RED.**
  Run `npx vitest run supabase/functions/invite-member/index.test.ts -t "unique reservation conflict"`. Expected: current implementation calls Auth.
- [ ] **Step 5: Add failing post-invite membership retry test.**
  First request persists Auth ID then membership insert fails and marks reservation failed. Second request transitions failed to reserved, inserts membership with stored Auth ID, marks completed, and never calls Auth again.
- [ ] **Step 6: Run retry test to verify RED.**
  Run `npx vitest run supabase/functions/invite-member/index.test.ts -t "retries membership"`. Expected: current implementation calls Auth twice and has no reservation status update.
- [ ] **Step 7: Add failing event reconciliation test.**
  Provide completed/reserved reservation with stored member Auth ID and missing event; assert event lookup uses `metadata.member_user_id`, repair insert happens, and response is generic `409`. Event write failure must be generic `500`.
- [ ] **Step 8: Run event test to verify RED.**
  Run `npx vitest run supabase/functions/invite-member/index.test.ts -t "reconciles reservation event"`. Expected: current pending-membership-only path does not use reservation data.
- [ ] **Step 9: Implement minimal reservation helpers and state transitions.**
  Reserve before Auth, reload unique conflicts, transition failed rows conditionally, reuse stored Auth IDs, update reservation before membership insert, mark failed on membership failure, mark completed after membership success, and route all existing membership/event repair through generic outcomes. Preserve existing event unique-conflict handling.
- [ ] **Step 10: Run invite GREEN.**
  Run `npx vitest run supabase/functions/invite-member/index.test.ts`. Expected: new reservation cases and existing authorization/idempotency/error cases pass without duplicate Auth calls.

### Task 4: Full verification

**Files:**
- No additional production files.

- [ ] **Step 1: Run focused GREEN suite.**
  Run `npm test -- supabase/functions/invite-member/index.test.ts supabase/functions/_shared/cors.test.ts`.
- [ ] **Step 2: Run full Vitest suite.**
  Run `npm test`.
- [ ] **Step 3: Run production build.**
  Run `npm run build`.
- [ ] **Step 4: Run available Deno checks.**
  Run `deno check supabase/functions/invite-member/index.ts supabase/functions/_shared/cors.ts` when `deno` exists; otherwise record unavailable command output. Run `supabase --version` and available local migration validation commands without linking, pushing, or deploying.
- [ ] **Step 5: Inspect worktree.**
  Run `git status --short` if repository metadata exists; otherwise list changed paths from tool results. Confirm no remote operation occurred.
