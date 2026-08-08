do $$
declare
  required_trigger text;
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'sentinel_members' and column_name = 'display_name'
  ) then
    raise exception 'Missing column sentinel_members.display_name';
  end if;

  if not has_column_privilege('authenticated', 'public.sentinel_members', 'display_name', 'SELECT') then
    raise exception 'authenticated must be able to read sentinel_members.display_name';
  end if;

  -- The whole point of the column-level grant: a display name is readable, an address is not.
  if has_column_privilege('authenticated', 'public.sentinel_members', 'invited_email', 'SELECT') then
    raise exception 'authenticated must NOT be able to read sentinel_members.invited_email';
  end if;

  -- Renaming goes through the RPC; the table must stay unwritable by authenticated.
  if has_column_privilege('authenticated', 'public.sentinel_members', 'display_name', 'UPDATE')
    or has_column_privilege('authenticated', 'public.sentinel_members', 'role', 'UPDATE')
    or has_column_privilege('authenticated', 'public.sentinel_members', 'status', 'UPDATE') then
    raise exception 'authenticated must hold no UPDATE privilege on sentinel_members';
  end if;

  if exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'sentinel_members' and cmd = 'UPDATE'
  ) then
    raise exception 'sentinel_members must have no UPDATE policy';
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'sentinel_members' and cmd = 'SELECT'
      and qual like '%sentinel_is_active_member%'
  ) then
    raise exception 'sentinel_members SELECT policy must cover all active workspace members';
  end if;

  if not exists (
    select 1 from pg_proc as proc
    join pg_namespace as ns on ns.oid = proc.pronamespace
    where ns.nspname = 'public' and proc.proname = 'sentinel_set_display_name'
      and proc.prosecdef
      and proc.proconfig @> array['search_path=public, pg_temp']
  ) then
    raise exception 'public.sentinel_set_display_name must exist as SECURITY DEFINER with a pinned search_path';
  end if;

  if has_function_privilege('anon', 'public.sentinel_set_display_name(text)', 'execute') then
    raise exception 'anon must not execute sentinel_set_display_name';
  end if;
  if not has_function_privilege('authenticated', 'public.sentinel_set_display_name(text)', 'execute') then
    raise exception 'authenticated must execute sentinel_set_display_name';
  end if;

  foreach required_trigger in array array[
    'sentinel_record_investigation_created',
    'sentinel_record_upload_created',
    'sentinel_touch_investigation_activity'
  ] loop
    if not exists (
      select 1 from pg_trigger where tgname = required_trigger and not tgisinternal
    ) then
      raise exception 'Missing trigger %', required_trigger;
    end if;
  end loop;

  raise notice 'sentinel identity and activity verified';
end;
$$;
