-- Give already-parsed uploads a pipeline, without inventing history.
--
-- Run rows only existed from the multi-agent migration forward, so every upload parsed
-- before it had no pipeline at all — and therefore no way to reach either agent, because
-- the Run agent action lives on a stage. The feature was unreachable on every piece of
-- existing data.
--
-- Worse, three uploads had findings and no run, so the same case said "Analysis not
-- started" on its summary while listing three findings one step away. A case is not allowed
-- to contradict itself.
--
-- Every value below is recorded fact rather than a plausible-looking guess:
--
--   * The deterministic rules ran for an upload exactly when an 'analysis-completed' event
--     was written for it. That event also carries the timestamp, so completed_at is read
--     from the audit trail rather than approximated by now().
--   * Uploads with no such event were parsed before analysis existed. They are seeded
--     'waiting', which is what they are: no run has been recorded.
--   * started_at stays null everywhere. Nothing ever recorded a start, and back-dating one
--     to make a row look complete is the fabrication this codebase keeps removing.
--   * The fraud-pattern agent has never run for any of these, so it is always 'waiting'.
--
-- Idempotent through the ON CONFLICT: re-running seeds nothing and overwrites nothing.

insert into public.sentinel_agent_runs (
  workspace_id,
  investigation_id,
  upload_id,
  agent_key,
  status,
  completed_at,
  input_count,
  output_count
)
select
  upload.workspace_id,
  upload.investigation_id,
  upload.id,
  agent.agent_key,
  case
    when agent.agent_key = 'deterministic' and analysis.completed_at is not null then 'complete'
    else 'waiting'
  end,
  case when agent.agent_key = 'deterministic' then analysis.completed_at end,
  -- The inline pass read every row the parse persisted.
  case
    when agent.agent_key = 'deterministic' and analysis.completed_at is not null then upload.row_count
    else 0
  end,
  case
    when agent.agent_key = 'deterministic' and analysis.completed_at is not null then coalesce(finding.total, 0)
    else 0
  end
from public.sentinel_uploads as upload
cross join (values ('deterministic'), ('fraud-pattern')) as agent(agent_key)
left join lateral (
  select max(event.created_at) as completed_at
  from public.sentinel_activity_events as event
  where event.event_type = 'analysis-completed'
    and event.metadata ->> 'upload_id' = upload.id::text
) as analysis on true
left join lateral (
  select count(*) as total
  from public.sentinel_findings as existing
  where existing.upload_id = upload.id
    and existing.agent_key = 'deterministic'
) as finding on true
where upload.status = 'parsed'
on conflict (upload_id, agent_key) do nothing;
