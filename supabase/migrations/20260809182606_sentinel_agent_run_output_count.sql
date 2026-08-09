-- A failed run must not claim the findings it left behind were zero.
--
-- sentinel_start_agent_run reset output_count to 0 whenever a run started. On success that
-- was immediately overwritten by the real count, so it was invisible — but a run that
-- started and then failed kept the zero, and the pipeline showed "0 outputs" on a stage
-- whose findings were still sitting in the ledger, untouched. The number contradicted the
-- screen next to it.
--
-- Removing the reset makes output_count mean "findings currently attributable to this
-- agent for this upload", which is exactly what it is: sentinel_record_analysis replaces
-- that agent's findings and sets the count in one transaction, so the two cannot drift.
-- A brand-new run still starts at 0 through the INSERT, because no findings exist yet.
--
-- Function body only — the signature is unchanged, so no Edge Function redeploy is needed.

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
      -- output_count deliberately untouched: it still describes the findings this agent
      -- has on record, which remain readable while the re-run is in flight and survive it
      -- if the re-run fails.
      failure_reason = null;

  return jsonb_build_object('status', 'running');
end;
$function$;

revoke execute on function public.sentinel_start_agent_run(uuid, uuid, uuid, text, integer) from public, anon, authenticated;
grant execute on function public.sentinel_start_agent_run(uuid, uuid, uuid, text, integer) to service_role;
