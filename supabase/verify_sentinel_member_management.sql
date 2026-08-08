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

  if has_column_privilege('authenticated', 'public.sentinel_members', 'role', 'UPDATE')
    or has_column_privilege('authenticated', 'public.sentinel_members', 'status', 'UPDATE') then
    raise exception 'authenticated must not hold direct UPDATE on sentinel_members role/status';
  end if;

  if exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'sentinel_members'
      and policyname = 'sentinel memberships are manageable by managers'
  ) then
    raise exception 'Obsolete direct-update membership policy still exists';
  end if;

  -- service_role already holds UPDATE on every reservation column (including status),
  -- so DELETE is required for test/ops cleanup to actually remove a seeded reservation row
  -- instead of silently 403ing.
  if not has_table_privilege('service_role', 'public.sentinel_invitation_reservations', 'DELETE') then
    raise exception 'service_role must hold DELETE on sentinel_invitation_reservations';
  end if;

  raise notice 'sentinel member management verified';
end;
$$;
