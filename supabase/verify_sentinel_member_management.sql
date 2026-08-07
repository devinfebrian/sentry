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

  raise notice 'sentinel member management verified';
end;
$$;
