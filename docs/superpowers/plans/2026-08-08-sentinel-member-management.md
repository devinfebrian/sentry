# Sentinel Member Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a workspace manager activate a pending member, change a member's role, and reject a pending invitation, so an invited analyst is no longer permanently stuck at "Workspace access is pending".

**Architecture:** Three `SECURITY DEFINER` Postgres functions granted to `authenticated` do the work. Each re-derives the caller's manager status internally from `private.sentinel_is_manager()`, takes a transaction-scoped advisory lock on the workspace, mutates the membership, and writes an audit event — all in one transaction. The browser calls them through `supabase.rpc()` via the existing structurally-typed `SentinelMemberClient`. Roster state moves out of `WorkspacePage` into a `useWorkspaceMembers` hook.

**Tech Stack:** Postgres (Supabase), plpgsql, TypeScript, React 19, `@supabase/supabase-js` v2, Vitest + Testing Library, Playwright.

**Spec:** `docs/superpowers/specs/2026-08-07-sentinel-member-management-design.md`

## Global Constraints

- Every new SQL function is `security definer`, `set search_path = public, pg_temp`, and re-derives authority from `private.sentinel_is_manager(p_workspace_id)`. Arguments are never trusted as authorization.
- New functions default to `execute` for `public`. Every function MUST be followed by `revoke execute ... from public, anon;` before `grant execute ... to authenticated, service_role;`.
- Function parameters use the `p_` prefix (matching `private.sentinel_is_active_member(p_workspace_id)`). Do not use the positional `$1`/`$2` style from `sentinel_finalize_upload`.
- SQLSTATE contract, relied on by the service layer:
  - `42501` — caller is not a manager. Message: `Manager membership required.`
  - `P0002` — member row not found. Message: `Member not found.`
  - `P0001` — a business rule refused. The message is user-facing prose and is shown verbatim.
- Activity event metadata for membership events carries `member_user_id` only (plus `from`/`to` for role changes). **Never** put `invited_email` in an activity event — the events table is readable by every active member, but `invited_email` is withheld from analysts by column grant.
- Membership events pass `investigation_id => null` so the `sentinel_validate_activity_event_scope` trigger short-circuits.
- Existing user-facing copy is reused verbatim where it already exists. Do not reword `MEMBERSHIP_PENDING_ERROR` or the invite notice strings.
- Run `npx vitest run` (full suite, currently 288 passing) before every commit. It must stay green.

## Applying migrations

This project is linked to Supabase project ref `lehwqjzzuppjnddwxxow`. The Supabase CLI is not a package dependency. Apply migrations with the Supabase MCP tool:

```
mcp__plugin_supabase_supabase__apply_migration
  name: "sentinel_member_management"
  query: <full contents of the migration file>
```

Run verification SQL with `mcp__plugin_supabase_supabase__execute_sql`. If you have the CLI installed globally instead, `supabase db push` and `psql -f <file>` are equivalent.

## File Structure

| File | Responsibility |
|---|---|
| `supabase/migrations/20260808000000_sentinel_member_management.sql` | **Create.** Event-type CHECK extension plus the three RPCs and their grants. |
| `supabase/verify_sentinel_member_management.sql` | **Create.** Schema assertions, following `verify_sentinel_foundation.sql`. |
| `src/domain/types.ts` | **Modify.** Add three methods to `SentinelMemberService`. |
| `src/services/sentinelMembers.ts` | **Modify.** Add `rpc` to the client type, SQLSTATE error mapping, and the three methods. |
| `src/services/sentinelMembers.test.ts` | **Modify.** Extend the structural fake with `rpc`; cover each method and each SQLSTATE. |
| `src/pages/useWorkspaceMembers.ts` | **Create.** Roster load, refresh, pending-first sort, and `mutate(action)`. |
| `src/pages/useWorkspaceMembers.test.ts` | **Create.** Sort order and mutate-then-refresh contract. |
| `src/pages/WorkspacePage.tsx` | **Modify.** Consume the hook; render the manager-only Actions column. |
| `src/pages/WorkspacePage.test.tsx` | **Modify.** Cover actions, confirm step, disabled state, announcements. |
| `src/styles/global.css` | **Modify.** Actions column layout and the missing `.member-identity` rule. |
| `tests/members.spec.ts` | **Create.** End-to-end proof of the SQL, including the guard and re-invite. |

---

### Task 1: Migration and schema verification

**Files:**
- Create: `supabase/migrations/20260808000000_sentinel_member_management.sql`
- Create: `supabase/verify_sentinel_member_management.sql`

**Interfaces:**
- Consumes: `private.sentinel_is_manager(uuid)` (existing), `public.sentinel_members`, `public.sentinel_activity_events`, `public.sentinel_invitation_reservations`.
- Produces:
  - `public.sentinel_activate_member(p_workspace_id uuid, p_user_id uuid) returns jsonb`
  - `public.sentinel_set_member_role(p_workspace_id uuid, p_user_id uuid, p_role text) returns jsonb`
  - `public.sentinel_reject_invitation(p_workspace_id uuid, p_user_id uuid) returns jsonb`
  - Non-rejection functions return `{workspace_id, user_id, role, status}`. Rejection returns SQL `null`.

- [ ] **Step 1: Write the verification script**

Create `supabase/verify_sentinel_member_management.sql`:

```sql
do $$
declare
  required_function text;
  expected_event_type text;
begin
  foreach required_function in array array[
    'sentinel_activate_member',
    'sentinel_set_member_role',
    'sentinel_reject_invitation'
  ] loop
    if not exists (
      select 1 from pg_proc as proc
      join pg_namespace as ns on ns.oid = proc.pronamespace
      where ns.nspname = 'public' and proc.proname = required_function
    ) then
      raise exception 'Missing function public.%', required_function;
    end if;

    if not exists (
      select 1 from pg_proc as proc
      join pg_namespace as ns on ns.oid = proc.pronamespace
      where ns.nspname = 'public' and proc.proname = required_function
        and proc.prosecdef
    ) then
      raise exception 'Function public.% must be SECURITY DEFINER', required_function;
    end if;

    if not exists (
      select 1 from pg_proc as proc
      join pg_namespace as ns on ns.oid = proc.pronamespace
      where ns.nspname = 'public' and proc.proname = required_function
        and proc.proconfig @> array['search_path=public, pg_temp']
    ) then
      raise exception 'Function public.% must pin search_path', required_function;
    end if;

    if has_function_privilege('anon', format('public.%I', required_function)
      || case required_function
           when 'sentinel_set_member_role' then '(uuid, uuid, text)'
           else '(uuid, uuid)'
         end, 'execute') then
      raise exception 'Function public.% must not be executable by anon', required_function;
    end if;

    if not has_function_privilege('authenticated', format('public.%I', required_function)
      || case required_function
           when 'sentinel_set_member_role' then '(uuid, uuid, text)'
           else '(uuid, uuid)'
         end, 'execute') then
      raise exception 'Function public.% must be executable by authenticated', required_function;
    end if;
  end loop;

  foreach expected_event_type in array array[
    'member-activated',
    'member-role-changed',
    'member-invite-rejected'
  ] loop
    if not exists (
      select 1 from pg_constraint
      where conname = 'sentinel_activity_events_event_type_check'
        and pg_get_constraintdef(oid) like '%' || expected_event_type || '%'
    ) then
      raise exception 'Event type % is not permitted by the CHECK constraint', expected_event_type;
    end if;
  end loop;

  raise notice 'sentinel member management verified';
end;
$$;
```

- [ ] **Step 2: Run verification to confirm it fails**

Run via `mcp__plugin_supabase_supabase__execute_sql` with the file contents.

Expected: `ERROR: Missing function public.sentinel_activate_member`

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/20260808000000_sentinel_member_management.sql`:

```sql
-- Membership lifecycle events join the audit vocabulary.
alter table public.sentinel_activity_events
  drop constraint if exists sentinel_activity_events_event_type_check;

alter table public.sentinel_activity_events
  add constraint sentinel_activity_events_event_type_check
  check (event_type in (
    'investigation-created',
    'upload-created',
    'parse-started',
    'parse-completed',
    'parse-failed',
    'member-invited',
    'member-activated',
    'member-role-changed',
    'member-invite-rejected'
  ));

/**
 * Every membership mutation serializes on one advisory lock per workspace.
 * Row-level ordering is not enough: each function locks its target row before
 * the last-manager guard runs, so two concurrent demotions of different
 * managers would deadlock holding each other's target.
 */
create or replace function public.sentinel_activate_member(
  p_workspace_id uuid,
  p_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  target public.sentinel_members%rowtype;
begin
  if not private.sentinel_is_manager(p_workspace_id) then
    raise exception using errcode = '42501', message = 'Manager membership required.';
  end if;

  perform pg_advisory_xact_lock(hashtext('sentinel_members:' || p_workspace_id::text));

  select member.* into target
  from public.sentinel_members as member
  where member.workspace_id = p_workspace_id
    and member.user_id = p_user_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'Member not found.';
  end if;

  -- Already active: idempotent, and deliberately writes no second event.
  if target.status = 'active' then
    return jsonb_build_object(
      'workspace_id', target.workspace_id,
      'user_id', target.user_id,
      'role', target.role,
      'status', target.status
    );
  end if;

  update public.sentinel_members as member
  set status = 'active'
  where member.workspace_id = p_workspace_id
    and member.user_id = p_user_id;

  insert into public.sentinel_activity_events (
    workspace_id, investigation_id, actor_id, event_type, metadata
  ) values (
    p_workspace_id, null, auth.uid(), 'member-activated',
    jsonb_build_object('member_user_id', p_user_id::text)
  );

  return jsonb_build_object(
    'workspace_id', p_workspace_id,
    'user_id', p_user_id,
    'role', target.role,
    'status', 'active'
  );
end;
$function$;

create or replace function public.sentinel_set_member_role(
  p_workspace_id uuid,
  p_user_id uuid,
  p_role text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  target public.sentinel_members%rowtype;
  manager_count integer;
begin
  if not private.sentinel_is_manager(p_workspace_id) then
    raise exception using errcode = '42501', message = 'Manager membership required.';
  end if;

  if p_role not in ('analyst', 'manager') then
    raise exception using errcode = 'P0001', message = 'Role must be analyst or manager.';
  end if;

  perform pg_advisory_xact_lock(hashtext('sentinel_members:' || p_workspace_id::text));

  select member.* into target
  from public.sentinel_members as member
  where member.workspace_id = p_workspace_id
    and member.user_id = p_user_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'Member not found.';
  end if;

  if target.role = p_role then
    return jsonb_build_object(
      'workspace_id', target.workspace_id,
      'user_id', target.user_id,
      'role', target.role,
      'status', target.status
    );
  end if;

  -- Losing the last active manager locks the workspace out of invitation and
  -- activation permanently, with no in-product recovery path.
  if target.role = 'manager' and target.status = 'active' then
    select count(*) into manager_count
    from (
      select 1
      from public.sentinel_members as member
      where member.workspace_id = p_workspace_id
        and member.role = 'manager'
        and member.status = 'active'
      for update
    ) as locked;

    if manager_count <= 1 then
      raise exception using errcode = 'P0001',
        message = 'Workspace must keep at least one manager.';
    end if;
  end if;

  update public.sentinel_members as member
  set role = p_role
  where member.workspace_id = p_workspace_id
    and member.user_id = p_user_id;

  insert into public.sentinel_activity_events (
    workspace_id, investigation_id, actor_id, event_type, metadata
  ) values (
    p_workspace_id, null, auth.uid(), 'member-role-changed',
    jsonb_build_object('member_user_id', p_user_id::text, 'from', target.role, 'to', p_role)
  );

  return jsonb_build_object(
    'workspace_id', p_workspace_id,
    'user_id', p_user_id,
    'role', p_role,
    'status', target.status
  );
end;
$function$;

create or replace function public.sentinel_reject_invitation(
  p_workspace_id uuid,
  p_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  target public.sentinel_members%rowtype;
begin
  if not private.sentinel_is_manager(p_workspace_id) then
    raise exception using errcode = '42501', message = 'Manager membership required.';
  end if;

  perform pg_advisory_xact_lock(hashtext('sentinel_members:' || p_workspace_id::text));

  select member.* into target
  from public.sentinel_members as member
  where member.workspace_id = p_workspace_id
    and member.user_id = p_user_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'Member not found.';
  end if;

  if target.status <> 'pending' then
    raise exception using errcode = 'P0001',
      message = 'Only pending invitations can be rejected.';
  end if;

  delete from public.sentinel_members as member
  where member.workspace_id = p_workspace_id
    and member.user_id = p_user_id;

  -- claimReservation treats a failed reservation as immediately re-claimable,
  -- so the same address can be invited again without deleting the row.
  if target.invited_email is not null then
    update public.sentinel_invitation_reservations as reservation
    set status = 'failed', updated_at = now()
    where reservation.workspace_id = p_workspace_id
      and lower(reservation.email) = lower(target.invited_email);
  end if;

  -- member_user_id only: activity events are readable by every active member,
  -- but invited_email is withheld from analysts by column grant.
  insert into public.sentinel_activity_events (
    workspace_id, investigation_id, actor_id, event_type, metadata
  ) values (
    p_workspace_id, null, auth.uid(), 'member-invite-rejected',
    jsonb_build_object('member_user_id', p_user_id::text)
  );

  return null::jsonb;
end;
$function$;

revoke execute on function public.sentinel_activate_member(uuid, uuid) from public, anon;
revoke execute on function public.sentinel_set_member_role(uuid, uuid, text) from public, anon;
revoke execute on function public.sentinel_reject_invitation(uuid, uuid) from public, anon;

grant execute on function public.sentinel_activate_member(uuid, uuid) to authenticated, service_role;
grant execute on function public.sentinel_set_member_role(uuid, uuid, text) to authenticated, service_role;
grant execute on function public.sentinel_reject_invitation(uuid, uuid) to authenticated, service_role;
```

- [ ] **Step 4: Apply the migration**

```
mcp__plugin_supabase_supabase__apply_migration
  name: "sentinel_member_management"
  query: <contents of the migration file>
```

- [ ] **Step 5: Run verification to confirm it passes**

Run the verify script via `execute_sql`.

Expected: `NOTICE: sentinel member management verified`, no exception.

- [ ] **Step 6: Confirm the security advisor is clean**

```
mcp__plugin_supabase_supabase__get_advisors  type: "security"
```

Expected: no new findings referencing the three new functions. A pre-existing finding unrelated to this work is acceptable — note it, do not fix it here.

- [ ] **Step 7: Commit**

```bash
git add supabase/migrations/20260808000000_sentinel_member_management.sql supabase/verify_sentinel_member_management.sql
git commit -m "feat: add member management RPCs with last-manager guard"
```

---

### Task 2: Service RPC plumbing, error mapping, and activate()

**Files:**
- Modify: `src/domain/types.ts:63-66`
- Modify: `src/services/sentinelMembers.ts`
- Modify: `src/services/sentinelMembers.test.ts`

**Interfaces:**
- Consumes: `public.sentinel_activate_member(p_workspace_id, p_user_id)` from Task 1.
- Produces:
  - `SentinelMemberService.activate(userId: string): Promise<void>`
  - `mapRpcError(operation: string, error: RpcError | null): Error` — exported for reuse by Tasks 3 and 4.
  - `type RpcError = { message?: string; code?: string }`

- [ ] **Step 1: Write the failing tests**

In `src/services/sentinelMembers.test.ts`, extend `ClientOptions` and `createClient`, then add the describe block. Replace the existing `createClient` with:

```ts
interface ClientOptions {
  rows?: MemberRow[];
  listError?: { message: string } | null;
  invokeResult?: { data: unknown; error: unknown };
  rpcResult?: { data: unknown; error: { message?: string; code?: string } | null };
}

function createClient({ rows = [], listError = null, invokeResult, rpcResult }: ClientOptions = {}) {
  const order = vi.fn(async () => ({ data: listError ? null : rows, error: listError }));
  const eq = vi.fn(() => ({ order }));
  const select = vi.fn(() => ({ eq }));
  const from = vi.fn(() => ({ select }));
  const invoke = vi.fn(async () => invokeResult ?? { data: { invited: true }, error: null });
  const rpc = vi.fn(async () => rpcResult ?? { data: null, error: null });

  const client = { from, functions: { invoke }, rpc } as unknown as SentinelMemberClient;
  return { client, from, select, eq, order, invoke, rpc };
}
```

Then append inside the top-level `describe("createSentinelMemberService", ...)`:

```ts
describe("activate", () => {
  it("calls the activate RPC with the workspace and member", async () => {
    const { client, rpc } = createClient();
    const service = createSentinelMemberService(client, { workspaceId, userId: managerId, role: "manager" });

    await service.activate(analystId);

    expect(rpc).toHaveBeenCalledWith("sentinel_activate_member", {
      p_workspace_id: workspaceId,
      p_user_id: analystId,
    });
  });

  it("resolves when the RPC succeeds", async () => {
    const { client } = createClient({
      rpcResult: { data: { workspace_id: workspaceId, user_id: analystId, role: "analyst", status: "active" }, error: null },
    });
    const service = createSentinelMemberService(client, { workspaceId, userId: managerId, role: "manager" });

    await expect(service.activate(analystId)).resolves.toBeUndefined();
  });

  it("surfaces a P0001 business rule message verbatim", async () => {
    const { client } = createClient({
      rpcResult: { data: null, error: { code: "P0001", message: "Workspace must keep at least one manager." } },
    });
    const service = createSentinelMemberService(client, { workspaceId, userId: managerId, role: "manager" });

    await expect(service.activate(analystId)).rejects.toThrow("Workspace must keep at least one manager.");
  });

  it("maps P0002 to a reload instruction", async () => {
    const { client } = createClient({
      rpcResult: { data: null, error: { code: "P0002", message: "Member not found." } },
    });
    const service = createSentinelMemberService(client, { workspaceId, userId: managerId, role: "manager" });

    await expect(service.activate(analystId)).rejects.toThrow("Member not found. Reload the roster and try again.");
  });

  it("maps 42501 to the manager-required message", async () => {
    const { client } = createClient({
      rpcResult: { data: null, error: { code: "42501", message: "Manager membership required." } },
    });
    const service = createSentinelMemberService(client, { workspaceId, userId: analystId, role: "analyst" });

    await expect(service.activate(analystId)).rejects.toThrow("Manager membership required.");
  });

  it("wraps an unrecognised failure with the operation name", async () => {
    const { client } = createClient({
      rpcResult: { data: null, error: { code: "08006", message: "connection failure" } },
    });
    const service = createSentinelMemberService(client, { workspaceId, userId: managerId, role: "manager" });

    await expect(service.activate(analystId)).rejects.toThrow("Unable to activate member: connection failure");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/services/sentinelMembers.test.ts`
Expected: FAIL — `service.activate is not a function`

- [ ] **Step 3: Add the service method to the domain type**

In `src/domain/types.ts`, replace the `SentinelMemberService` interface:

```ts
export interface SentinelMemberService {
  list(): Promise<SentinelMember[]>;
  invite(email: string): Promise<void>;
  activate(userId: string): Promise<void>;
}
```

- [ ] **Step 4: Implement the client type, error mapping, and activate**

In `src/services/sentinelMembers.ts`, add to `SentinelMemberClient`:

```ts
export type RpcError = { message?: string; code?: string };

export type SentinelMemberClient = {
  from(table: MemberSource): {
    select(columns: string): MemberReadQuery;
  };
  functions: {
    invoke(
      name: "invite-member",
      options: { body: { email: string; role: "analyst" } },
    ): Promise<{ data: unknown; error: unknown }>;
  };
  rpc(
    name: "sentinel_activate_member" | "sentinel_set_member_role" | "sentinel_reject_invitation",
    args: Record<string, string>,
  ): Promise<{ data: unknown; error: RpcError | null }>;
};
```

Add the constant and mapper beside the existing `mapError`:

```ts
export const MEMBER_NOT_FOUND_ERROR = "Member not found. Reload the roster and try again.";
export const MANAGER_REQUIRED_ERROR = "Manager membership required.";

/**
 * The RPCs raise P0001 with finished user-facing prose, so those messages are
 * shown as written rather than wrapped. Mirrors how processing.ts keys off
 * P0001 for a lost processing lease.
 */
export function mapRpcError(operation: string, error: RpcError | null) {
  if (error?.code === "P0001" && error.message?.trim()) return new Error(error.message);
  if (error?.code === "P0002") return new Error(MEMBER_NOT_FOUND_ERROR);
  if (error?.code === "42501") return new Error(MANAGER_REQUIRED_ERROR);
  return mapError(operation, error);
}
```

Add the method to the returned object in `createSentinelMemberService`, after `invite`:

```ts
async activate(userId) {
  const { error } = await client.rpc("sentinel_activate_member", {
    p_workspace_id: context.workspaceId,
    p_user_id: userId,
  });

  if (error) throw mapRpcError("activate member", error);
},
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/services/sentinelMembers.test.ts`
Expected: PASS

- [ ] **Step 6: Run the full suite and typecheck**

Run: `npx vitest run && npx tsc -b`
Expected: all tests pass, no type errors.

- [ ] **Step 7: Commit**

```bash
git add src/domain/types.ts src/services/sentinelMembers.ts src/services/sentinelMembers.test.ts
git commit -m "feat: add member activation to the member service"
```

---

### Task 3: Service setRole()

**Files:**
- Modify: `src/domain/types.ts`
- Modify: `src/services/sentinelMembers.ts`
- Modify: `src/services/sentinelMembers.test.ts`

**Interfaces:**
- Consumes: `mapRpcError` and the `rpc` client member from Task 2; `public.sentinel_set_member_role` from Task 1.
- Produces: `SentinelMemberService.setRole(userId: string, role: SentinelMemberRole): Promise<void>`

- [ ] **Step 1: Write the failing tests**

Append to `src/services/sentinelMembers.test.ts`, inside the top-level describe:

```ts
describe("setRole", () => {
  it("calls the role RPC with the target role", async () => {
    const { client, rpc } = createClient();
    const service = createSentinelMemberService(client, { workspaceId, userId: managerId, role: "manager" });

    await service.setRole(analystId, "manager");

    expect(rpc).toHaveBeenCalledWith("sentinel_set_member_role", {
      p_workspace_id: workspaceId,
      p_user_id: analystId,
      p_role: "manager",
    });
  });

  it("surfaces the last-manager guard message verbatim", async () => {
    const { client } = createClient({
      rpcResult: { data: null, error: { code: "P0001", message: "Workspace must keep at least one manager." } },
    });
    const service = createSentinelMemberService(client, { workspaceId, userId: managerId, role: "manager" });

    await expect(service.setRole(managerId, "analyst")).rejects.toThrow(
      "Workspace must keep at least one manager.",
    );
  });

  it("wraps an unrecognised failure with the operation name", async () => {
    const { client } = createClient({
      rpcResult: { data: null, error: { code: "08006", message: "connection failure" } },
    });
    const service = createSentinelMemberService(client, { workspaceId, userId: managerId, role: "manager" });

    await expect(service.setRole(analystId, "manager")).rejects.toThrow(
      "Unable to change member role: connection failure",
    );
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/services/sentinelMembers.test.ts -t setRole`
Expected: FAIL — `service.setRole is not a function`

- [ ] **Step 3: Implement setRole**

In `src/domain/types.ts`, add to `SentinelMemberService`:

```ts
  setRole(userId: string, role: SentinelMemberRole): Promise<void>;
```

In `src/services/sentinelMembers.ts`, add after `activate`:

```ts
async setRole(userId, role) {
  const { error } = await client.rpc("sentinel_set_member_role", {
    p_workspace_id: context.workspaceId,
    p_user_id: userId,
    p_role: role,
  });

  if (error) throw mapRpcError("change member role", error);
},
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/services/sentinelMembers.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/domain/types.ts src/services/sentinelMembers.ts src/services/sentinelMembers.test.ts
git commit -m "feat: add member role change to the member service"
```

---

### Task 4: Service rejectInvitation()

**Files:**
- Modify: `src/domain/types.ts`
- Modify: `src/services/sentinelMembers.ts`
- Modify: `src/services/sentinelMembers.test.ts`

**Interfaces:**
- Consumes: `mapRpcError` and the `rpc` client member from Task 2; `public.sentinel_reject_invitation` from Task 1.
- Produces: `SentinelMemberService.rejectInvitation(userId: string): Promise<void>`

- [ ] **Step 1: Write the failing tests**

Append to `src/services/sentinelMembers.test.ts`, inside the top-level describe:

```ts
describe("rejectInvitation", () => {
  it("calls the reject RPC with the workspace and member", async () => {
    const { client, rpc } = createClient();
    const service = createSentinelMemberService(client, { workspaceId, userId: managerId, role: "manager" });

    await service.rejectInvitation(analystId);

    expect(rpc).toHaveBeenCalledWith("sentinel_reject_invitation", {
      p_workspace_id: workspaceId,
      p_user_id: analystId,
    });
  });

  it("surfaces the non-pending refusal verbatim", async () => {
    const { client } = createClient({
      rpcResult: { data: null, error: { code: "P0001", message: "Only pending invitations can be rejected." } },
    });
    const service = createSentinelMemberService(client, { workspaceId, userId: managerId, role: "manager" });

    await expect(service.rejectInvitation(analystId)).rejects.toThrow(
      "Only pending invitations can be rejected.",
    );
  });

  it("wraps an unrecognised failure with the operation name", async () => {
    const { client } = createClient({
      rpcResult: { data: null, error: { code: "08006", message: "connection failure" } },
    });
    const service = createSentinelMemberService(client, { workspaceId, userId: managerId, role: "manager" });

    await expect(service.rejectInvitation(analystId)).rejects.toThrow(
      "Unable to reject invitation: connection failure",
    );
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/services/sentinelMembers.test.ts -t rejectInvitation`
Expected: FAIL — `service.rejectInvitation is not a function`

- [ ] **Step 3: Implement rejectInvitation**

In `src/domain/types.ts`, add to `SentinelMemberService`:

```ts
  rejectInvitation(userId: string): Promise<void>;
```

In `src/services/sentinelMembers.ts`, add after `setRole`:

```ts
async rejectInvitation(userId) {
  const { error } = await client.rpc("sentinel_reject_invitation", {
    p_workspace_id: context.workspaceId,
    p_user_id: userId,
  });

  if (error) throw mapRpcError("reject invitation", error);
},
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/services/sentinelMembers.test.ts`
Expected: PASS

- [ ] **Step 5: Run the full suite and typecheck**

Run: `npx vitest run && npx tsc -b`
Expected: all pass. `App.tsx` needs no change — it casts `supabase` to `SentinelMemberClient`, and the real client already has `rpc`.

- [ ] **Step 6: Commit**

```bash
git add src/domain/types.ts src/services/sentinelMembers.ts src/services/sentinelMembers.test.ts
git commit -m "feat: add invitation rejection to the member service"
```

---

### Task 5: Extract the useWorkspaceMembers hook

Pure refactor. **All 12 existing `WorkspacePage.test.tsx` tests must stay green without modification** — that is the proof the extraction changed no behaviour.

**Files:**
- Create: `src/pages/useWorkspaceMembers.ts`
- Create: `src/pages/useWorkspaceMembers.test.ts`
- Modify: `src/pages/WorkspacePage.tsx:32-110`

**Interfaces:**
- Consumes: `SentinelMemberService` from Tasks 2-4.
- Produces:

```ts
type RosterState =
  | { status: "loading" }
  | { status: "error"; error: unknown }
  | { status: "ready"; members: SentinelMember[] };

interface MutationResult { ok: boolean; message: string }

interface WorkspaceMembers {
  state: RosterState;
  members: SentinelMember[];
  activeManagerCount: number;
  retry(): void;
  mutate(action: () => Promise<void>, successMessage: string): Promise<MutationResult>;
}

function useWorkspaceMembers(
  memberService?: Pick<SentinelMemberService, "list"> & Partial<SentinelMemberService> | null,
): WorkspaceMembers
```

- [ ] **Step 1: Write the failing tests**

Create `src/pages/useWorkspaceMembers.test.ts`:

```ts
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { SentinelMember } from "../domain/types";
import { useWorkspaceMembers } from "./useWorkspaceMembers";

const activeManager: SentinelMember = {
  userId: "22222222-2222-4222-8222-222222222222",
  email: "manager@example.com",
  role: "manager",
  status: "active",
  joinedAt: "2026-08-01T09:00:00.000Z",
  isSelf: true,
};

const pendingAnalyst: SentinelMember = {
  userId: "33333333-3333-4333-8333-333333333333",
  email: "analyst@example.com",
  role: "analyst",
  status: "pending",
  joinedAt: "2026-08-04T09:00:00.000Z",
  isSelf: false,
};

function service(members: SentinelMember[]) {
  return { list: vi.fn(async () => members) };
}

describe("useWorkspaceMembers", () => {
  it("sorts pending members ahead of active ones", async () => {
    const { result } = renderHook(() => useWorkspaceMembers(service([activeManager, pendingAnalyst])));

    await waitFor(() => expect(result.current.state.status).toBe("ready"));
    expect(result.current.members.map((member) => member.userId)).toEqual([
      pendingAnalyst.userId,
      activeManager.userId,
    ]);
  });

  it("counts only active managers", async () => {
    const { result } = renderHook(() => useWorkspaceMembers(service([activeManager, pendingAnalyst])));

    await waitFor(() => expect(result.current.state.status).toBe("ready"));
    expect(result.current.activeManagerCount).toBe(1);
  });

  it("refetches the roster after a successful mutation", async () => {
    const memberService = service([activeManager, pendingAnalyst]);
    const { result } = renderHook(() => useWorkspaceMembers(memberService));
    await waitFor(() => expect(result.current.state.status).toBe("ready"));
    memberService.list.mockClear();

    let outcome: { ok: boolean; message: string } | undefined;
    await act(async () => {
      outcome = await result.current.mutate(async () => undefined, "Member activated.");
    });

    expect(memberService.list).toHaveBeenCalledTimes(1);
    expect(outcome).toEqual({ ok: true, message: "Member activated." });
  });

  it("reports the action as done when only the refresh fails", async () => {
    const memberService = service([activeManager]);
    const { result } = renderHook(() => useWorkspaceMembers(memberService));
    await waitFor(() => expect(result.current.state.status).toBe("ready"));
    memberService.list.mockRejectedValueOnce(new Error("network down"));

    let outcome: { ok: boolean; message: string } | undefined;
    await act(async () => {
      outcome = await result.current.mutate(async () => undefined, "Member activated.");
    });

    expect(outcome?.ok).toBe(true);
    expect(outcome?.message).toMatch(/could not be refreshed/i);
  });

  it("reports a failed mutation and still refreshes the roster", async () => {
    const memberService = service([activeManager]);
    const { result } = renderHook(() => useWorkspaceMembers(memberService));
    await waitFor(() => expect(result.current.state.status).toBe("ready"));
    memberService.list.mockClear();

    let outcome: { ok: boolean; message: string } | undefined;
    await act(async () => {
      outcome = await result.current.mutate(async () => {
        throw new Error("Workspace must keep at least one manager.");
      }, "Role changed.");
    });

    expect(outcome).toEqual({ ok: false, message: "Workspace must keep at least one manager." });
    expect(memberService.list).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/pages/useWorkspaceMembers.test.ts`
Expected: FAIL — cannot resolve `./useWorkspaceMembers`

- [ ] **Step 3: Write the hook**

Create `src/pages/useWorkspaceMembers.ts`:

```ts
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SentinelMember, SentinelMemberService } from "../domain/types";

export type RosterState =
  | { status: "loading" }
  | { status: "error"; error: unknown }
  | { status: "ready"; members: SentinelMember[] };

export interface MutationResult {
  ok: boolean;
  message: string;
}

type RosterService = Pick<SentinelMemberService, "list"> & Partial<SentinelMemberService>;

const UNAVAILABLE_ERROR = "Workspace member directory is unavailable. Sign in again and retry.";
const REFRESH_FAILED_SUFFIX = "The member list could not be refreshed — reload to see it.";

/** Pending members first: approving them is why a manager opens this page. */
function sortMembers(members: SentinelMember[]) {
  return [...members].sort((left, right) => {
    if (left.status !== right.status) return left.status === "pending" ? -1 : 1;
    return left.joinedAt.localeCompare(right.joinedAt);
  });
}

export function useWorkspaceMembers(memberService?: RosterService | null) {
  const [state, setState] = useState<RosterState>({ status: "loading" });
  const [retryKey, setRetryKey] = useState(0);
  const requestIdRef = useRef(0);

  useEffect(() => {
    const requestId = ++requestIdRef.current;
    let active = true;
    const isCurrent = () => active && requestIdRef.current === requestId;

    setState({ status: "loading" });
    if (!memberService) {
      setState({ status: "error", error: new Error(UNAVAILABLE_ERROR) });
      return () => {
        active = false;
      };
    }

    void Promise.resolve()
      .then(() => memberService.list())
      .then((members) => {
        if (isCurrent()) setState({ status: "ready", members: sortMembers(members) });
      })
      .catch((error: unknown) => {
        if (isCurrent()) setState({ status: "error", error });
      });

    return () => {
      active = false;
    };
  }, [memberService, retryKey]);

  const retry = useCallback(() => setRetryKey((current) => current + 1), []);

  /**
   * Runs a mutation then refetches. The refetch is best effort and runs even on
   * failure: nearly every failure here means the caller's view is stale, and
   * correcting it is the manager's next need.
   */
  const mutate = useCallback(async (action: () => Promise<void>, successMessage: string): Promise<MutationResult> => {
    if (!memberService) return { ok: false, message: UNAVAILABLE_ERROR };

    const requestId = requestIdRef.current;
    let failure: string | null = null;
    try {
      await action();
    } catch (caught) {
      failure = caught instanceof Error ? caught.message : "Unable to update member.";
    }

    try {
      const members = await memberService.list();
      if (requestIdRef.current === requestId) setState({ status: "ready", members: sortMembers(members) });
    } catch {
      // The action's own outcome is what the manager needs to hear first.
      return failure ? { ok: false, message: failure } : { ok: true, message: `${successMessage} ${REFRESH_FAILED_SUFFIX}` };
    }

    return failure ? { ok: false, message: failure } : { ok: true, message: successMessage };
  }, [memberService]);

  const members = state.status === "ready" ? state.members : [];
  const activeManagerCount = useMemo(
    () => members.filter((member) => member.role === "manager" && member.status === "active").length,
    [members],
  );

  return { state, members, activeManagerCount, retry, mutate };
}
```

- [ ] **Step 4: Run the hook tests to verify they pass**

Run: `npx vitest run src/pages/useWorkspaceMembers.test.ts`
Expected: PASS

- [ ] **Step 5: Rewire WorkspacePage to use the hook**

In `src/pages/WorkspacePage.tsx`, delete the `LoadState` type, the `state`/`retryKey`/`requestIdRef` state, the loading `useEffect`, the `retry` callback, and the `members` derivation (lines 15-18, 33-34, 39, 42-69, and 110). Replace with:

```ts
import { useWorkspaceMembers } from "./useWorkspaceMembers";
```

and inside the component, above the invite handler:

```ts
const { state, members, retry, mutate } = useWorkspaceMembers(memberService);
```

Rewrite `handleInvite` to route through `mutate`, keeping the existing copy exactly:

```ts
const handleInvite = async (event: FormEvent<HTMLFormElement>) => {
  event.preventDefault();
  if (!memberService || inviting) return;

  setInviteError("");
  setInviteNotice("");

  const normalized = normalizeMemberEmail(email);
  if (!normalized) {
    setInviteError(INVALID_EMAIL_ERROR);
    return;
  }

  setInviting(true);
  const outcome = await mutate(
    () => memberService.invite(normalized),
    `Invitation sent to ${normalized}. The member stays pending until they accept.`,
  );
  if (outcome.ok) setEmail("");
  if (outcome.ok) setInviteNotice(outcome.message);
  else setInviteError(outcome.message);
  setInviting(false);
};
```

Leave all JSX unchanged.

- [ ] **Step 6: Run the full suite to prove no behaviour changed**

Run: `npx vitest run && npx tsc -b`
Expected: PASS, including all 12 pre-existing `WorkspacePage.test.tsx` tests **without edits to that file**. If any fail, the extraction changed behaviour — fix the hook, not the test.

- [ ] **Step 7: Commit**

```bash
git add src/pages/useWorkspaceMembers.ts src/pages/useWorkspaceMembers.test.ts src/pages/WorkspacePage.tsx
git commit -m "refactor: extract roster state into useWorkspaceMembers"
```

---

### Task 6: Manager actions column

**Files:**
- Modify: `src/pages/WorkspacePage.tsx`
- Modify: `src/pages/WorkspacePage.test.tsx`

**Interfaces:**
- Consumes: `useWorkspaceMembers` (Task 5); `activate`, `setRole`, `rejectInvitation` (Tasks 2-4).
- Produces: no new exports.

- [ ] **Step 1: Write the failing tests**

In `src/pages/WorkspacePage.test.tsx`, extend the `memberService` helper to include the new methods:

```ts
function memberService(
  overrides: Partial<{
    list: () => Promise<SentinelMember[]>;
    invite: (email: string) => Promise<void>;
    activate: (userId: string) => Promise<void>;
    setRole: (userId: string, role: "analyst" | "manager") => Promise<void>;
    rejectInvitation: (userId: string) => Promise<void>;
  }> = {},
) {
  return {
    list: vi.fn(overrides.list ?? (async () => [manager, analyst])),
    invite: vi.fn(overrides.invite ?? (async () => undefined)),
    activate: vi.fn(overrides.activate ?? (async () => undefined)),
    setRole: vi.fn(overrides.setRole ?? (async () => undefined)),
    rejectInvitation: vi.fn(overrides.rejectInvitation ?? (async () => undefined)),
  };
}
```

Then append a new describe block:

```ts
describe("member actions", () => {
  const secondManager: SentinelMember = {
    userId: "44444444-4444-4444-8444-444444444444",
    email: "second@example.com",
    role: "manager",
    status: "active",
    joinedAt: "2026-08-02T09:00:00.000Z",
    isSelf: false,
  };

  function rowFor(email: string) {
    return within(screen.getByRole("row", { name: new RegExp(email) }));
  }

  it("hides the actions column from an analyst", async () => {
    renderPage({ memberService: memberService({ list: async () => [analyst] }), role: "analyst" });

    await screen.findByText("analyst@example.com");
    expect(screen.queryByRole("columnheader", { name: /actions/i })).not.toBeInTheDocument();
  });

  it("activates a pending member and announces it", async () => {
    const service = memberService();
    renderPage({ memberService: service, role: "manager" });

    await screen.findByRole("table", { name: /workspace members/i });
    await userEvent.click(rowFor("analyst@example.com").getByRole("button", { name: /activate/i }));

    expect(service.activate).toHaveBeenCalledWith(analyst.userId);
    expect(await screen.findByRole("status")).toHaveTextContent(/activated/i);
  });

  it("promotes an active analyst to manager", async () => {
    const service = memberService({
      list: async () => [{ ...analyst, status: "active" as const }, manager],
    });
    renderPage({ memberService: service, role: "manager" });

    await screen.findByRole("table", { name: /workspace members/i });
    await userEvent.click(rowFor("analyst@example.com").getByRole("button", { name: /make manager/i }));

    expect(service.setRole).toHaveBeenCalledWith(analyst.userId, "manager");
  });

  it("disables demotion when only one active manager remains", async () => {
    renderPage({ memberService: memberService(), role: "manager" });

    await screen.findByRole("table", { name: /workspace members/i });
    expect(rowFor("manager@example.com").getByRole("button", { name: /make analyst/i })).toBeDisabled();
  });

  it("enables demotion once a second manager exists", async () => {
    const service = memberService({ list: async () => [manager, secondManager] });
    renderPage({ memberService: service, role: "manager" });

    await screen.findByRole("table", { name: /workspace members/i });
    expect(rowFor("manager@example.com").getByRole("button", { name: /make analyst/i })).toBeEnabled();
  });

  it("requires a confirm step before rejecting an invitation", async () => {
    const service = memberService();
    renderPage({ memberService: service, role: "manager" });

    await screen.findByRole("table", { name: /workspace members/i });
    await userEvent.click(rowFor("analyst@example.com").getByRole("button", { name: /^reject$/i }));

    expect(service.rejectInvitation).not.toHaveBeenCalled();
    await userEvent.click(rowFor("analyst@example.com").getByRole("button", { name: /confirm reject/i }));
    expect(service.rejectInvitation).toHaveBeenCalledWith(analyst.userId);
  });

  it("abandons the reject confirmation on cancel", async () => {
    const service = memberService();
    renderPage({ memberService: service, role: "manager" });

    await screen.findByRole("table", { name: /workspace members/i });
    await userEvent.click(rowFor("analyst@example.com").getByRole("button", { name: /^reject$/i }));
    await userEvent.click(rowFor("analyst@example.com").getByRole("button", { name: /cancel/i }));

    expect(rowFor("analyst@example.com").getByRole("button", { name: /^reject$/i })).toBeInTheDocument();
    expect(service.rejectInvitation).not.toHaveBeenCalled();
  });

  it("reports a refused action in the alert region", async () => {
    const service = memberService({
      activate: async () => {
        throw new Error("Member not found. Reload the roster and try again.");
      },
    });
    renderPage({ memberService: service, role: "manager" });

    await screen.findByRole("table", { name: /workspace members/i });
    await userEvent.click(rowFor("analyst@example.com").getByRole("button", { name: /activate/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/reload the roster/i);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/pages/WorkspacePage.test.tsx -t "member actions"`
Expected: FAIL — no `Activate` button found.

- [ ] **Step 3: Implement the actions column**

In `src/pages/WorkspacePage.tsx`, pull `activeManagerCount` from the hook and add row action state:

```ts
const { state, members, activeManagerCount, retry, mutate } = useWorkspaceMembers(memberService);
const [busyUserId, setBusyUserId] = useState<string | null>(null);
const [confirmingRejectId, setConfirmingRejectId] = useState<string | null>(null);
// Narrowed once, so the row actions need no non-null assertions. A null service
// puts the hook in its error state, so the table never renders without one.
const actions = isManager && memberService ? memberService : null;
```

Add the action runner beside `handleInvite`:

```ts
const runAction = async (userId: string, action: () => Promise<void>, successMessage: string) => {
  if (busyUserId) return;

  setInviteError("");
  setInviteNotice("");
  setBusyUserId(userId);
  const outcome = await mutate(action, successMessage);
  if (outcome.ok) setInviteNotice(outcome.message);
  else setInviteError(outcome.message);
  setBusyUserId(null);
  setConfirmingRejectId(null);
};
```

Add the header cell, immediately after the `Joined` header:

```tsx
{actions && <th scope="col">Actions</th>}
```

Add the body cell as the last cell of each row:

```tsx
{actions && (
  <td className="member-actions">
    {member.status === "pending" ? (
      <>
        <Button
          variant="secondary"
          type="button"
          disabled={busyUserId !== null}
          onClick={() => void runAction(
            member.userId,
            () => actions.activate(member.userId),
            `${member.email ?? "Member"} activated.`,
          )}
        >
          Activate
        </Button>
        {confirmingRejectId === member.userId ? (
          <>
            <Button
              variant="destructive"
              type="button"
              disabled={busyUserId !== null}
              onClick={() => void runAction(
                member.userId,
                () => actions.rejectInvitation(member.userId),
                `Invitation for ${member.email ?? "member"} rejected.`,
              )}
            >
              Confirm reject
            </Button>
            <Button variant="quiet" type="button" onClick={() => setConfirmingRejectId(null)}>Cancel</Button>
          </>
        ) : (
          <Button
            variant="quiet"
            type="button"
            disabled={busyUserId !== null}
            onClick={() => setConfirmingRejectId(member.userId)}
          >
            Reject
          </Button>
        )}
      </>
    ) : member.role === "analyst" ? (
      <Button
        variant="secondary"
        type="button"
        disabled={busyUserId !== null}
        onClick={() => void runAction(
          member.userId,
          () => actions.setRole(member.userId, "manager"),
          `${member.email ?? "Member"} is now a manager.`,
        )}
      >
        Make manager
      </Button>
    ) : (
      <>
        <Button
          variant="secondary"
          type="button"
          disabled={busyUserId !== null || activeManagerCount <= 1}
          onClick={() => void runAction(
            member.userId,
            () => actions.setRole(member.userId, "analyst"),
            `${member.email ?? "Member"} is now an analyst.`,
          )}
        >
          Make analyst
        </Button>
        {activeManagerCount <= 1 && (
          <span className="member-action-hint">Workspace must keep at least one manager.</span>
        )}
      </>
    )}
  </td>
)}
```

Widen the `memberService` prop type so the actions are callable:

```ts
interface WorkspacePageProps {
  memberService?: Pick<SentinelMemberService, "list" | "invite" | "activate" | "setRole" | "rejectInvitation"> | null;
  role?: SentinelMemberRole | null;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/pages/WorkspacePage.test.tsx`
Expected: PASS

- [ ] **Step 5: Run the full suite and typecheck**

Run: `npx vitest run && npx tsc -b`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/pages/WorkspacePage.tsx src/pages/WorkspacePage.test.tsx
git commit -m "feat: add manager member actions to the workspace page"
```

---

### Task 7: Actions column styling

**Files:**
- Modify: `src/styles/global.css`

**Interfaces:**
- Consumes: `.member-actions`, `.member-action-hint`, `.member-identity` class names from Task 6 and existing JSX.
- Produces: no code interfaces.

- [ ] **Step 1: Add the rules**

Append to `src/styles/global.css` immediately after the existing `.member-self` rule at line 1619, matching its conventions — this stylesheet uses literal pixel gaps, `--color-slate` for muted text, and the `--text-caption` font shorthand. There is no spacing scale; do not invent one.

```css
.member-identity {
  font: var(--text-label);
}

.member-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

/* The full 44px control height makes table rows unreadably tall, so row
   actions get a compact variant of the same button shape. */
.member-actions .button {
  min-height: 32px;
  padding: 5px 10px;
  font: var(--text-caption);
}

.member-action-hint {
  flex-basis: 100%;
  color: var(--color-slate);
  font: var(--text-caption);
}
```

- [ ] **Step 2: Verify visually**

Run: `npm run dev`, sign in as the manager, open `/workspace`.
Expected: actions sit on one row per member without overflowing the table; the demotion hint wraps rather than stretching the column. Check at a 390px viewport too — `.table-scroll` should scroll horizontally rather than the page.

- [ ] **Step 3: Run the full suite**

Run: `npx vitest run`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/styles/global.css
git commit -m "style: lay out the workspace member actions column"
```

---

### Task 8: End-to-end proof

This is the only task that exercises the SQL. It runs against the live linked project.

**Files:**
- Create: `tests/members.spec.ts`

**Interfaces:**
- Consumes: `requireCredentials`, `storageStatePath` from `tests/env.ts`; all three RPCs from Task 1; the UI from Task 6.
- Produces: no code interfaces.

- [ ] **Step 1: Write the spec**

Create `tests/members.spec.ts`:

```ts
import { expect, test, type Page } from "@playwright/test";
import { requireCredentials, storageStatePath } from "./env";

const { supabaseUrl, publishableKey } = requireCredentials("manager");

// Membership mutations touch state every other spec depends on, so this file
// never runs in parallel with itself.
test.describe.configure({ mode: "serial" });

async function accessToken(page: Page) {
  const token = await page.evaluate(() => {
    const key = Object.keys(window.localStorage).find((k) => k.startsWith("sb-") && k.includes("auth-token"));
    if (!key) return null;
    try {
      const parsed = JSON.parse(window.localStorage.getItem(key) ?? "null");
      return parsed?.access_token ?? parsed?.currentSession?.access_token ?? null;
    } catch {
      return null;
    }
  });
  expect(token, "signed-in session token").toBeTruthy();
  return token as string;
}

async function rest(token: string, path: string, init: RequestInit = {}) {
  const response = await fetch(`${supabaseUrl}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: publishableKey,
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

async function callRpc(token: string, name: string, args: Record<string, string>) {
  return rest(token, `rpc/${name}`, { method: "POST", body: JSON.stringify(args) });
}

async function openWorkspace(page: Page) {
  await page.goto("/workspace");
  await page.getByRole("heading", { name: "Team and settings" }).waitFor();
  return accessToken(page);
}

async function workspaceIdFor(token: string) {
  const membership = await rest(token, "sentinel_members?select=workspace_id&limit=1");
  return membership.body[0].workspace_id as string;
}

/** A unique address per run, so re-runs never collide on the pending unique index. */
function uniqueEmail() {
  return `pending-${Date.now().toString(36)}@example.com`;
}

test.describe("manager member management", () => {
  test.use({ storageState: storageStatePath("manager") });

  test("activates a pending member and records the event", async ({ page }) => {
    const token = await openWorkspace(page);
    const email = uniqueEmail();

    await page.getByRole("textbox", { name: /email/i }).fill(email);
    await page.getByRole("button", { name: /send invitation/i }).click();
    await expect(page.getByRole("status")).toContainText(email, { timeout: 30_000 });

    const row = page.getByRole("row", { name: new RegExp(email) });
    await expect(row).toBeVisible();
    await row.getByRole("button", { name: /activate/i }).click();
    await expect(page.getByRole("status")).toContainText(/activated/i, { timeout: 30_000 });

    const members = await rest(token, `sentinel_manager_roster?select=user_id,status&invited_email=eq.${email}`);
    expect(members.body[0].status).toBe("active");

    const memberUserId = members.body[0].user_id;
    const events = await rest(
      token,
      `sentinel_activity_events?select=event_type&event_type=eq.member-activated&metadata->>member_user_id=eq.${memberUserId}`,
    );
    expect(events.body.length).toBeGreaterThan(0);

    // No cleanup. An activated member can no longer be rejected, and this slice
    // has no offboarding path by design. uniqueEmail() gives every run its own
    // member, and an extra active analyst affects no other assertion.
  });

  test("refuses to demote the last active manager", async ({ page }) => {
    const token = await openWorkspace(page);
    const workspaceId = await workspaceIdFor(token);
    const self = await rest(token, "sentinel_manager_roster?select=user_id,role&role=eq.manager&status=eq.active");
    const managers = self.body as { user_id: string }[];
    test.skip(managers.length !== 1, "guard only applies with exactly one active manager");

    const refusal = await callRpc(token, "sentinel_set_member_role", {
      p_workspace_id: workspaceId,
      p_user_id: managers[0].user_id,
      p_role: "analyst",
    });

    expect(refusal.status).toBe(400);
    expect(refusal.body.message).toMatch(/at least one manager/i);

    const after = await rest(token, `sentinel_manager_roster?select=role&user_id=eq.${managers[0].user_id}`);
    expect(after.body[0].role).toBe("manager");
  });

  test("rejects a pending invitation and frees the address for re-invitation", async ({ page }) => {
    const token = await openWorkspace(page);
    const email = uniqueEmail();

    await page.getByRole("textbox", { name: /email/i }).fill(email);
    await page.getByRole("button", { name: /send invitation/i }).click();
    await expect(page.getByRole("status")).toContainText(email, { timeout: 30_000 });

    const row = page.getByRole("row", { name: new RegExp(email) });
    await row.getByRole("button", { name: /^reject$/i }).click();
    await row.getByRole("button", { name: /confirm reject/i }).click();
    await expect(page.getByRole("status")).toContainText(/rejected/i, { timeout: 30_000 });

    const gone = await rest(token, `sentinel_manager_roster?select=user_id&invited_email=eq.${email}`);
    expect(gone.body).toEqual([]);

    // The regression that matters: the reservation no longer blocks re-invitation.
    await page.getByRole("textbox", { name: /email/i }).fill(email);
    await page.getByRole("button", { name: /send invitation/i }).click();
    await expect(page.getByRole("status")).toContainText(email, { timeout: 30_000 });
    await expect(page.getByRole("alert")).toHaveCount(0);
  });
});

test.describe("analyst member management", () => {
  test.use({ storageState: storageStatePath("analyst") });

  test("is refused by every member management RPC", async ({ page }) => {
    await page.goto("/workspace");
    await page.getByRole("heading", { name: "Team and settings" }).waitFor();
    const token = await accessToken(page);
    const workspaceId = await workspaceIdFor(token);
    const self = await rest(token, "sentinel_members?select=user_id&limit=1");
    const selfId = self.body[0].user_id as string;

    for (const [name, args] of [
      ["sentinel_activate_member", { p_workspace_id: workspaceId, p_user_id: selfId }],
      ["sentinel_set_member_role", { p_workspace_id: workspaceId, p_user_id: selfId, p_role: "manager" }],
      ["sentinel_reject_invitation", { p_workspace_id: workspaceId, p_user_id: selfId }],
    ] as const) {
      const response = await callRpc(token, name, args);
      expect(response.status, `${name} must refuse an analyst`).toBeGreaterThanOrEqual(400);
      expect(JSON.stringify(response.body)).toMatch(/manager membership required/i);
    }
  });
});
```

- [ ] **Step 2: Run the new spec**

Run: `npx playwright test tests/members.spec.ts`
Expected: all tests pass. If `refuses to demote the last active manager` skips, the seeded workspace has more than one manager — that is a valid skip, note it and move on.

- [ ] **Step 3: Run the whole e2e suite for cross-contamination**

Run: `npx playwright test`
Expected: `tests/workspace.spec.ts` still passes. If it fails on member counts, the new spec left state behind — fix the cleanup in `members.spec.ts`, not the older spec.

- [ ] **Step 4: Commit**

```bash
git add tests/members.spec.ts
git commit -m "test: prove member management RPCs end to end"
```

---

## Known limitation carried from the spec

After reject then re-invite of the same address, `reconcileInvitationEvent` finds the pre-existing `member-invited` event (the partial unique index keys on workspace and `metadata.member_user_id`) and skips inserting a new one. The audit log reads invited, rejected, then nothing for the second invite. Correcting this means changing `invite-member`'s idempotency model and is deliberately out of scope. The e2e test above asserts the re-invitation *succeeds*; it does not assert a second event.
