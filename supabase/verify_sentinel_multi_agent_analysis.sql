-- Verifies 20260809174332_sentinel_multi_agent_analysis.sql against a live database.
--
-- Function lookups are signature-qualified and constraint lookups are scoped to their table.
-- The member-management verify script was noted as loose on both counts; this one is not,
-- because the delete-scoping it checks is the difference between two producers coexisting
-- and one silently erasing the other.
--
-- Signatures are matched with oidvectortypes(proargtypes), not
-- pg_get_function_identity_arguments, which on this server returns parameter *names*
-- alongside types ("p_upload_id uuid, ..."). A bare-type comparison against that never
-- matches, so a check written that way passes vacuously whenever it is asserting absence —
-- which is exactly how the "the single-producer version must be dropped" check below
-- initially reported success while testing nothing at all.

do $$
declare
  expected_agent_keys constant text[] := array['deterministic', 'fraud-pattern'];
  agent_key text;
begin
  ------------------------------------------------------------------------------------------
  -- Findings carry a producer
  ------------------------------------------------------------------------------------------

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'sentinel_findings' and column_name = 'agent_key'
      and is_nullable = 'NO'
  ) then
    raise exception 'sentinel_findings.agent_key must exist and be NOT NULL';
  end if;

  -- The default was dropped on purpose: a new writer must name itself rather than inherit
  -- 'deterministic' and quietly file AI findings under the rules.
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'sentinel_findings' and column_name = 'agent_key'
      and column_default is not null
  ) then
    raise exception 'sentinel_findings.agent_key must carry no default';
  end if;

  if exists (
    select 1 from pg_constraint as con
    join pg_class as rel on rel.oid = con.conrelid
    join pg_namespace as ns on ns.oid = rel.relnamespace
    where ns.nspname = 'public' and rel.relname = 'sentinel_findings'
      and con.conname = 'sentinel_findings_rule_check'
  ) then
    raise exception 'sentinel_findings_rule_check must be gone: rule names are producer-scoped now';
  end if;

  if not exists (
    select 1 from pg_constraint as con
    join pg_class as rel on rel.oid = con.conrelid
    join pg_namespace as ns on ns.oid = rel.relnamespace
    where ns.nspname = 'public' and rel.relname = 'sentinel_findings'
      and con.conname = 'sentinel_findings_agent_key_check'
  ) then
    raise exception 'sentinel_findings must constrain agent_key';
  end if;

  ------------------------------------------------------------------------------------------
  -- Agent runs
  ------------------------------------------------------------------------------------------

  if to_regclass('public.sentinel_agent_runs') is null then
    raise exception 'Missing table public.sentinel_agent_runs';
  end if;

  if not exists (
    select 1 from pg_class as rel
    join pg_namespace as ns on ns.oid = rel.relnamespace
    where ns.nspname = 'public' and rel.relname = 'sentinel_agent_runs' and rel.relrowsecurity
  ) then
    raise exception 'sentinel_agent_runs must have row level security enabled';
  end if;

  if has_table_privilege('authenticated', 'public.sentinel_agent_runs', 'INSERT')
    or has_table_privilege('authenticated', 'public.sentinel_agent_runs', 'UPDATE')
    or has_table_privilege('authenticated', 'public.sentinel_agent_runs', 'DELETE') then
    raise exception 'sentinel_agent_runs must be machine-written only';
  end if;

  if not has_table_privilege('authenticated', 'public.sentinel_agent_runs', 'SELECT') then
    raise exception 'active members must be able to read sentinel_agent_runs';
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'sentinel_agent_runs' and cmd = 'SELECT'
      and qual like '%sentinel_is_active_member%'
  ) then
    raise exception 'sentinel_agent_runs SELECT policy must be scoped to active workspace members';
  end if;

  -- One run per producer per upload. Without this a retry appends instead of updating, and
  -- the pipeline shows the same stage several times over.
  if not exists (
    select 1 from pg_constraint as con
    join pg_class as rel on rel.oid = con.conrelid
    join pg_namespace as ns on ns.oid = rel.relnamespace
    where ns.nspname = 'public' and rel.relname = 'sentinel_agent_runs'
      and con.conname = 'sentinel_agent_runs_upload_agent_key' and con.contype = 'u'
  ) then
    raise exception 'sentinel_agent_runs must be unique on (upload_id, agent_key)';
  end if;

  -- A failed run that cannot say why would put an unexplained red stage in front of an
  -- analyst, which is the one thing the design spec rules out.
  if not exists (
    select 1 from pg_constraint as con
    join pg_class as rel on rel.oid = con.conrelid
    join pg_namespace as ns on ns.oid = rel.relnamespace
    where ns.nspname = 'public' and rel.relname = 'sentinel_agent_runs'
      and con.conname = 'sentinel_agent_runs_failure_reason_check' and con.contype = 'c'
  ) then
    raise exception 'sentinel_agent_runs must require a failure_reason exactly when failed';
  end if;

  ------------------------------------------------------------------------------------------
  -- Activity vocabulary
  ------------------------------------------------------------------------------------------

  if not exists (
    select 1 from pg_constraint as con
    join pg_class as rel on rel.oid = con.conrelid
    join pg_namespace as ns on ns.oid = rel.relnamespace
    where ns.nspname = 'public' and rel.relname = 'sentinel_activity_events'
      and con.conname = 'sentinel_activity_events_event_type_check'
      and pg_get_constraintdef(con.oid) like '%analysis-failed%'
  ) then
    raise exception 'sentinel_activity_events must accept analysis-failed';
  end if;

  ------------------------------------------------------------------------------------------
  -- Functions: exact signatures, SECURITY DEFINER, pinned search_path, service_role only
  ------------------------------------------------------------------------------------------

  -- The single-producer version must be gone, not merely superseded: while it exists it is
  -- a callable path whose delete clears every agent's findings for the upload.
  if exists (
    select 1 from pg_proc as proc
    join pg_namespace as ns on ns.oid = proc.pronamespace
    where ns.nspname = 'public' and proc.proname = 'sentinel_record_analysis'
      and oidvectortypes(proc.proargtypes) = 'uuid, uuid, uuid, jsonb, uuid'
  ) then
    raise exception 'The single-producer sentinel_record_analysis(uuid, uuid, uuid, jsonb, uuid) must be dropped';
  end if;

  if not exists (
    select 1 from pg_proc as proc
    join pg_namespace as ns on ns.oid = proc.pronamespace
    where ns.nspname = 'public' and proc.proname = 'sentinel_record_analysis'
      and oidvectortypes(proc.proargtypes) = 'uuid, uuid, uuid, text, jsonb, uuid'
      and proc.prosecdef
      and proc.proconfig @> array['search_path=public, pg_temp']
      -- The scoping this whole migration exists for.
      and pg_get_functiondef(proc.oid) like '%existing.agent_key = p_agent_key%'
  ) then
    raise exception 'sentinel_record_analysis(uuid, uuid, uuid, text, jsonb, uuid) must exist and scope its delete by agent_key';
  end if;

  if not exists (
    select 1 from pg_proc as proc
    join pg_namespace as ns on ns.oid = proc.pronamespace
    where ns.nspname = 'public' and proc.proname = 'sentinel_fail_analysis'
      and oidvectortypes(proc.proargtypes) = 'uuid, uuid, uuid, text, uuid, text'
      and proc.prosecdef
      and proc.proconfig @> array['search_path=public, pg_temp']
  ) then
    raise exception 'sentinel_fail_analysis(uuid, uuid, uuid, text, uuid, text) must exist as SECURITY DEFINER with a pinned search_path';
  end if;

  if not exists (
    select 1 from pg_proc as proc
    join pg_namespace as ns on ns.oid = proc.pronamespace
    where ns.nspname = 'public' and proc.proname = 'sentinel_seed_agent_runs'
      and oidvectortypes(proc.proargtypes) = 'uuid, uuid, uuid, text[]'
      and proc.prosecdef
      and proc.proconfig @> array['search_path=public, pg_temp']
  ) then
    raise exception 'sentinel_seed_agent_runs(uuid, uuid, uuid, text[]) must exist as SECURITY DEFINER with a pinned search_path';
  end if;

  if not exists (
    select 1 from pg_proc as proc
    join pg_namespace as ns on ns.oid = proc.pronamespace
    where ns.nspname = 'public' and proc.proname = 'sentinel_start_agent_run'
      and oidvectortypes(proc.proargtypes) = 'uuid, uuid, uuid, text, integer'
      and proc.prosecdef
      and proc.proconfig @> array['search_path=public, pg_temp']
  ) then
    raise exception 'sentinel_start_agent_run(uuid, uuid, uuid, text, integer) must exist as SECURITY DEFINER with a pinned search_path';
  end if;

  -- Starting a run must not zero output_count. It did once, and a run that started and then
  -- failed reported "0 outputs" on a stage whose findings were still in the ledger — the
  -- number contradicting the findings listed beside it.
  if exists (
    select 1 from pg_proc as proc
    join pg_namespace as ns on ns.oid = proc.pronamespace
    where ns.nspname = 'public' and proc.proname = 'sentinel_start_agent_run'
      and oidvectortypes(proc.proargtypes) = 'uuid, uuid, uuid, text, integer'
      and pg_get_functiondef(proc.oid) like '%output_count = 0%'
  ) then
    raise exception 'sentinel_start_agent_run must leave output_count alone: it describes findings still on record';
  end if;

  -- Every one of these writes findings or run state. A client holding EXECUTE could
  -- fabricate a finding about its own data, which is what the machine-written-only rule on
  -- these tables exists to prevent.
  if has_function_privilege('authenticated', 'public.sentinel_record_analysis(uuid, uuid, uuid, text, jsonb, uuid)', 'EXECUTE')
    or has_function_privilege('authenticated', 'public.sentinel_fail_analysis(uuid, uuid, uuid, text, uuid, text)', 'EXECUTE')
    or has_function_privilege('authenticated', 'public.sentinel_seed_agent_runs(uuid, uuid, uuid, text[])', 'EXECUTE')
    or has_function_privilege('authenticated', 'public.sentinel_start_agent_run(uuid, uuid, uuid, text, integer)', 'EXECUTE') then
    raise exception 'authenticated must hold no EXECUTE on the analysis RPCs';
  end if;

  if not has_function_privilege('service_role', 'public.sentinel_record_analysis(uuid, uuid, uuid, text, jsonb, uuid)', 'EXECUTE')
    or not has_function_privilege('service_role', 'public.sentinel_fail_analysis(uuid, uuid, uuid, text, uuid, text)', 'EXECUTE')
    or not has_function_privilege('service_role', 'public.sentinel_seed_agent_runs(uuid, uuid, uuid, text[])', 'EXECUTE')
    or not has_function_privilege('service_role', 'public.sentinel_start_agent_run(uuid, uuid, uuid, text, integer)', 'EXECUTE') then
    raise exception 'service_role must hold EXECUTE on the analysis RPCs';
  end if;

  ------------------------------------------------------------------------------------------
  -- The producer set agrees with what the application ships
  ------------------------------------------------------------------------------------------

  foreach agent_key in array expected_agent_keys loop
    begin
      insert into public.sentinel_agent_runs (workspace_id, investigation_id, upload_id, agent_key)
      values (gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), agent_key);
      raise exception 'Expected the foreign keys to reject a synthetic run for %', agent_key;
    exception
      when foreign_key_violation then
        -- Reached the FK, so the agent_key CHECK accepted it. That is what we are testing.
        null;
      when check_violation then
        raise exception 'sentinel_agent_runs rejects agent_key %, which the application ships', agent_key;
    end;
  end loop;

  raise notice 'sentinel multi-agent analysis schema verified';
end;
$$;
