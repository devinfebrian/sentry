-- Analysis becomes multi-producer, observable, and re-runnable.
--
-- Until now exactly one producer wrote findings: the deterministic rules, inline inside
-- parse-upload, with a delete that cleared the whole upload. Three things change here so a
-- second producer (an AI investigator) can write alongside it without erasing it:
--
--   1. Findings carry an agent_key, and the rule CHECK gives way to an agent_key CHECK.
--   2. sentinel_record_analysis scopes its delete to one agent, so each producer is
--      independently idempotent.
--   3. sentinel_agent_runs records what each producer is doing, so a slow or failed agent
--      has somewhere to say so instead of vanishing into a swallowed exception.
--
-- Note on leases: unlike sentinel_finalize_upload, nothing here takes the parser's
-- processing lease. Analysis runs after the parse has finished and released it — the upload
-- is 'parsed' by then — so these functions verify the upload exists in the workspace and
-- stop there.

-- --------------------------------------------------------------------------------------
-- 1. Findings gain a producer
-- --------------------------------------------------------------------------------------

-- Every finding that exists today came from the deterministic rules, so the default
-- backfills them truthfully. It is dropped immediately: new writers must say who they are.
alter table public.sentinel_findings
  add column agent_key text not null default 'deterministic';

alter table public.sentinel_findings
  alter column agent_key drop default;

/**
 * The producer set is constrained; the rule name no longer is.
 *
 * Dropping sentinel_findings_rule_check gives up database-level validation of the three
 * deterministic rule names — a deliberate trade. An AI producer's rule slugs cannot be
 * enumerated ahead of time, and a CHECK listing both producers' vocabularies would have to
 * be migrated every time either one learned a new pattern. The deterministic rules are
 * still constrained where they are actually produced, by the AnalysisRule union in
 * _shared/analysis.ts. What must be constrained here is agent_key, because the delete
 * scoping below depends on it: an unrecognised agent_key would silently own no findings.
 */
alter table public.sentinel_findings
  drop constraint sentinel_findings_rule_check;

alter table public.sentinel_findings
  add constraint sentinel_findings_agent_key_check
  check (agent_key in ('deterministic', 'fraud-pattern'));

-- The delete below matches on all three columns; the old two-column index is a prefix of
-- this one and has nothing left to do.
create index sentinel_findings_workspace_upload_agent_idx
  on public.sentinel_findings (workspace_id, upload_id, agent_key);

drop index public.sentinel_findings_workspace_upload_idx;

-- --------------------------------------------------------------------------------------
-- 2. Agent runs: what each producer is doing, and why it stopped
-- --------------------------------------------------------------------------------------

create table public.sentinel_agent_runs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.sentinel_workspaces(id) on delete cascade,
  investigation_id uuid not null references public.sentinel_investigations(id) on delete cascade,
  upload_id uuid not null references public.sentinel_uploads(id) on delete cascade,
  agent_key text not null check (agent_key in ('deterministic', 'fraud-pattern')),
  status text not null default 'waiting' check (status in ('waiting', 'running', 'complete', 'failed')),
  failure_reason text,
  -- Rows the producer was given, and findings it returned. Both stay 0 until it runs.
  input_count integer not null default 0 check (input_count >= 0),
  output_count integer not null default 0 check (output_count >= 0),
  created_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  -- One run per producer per upload. A re-run updates this row rather than accumulating
  -- history, which is what makes the pipeline readable and re-running idempotent.
  constraint sentinel_agent_runs_upload_agent_key
    unique (upload_id, agent_key),
  /**
   * A failed run must say why, and a run that did not fail must not carry a reason.
   * The design spec requires failure to be explained in plain language rather than
   * signalled by colour; this is that requirement written where it cannot be forgotten.
   */
  constraint sentinel_agent_runs_failure_reason_check
    check ((status = 'failed') = (failure_reason is not null)),
  constraint sentinel_agent_runs_workspace_investigation_fkey
    foreign key (workspace_id, investigation_id)
    references public.sentinel_investigations (workspace_id, id)
    on delete cascade,
  constraint sentinel_agent_runs_workspace_upload_fkey
    foreign key (workspace_id, upload_id)
    references public.sentinel_uploads (workspace_id, id)
    on delete cascade
);

create index sentinel_agent_runs_workspace_investigation_idx
  on public.sentinel_agent_runs (workspace_id, investigation_id);

revoke all on table public.sentinel_agent_runs from public, anon, authenticated;
grant select on table public.sentinel_agent_runs to authenticated;
grant all on table public.sentinel_agent_runs to service_role;

alter table public.sentinel_agent_runs enable row level security;

create policy "sentinel agent runs are readable by active members"
  on public.sentinel_agent_runs
  for select
  to authenticated
  using (private.sentinel_is_active_member(workspace_id));

-- --------------------------------------------------------------------------------------
-- 3. Analysis joins the audit vocabulary on the failure side too
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
    'analysis-failed'
  ));

-- --------------------------------------------------------------------------------------
-- 4. Run lifecycle
-- --------------------------------------------------------------------------------------

/**
 * Seeds one waiting run per producer, so the pipeline shows every agent the moment an
 * upload parses rather than materialising stages as they happen to start. Called once by
 * parse-upload. Idempotent: a re-parse leaves existing runs alone.
 */
create or replace function public.sentinel_seed_agent_runs(
  p_upload_id uuid,
  p_workspace_id uuid,
  p_investigation_id uuid,
  p_agent_keys text[]
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  seeded integer := 0;
begin
  if not exists (
    select 1 from public.sentinel_uploads as upload
    where upload.id = p_upload_id
      and upload.workspace_id = p_workspace_id
      and upload.investigation_id = p_investigation_id
  ) then
    raise exception using errcode = 'P0002', message = 'Upload not found.';
  end if;

  insert into public.sentinel_agent_runs (
    workspace_id, investigation_id, upload_id, agent_key, status
  )
  select p_workspace_id, p_investigation_id, p_upload_id, agent_key, 'waiting'
  from unnest(coalesce(p_agent_keys, array[]::text[])) as agent_key
  on conflict (upload_id, agent_key) do nothing;

  get diagnostics seeded = row_count;
  return seeded;
end;
$function$;

/**
 * Marks a producer running. Clears any failure_reason from a previous attempt — the
 * CHECK constraint requires that, and a retry that kept the old reason would be lying
 * about the run currently in flight.
 */
create or replace function public.sentinel_start_agent_run(
  p_upload_id uuid,
  p_workspace_id uuid,
  p_investigation_id uuid,
  p_agent_key text,
  p_input_count integer
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
begin
  insert into public.sentinel_agent_runs (
    workspace_id, investigation_id, upload_id, agent_key,
    status, started_at, input_count, output_count, failure_reason
  )
  values (
    p_workspace_id, p_investigation_id, p_upload_id, p_agent_key,
    'running', now(), coalesce(p_input_count, 0), 0, null
  )
  on conflict (upload_id, agent_key) do update
  set status = 'running',
      started_at = now(),
      completed_at = null,
      input_count = coalesce(p_input_count, 0),
      output_count = 0,
      failure_reason = null;

  return jsonb_build_object('status', 'running');
end;
$function$;

-- --------------------------------------------------------------------------------------
-- 5. Recording analysis, scoped to one producer
-- --------------------------------------------------------------------------------------

-- The argument list changes, so this is a new function rather than a replacement. Drop the
-- single-producer version explicitly; leaving it callable would leave a path that still
-- deletes every agent's findings.
drop function if exists public.sentinel_record_analysis(uuid, uuid, uuid, jsonb, uuid);

/**
 * Replaces one producer's analysis for one upload in a single transaction, and completes
 * that producer's run in the same breath — findings, run status, and the audit event
 * cannot disagree with each other because nothing can land between them.
 *
 * The delete is scoped by agent_key. That scoping is the whole point of this migration:
 * re-running the AI investigator must not erase what the deterministic rules proved.
 */
create or replace function public.sentinel_record_analysis(
  p_upload_id uuid,
  p_workspace_id uuid,
  p_investigation_id uuid,
  p_agent_key text,
  p_findings jsonb,
  p_actor_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  finding jsonb;
  evidence jsonb;
  new_finding_id uuid;
  finding_total integer := 0;
  evidence_total integer := 0;
begin
  if not exists (
    select 1 from public.sentinel_uploads as upload
    where upload.id = p_upload_id
      and upload.workspace_id = p_workspace_id
      and upload.investigation_id = p_investigation_id
  ) then
    raise exception using errcode = 'P0002', message = 'Upload not found.';
  end if;

  -- Evidence cascades from findings, so one delete clears this producer's previous run.
  delete from public.sentinel_findings as existing
  where existing.upload_id = p_upload_id
    and existing.workspace_id = p_workspace_id
    and existing.agent_key = p_agent_key;

  for finding in select * from jsonb_array_elements(coalesce(p_findings, '[]'::jsonb)) loop
    insert into public.sentinel_findings (
      workspace_id, investigation_id, upload_id, agent_key, rule, agent, summary, confidence
    ) values (
      p_workspace_id,
      p_investigation_id,
      p_upload_id,
      p_agent_key,
      finding ->> 'rule',
      finding ->> 'agent',
      finding ->> 'summary',
      coalesce((finding ->> 'confidence')::numeric, 1)
    )
    returning id into new_finding_id;

    finding_total := finding_total + 1;

    for evidence in select * from jsonb_array_elements(coalesce(finding -> 'evidence', '[]'::jsonb)) loop
      insert into public.sentinel_evidence (
        workspace_id, investigation_id, finding_id, source_row, source_label, claim, relevance
      ) values (
        p_workspace_id,
        p_investigation_id,
        new_finding_id,
        (evidence ->> 'sourceRow')::integer,
        evidence ->> 'sourceLabel',
        evidence ->> 'claim',
        evidence ->> 'relevance'
      );

      evidence_total := evidence_total + 1;
    end loop;
  end loop;

  insert into public.sentinel_agent_runs (
    workspace_id, investigation_id, upload_id, agent_key,
    status, completed_at, output_count, failure_reason
  )
  values (
    p_workspace_id, p_investigation_id, p_upload_id, p_agent_key,
    'complete', now(), finding_total, null
  )
  on conflict (upload_id, agent_key) do update
  set status = 'complete',
      completed_at = now(),
      output_count = finding_total,
      failure_reason = null;

  insert into public.sentinel_activity_events (
    workspace_id, investigation_id, actor_id, event_type, metadata
  ) values (
    p_workspace_id,
    p_investigation_id,
    p_actor_id,
    'analysis-completed',
    jsonb_build_object(
      'upload_id', p_upload_id::text,
      'agentKey', p_agent_key,
      'findingCount', finding_total,
      'evidenceCount', evidence_total
    )
  );

  return jsonb_build_object('findingCount', finding_total, 'evidenceCount', evidence_total);
end;
$function$;

/**
 * Records that one producer failed, with a reason a reader can act on.
 *
 * Findings from a previous successful run are deliberately left in place: a failed re-run
 * does not retract what was already proved, and erasing it would make a transient API
 * outage look like a retraction of evidence.
 */
create or replace function public.sentinel_fail_analysis(
  p_upload_id uuid,
  p_workspace_id uuid,
  p_investigation_id uuid,
  p_agent_key text,
  p_actor_id uuid,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  failure_message text := coalesce(nullif(trim(p_reason), ''), 'Analysis failed. You can retry this agent.');
begin
  if not exists (
    select 1 from public.sentinel_uploads as upload
    where upload.id = p_upload_id
      and upload.workspace_id = p_workspace_id
      and upload.investigation_id = p_investigation_id
  ) then
    raise exception using errcode = 'P0002', message = 'Upload not found.';
  end if;

  insert into public.sentinel_agent_runs (
    workspace_id, investigation_id, upload_id, agent_key,
    status, completed_at, failure_reason
  )
  values (
    p_workspace_id, p_investigation_id, p_upload_id, p_agent_key,
    'failed', now(), failure_message
  )
  on conflict (upload_id, agent_key) do update
  set status = 'failed',
      completed_at = now(),
      failure_reason = failure_message;

  insert into public.sentinel_activity_events (
    workspace_id, investigation_id, actor_id, event_type, metadata
  ) values (
    p_workspace_id,
    p_investigation_id,
    p_actor_id,
    'analysis-failed',
    jsonb_build_object(
      'upload_id', p_upload_id::text,
      'agentKey', p_agent_key,
      'reason', failure_message
    )
  );

  return jsonb_build_object('status', 'failed', 'reason', failure_message);
end;
$function$;

-- --------------------------------------------------------------------------------------
-- 6. Grants — every one of these is machine-written only
-- --------------------------------------------------------------------------------------

revoke execute on function public.sentinel_seed_agent_runs(uuid, uuid, uuid, text[]) from public, anon, authenticated;
revoke execute on function public.sentinel_start_agent_run(uuid, uuid, uuid, text, integer) from public, anon, authenticated;
revoke execute on function public.sentinel_record_analysis(uuid, uuid, uuid, text, jsonb, uuid) from public, anon, authenticated;
revoke execute on function public.sentinel_fail_analysis(uuid, uuid, uuid, text, uuid, text) from public, anon, authenticated;

grant execute on function public.sentinel_seed_agent_runs(uuid, uuid, uuid, text[]) to service_role;
grant execute on function public.sentinel_start_agent_run(uuid, uuid, uuid, text, integer) to service_role;
grant execute on function public.sentinel_record_analysis(uuid, uuid, uuid, text, jsonb, uuid) to service_role;
grant execute on function public.sentinel_fail_analysis(uuid, uuid, uuid, text, uuid, text) to service_role;
