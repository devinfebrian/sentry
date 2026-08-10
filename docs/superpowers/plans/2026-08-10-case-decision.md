# Case Decision Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an analyst recommend a decision on a case and a manager approve, reject, or send it back — recorded as an audit event that cannot be forged, so `sentinel_investigations.status` stops reading `open` on every case in the workspace.

**Architecture:** One `security definer` RPC performs a status write and an activity-event write in a single transaction, enforcing nine guards the UI cannot be trusted with. No new table: the decision history is `sentinel_activity_events` filtered to the case, which the existing feed components already render. The panel replaces `StepNotBuiltState` on the decision step only.

**Tech Stack:** Postgres/Supabase (plpgsql, RLS), React 19 + TypeScript, Vitest + Testing Library, Playwright.

**Spec:** `docs/superpowers/specs/2026-08-10-case-decision-design.md`

## Corrections

This plan is a historical record of what was proposed, not of what shipped — left unedited
below so nobody loses the reasoning that produced it. Two things changed during execution;
copy neither the SQL nor the error code below as current without checking the migration.

- **Not-found is `PT404`, not `P0002`.** Five places in this plan say `P0002` for guard 2's
  not-found error, and all five shipped as `PT404` instead. Cited by section and the exact
  stale text rather than by line number, since line numbers drift the moment anything above
  them is edited and a wrong citation is worse than none:
  - Task 1, Interfaces: "Raises `P0001` with a human-readable message for every refusal and
    `P0002` when the investigation is not found."
  - Task 1, Step 3 ("Write the migration"): `` raise exception using errcode = 'P0002', message = 'Investigation not found.'; ``
  - Task 4, Step 1 ("Write the failing service test"): `` { code: "P0002", message: "Investigation not found." } ``
  - Task 4, Step 4 ("Write the service"), the doc comment above `mapRpcError`: "P0002 is the
    exception: \"Investigation not found\" is a true statement about a query, not advice."
  - Task 4, Step 4, inside `mapRpcError`: `` if (error?.code === "P0002") return new Error(CASE_NOT_FOUND_ERROR); ``

  `P0002`, the standard plpgsql `no_data_found` SQLSTATE, has no entry in PostgREST's default
  SQLSTATE-to-HTTP-status table and surfaces as a bare 500 for an RPC called straight from the
  browser, where the status code is part of the contract; `PT404` is PostgREST's own
  explicit-status convention instead. Caught in Task 2's review.
- **Guard 9 fails closed instead of trusting a recommender exists, and `update (status)` is
  revoked from `authenticated`.** This plan (and the spec it followed) asserted that "`review`
  is only reachable through a recommendation," which was false: the foundation migration's two
  update policies had already been merged, on 2026-08-06, into one granting `authenticated` a
  direct `UPDATE` on `sentinel_investigations` — any manager unconditionally, an assigned
  analyst while status is `open`/`review`. A manager could `PATCH` status straight to
  `'review'` and then approve alone, or straight to `'approved'` with no audit event at all.
  Caught in Task 1's review; fixed by making guard 9 refuse when no `case-recommended` actor is
  found, and by revoking the direct-PATCH surface outright rather than relying on either fix
  alone.

Full detail on both, with the evidence, is in
`docs/superpowers/follow-ups/2026-08-10-case-decision.md`.

## Global Constraints

- Branch is `case-decision`, already created from `main` at `4f16f12`. Do not create another.
- Commands: `npm test` (Vitest, all unit tests), `npx vitest run <path>` (one file), `npm run test:e2e` (Playwright), `npx tsc -b` (type check). `npx playwright test tests/decisions.spec.ts` runs one spec.
- Every task ends with `npx tsc -b` clean and `npm test` green before its commit.
- **Do not regenerate `src/lib/database.types.ts` with `supabase gen types`.** It is hand-curated and partial by convention; regenerating replaces hand-narrowed unions like `role: "analyst" | "manager"` with bare `string` and breaks four call sites. Edit it by hand.
- **Migration ledger:** the `apply_migration` MCP tool ignores the filename and stamps its own version into `schema_migrations`. After applying, delete the stamped rows and insert one row whose `version` matches the repo filename, or `supabase db push` will not succeed later. This has bitten this project twice.
- Rationale cap is **2000 characters** everywhere it appears — SQL constraint, RPC guard, and the textarea's `maxLength`.
- The five action strings are exactly: `recommend-approve`, `recommend-reject`, `approve`, `reject`, `request-evidence`.
- The four event types are exactly: `case-recommended`, `case-approved`, `case-rejected`, `case-evidence-requested`.
- Prose in commit messages and code comments follows the house style already in this repo: say what changed and why the alternative was rejected. No bullet-point changelogs.

## File Structure

**Create:**

| Path | Responsibility |
| --- | --- |
| `supabase/migrations/20260810120000_sentinel_case_decisions.sql` | Event-type CHECK extension, rationale constraint, `sentinel_record_decision` |
| `src/services/sentinelDecisions.ts` | The RPC client. One concern: turning an action into a call and an error into a sentence |
| `src/services/sentinelDecisions.test.ts` | Call-shape and error-mapping tests |
| `src/components/decisions/DecisionPanel.tsx` | Which controls this viewer gets, and the history beneath them |
| `src/components/decisions/DecisionPanel.test.tsx` | One test per role/status row |
| `tests/decisions.spec.ts` | The nine guards, against the live RPC |
| `docs/superpowers/follow-ups/2026-08-10-case-decision.md` | Triaged findings |

**Modify:**

| Path | Change |
| --- | --- |
| `src/domain/types.ts` | `ActivityEventType` +6, `ActivityEntry.rationale`, `CaseSummary.ownerId`, `SentinelDecisionService` |
| `src/lib/database.types.ts` | `sentinel_activity_events` event_type union +6 (Row and Insert) |
| `src/services/sentinelActivity.ts:20` | `ACTIVITY_COLUMNS` gains `rationale`; `mapRow` maps it |
| `src/services/activityMessages.ts` | Four new `describeActivity` cases |
| `src/components/activity/ActivityFeed.tsx` | Render `rationale` when the event carries one; tone for decision types |
| `src/services/sentinelInvestigations.ts` | `mapRow` returns `ownerId` |
| `src/pages/CaseWorkspacePage.tsx:218` | `StepNotBuiltState` narrows to `report`; `DecisionPanel` takes `decision` |
| `src/app/App.tsx:117` | Thread `role` and `decisionService` into `CaseWorkspacePage` |
| `tests/workspace.spec.ts` | The two-role handoff |

**Untouched on purpose:** `src/components/decisions/DecisionRecord.tsx` is fixture-backed and serves `/demo`. `sentinel_investigation_queue` already selects `status`. `CaseStage` gains nothing.

---

### Task 1: The migration and one live decision

**Files:**
- Create: `supabase/migrations/20260810120000_sentinel_case_decisions.sql`
- Create: `tests/decisions.spec.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `public.sentinel_record_decision(p_investigation_id uuid, p_workspace_id uuid, p_action text, p_rationale text) returns jsonb`, returning `{ "status": <new status>, "event_id": <uuid> }`. Raises `P0001` with a human-readable message for every refusal and `P0002` when the investigation is not found. Also produces the seeding helpers in `tests/decisions.spec.ts` that Task 2 extends.

- [ ] **Step 1: Write the failing happy-path test**

Create `tests/decisions.spec.ts`. This file talks to the live project the way `tests/members.spec.ts` does, and it seeds its own disposable case so it never decides a case a human cares about.

```ts
import { expect, test, type Page } from "@playwright/test";
import { requireCredentials, requireServiceRoleKey, storageStatePath } from "./env";

const { supabaseUrl, publishableKey } = requireCredentials("manager");

// Decisions advance status and append events. Unlike re-running an agent, they are not
// idempotent, so this file never races itself over a shared fixture.
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

function subjectOf(token: string) {
  const payload = token.split(".")[1] ?? "";
  const decoded = Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
  return JSON.parse(decoded).sub as string;
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

async function adminRest(path: string, init: RequestInit = {}) {
  const secretKey = requireServiceRoleKey();
  const response = await fetch(`${supabaseUrl}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: secretKey,
      Authorization: `Bearer ${secretKey}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
      ...(init.headers ?? {}),
    },
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

async function decide(token: string, args: { investigationId: string; workspaceId: string; action: string; rationale: string }) {
  return rest(token, "rpc/sentinel_record_decision", {
    method: "POST",
    body: JSON.stringify({
      p_investigation_id: args.investigationId,
      p_workspace_id: args.workspaceId,
      p_action: args.action,
      p_rationale: args.rationale,
    }),
  });
}

type SeededCase = { id: string; workspaceId: string };

/**
 * A disposable case, seeded with the service role so its owner and upload state are exactly
 * what the test needs rather than whatever the shared backlog happens to hold.
 *
 * withUpload seeds an upload row and nothing else. Guard 5 asks whether the case has an
 * upload at all, so a parsed file would be more setup proving the same thing.
 */
async function seedCase(options: { workspaceId: string; ownerId: string; withUpload: boolean }): Promise<SeededCase> {
  const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`.toUpperCase();
  const created = await adminRest("sentinel_investigations", {
    method: "POST",
    body: JSON.stringify({
      workspace_id: options.workspaceId,
      reference: `INV-DEC${suffix}`,
      entity: "Decision guard fixture",
      owner_id: options.ownerId,
      created_by: options.ownerId,
      status: "open",
    }),
  });
  expect(created.status, `seed investigation: ${JSON.stringify(created.body)}`).toBe(201);
  const id = created.body[0].id as string;

  if (options.withUpload) {
    const uploadId = crypto.randomUUID();
    const upload = await adminRest("sentinel_uploads", {
      method: "POST",
      body: JSON.stringify({
        id: uploadId,
        workspace_id: options.workspaceId,
        investigation_id: id,
        // The storage_path CHECK requires workspace/investigation/upload/filename.
        storage_path: `${options.workspaceId}/${id}/${uploadId}/seed.csv`,
        original_name: "seed.csv",
        extension: "csv",
        byte_size: 128,
        status: "parsed",
        row_count: 3,
        uploaded_by: options.ownerId,
      }),
    });
    expect(upload.status, `seed upload: ${JSON.stringify(upload.body)}`).toBe(201);
  }

  return { id, workspaceId: options.workspaceId };
}

/**
 * Events must go first. sentinel_activity_events.investigation_id is `on delete set null`,
 * so deleting the case first would orphan its events into the workspace feed rather than
 * remove them.
 */
async function removeCase(seeded: SeededCase) {
  await adminRest(`sentinel_activity_events?investigation_id=eq.${seeded.id}`, { method: "DELETE" });
  await adminRest(`sentinel_uploads?investigation_id=eq.${seeded.id}`, { method: "DELETE" });
  await adminRest(`sentinel_investigations?id=eq.${seeded.id}`, { method: "DELETE" });
}

async function signedInToken(page: Page) {
  await page.goto("/cases");
  await page.getByRole("heading", { name: "Cases" }).waitFor();
  return accessToken(page);
}

async function workspaceIdFor(token: string) {
  const membership = await rest(token, "sentinel_members?select=workspace_id&limit=1");
  return membership.body[0].workspace_id as string;
}

test.describe("recording a decision", () => {
  test.use({ storageState: storageStatePath("analyst") });

  test("an analyst's recommendation moves the case to review and records their words", async ({ page }) => {
    const token = await signedInToken(page);
    const analystId = subjectOf(token);
    const workspaceId = await workspaceIdFor(token);
    const seeded = await seedCase({ workspaceId, ownerId: analystId, withUpload: true });

    try {
      const response = await decide(token, {
        investigationId: seeded.id,
        workspaceId,
        action: "recommend-approve",
        rationale: "Outlier amount is explained by the annual settlement.",
      });

      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.body.status).toBe("review");
      expect(response.body.event_id).toBeTruthy();

      const investigation = await rest(token, `sentinel_investigations?select=status&id=eq.${seeded.id}`);
      expect(investigation.body[0].status).toBe("review");

      const events = await rest(
        token,
        `sentinel_activity_events?select=event_type,actor_id,rationale,metadata&investigation_id=eq.${seeded.id}&event_type=eq.case-recommended`,
      );
      expect(events.body).toHaveLength(1);
      expect(events.body[0].actor_id).toBe(analystId);
      expect(events.body[0].rationale).toBe("Outlier amount is explained by the annual settlement.");
      expect(events.body[0].metadata).toMatchObject({
        from_status: "open",
        to_status: "review",
        recommendation: "approve",
      });
    } finally {
      await removeCase(seeded);
    }
  });
});
```

- [ ] **Step 2: Run it and confirm it fails for the right reason**

Run: `npx playwright test tests/decisions.spec.ts`
Expected: FAIL. The response status is `404` and the body names `sentinel_record_decision` as an undefined function. If it fails on seeding instead, fix the seed before writing any SQL — a seeding bug will masquerade as a guard bug for the whole of Task 2.

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/20260810120000_sentinel_case_decisions.sql`:

```sql
-- A case can now carry a decision somebody actually made.
--
-- status has held 'open' on every investigation ever created: create() writes it once and
-- nothing has moved it since, so the CaseHeader badge reports a constant as though it were
-- state. The two-role chain below is not new either — the foundation migration wrote an
-- analyst update policy bounded on both sides by status in ('open','review') and a manager
-- policy without that bound, then never exercised either.

-- --------------------------------------------------------------------------------------
-- 1. Decisions join the audit vocabulary
-- --------------------------------------------------------------------------------------

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
    'member-invite-rejected',
    'analysis-completed',
    'analysis-failed',
    'case-recommended',
    'case-approved',
    'case-rejected',
    'case-evidence-requested'
  ));

-- --------------------------------------------------------------------------------------
-- 2. The rationale column gains a bound before anything writes to it
-- --------------------------------------------------------------------------------------
-- Declared 2026-08-05 and never written to, so this constraint cannot fail against existing
-- rows: every one of them is null.

alter table public.sentinel_activity_events
  drop constraint if exists sentinel_activity_events_rationale_check;

alter table public.sentinel_activity_events
  add constraint sentinel_activity_events_rationale_check
  check (rationale is null or (btrim(rationale) <> '' and length(rationale) <= 2000));

comment on column public.sentinel_activity_events.rationale is
  'The actor''s own words for a decision, stored verbatim. Null on machine-generated events, which have no author to quote.';

-- --------------------------------------------------------------------------------------
-- 3. The decision itself
-- --------------------------------------------------------------------------------------

/**
 * Records one decision: a status write and an audit event, in one transaction, so the case
 * and its trail cannot disagree about what happened.
 *
 * security definer is forced rather than chosen. sentinel_activity_events has a select
 * policy and no insert policy for authenticated, so every audit write in this system goes
 * through a definer function or the service role. The consequence is that RLS does not
 * enforce the two-role split from inside here, so the guards below do, matching the
 * foundation migration's update policies rather than inventing a second rule.
 *
 * The actor is auth.uid() and is deliberately not a parameter. sentinel_record_analysis
 * takes p_actor_id because an edge function calls it with the service role and has no
 * session to read; this one is called straight from the browser, where an actor argument
 * would let any member sign a colleague's name to a decision.
 */
create or replace function public.sentinel_record_decision(
  p_investigation_id uuid,
  p_workspace_id uuid,
  p_action text,
  p_rationale text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_actor uuid := auth.uid();
  v_is_manager boolean;
  v_owner_id uuid;
  v_status text;
  v_next_status text;
  v_event_type text;
  v_recommendation text;
  v_rationale text := btrim(coalesce(p_rationale, ''));
  v_last_recommender uuid;
  v_event_id uuid;
begin
  -- Guard 1: membership.
  if v_actor is null or not private.sentinel_is_active_member(p_workspace_id) then
    raise exception using errcode = 'P0001', message = 'Active workspace membership required.';
  end if;

  v_is_manager := private.sentinel_is_manager(p_workspace_id);

  -- Guard 2: the case exists here. `for update` also serialises two decisions racing on one
  -- case — the second waits, re-reads the status this one wrote, and fails guard 8 rather
  -- than reading a stale recommender for guard 9.
  select i.owner_id, i.status
  into v_owner_id, v_status
  from public.sentinel_investigations as i
  where i.id = p_investigation_id
    and i.workspace_id = p_workspace_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'Investigation not found.';
  end if;

  -- Guard 3: known action.
  if p_action not in ('recommend-approve', 'recommend-reject', 'approve', 'reject', 'request-evidence') then
    raise exception using errcode = 'P0001', message = 'Unknown decision action.';
  end if;

  -- Guard 4: the rationale is the deliverable, so it is required on every action.
  if v_rationale = '' then
    raise exception using errcode = 'P0001', message = 'Record why you are making this decision.';
  end if;

  if length(v_rationale) > 2000 then
    raise exception using errcode = 'P0001', message = 'Rationale must be 2000 characters or fewer.';
  end if;

  -- Guard 5: nothing to decide about. This is the same condition the queue view calls
  -- 'awaiting-import' (pipeline.uploads is null or 0), asked directly rather than restated.
  if not exists (
    select 1
    from public.sentinel_uploads as u
    where u.investigation_id = p_investigation_id
      and u.workspace_id = p_workspace_id
  ) then
    raise exception using errcode = 'P0001', message = 'Import data before deciding this case.';
  end if;

  -- Guards 6 and 7: who may do what. Guard 6 mirrors the analyst update policy's
  -- owner_id = auth.uid() rather than inventing a parallel rule.
  if p_action in ('recommend-approve', 'recommend-reject') then
    if not v_is_manager and v_owner_id is distinct from v_actor then
      raise exception using errcode = 'P0001',
        message = 'Only the assigned analyst or a manager can recommend on this case.';
    end if;
  else
    if not v_is_manager then
      raise exception using errcode = 'P0001',
        message = 'Manager membership required to decide this case.';
    end if;
  end if;

  -- Guard 8: the action's status precondition, and what it writes.
  if p_action in ('recommend-approve', 'recommend-reject') then
    if v_status <> 'open' then
      raise exception using errcode = 'P0001',
        message = 'This case already has a recommendation awaiting review.';
    end if;
    v_next_status := 'review';
    v_event_type := 'case-recommended';
    v_recommendation := case when p_action = 'recommend-approve' then 'approve' else 'reject' end;

  elsif p_action in ('approve', 'reject') then
    if v_status <> 'review' then
      raise exception using errcode = 'P0001', message = 'This case has no recommendation to decide.';
    end if;
    v_next_status := case when p_action = 'approve' then 'approved' else 'closed' end;
    v_event_type := case when p_action = 'approve' then 'case-approved' else 'case-rejected' end;
    v_recommendation := p_action;

  else
    -- request-evidence. approved and closed are reachable-from rather than terminal: a
    -- review system that cannot correct itself records its mistakes as permanent, and the
    -- original decision survives in the trail either way.
    if v_status not in ('review', 'approved', 'closed') then
      raise exception using errcode = 'P0001', message = 'This case is already back with the analyst.';
    end if;
    v_next_status := 'open';
    v_event_type := 'case-evidence-requested';
    v_recommendation := 'request-evidence';
  end if;

  -- Guard 9: separation of duties. Cannot misfire for want of a recommender — 'review' is
  -- only reachable through a recommendation, which guard 8 has already established.
  if p_action in ('approve', 'reject') then
    select e.actor_id
    into v_last_recommender
    from public.sentinel_activity_events as e
    where e.investigation_id = p_investigation_id
      and e.event_type = 'case-recommended'
    order by e.created_at desc
    limit 1;

    if v_last_recommender is not distinct from v_actor then
      raise exception using errcode = 'P0001',
        message = 'You recommended this case. Another manager must decide it.';
    end if;
  end if;

  update public.sentinel_investigations as i
  set status = v_next_status,
      updated_at = now()
  where i.id = p_investigation_id;

  insert into public.sentinel_activity_events (
    workspace_id, investigation_id, actor_id, event_type, rationale, metadata
  ) values (
    p_workspace_id,
    p_investigation_id,
    v_actor,
    v_event_type,
    v_rationale,
    jsonb_build_object(
      'from_status', v_status,
      'to_status', v_next_status,
      'recommendation', v_recommendation
    )
  )
  returning id into v_event_id;

  return jsonb_build_object('status', v_next_status, 'event_id', v_event_id);
end;
$function$;

revoke all on function public.sentinel_record_decision(uuid, uuid, text, text) from public, anon;
grant execute on function public.sentinel_record_decision(uuid, uuid, text, text) to authenticated;
```

- [ ] **Step 4: Apply the migration and reconcile the ledger**

Apply it with the Supabase `apply_migration` MCP tool, name `sentinel_case_decisions`.

Then check what it stamped and repair the ledger so the repo filename is what the ledger holds:

```sql
select version from supabase_migrations.schema_migrations order by version desc limit 5;
```

Delete any row this apply added whose `version` is not `20260810120000`, then insert `20260810120000`. Confirm the function landed with its real argument types — `pg_get_function_identity_arguments` returns parameter *names* on this server and will not match a bare type list:

```sql
select proname, oidvectortypes(proargtypes) as args, prosecdef
from pg_proc where proname = 'sentinel_record_decision';
```

Expected: one row, `uuid, uuid, text, text`, `prosecdef = true`.

- [ ] **Step 5: Run the test and verify it passes**

Run: `npx playwright test tests/decisions.spec.ts`
Expected: PASS, 1 test. The seeded case is deleted by the `finally` block — confirm nothing is left behind:

```sql
select count(*) from public.sentinel_investigations where reference like 'INV-DEC%';
```

Expected: `0`.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/20260810120000_sentinel_case_decisions.sql tests/decisions.spec.ts
git commit -F - <<'EOF'
Let a case carry a decision somebody actually made

status has been a constant since the foundation migration wrote it once as
'open' and nothing moved it after. sentinel_record_decision advances it and
writes the audit event in the same transaction, so the case and its trail
cannot disagree about what happened.

The actor is auth.uid() rather than an argument. sentinel_record_analysis
takes p_actor_id because an edge function calls it with no session to read;
this one is called from the browser, where an actor argument would let any
member sign a colleague's name to a decision.

The rationale column has sat unused since 2026-08-05 and gets its bound here,
which cannot fail against existing rows because every one of them is null.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
```

---

### Task 2: The nine guards, proven

**Files:**
- Modify: `tests/decisions.spec.ts`

**Interfaces:**
- Consumes: `sentinel_record_decision` and the `seedCase` / `removeCase` / `decide` / `signedInToken` / `workspaceIdFor` helpers from Task 1.
- Produces: nothing consumed by later tasks.

A UI that hides a button proves nothing about whether the database refuses the write. Guards 5 and 9 in particular would be invisible from the interface.

- [ ] **Step 1: Add the analyst-side guard tests**

Append inside the existing `test.describe("recording a decision")` block (analyst storage state):

```ts
  test("refuses a case with nothing imported", async ({ page }) => {
    const token = await signedInToken(page);
    const analystId = subjectOf(token);
    const workspaceId = await workspaceIdFor(token);
    const seeded = await seedCase({ workspaceId, ownerId: analystId, withUpload: false });

    try {
      const response = await decide(token, {
        investigationId: seeded.id, workspaceId,
        action: "recommend-approve", rationale: "Looks fine to me.",
      });

      expect(response.status).toBe(400);
      expect(response.body.message).toMatch(/import data before deciding/i);

      const after = await rest(token, `sentinel_investigations?select=status&id=eq.${seeded.id}`);
      expect(after.body[0].status, "a refused decision must not move the case").toBe("open");
    } finally {
      await removeCase(seeded);
    }
  });

  test("refuses an empty rationale, and one over the cap", async ({ page }) => {
    const token = await signedInToken(page);
    const analystId = subjectOf(token);
    const workspaceId = await workspaceIdFor(token);
    const seeded = await seedCase({ workspaceId, ownerId: analystId, withUpload: true });

    try {
      const blank = await decide(token, {
        investigationId: seeded.id, workspaceId, action: "recommend-approve", rationale: "   ",
      });
      expect(blank.status).toBe(400);
      expect(blank.body.message).toMatch(/record why/i);

      const huge = await decide(token, {
        investigationId: seeded.id, workspaceId, action: "recommend-approve", rationale: "x".repeat(2001),
      });
      expect(huge.status).toBe(400);
      expect(huge.body.message).toMatch(/2000 characters or fewer/i);

      // The boundary itself is allowed, so the cap is a cap and not an off-by-one.
      const exact = await decide(token, {
        investigationId: seeded.id, workspaceId, action: "recommend-approve", rationale: "x".repeat(2000),
      });
      expect(exact.status, JSON.stringify(exact.body)).toBe(200);
    } finally {
      await removeCase(seeded);
    }
  });

  test("refuses an unknown action", async ({ page }) => {
    const token = await signedInToken(page);
    const analystId = subjectOf(token);
    const workspaceId = await workspaceIdFor(token);
    const seeded = await seedCase({ workspaceId, ownerId: analystId, withUpload: true });

    try {
      const response = await decide(token, {
        investigationId: seeded.id, workspaceId, action: "approve-please", rationale: "Fine.",
      });
      expect(response.status).toBe(400);
      expect(response.body.message).toMatch(/unknown decision action/i);
    } finally {
      await removeCase(seeded);
    }
  });

  test("refuses an investigation outside the caller's workspace", async ({ page }) => {
    const token = await signedInToken(page);
    const workspaceId = await workspaceIdFor(token);

    const response = await decide(token, {
      investigationId: crypto.randomUUID(), workspaceId,
      action: "recommend-approve", rationale: "Fine.",
    });

    expect(response.status).toBe(404);
    expect(response.body.message).toMatch(/investigation not found/i);
  });

  test("refuses an analyst recommending on a case they do not own", async ({ page, browser }) => {
    const analystToken = await signedInToken(page);
    const workspaceId = await workspaceIdFor(analystToken);

    const managerContext = await browser.newContext({ storageState: storageStatePath("manager") });
    try {
      const managerPage = await managerContext.newPage();
      const managerId = subjectOf(await signedInToken(managerPage));
      const seeded = await seedCase({ workspaceId, ownerId: managerId, withUpload: true });

      try {
        const response = await decide(analystToken, {
          investigationId: seeded.id, workspaceId,
          action: "recommend-approve", rationale: "Not my case.",
        });
        expect(response.status).toBe(400);
        expect(response.body.message).toMatch(/assigned analyst or a manager/i);
      } finally {
        await removeCase(seeded);
      }
    } finally {
      await managerContext.close();
    }
  });

  test("refuses an analyst approving anything", async ({ page }) => {
    const token = await signedInToken(page);
    const analystId = subjectOf(token);
    const workspaceId = await workspaceIdFor(token);
    const seeded = await seedCase({ workspaceId, ownerId: analystId, withUpload: true });

    try {
      const recommended = await decide(token, {
        investigationId: seeded.id, workspaceId,
        action: "recommend-approve", rationale: "Ready for review.",
      });
      expect(recommended.status).toBe(200);

      const response = await decide(token, {
        investigationId: seeded.id, workspaceId, action: "approve", rationale: "And approved.",
      });
      expect(response.status).toBe(400);
      expect(response.body.message).toMatch(/manager membership required/i);

      const after = await rest(token, `sentinel_investigations?select=status&id=eq.${seeded.id}`);
      expect(after.body[0].status).toBe("review");
    } finally {
      await removeCase(seeded);
    }
  });

  test("refuses a second recommendation while one is awaiting review", async ({ page }) => {
    const token = await signedInToken(page);
    const analystId = subjectOf(token);
    const workspaceId = await workspaceIdFor(token);
    const seeded = await seedCase({ workspaceId, ownerId: analystId, withUpload: true });

    try {
      expect((await decide(token, {
        investigationId: seeded.id, workspaceId,
        action: "recommend-approve", rationale: "First call.",
      })).status).toBe(200);

      const second = await decide(token, {
        investigationId: seeded.id, workspaceId,
        action: "recommend-reject", rationale: "Changed my mind.",
      });
      expect(second.status).toBe(400);
      expect(second.body.message).toMatch(/already has a recommendation/i);
    } finally {
      await removeCase(seeded);
    }
  });
```

- [ ] **Step 2: Add the manager-side guard tests**

Append a second describe block at the end of the file:

```ts
test.describe("deciding a recommended case", () => {
  test.use({ storageState: storageStatePath("manager") });

  test("refuses the manager who wrote the recommendation", async ({ page }) => {
    const token = await signedInToken(page);
    const managerId = subjectOf(token);
    const workspaceId = await workspaceIdFor(token);
    const seeded = await seedCase({ workspaceId, ownerId: managerId, withUpload: true });

    try {
      // A manager may recommend on any case; guard 9 is about who may then decide it.
      expect((await decide(token, {
        investigationId: seeded.id, workspaceId,
        action: "recommend-approve", rationale: "My own read of it.",
      })).status).toBe(200);

      const response = await decide(token, {
        investigationId: seeded.id, workspaceId, action: "approve", rationale: "And I agree with myself.",
      });

      expect(response.status).toBe(400);
      expect(response.body.message).toMatch(/another manager must decide/i);

      const after = await rest(token, `sentinel_investigations?select=status&id=eq.${seeded.id}`);
      expect(after.body[0].status, "a refused approval must leave the case in review").toBe("review");
    } finally {
      await removeCase(seeded);
    }
  });

  test("approves a case somebody else recommended, and can send a decided case back", async ({ page, browser }) => {
    const managerToken = await signedInToken(page);
    const workspaceId = await workspaceIdFor(managerToken);

    const analystContext = await browser.newContext({ storageState: storageStatePath("analyst") });
    try {
      const analystPage = await analystContext.newPage();
      const analystToken = await signedInToken(analystPage);
      const analystId = subjectOf(analystToken);
      const seeded = await seedCase({ workspaceId, ownerId: analystId, withUpload: true });

      try {
        expect((await decide(analystToken, {
          investigationId: seeded.id, workspaceId,
          action: "recommend-approve", rationale: "Settlement explains the outlier.",
        })).status).toBe(200);

        const approved = await decide(managerToken, {
          investigationId: seeded.id, workspaceId, action: "approve", rationale: "Agreed, closing it out.",
        });
        expect(approved.status, JSON.stringify(approved.body)).toBe(200);
        expect(approved.body.status).toBe("approved");

        // approved is reachable-from, not terminal.
        const sentBack = await decide(managerToken, {
          investigationId: seeded.id, workspaceId,
          action: "request-evidence", rationale: "Attach the settlement letter before we file this.",
        });
        expect(sentBack.status, JSON.stringify(sentBack.body)).toBe(200);
        expect(sentBack.body.status).toBe("open");

        const trail = await rest(
          managerToken,
          `sentinel_activity_events?select=event_type&investigation_id=eq.${seeded.id}&order=created_at.asc`,
        );
        const types = trail.body.map((row: { event_type: string }) => row.event_type);
        expect(types).toEqual(
          expect.arrayContaining(["case-recommended", "case-approved", "case-evidence-requested"]),
        );
      } finally {
        await removeCase(seeded);
      }
    } finally {
      await analystContext.close();
    }
  });

  test("refuses approving a case with no recommendation", async ({ page }) => {
    const token = await signedInToken(page);
    const managerId = subjectOf(token);
    const workspaceId = await workspaceIdFor(token);
    const seeded = await seedCase({ workspaceId, ownerId: managerId, withUpload: true });

    try {
      const response = await decide(token, {
        investigationId: seeded.id, workspaceId, action: "approve", rationale: "Straight to yes.",
      });
      expect(response.status).toBe(400);
      expect(response.body.message).toMatch(/no recommendation to decide/i);
    } finally {
      await removeCase(seeded);
    }
  });
});
```

- [ ] **Step 3: Run the suite**

Run: `npx playwright test tests/decisions.spec.ts`
Expected: PASS, 11 tests.

If any guard fails, the fix belongs in the migration, not the test. Re-apply with `apply_migration` (`create or replace function` is safe to re-run), reconcile the ledger again, and re-run.

- [ ] **Step 4: Confirm the suite cleans up after itself**

```sql
select count(*) from public.sentinel_investigations where reference like 'INV-DEC%';
select count(*) from public.sentinel_activity_events where event_type like 'case-%';
```

Expected: `0` and `0`. A non-zero count means a `finally` block was skipped — find it before committing, because Task 7 will run this file repeatedly.

- [ ] **Step 5: Commit**

```bash
git add tests/decisions.spec.ts
git commit -F - <<'EOF'
Prove the decision guards against the database, not the buttons

A UI that hides a button proves nothing about whether the database refuses the
write, and two of these guards have no visible surface at all: separation of
duties and the no-uploads refusal would both be invisible from the interface.

Every test seeds its own case and deletes it in a finally block. The shared
backlog was not an option here the way it was for the stage filter: a decision
advances status and appends events, so unlike re-running an agent it cannot be
repeated over the same row without changing what the next run sees.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
```

---

### Task 3: Types, and the audit trail learning to quote people

**Files:**
- Modify: `src/domain/types.ts`, `src/lib/database.types.ts`, `src/services/sentinelActivity.ts`, `src/services/activityMessages.ts`, `src/components/activity/ActivityFeed.tsx`
- Test: `src/services/activityMessages.test.ts`, `src/components/activity/ActivityFeed.test.tsx`

**Interfaces:**
- Consumes: the four event types from Task 1's migration.
- Produces: `ActivityEntry.rationale?: string | null`; `ActivityEventType` covering all fifteen event types; `describeActivity` sentences for the four decision types; `ActivityFeed` rendering `entry.rationale` in an element with class `activity-rationale`.

`ActivityEventType` is currently two values behind the database — `analysis-completed` and `analysis-failed` are in the CHECK and not in the union, so those events fall to `describeActivity`'s `default` branch. This task closes that drift while it is in the file.

- [ ] **Step 1: Write the failing message tests**

Add to `src/services/activityMessages.test.ts`, following the `entry()` helper already in that file:

```ts
  it("reads a recommendation as the recommendation, not the event name", () => {
    const sentence = describeActivity(
      entry({ type: "case-recommended", metadata: { recommendation: "approve", from_status: "open", to_status: "review" } }),
      names,
    );
    expect(sentence).toBe("recommended approving this case");
  });

  it("names the opposite recommendation too", () => {
    const sentence = describeActivity(
      entry({ type: "case-recommended", metadata: { recommendation: "reject" } }),
      names,
    );
    expect(sentence).toBe("recommended rejecting this case");
  });

  it("falls back when a recommendation event carries no recommendation", () => {
    expect(describeActivity(entry({ type: "case-recommended", metadata: {} }), names))
      .toBe("recorded a recommendation");
  });

  it("reads the three manager decisions", () => {
    expect(describeActivity(entry({ type: "case-approved", metadata: {} }), names)).toBe("approved this case");
    expect(describeActivity(entry({ type: "case-rejected", metadata: {} }), names)).toBe("rejected this case");
    expect(describeActivity(entry({ type: "case-evidence-requested", metadata: {} }), names))
      .toBe("asked for more evidence");
  });
```

- [ ] **Step 2: Write the failing feed test**

Add to `src/components/activity/ActivityFeed.test.tsx`:

```ts
  it("quotes the actor's rationale when the event carries one", () => {
    renderFeed([entry({
      type: "case-approved",
      rationale: "Settlement letter is attached and matches the amount.",
    })]);

    const row = screen.getByRole("listitem");
    expect(row).toHaveTextContent("approved this case");
    expect(within(row).getByText("Settlement letter is attached and matches the amount."))
      .toBeInTheDocument();
  });

  it("renders no rationale element for an event that has none", () => {
    const { container } = render(
      <MemoryRouter>
        <ActivityFeed entries={[entry({ type: "parse-started" })]} names={names} />
      </MemoryRouter>,
    );

    expect(container.querySelector(".activity-rationale")).toBeNull();
  });
```

The second test needs `render` and `container`, so import `render` in that file if the existing `renderFeed` helper hides it.

- [ ] **Step 3: Run both and confirm they fail**

Run: `npx vitest run src/services/activityMessages.test.ts src/components/activity/ActivityFeed.test.tsx`
Expected: FAIL. The message tests get the `default` branch's `"case recommended"`; the feed tests fail on a missing rationale element and a TypeScript error on the unknown `rationale` property.

- [ ] **Step 4: Extend the types**

In `src/domain/types.ts`, replace the `ActivityEventType` union with all fifteen values and add `rationale` to `ActivityEntry`:

```ts
export type ActivityEventType =
  | "investigation-created"
  | "upload-created"
  | "parse-started"
  | "parse-completed"
  | "parse-failed"
  | "member-invited"
  | "member-activated"
  | "member-role-changed"
  | "member-invite-rejected"
  | "analysis-completed"
  | "analysis-failed"
  | "case-recommended"
  | "case-approved"
  | "case-rejected"
  | "case-evidence-requested";
```

In the `ActivityEntry` interface, below `metadata`:

```ts
  /**
   * The actor's own words, on the events that have an author. Null everywhere else — a
   * parse did not have a reason, it had a result.
   */
  rationale?: string | null;
```

In `src/lib/database.types.ts`, replace the `event_type` union in **both** the `Row` and `Insert` blocks of `sentinel_activity_events` with the same fifteen values. Edit by hand; do not regenerate.

- [ ] **Step 5: Read the column and map it**

In `src/services/sentinelActivity.ts`, line 20:

```ts
export const ACTIVITY_COLUMNS = "id, investigation_id, actor_id, event_type, rationale, metadata, created_at";
```

and in `mapRow`, below `metadata`:

```ts
    rationale: row.rationale,
```

- [ ] **Step 6: Write the four sentences**

In `src/services/activityMessages.ts`, add these cases before `default`:

```ts
    case "case-recommended": {
      const recommendation = text(metadata, "recommendation");
      if (recommendation === "approve") return "recommended approving this case";
      if (recommendation === "reject") return "recommended rejecting this case";
      return "recorded a recommendation";
    }
    case "case-approved":
      return "approved this case";
    case "case-rejected":
      return "rejected this case";
    case "case-evidence-requested":
      return "asked for more evidence";
```

- [ ] **Step 7: Render the rationale**

In `src/components/activity/ActivityFeed.tsx`, extend `toneFor` and add the rationale below the detail span:

```ts
function toneFor(type: ActivityEntry["type"]) {
  if (type === "parse-failed" || type === "member-invite-rejected" || type === "case-rejected") return "risk" as const;
  if (type === "parse-completed" || type === "member-activated" || type === "case-approved") return "confirm" as const;
  return "action" as const;
}
```

Inside the `<span className="activity-detail">`, after the case link block:

```tsx
              {entry.rationale && <span className="activity-rationale">{entry.rationale}</span>}
```

Add to `src/styles/global.css`, beside the other `.activity-*` rules:

```css
.activity-rationale {
  display: block;
  margin-top: 0.35rem;
  padding-left: 0.75rem;
  border-left: 2px solid var(--line-soft);
  color: var(--text-secondary);
}
```

Check those two custom property names against the file before using them — substitute the nearest equivalents already in use if they differ. A class with no rule behind it has shipped in this project before.

- [ ] **Step 8: Run the tests**

Run: `npx vitest run src/services/activityMessages.test.ts src/components/activity/ActivityFeed.test.tsx && npx tsc -b`
Expected: PASS on both files, `tsc` clean.

- [ ] **Step 9: Run the whole unit suite**

Run: `npm test`
Expected: all green. Widening `ActivityEventType` can surface exhaustive switches elsewhere; if anything breaks, fix it here rather than deferring.

- [ ] **Step 10: Commit**

```bash
git add src/domain/types.ts src/lib/database.types.ts src/services/sentinelActivity.ts src/services/activityMessages.ts src/services/activityMessages.test.ts src/components/activity/ActivityFeed.tsx src/components/activity/ActivityFeed.test.tsx src/styles/global.css
git commit -F - <<'EOF'
Teach the audit trail to quote the person who decided

The rationale column has been readable since 2026-08-05 and unread since:
ACTIVITY_COLUMNS never selected it because nothing wrote it. Now something
does, so the feed shows the words rather than only the verb.

ActivityEventType was two values behind the database — analysis-completed and
analysis-failed were in the CHECK and not in the union, so both fell to the
default branch and rendered as their own slugs. Closed here rather than left
for whoever notices the third one.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
```

---

### Task 4: The service layer

**Files:**
- Create: `src/services/sentinelDecisions.ts`, `src/services/sentinelDecisions.test.ts`
- Modify: `src/domain/types.ts`, `src/services/sentinelInvestigations.ts`
- Test: `src/services/sentinelInvestigations.test.ts`

**Interfaces:**
- Consumes: `sentinel_record_decision` from Task 1.
- Produces: `createSentinelDecisionService(client, context)` returning `SentinelDecisionService` with `record(investigationId: string, action: DecisionAction, rationale: string): Promise<{ status: CaseStatus }>`; the exported types `DecisionAction` and `CaseStatus`; and `CaseSummary.ownerId: string | null`.

- [ ] **Step 1: Write the failing service test**

Create `src/services/sentinelDecisions.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { createSentinelDecisionService } from "./sentinelDecisions";

function clientReturning(result: { data: unknown; error: { code?: string; message?: string } | null }) {
  const rpc = vi.fn().mockResolvedValue(result);
  return { client: { rpc } as never, rpc };
}

const context = { workspaceId: "workspace-1" };

describe("createSentinelDecisionService", () => {
  it("names the investigation, the workspace, the action, and the rationale", async () => {
    const { client, rpc } = clientReturning({ data: { status: "review", event_id: "event-1" }, error: null });

    const result = await createSentinelDecisionService(client, context)
      .record("inv-1", "recommend-approve", "  Settlement explains it.  ");

    expect(rpc).toHaveBeenCalledWith("sentinel_record_decision", {
      p_investigation_id: "inv-1",
      p_workspace_id: "workspace-1",
      p_action: "recommend-approve",
      p_rationale: "Settlement explains it.",
    });
    expect(result).toEqual({ status: "review" });
  });

  it("sends no actor id, because the RPC reads the caller from auth.uid()", async () => {
    const { client, rpc } = clientReturning({ data: { status: "review" }, error: null });

    await createSentinelDecisionService(client, context).record("inv-1", "recommend-reject", "No.");

    expect(Object.keys(rpc.mock.calls[0][1])).not.toContain("p_actor_id");
  });

  it("surfaces a P0001 refusal verbatim, because the database wrote it for a reader", async () => {
    const { client } = clientReturning({
      data: null,
      error: { code: "P0001", message: "You recommended this case. Another manager must decide it." },
    });

    await expect(createSentinelDecisionService(client, context).record("inv-1", "approve", "Yes."))
      .rejects.toThrow("You recommended this case. Another manager must decide it.");
  });

  it("translates a missing investigation into something a reader can act on", async () => {
    const { client } = clientReturning({ data: null, error: { code: "P0002", message: "Investigation not found." } });

    await expect(createSentinelDecisionService(client, context).record("inv-1", "approve", "Yes."))
      .rejects.toThrow(/reload/i);
  });

  it("refuses an empty rationale before spending a network call", async () => {
    const { client, rpc } = clientReturning({ data: null, error: null });

    await expect(createSentinelDecisionService(client, context).record("inv-1", "approve", "   "))
      .rejects.toThrow(/record why/i);
    expect(rpc).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run src/services/sentinelDecisions.test.ts`
Expected: FAIL — cannot resolve `./sentinelDecisions`.

- [ ] **Step 3: Add the domain types**

In `src/domain/types.ts`, beside the other service interfaces:

```ts
export type CaseStatus = "open" | "review" | "approved" | "closed";

export type DecisionAction =
  | "recommend-approve"
  | "recommend-reject"
  | "approve"
  | "reject"
  | "request-evidence";

export interface SentinelDecisionService {
  record(investigationId: string, action: DecisionAction, rationale: string): Promise<{ status: CaseStatus }>;
}
```

Then change `CaseSummary.status` to use the alias (`status: CaseStatus;`) and add `ownerId` beside `owner`:

```ts
  /** The resolved display name, for reading. */
  owner: string;
  /** The identifier, for deciding whether the viewer is the owner. */
  ownerId: string | null;
```

Update `InvestigationRow.status` in `src/services/sentinelInvestigations.ts` to `CaseStatus` and import it, so the row shape and the summary cannot drift apart.

- [ ] **Step 4: Write the service**

Create `src/services/sentinelDecisions.ts`:

```ts
import type { CaseStatus, DecisionAction, SentinelDecisionService } from "../domain/types";

type RpcError = { code?: string; message?: string };

export type SentinelDecisionClient = {
  rpc(
    name: "sentinel_record_decision",
    args: { p_investigation_id: string; p_workspace_id: string; p_action: DecisionAction; p_rationale: string },
  ): Promise<{ data: unknown; error: RpcError | null }>;
};

type DecisionContext = { workspaceId: string };

export const EMPTY_RATIONALE_ERROR = "Record why you are making this decision.";
export const MAX_RATIONALE_LENGTH = 2000;
export const LONG_RATIONALE_ERROR = `Rationale must be ${MAX_RATIONALE_LENGTH} characters or fewer.`;
export const CASE_NOT_FOUND_ERROR = "This case is no longer available. Reload the page and try again.";

/**
 * P0001 messages are written for a reader by the function that raised them, so passing one
 * through untouched is more useful than any sentence this layer could substitute. P0002 is
 * the exception: "Investigation not found" is a true statement about a query, not advice.
 */
function mapRpcError(error: RpcError | null) {
  if (error?.code === "P0001" && error.message?.trim()) return new Error(error.message);
  if (error?.code === "P0002") return new Error(CASE_NOT_FOUND_ERROR);
  return new Error(`Unable to record decision: ${error?.message || "Unknown Supabase error."}`);
}

export function createSentinelDecisionService(
  client: SentinelDecisionClient,
  context: DecisionContext,
): SentinelDecisionService {
  return {
    async record(investigationId, action, rationale) {
      // Checked here as well as in the RPC. The database is the authority; this only saves
      // a round trip on the mistake a reader is most likely to make.
      const trimmed = rationale.trim();
      if (!trimmed) throw new Error(EMPTY_RATIONALE_ERROR);
      if (trimmed.length > MAX_RATIONALE_LENGTH) throw new Error(LONG_RATIONALE_ERROR);

      // No actor argument: the RPC resolves the caller from auth.uid(), so a client cannot
      // sign someone else's name to a decision.
      const { data, error } = await client.rpc("sentinel_record_decision", {
        p_investigation_id: investigationId,
        p_workspace_id: context.workspaceId,
        p_action: action,
        p_rationale: trimmed,
      });

      if (error) throw mapRpcError(error);

      const status = (data as { status?: string } | null)?.status;
      return { status: status as CaseStatus };
    },
  };
}
```

- [ ] **Step 5: Return the owner id**

In `src/services/sentinelInvestigations.ts`, inside `mapRow`, beside `owner`:

```ts
    ownerId: row.owner_id,
```

- [ ] **Step 6: Cover the owner id**

Add to `src/services/sentinelInvestigations.test.ts`:

```ts
  it("returns the owner id alongside the resolved name, so a page can ask whether it is yours", async () => {
    // Follow the existing test in this file for how a client is stubbed and a row is shaped;
    // the assertion is what matters here.
    const [summary] = await listWithRows([row({ owner_id: "user-7" })]);

    expect(summary.ownerId).toBe("user-7");
    expect(summary.owner).not.toBe("user-7");
  });
```

Adapt `listWithRows` and `row` to whatever the file's existing helpers are called. If it has none, stub the client the way the neighbouring test in that file does.

- [ ] **Step 7: Run the tests**

Run: `npx vitest run src/services/sentinelDecisions.test.ts src/services/sentinelInvestigations.test.ts && npx tsc -b`
Expected: PASS on both, `tsc` clean.

Adding a required `ownerId` to `CaseSummary` will break every fixture that builds one. Fix each by adding `ownerId: null` unless the test is about ownership.

- [ ] **Step 8: Run the whole suite and commit**

Run: `npm test`
Expected: all green.

```bash
git add src/domain/types.ts src/services/sentinelDecisions.ts src/services/sentinelDecisions.test.ts src/services/sentinelInvestigations.ts src/services/sentinelInvestigations.test.ts
git commit -F - <<'EOF'
Give the client a way to record a decision, and a way to know whose case it is

CaseSummary carried a resolved owner name and no identifier, so nothing on a
page could answer whether the viewer owns the case it is rendering — which is
the first thing the decision step has to know.

P0001 messages pass through untouched. The function that raised them wrote
them for a reader, and any sentence this layer substituted would know less
about why the write was refused.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
```

---

### Task 5: The panel

**Files:**
- Create: `src/components/decisions/DecisionPanel.tsx`, `src/components/decisions/DecisionPanel.test.tsx`

**Interfaces:**
- Consumes: `SentinelDecisionService`, `DecisionAction`, `CaseStatus`, `CaseSummary.ownerId` (Task 4); `ActivityFeed` with rationale rendering and `useActivityFeed` (Task 3).
- Produces: `<DecisionPanel caseItem viewerId role decisionService activityService memberNames onDecided />`, where `onDecided: () => void` is called after a successful write.

`src/components/decisions/DecisionRecord.tsx` stays untouched — it is fixture-backed and serves `/demo`.

All CSS classes used below already exist in `src/styles/global.css`: `.decision-record`, `.decision-record-heading`, `.decision-recommendation`, `.decision-actions`, `.decision-form`, `.decision-history`, `.state-panel`, `.section-kicker`, `.section-header-lined`. Do not invent new ones.

- [ ] **Step 1: Write the failing component tests**

Create `src/components/decisions/DecisionPanel.test.tsx`:

```tsx
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import type { ActivityEntry, CaseStatus, CaseSummary } from "../../domain/types";
import { DecisionPanel } from "./DecisionPanel";

const caseItem = (status: CaseStatus, ownerId: string | null = "analyst-1"): CaseSummary => ({
  id: "INV-ABC123",
  databaseId: "inv-uuid-1",
  entity: "Northwind Freight",
  owner: "ada.lovelace",
  ownerId,
  risk: "high",
  stageId: "analysed",
  status,
  ageDays: 2,
  lastActivity: new Date().toISOString(),
});

const recommendedBy = (actorId: string): ActivityEntry => ({
  id: "event-1",
  investigationId: "inv-uuid-1",
  actorId,
  type: "case-recommended",
  metadata: { recommendation: "approve", from_status: "open", to_status: "review" },
  rationale: "Settlement explains the outlier.",
  occurredAt: new Date(Date.now() - 5 * 60_000).toISOString(),
});

function renderPanel(overrides: Partial<Parameters<typeof DecisionPanel>[0]> = {}) {
  const record = vi.fn().mockResolvedValue({ status: "review" });
  const entries = overrides.__entries ?? [];
  const activityService = { list: vi.fn().mockResolvedValue(entries) };

  render(
    <MemoryRouter>
      <DecisionPanel
        caseItem={caseItem("open")}
        viewerId="analyst-1"
        role="analyst"
        decisionService={{ record }}
        activityService={activityService}
        onDecided={vi.fn()}
        {...overrides}
      />
    </MemoryRouter>,
  );

  return { record, activityService };
}

describe("DecisionPanel", () => {
  it("offers the owner both recommendations while the case is open", async () => {
    renderPanel();

    expect(await screen.findByRole("button", { name: /recommend approve/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /recommend reject/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^approve$/i })).not.toBeInTheDocument();
  });

  it("offers nothing to an analyst who does not own the case", async () => {
    renderPanel({ caseItem: caseItem("open", "someone-else") });

    await waitFor(() => expect(screen.queryByRole("button", { name: /recommend/i })).not.toBeInTheDocument());
    expect(screen.getByText(/only the assigned analyst/i)).toBeInTheDocument();
  });

  it("sends the chosen action and the typed rationale", async () => {
    const { record } = renderPanel();

    await userEvent.click(await screen.findByRole("button", { name: /recommend approve/i }));
    await userEvent.type(screen.getByRole("textbox", { name: /rationale/i }), "Settlement explains it.");
    await userEvent.click(screen.getByRole("button", { name: /^record decision$/i }));

    await waitFor(() => expect(record).toHaveBeenCalledWith("inv-uuid-1", "recommend-approve", "Settlement explains it."));
  });

  it("will not submit an empty rationale", async () => {
    const { record } = renderPanel();

    await userEvent.click(await screen.findByRole("button", { name: /recommend approve/i }));
    await userEvent.click(screen.getByRole("button", { name: /^record decision$/i }));

    expect(record).not.toHaveBeenCalled();
  });

  it("gives a manager all three decisions on a case somebody else recommended", async () => {
    renderPanel({
      caseItem: caseItem("review"),
      role: "manager",
      viewerId: "manager-1",
      __entries: [recommendedBy("analyst-1")],
    });

    expect(await screen.findByRole("button", { name: /^approve$/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^reject$/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /request more evidence/i })).toBeInTheDocument();
  });

  it("withholds approval from the manager who wrote the recommendation, and says why", async () => {
    renderPanel({
      caseItem: caseItem("review", "manager-1"),
      role: "manager",
      viewerId: "manager-1",
      __entries: [recommendedBy("manager-1")],
    });

    expect(await screen.findByText(/another manager must decide/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^approve$/i })).not.toBeInTheDocument();
  });

  it("lets a manager reopen a decided case, and nothing else", async () => {
    renderPanel({
      caseItem: caseItem("approved"),
      role: "manager",
      viewerId: "manager-1",
      __entries: [recommendedBy("analyst-1")],
    });

    expect(await screen.findByRole("button", { name: /request more evidence/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^approve$/i })).not.toBeInTheDocument();
  });

  it("shows the refusal the database returned rather than a generic failure", async () => {
    const record = vi.fn().mockRejectedValue(new Error("You recommended this case. Another manager must decide it."));
    renderPanel({ decisionService: { record } });

    await userEvent.click(await screen.findByRole("button", { name: /recommend approve/i }));
    await userEvent.type(screen.getByRole("textbox", { name: /rationale/i }), "Mine.");
    await userEvent.click(screen.getByRole("button", { name: /^record decision$/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/another manager must decide/i);
  });

  it("shows the history with each decision's rationale", async () => {
    renderPanel({ caseItem: caseItem("review"), __entries: [recommendedBy("analyst-1")] });

    expect(await screen.findByText("Settlement explains the outlier.")).toBeInTheDocument();
  });
});
```

`__entries` is a test-only prop name used to seed the stubbed `activityService`; the component itself takes no such prop. Declare the helper's parameter type as `Partial<Parameters<typeof DecisionPanel>[0]> & { __entries?: ActivityEntry[] }` and strip `__entries` before spreading into the component.

- [ ] **Step 2: Run and confirm they fail**

Run: `npx vitest run src/components/decisions/DecisionPanel.test.tsx`
Expected: FAIL — cannot resolve `./DecisionPanel`.

- [ ] **Step 3: Write the panel**

Create `src/components/decisions/DecisionPanel.tsx`:

```tsx
import { useMemo, useState } from "react";
import type {
  ActivityEntry, CaseStatus, CaseSummary, DecisionAction, SentinelActivityService, SentinelDecisionService,
} from "../../domain/types";
import { useActivityFeed } from "../../pages/useActivityFeed";
import type { MemberNameLookup } from "../../services/memberNames";
import { MAX_RATIONALE_LENGTH } from "../../services/sentinelDecisions";
import { ActivityFeed } from "../activity/ActivityFeed";
import { Button } from "../ui/Button";
import { LoadingState } from "../ui/LoadingState";
import { StatusBadge } from "../ui/StatusBadge";

interface DecisionPanelProps {
  caseItem: CaseSummary;
  viewerId: string | null;
  role: "analyst" | "manager" | null;
  decisionService?: Pick<SentinelDecisionService, "record"> | null;
  activityService?: SentinelActivityService | null;
  memberNames?: MemberNameLookup | null;
  onDecided: () => void;
}

const DECISION_TYPES = new Set<ActivityEntry["type"]>([
  "case-recommended", "case-approved", "case-rejected", "case-evidence-requested",
]);

const statusLabels: Record<CaseStatus, string> = {
  open: "Open", review: "Pending approval", approved: "Approved", closed: "Closed",
};

const statusTones: Record<CaseStatus, "neutral" | "action" | "confirm" | "risk"> = {
  open: "neutral", review: "action", approved: "confirm", closed: "risk",
};

const actionLabels: Record<DecisionAction, string> = {
  "recommend-approve": "Recommend approve",
  "recommend-reject": "Recommend reject",
  approve: "Approve",
  reject: "Reject",
  "request-evidence": "Request more evidence",
};

/**
 * What this viewer may do about this case, and what everyone has already done.
 *
 * Every rule here is also a guard in sentinel_record_decision. This decides which buttons
 * exist; the database decides which writes land. Where the two disagree the database wins,
 * and the refusal it wrote is what the alert shows — which is why nothing here is optimistic.
 */
export function DecisionPanel({
  caseItem, viewerId, role, decisionService, activityService, memberNames, onDecided,
}: DecisionPanelProps) {
  const { state } = useActivityFeed({
    activity: activityService, memberNames, investigationId: caseItem.databaseId,
  });
  const [pending, setPending] = useState<DecisionAction | null>(null);
  const [rationale, setRationale] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const decisions = useMemo(
    () => (state.status === "ready" ? state.entries.filter((entry) => DECISION_TYPES.has(entry.type)) : []),
    [state],
  );

  const lastRecommender = decisions.find((entry) => entry.type === "case-recommended")?.actorId ?? null;
  const isOwner = Boolean(viewerId) && caseItem.ownerId === viewerId;
  const isManager = role === "manager";
  const recommendedThis = Boolean(viewerId) && lastRecommender === viewerId;

  const available: DecisionAction[] = (() => {
    if (!decisionService) return [];
    if (caseItem.status === "open") {
      return isOwner || isManager ? ["recommend-approve", "recommend-reject"] : [];
    }
    if (!isManager) return [];
    if (caseItem.status === "review") {
      return recommendedThis ? ["request-evidence"] : ["approve", "reject", "request-evidence"];
    }
    return ["request-evidence"];
  })();

  const withheldReason = (() => {
    if (available.length > 0) return null;
    if (caseItem.status === "open") return "Only the assigned analyst or a manager can recommend on this case.";
    if (!isManager) return "A manager decides this case once a recommendation is recorded.";
    return null;
  })();

  const selfRecommendedNote = caseItem.status === "review" && isManager && recommendedThis
    ? "You recommended this case. Another manager must decide it."
    : null;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!pending || !decisionService) return;
    const trimmed = rationale.trim();
    if (!trimmed) {
      setError("Record why you are making this decision.");
      return;
    }

    setBusy(true);
    setError(null);
    try {
      await decisionService.record(caseItem.databaseId, pending, trimmed);
      setPending(null);
      setRationale("");
      onDecided();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to record decision.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="decision-record" aria-labelledby="decision-panel-title">
      <div className="decision-record-heading">
        <div>
          <span className="section-kicker">Decision / accountable review</span>
          <h2 id="decision-panel-title">Decision record</h2>
        </div>
        <StatusBadge
          status={caseItem.status}
          label={statusLabels[caseItem.status]}
          tone={statusTones[caseItem.status]}
        />
      </div>

      {selfRecommendedNote && <p className="decision-recommendation">{selfRecommendedNote}</p>}
      {withheldReason && <p className="decision-recommendation">{withheldReason}</p>}

      {available.length > 0 && (
        <div className="decision-actions">
          {available.map((action) => (
            <Button
              key={action}
              variant={action === "approve" || action === "recommend-approve" ? "primary"
                : action === "reject" || action === "recommend-reject" ? "destructive" : "secondary"}
              onClick={() => { setPending(action); setError(null); }}
            >
              {actionLabels[action]}
            </Button>
          ))}
        </div>
      )}

      {pending && (
        <form className="decision-form" onSubmit={submit}>
          <label htmlFor="decision-rationale">Rationale</label>
          <textarea
            id="decision-rationale"
            value={rationale}
            maxLength={MAX_RATIONALE_LENGTH}
            onChange={(event) => setRationale(event.target.value)}
            placeholder="Record why this decision is the right one on the evidence."
          />
          <div>
            <Button variant="primary" type="submit" disabled={busy}>Record decision</Button>
            <Button variant="quiet" type="button" onClick={() => { setPending(null); setError(null); }}>Cancel</Button>
          </div>
        </form>
      )}

      {error && <div role="alert">{error}</div>}

      <div className="decision-history">
        <div className="section-header-lined">
          <div>
            <span className="section-kicker">Audit trail</span>
            <h3>Revision history</h3>
          </div>
          <span className="section-meta">Immutable events</span>
        </div>
        {state.status === "loading" && <LoadingState label="Loading decision history" />}
        {state.status === "ready" && decisions.length === 0 && <p>No decision has been recorded yet.</p>}
        {decisions.length > 0 && (
          <ActivityFeed
            entries={decisions}
            names={state.status === "ready" ? state.names : undefined}
            showCaseLinks={false}
          />
        )}
      </div>
    </section>
  );
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run src/components/decisions/DecisionPanel.test.tsx && npx tsc -b`
Expected: PASS, 9 tests, `tsc` clean.

- [ ] **Step 5: Commit**

```bash
git add src/components/decisions/DecisionPanel.tsx src/components/decisions/DecisionPanel.test.tsx
git commit -F - <<'EOF'
Show a reviewer what they may decide, and why not when they may not

Every rule in this panel is also a guard in sentinel_record_decision. The panel
decides which buttons exist; the database decides which writes land, and where
they disagree the database wins — which is why nothing here is optimistic and
why the alert shows the refusal the function wrote rather than a sentence of
this component's own.

A manager who recommended the case is told so instead of being shown an approve
button that always fails. In a one-manager workspace that is a deadlock, and an
honest one: nobody separates duties from themselves.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
```

---

### Task 6: Wiring

**Files:**
- Modify: `src/pages/CaseWorkspacePage.tsx`, `src/app/App.tsx`
- Test: `src/pages/CaseWorkspacePage.test.tsx`

**Interfaces:**
- Consumes: `DecisionPanel` (Task 5), `createSentinelDecisionService` (Task 4).
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Write the failing page tests**

Add to `src/pages/CaseWorkspacePage.test.tsx`, following the render helper already in that file:

```tsx
  it("puts a real decision panel on the decision step of an analysed case", async () => {
    renderCasePage({ step: "decision", caseItem: analysedCase, role: "analyst" });

    expect(await screen.findByRole("heading", { name: "Decision record" })).toBeInTheDocument();
    expect(screen.queryByText(/this step is not built yet/i)).not.toBeInTheDocument();
  });

  it("still says the report step is not built", async () => {
    renderCasePage({ step: "report", caseItem: analysedCase, role: "analyst" });

    expect(await screen.findByText(/this step is not built yet/i)).toBeInTheDocument();
  });

  it("says analysis has not started on the decision step of a case awaiting import", async () => {
    renderCasePage({ step: "decision", caseItem: { ...analysedCase, stageId: "awaiting-import" }, role: "analyst" });

    expect(await screen.findByText(/analysis/i)).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Decision record" })).not.toBeInTheDocument();
  });
```

Extend that file's render helper to accept `role` and `viewerId` and to pass a stubbed `decisionService` and `activityService`. `analysedCase` should be a `CaseSummary` with `stageId: "analysed"`, `status: "open"`, and `ownerId` equal to the `viewerId` the helper passes, so the owner branch is the one under test.

- [ ] **Step 2: Run and confirm they fail**

Run: `npx vitest run src/pages/CaseWorkspacePage.test.tsx`
Expected: FAIL — the decision step renders `StepNotBuiltState`, so "Decision record" is absent and "this step is not built yet" is present.

- [ ] **Step 3: Wire the page**

In `src/pages/CaseWorkspacePage.tsx`:

Add to the imports:

```ts
import { DecisionPanel } from "../components/decisions/DecisionPanel";
```

and add `SentinelDecisionService` to the type import from `../domain/types`.

Add to `CaseWorkspacePageProps`:

```ts
  decisionService?: Pick<SentinelDecisionService, "record"> | null;
  /** Who is looking, so the panel can tell whether this case is theirs. */
  viewerId?: string | null;
  role?: "analyst" | "manager" | null;
```

Destructure all three in the signature. **Do not call `useAuth()` inside this page.** `role` already reaches `WorkspacePage` as a prop from `App.tsx:123`, and the demo routes plus every existing test in `CaseWorkspacePage.test.tsx` render this component with no `AuthProvider` above it — a hook call here would throw in all of them.

Replace the `StepNotBuiltState` block at line 218 with:

```tsx
            {/* Report has no producer at any stage; decision now does. Narrowing this rather
                than deleting it keeps the distinction the state was built to make: "not
                started" is a claim about the case, "not built" is a claim about the software. */}
            {!analysisFailed && analysisHasBegun && step === "report" && (
              <StepNotBuiltState step={step} stage={caseItem.stageId} risk={caseItem.risk} />
            )}
            {!analysisFailed && analysisHasBegun && step === "decision" && (
              <DecisionPanel
                caseItem={caseItem}
                viewerId={viewerId ?? null}
                role={role ?? null}
                decisionService={decisionService}
                activityService={activityService}
                memberNames={memberNames}
                onDecided={() => setRetryKey((current) => current + 1)}
              />
            )}
```

`setRetryKey` already exists at line 60 and re-runs the case load, which is what re-reads the new status. Confirm the load effect depends on `retryKey` before relying on it; if it does not, add it to the dependency array.

- [ ] **Step 4: Wire the app**

In `src/app/App.tsx`, build the service beside the others (following the `memberService` memo at line 62) and pass it to the route at line 117:

```ts
  const decisionService = useMemo(() => workspaceId && client
    ? createSentinelDecisionService(client, { workspaceId })
    : null, [client, workspaceId]);
```

Use whichever client variable the neighbouring services use — match `activityService`'s construction exactly rather than introducing a new client.

`App.tsx:49` already destructures `user` and `role` from `useAuth()`, so both are in scope:

```tsx
        <Route path="/cases/:caseId/:step" element={<CaseWorkspacePage investigationService={investigationService} uploadService={uploadService} activityService={activityService} analysisService={analysisService} agentRunService={agentRunService} decisionService={decisionService} memberNames={memberNames} viewerId={user?.id ?? null} role={role} />} />
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run src/pages/CaseWorkspacePage.test.tsx && npx tsc -b`
Expected: PASS, `tsc` clean.

- [ ] **Step 6: Run the whole suite**

Run: `npm test`
Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add src/pages/CaseWorkspacePage.tsx src/pages/CaseWorkspacePage.test.tsx src/app/App.tsx
git commit -F - <<'EOF'
Put the decision step behind a decision instead of an apology

StepNotBuiltState narrows to report rather than being deleted, because the
distinction it was built to make still holds: "analysis not started" is a claim
about the case, "not built" is a claim about the software, and report is still
the latter. A case awaiting import falls through to the former on this step,
unchanged.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
```

---

### Task 7: The handoff, end to end

**Files:**
- Modify: `tests/workspace.spec.ts`

**Interfaces:**
- Consumes: everything above.
- Produces: nothing.

This is the only test that drives the two roles through the real UI. It seeds and deletes its own case for the same reason Task 2 does.

- [ ] **Step 1: Write the failing test**

Add at the end of `tests/workspace.spec.ts`. It needs the service role to seed, so import `requireServiceRoleKey` from `./env` and add an `adminRest` helper matching the one in `tests/decisions.spec.ts` if the file has none.

```ts
test.describe("deciding a case", () => {
  test.use({ storageState: storageStatePath("analyst") });

  test("an analyst recommends and a manager approves", async ({ page, browser }) => {
    await page.goto("/cases");
    await page.getByRole("heading", { name: "Cases" }).waitFor();
    const analystToken = await accessToken(page);
    const analystId = subjectOf(analystToken);
    const workspaceId = (await restRequest(analystToken, "sentinel_members?select=workspace_id&limit=1")).body[0].workspace_id;

    // Seeded rather than borrowed: a decision advances status and appends events, so running
    // this against a case from the shared backlog would leave it decided for every later run.
    const seeded = await seedDecidableCase({ workspaceId, ownerId: analystId });

    try {
      await page.goto(`/cases/${seeded.reference}/decision`);
      await expect(page.getByRole("heading", { name: "Decision record" })).toBeVisible();

      await page.getByRole("button", { name: /recommend approve/i }).click();
      await page.getByRole("textbox", { name: /rationale/i })
        .fill("Outlier is the annual settlement, confirmed against the ledger.");
      await page.getByRole("button", { name: /^record decision$/i }).click();

      // Assert the positive before any absence: this proves the panel re-rendered on real
      // data, which is what makes the missing-button check below mean anything.
      await expect(page.getByText("Pending approval")).toBeVisible();
      await expect(page.getByText("Outlier is the annual settlement, confirmed against the ledger.")).toBeVisible();
      await expect(page.getByRole("button", { name: /recommend approve/i })).toHaveCount(0);

      const managerContext = await browser.newContext({ storageState: storageStatePath("manager") });
      try {
        const managerPage = await managerContext.newPage();
        await managerPage.goto(`/cases/${seeded.reference}/decision`);
        await expect(managerPage.getByRole("heading", { name: "Decision record" })).toBeVisible();
        await expect(managerPage.getByText("Outlier is the annual settlement, confirmed against the ledger.")).toBeVisible();

        await managerPage.getByRole("button", { name: /^approve$/i }).click();
        await managerPage.getByRole("textbox", { name: /rationale/i }).fill("Ledger checks out. Approved.");
        await managerPage.getByRole("button", { name: /^record decision$/i }).click();

        await expect(managerPage.getByText("Approved")).toBeVisible();

        // The workspace feed carries it too, with both sets of words.
        await managerPage.goto("/activity");
        await expect(managerPage.getByText("Ledger checks out. Approved.")).toBeVisible();
      } finally {
        await managerContext.close();
      }
    } finally {
      await removeSeededCase(seeded.id);
    }
  });
});
```

Write `seedDecidableCase` and `removeSeededCase` as service-role helpers in this file, mirroring `seedCase` and `removeCase` from `tests/decisions.spec.ts` — one investigation owned by the analyst, one upload row, `INV-E2E`-prefixed reference — and returning `{ id, reference }`. `removeSeededCase` deletes activity events first, because `investigation_id` is `on delete set null`.

- [ ] **Step 2: Run it**

Run: `npx playwright test tests/workspace.spec.ts -g "recommends and a manager approves"`
Expected: PASS.

If the manager sees no Approve button, check `role` is reaching `CaseWorkspacePage` — a manager promotion does not reflect in a live session until the token refreshes, and the storage state was captured at setup time.

- [ ] **Step 3: Run both live suites**

Run: `npm run test:e2e`
Expected: all green, including the pre-existing tests.

Then confirm nothing was left behind:

```sql
select count(*) from public.sentinel_investigations where reference like 'INV-E2E%' or reference like 'INV-DEC%';
```

Expected: `0`.

- [ ] **Step 4: Commit**

```bash
git add tests/workspace.spec.ts
git commit -F - <<'EOF'
Walk one case from a recommendation to an approval, in a real browser

Seeded rather than borrowed. The stage filter test could read whatever the
shared backlog held because reading changes nothing; a decision advances status
and appends events, so borrowing a case here would leave it decided for every
later run of this suite.

Positive assertions come before the absence: the recommendation and its
rationale must be on screen before the missing Recommend button proves
anything, since toHaveCount(0) is satisfied instantly by a page that has not
rendered.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
```

---

### Task 8: Record what was left

**Files:**
- Create: `docs/superpowers/follow-ups/2026-08-10-case-decision.md`

**Interfaces:**
- Consumes: everything observed while building.
- Produces: nothing.

- [ ] **Step 1: Write the note**

Follow the shape of `docs/superpowers/follow-ups/2026-08-10-case-risk-and-stage.md`: a `**Covers:**` line with the commit range, then **Should fix soon**, **Known gaps, accepted**, **Traps worth not rediscovering**, **Closed since the last note**.

It must carry, at minimum:

- **`invite-member` is still serving its `_6` build.** Three notes have now said so. Check whether it is still true and say which, rather than letting it drop a fourth time.
- **The two unrated fraud-pattern findings**, if still unrated — carried from the risk-and-stage note.
- **The one-manager deadlock**, under accepted gaps, with the reasoning: separation of duties is not satisfiable by one person, and the panel says so rather than failing on click.
- **`approved` and `closed` are not terminal**, under accepted gaps, with why freezing them was rejected.
- Whatever the build actually turned up. The prior notes are worth reading for tone: each entry says what was seen, what was decided, and what would change the decision.

- [ ] **Step 2: Verify the whole thing one more time**

```bash
npx tsc -b && npm test && npm run test:e2e
```

Expected: `tsc` clean, all unit tests green, all Playwright tests green. Record the actual counts in the note's header rather than a claim that they passed.

- [ ] **Step 3: Commit and push**

```bash
git add docs/superpowers/follow-ups/2026-08-10-case-decision.md
git commit -F - <<'EOF'
Record the decision follow-ups

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
git push -u origin case-decision
```

---

## Self-Review

**Spec coverage.** Every section of `2026-08-10-case-decision-design.md` maps to a task: the state machine and the RPC to Task 1, the nine guards to Tasks 1–2, the event types and rationale plumbing to Task 3, the storage decision to Tasks 1 and 3, the three-axis model to Task 3 (`CaseStage` untouched) and Task 6, the panel table to Task 5, the two plumbing changes to Tasks 4 and 6, data flow to Tasks 4–6, and the three testing tiers to Tasks 2, 3–6, and 7. Both spec risks are addressed rather than inherited — seeded disposable cases in Tasks 2 and 7 for the first, `select … for update` in Task 1 for the second.

**Type consistency.** `DecisionAction`, `CaseStatus`, and `SentinelDecisionService` are defined once in Task 4 and used unchanged in Tasks 5 and 6. `record(investigationId, action, rationale)` keeps that argument order everywhere. `ownerId` is the name in the domain type, the mapper, and the panel. The four event types and five action strings are spelled identically in the SQL, the tests, the messages, and the panel.

**Known soft spots**, flagged rather than hidden: Task 4 Step 6 and Task 6 Step 1 adapt to helpers in existing test files this plan does not reproduce, so the implementer must read those files first. Task 3 Step 7's CSS custom property names must be checked against `global.css` before use.
