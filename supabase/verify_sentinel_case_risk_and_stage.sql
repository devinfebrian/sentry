-- Verifies 20260810060036_sentinel_case_risk_and_stage.sql against a live database.
--
-- Signatures are matched with oidvectortypes(proargtypes), never
-- pg_get_function_identity_arguments, which returns parameter names on this server and so
-- passes vacuously whenever a check asserts absence.

do $$
declare
  unrated_deterministic integer;
  rated_fraud integer;
  distinct_stages integer;
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'sentinel_findings' and column_name = 'severity'
      and is_nullable = 'YES' and column_default is null
  ) then
    raise exception 'sentinel_findings.severity must exist, be nullable, and carry no default';
  end if;

  -- Scoped to the table: a same-named constraint elsewhere must not satisfy this.
  if not exists (
    select 1 from pg_constraint as con
    join pg_class as rel on rel.oid = con.conrelid
    join pg_namespace as ns on ns.oid = rel.relnamespace
    where ns.nspname = 'public' and rel.relname = 'sentinel_findings'
      and con.contype = 'c'
      and pg_get_constraintdef(con.oid) like '%severity%low%medium%high%'
  ) then
    raise exception 'sentinel_findings.severity must be constrained to low/medium/high';
  end if;

  -- Matches the shape, not just the word: the column list must place severity right
  -- after confidence, and the values list must carry the matching nullif(...) entry in
  -- the same position. A bare '%severity%' check would pass on a comment mentioning the
  -- word, or on a column added in the wrong ordinal position — silent misalignment that
  -- writes the wrong value into the wrong column, which is exactly what this guards against.
  if not exists (
    select 1 from pg_proc as proc
    join pg_namespace as ns on ns.oid = proc.pronamespace
    where ns.nspname = 'public' and proc.proname = 'sentinel_record_analysis'
      and oidvectortypes(proc.proargtypes) = 'uuid, uuid, uuid, text, jsonb, uuid'
      and pg_get_functiondef(proc.oid) like '%confidence, severity%'
      and pg_get_functiondef(proc.oid) like '%nullif(finding ->> ''severity'', '''')%'
  ) then
    raise exception 'sentinel_record_analysis must persist severity in the correct column position';
  end if;

  if not exists (
    select 1 from pg_class as rel
    join pg_namespace as ns on ns.oid = rel.relnamespace
    where ns.nspname = 'public' and rel.relname = 'sentinel_investigation_queue'
      and rel.relkind = 'v'
      and rel.reloptions @> array['security_invoker=true']
  ) then
    raise exception 'sentinel_investigation_queue must exist as a security_invoker view';
  end if;

  -- The backfill is total for the rules: every deterministic finding whose magnitude the
  -- record still holds must now carry a rating.
  select count(*) into unrated_deterministic
  from public.sentinel_findings
  where agent_key = 'deterministic' and severity is null
    and (rule <> 'outlier-amount' or summary ~ '[0-9]+x the median');
  if unrated_deterministic > 0 then
    raise exception 'deterministic findings left unrated by the backfill: %', unrated_deterministic;
  end if;

  -- And it invented nothing for the producer that never stated one.
  select count(*) into rated_fraud
  from public.sentinel_findings where agent_key = 'fraud-pattern' and severity is not null;
  if rated_fraud > 0 then
    raise exception 'fraud-pattern findings were rated without the agent stating a severity: %', rated_fraud;
  end if;

  -- 'not in' evaluates to NULL (not true) for a NULL stage or risk, so a NULL would
  -- silently pass this check without the explicit "is null" arms below — exactly the
  -- regression this assertion exists to catch.
  if exists (
    select 1 from public.sentinel_investigation_queue
    where stage is null or risk is null
       or stage not in ('awaiting-import', 'analysing', 'analysis-failed',
                        'awaiting-analysis', 'fraud-review', 'analysed')
       or risk not in ('low', 'medium', 'high', 'not-assessed')
  ) then
    raise exception 'the view produced a risk or stage outside the permitted set';
  end if;

  -- The filters exist to narrow a list. One value across every case is the condition that
  -- got them withheld, and shipping back into it would be the same defect.
  select count(distinct stage) into distinct_stages from public.sentinel_investigation_queue;
  if distinct_stages < 2 then
    raise exception 'every case shares one stage; the Stage filter would be inert';
  end if;

  raise notice 'sentinel_case_risk_and_stage verified';
end;
$$;
