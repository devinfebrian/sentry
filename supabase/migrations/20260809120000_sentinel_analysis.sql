-- Findings and their evidence: the first thing this workspace analyses rather than stores.
--
-- Both tables are machine-written only. authenticated may read them; every write goes
-- through sentinel_record_analysis under the parser's processing lease, so a client cannot
-- fabricate a finding about its own data.

create table public.sentinel_findings (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.sentinel_workspaces(id) on delete cascade,
  investigation_id uuid not null references public.sentinel_investigations(id) on delete cascade,
  upload_id uuid not null references public.sentinel_uploads(id) on delete cascade,
  rule text not null check (rule in ('duplicate-amount', 'outlier-amount', 'missing-amount')),
  agent text not null,
  summary text not null,
  -- 1 for a deterministic observation. Kept because agents will need the range.
  confidence numeric not null default 1 check (confidence >= 0 and confidence <= 1),
  created_at timestamptz not null default now(),
  constraint sentinel_findings_workspace_id_key unique (workspace_id, id),
  constraint sentinel_findings_workspace_investigation_fkey
    foreign key (workspace_id, investigation_id)
    references public.sentinel_investigations (workspace_id, id)
    on delete cascade,
  constraint sentinel_findings_workspace_upload_fkey
    foreign key (workspace_id, upload_id)
    references public.sentinel_uploads (workspace_id, id)
    on delete cascade
);

create table public.sentinel_evidence (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.sentinel_workspaces(id) on delete cascade,
  investigation_id uuid not null references public.sentinel_investigations(id) on delete cascade,
  finding_id uuid not null references public.sentinel_findings(id) on delete cascade,
  -- Matches sentinel_import_rows: row 1 is the header, so data starts at 2.
  source_row integer not null check (source_row >= 2),
  source_label text not null,
  claim text not null,
  relevance text not null check (relevance in ('supporting', 'contradictory', 'context')),
  state text not null default 'unreviewed' check (state in ('unreviewed', 'reviewed', 'supports', 'contradicts')),
  created_at timestamptz not null default now(),
  constraint sentinel_evidence_workspace_finding_fkey
    foreign key (workspace_id, finding_id)
    references public.sentinel_findings (workspace_id, id)
    on delete cascade
);

create index sentinel_findings_workspace_investigation_idx
  on public.sentinel_findings (workspace_id, investigation_id);
create index sentinel_findings_workspace_upload_idx
  on public.sentinel_findings (workspace_id, upload_id);
create index sentinel_evidence_finding_idx
  on public.sentinel_evidence (finding_id);
create index sentinel_evidence_workspace_investigation_idx
  on public.sentinel_evidence (workspace_id, investigation_id);

revoke all on table public.sentinel_findings from public, anon, authenticated;
revoke all on table public.sentinel_evidence from public, anon, authenticated;
grant select on table public.sentinel_findings to authenticated;
grant select on table public.sentinel_evidence to authenticated;
grant all on table public.sentinel_findings to service_role;
grant all on table public.sentinel_evidence to service_role;

alter table public.sentinel_findings enable row level security;
alter table public.sentinel_evidence enable row level security;

create policy "sentinel findings are readable by active members"
  on public.sentinel_findings
  for select
  to authenticated
  using (private.sentinel_is_active_member(workspace_id));

create policy "sentinel evidence is readable by active members"
  on public.sentinel_evidence
  for select
  to authenticated
  using (private.sentinel_is_active_member(workspace_id));

-- Analysis joins the audit vocabulary, so the activity feed shows it like everything else.
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
    'analysis-completed'
  ));

/**
 * Replaces the analysis for one upload in a single transaction, so a re-run can never
 * leave a half-updated set. Guarded by the same processing lease sentinel_finalize_upload
 * uses: whoever no longer owns the lease no longer owns the findings.
 */
create or replace function public.sentinel_record_analysis(
  p_upload_id uuid,
  p_workspace_id uuid,
  p_investigation_id uuid,
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

  -- Evidence cascades from findings, so one delete clears the previous run.
  delete from public.sentinel_findings as existing
  where existing.upload_id = p_upload_id
    and existing.workspace_id = p_workspace_id;

  for finding in select * from jsonb_array_elements(coalesce(p_findings, '[]'::jsonb)) loop
    insert into public.sentinel_findings (
      workspace_id, investigation_id, upload_id, rule, agent, summary, confidence
    ) values (
      p_workspace_id,
      p_investigation_id,
      p_upload_id,
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

  insert into public.sentinel_activity_events (
    workspace_id, investigation_id, actor_id, event_type, metadata
  ) values (
    p_workspace_id,
    p_investigation_id,
    p_actor_id,
    'analysis-completed',
    jsonb_build_object('upload_id', p_upload_id::text, 'findingCount', finding_total, 'evidenceCount', evidence_total)
  );

  return jsonb_build_object('findingCount', finding_total, 'evidenceCount', evidence_total);
end;
$function$;

revoke execute on function public.sentinel_record_analysis(uuid, uuid, uuid, jsonb, uuid) from public, anon, authenticated;
grant execute on function public.sentinel_record_analysis(uuid, uuid, uuid, jsonb, uuid) to service_role;
