-- A case can now report a risk it earned and a stage it reached.
--
-- Until now mapRow returned 'not-assessed' and 'not-started' for every investigation, so a
-- case holding four findings from two agents still read as unexamined. Both values now come
-- from what the producers recorded.
--
-- severity is nullable on purpose. null means no producer rated this finding — a different
-- statement from 'low' — and two AI findings predating this migration are exactly that.

alter table public.sentinel_findings
  add column severity text
  check (severity in ('low', 'medium', 'high'));

comment on column public.sentinel_findings.severity is
  'How much the finding matters, as opposed to confidence, which is whether it is real. Null means no producer rated it.';

/**
 * Persists one producer's findings (and their evidence) for one upload, and completes
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
      workspace_id, investigation_id, upload_id, agent_key, rule, agent, summary, confidence, severity
    ) values (
      p_workspace_id,
      p_investigation_id,
      p_upload_id,
      p_agent_key,
      finding ->> 'rule',
      finding ->> 'agent',
      finding ->> 'summary',
      coalesce((finding ->> 'confidence')::numeric, 1),
      nullif(finding ->> 'severity', '')
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
 * Rate the findings that predate the column, from magnitudes the record still holds.
 *
 * Nothing here is invented. A duplicate group's size *is* its supporting evidence count,
 * one evidence row per member. A missing-amount finding's affected count is likewise its
 * evidence count, over the upload's own row_count. The outlier multiple survives only in
 * the summary the rules themselves wrote, in a format those rules control — and where the
 * pattern does not match, severity stays null rather than falling back to a guess.
 *
 * Scoped to agent_key = 'deterministic': the two fraud-pattern findings on record were
 * never asked for a severity, and no column can reconstruct one. They stay null until that
 * agent next runs.
 *
 * Idempotent through `severity is null` — re-running rates nothing and overwrites nothing.
 */
update public.sentinel_findings as f
set severity = case f.rule
    when 'duplicate-amount' then
      case when evidence.count >= 3 then 'high' else 'medium' end
    when 'outlier-amount' then
      case
        when substring(f.summary from '([0-9]+)x the median') is null then null
        when (substring(f.summary from '([0-9]+)x the median'))::integer >= 10 then 'high'
        else 'medium'
      end
    when 'missing-amount' then
      case
        when coalesce(upload.row_count, 0) = 0 then null
        when evidence.count::numeric / upload.row_count >= 0.1 then 'medium'
        else 'low'
      end
  end
from public.sentinel_uploads as upload,
  lateral (
    select count(*) as count
    from public.sentinel_evidence as e
    where e.finding_id = f.id and e.relevance = 'supporting'
  ) as evidence
where upload.id = f.upload_id
  and f.severity is null
  and f.agent_key = 'deterministic';

/**
 * Risk and stage, derived where the rows are.
 *
 * security_invoker, following sentinel_manager_roster: RLS on the underlying tables applies
 * as the calling user, so this view adds no new reach.
 *
 * The aggregation lives here rather than in the browser because deriving risk client-side
 * means reading workspace-wide findings, and that read is capped at DEFAULT_FINDING_LIMIT
 * with no paging. A case whose risk changed because its findings fell off the end of a
 * capped read would be a worse bug than the one this migration fixes.
 */
create view public.sentinel_investigation_queue
with (security_invoker = true)
as
select
  i.id,
  i.workspace_id,
  i.reference,
  i.entity,
  i.owner_id,
  i.status,
  i.created_at,
  i.updated_at,
  -- Highest severity on record. Null severities are ignored rather than counted as low, so
  -- 'not-assessed' means nothing was rated — including a case whose agents found nothing.
  case
    when bool_or(severity_of.finding = 'high') then 'high'
    when bool_or(severity_of.finding = 'medium') then 'medium'
    when bool_or(severity_of.finding = 'low') then 'low'
    else 'not-assessed'
  end as risk,
  -- First match wins. Written over uploads *lacking* a complete run rather than over runs in
  -- a non-complete state, because an upload can legitimately have no run row yet — parse-upload
  -- seeds them, so a case opened during a parse sits in exactly that gap. Phrased the other
  -- way it would match nothing until 'analysed' and claim to be finished.
  case
    when pipeline.uploads = 0 then 'awaiting-import'
    when pipeline.running > 0 then 'analysing'
    when pipeline.failed > 0 then 'analysis-failed'
    when pipeline.awaiting_deterministic > 0 then 'awaiting-analysis'
    when pipeline.awaiting_fraud_pattern > 0 then 'fraud-review'
    else 'analysed'
  end as stage
from public.sentinel_investigations as i
left join lateral (
  select f.severity as finding
  from public.sentinel_findings as f
  where f.investigation_id = i.id
) as severity_of on true
left join lateral (
  select
    count(*) as uploads,
    count(*) filter (where runs.running > 0) as running,
    count(*) filter (where runs.failed > 0) as failed,
    count(*) filter (where runs.deterministic_complete = 0) as awaiting_deterministic,
    count(*) filter (where runs.fraud_pattern_complete = 0) as awaiting_fraud_pattern
  from public.sentinel_uploads as u
  cross join lateral (
    select
      count(*) filter (where r.status = 'running') as running,
      count(*) filter (where r.status = 'failed') as failed,
      count(*) filter (where r.agent_key = 'deterministic' and r.status = 'complete') as deterministic_complete,
      count(*) filter (where r.agent_key = 'fraud-pattern' and r.status = 'complete') as fraud_pattern_complete
    from public.sentinel_agent_runs as r
    where r.upload_id = u.id
  ) as runs
  where u.investigation_id = i.id
) as pipeline on true
group by i.id, i.workspace_id, i.reference, i.entity, i.owner_id, i.status, i.created_at, i.updated_at,
  pipeline.uploads, pipeline.running, pipeline.failed, pipeline.awaiting_deterministic,
  pipeline.awaiting_fraud_pattern;

revoke all on table public.sentinel_investigation_queue from public, anon, authenticated;
grant select on table public.sentinel_investigation_queue to authenticated;
