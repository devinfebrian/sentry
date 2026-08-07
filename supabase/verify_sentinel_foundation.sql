-- Auth signup settings are validated by static TOML checks because Postgres cannot read config.toml.
-- Runtime RLS tests require a connected local Supabase database.

do $$
declare
  required_table text;
  required_policy_table text;
  required_function text;
  storage_workspace_uuid_segment text;
  storage_workspace_uuid_regex text;
  storage_path_shape_regex text;
  expected_storage_policy text;
  expected_storage_write_policy text;
  expected_path_constraint text;
  expected_storage_trigger_body text;
begin
  storage_workspace_uuid_segment := '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
  storage_workspace_uuid_regex := '^' || storage_workspace_uuid_segment || '$';
  storage_path_shape_regex := '^' || storage_workspace_uuid_segment || '/' || storage_workspace_uuid_segment || '/' || storage_workspace_uuid_segment || '/[A-Za-z0-9][A-Za-z0-9._-]{0,254}$';
  expected_storage_policy := 'bucket_id=''sentinel-imports''::textandcasewhenstorage.foldername(name)[1]~''' || storage_workspace_uuid_regex || '''::textthenprivate.sentinel_is_active_member(storage.foldername(name)[1]::uuid)elsefalseend';
  expected_storage_write_policy := expected_storage_policy || 'andprivate.sentinel_can_write_import_object(name)';
  expected_path_constraint := format(
    'CHECK ((storage_path ~ %L::text))',
    storage_path_shape_regex
  );
  expected_storage_trigger_body := $expected$
begin if new.storage_path !~ '^[^/]+/[^/]+/[^/]+/[A-Za-z0-9][A-Za-z0-9._-]{0,254}$' or split_part(new.storage_path, '/', 1) <> new.workspace_id::text or split_part(new.storage_path, '/', 2) <> new.investigation_id::text or split_part(new.storage_path, '/', 3) <> new.id::text then raise exception 'Upload storage_path must be workspace/investigation/upload/safe-filename'; end if; return new; end;
$expected$;

  foreach required_table in array array[
    'sentinel_workspaces',
    'sentinel_members',
    'sentinel_investigations',
    'sentinel_uploads',
    'sentinel_import_rows',
    'sentinel_activity_events'
  ] loop
    if not exists (
      select 1
      from pg_class as relation
      join pg_namespace as namespace on namespace.oid = relation.relnamespace
      where namespace.nspname = 'public'
        and relation.relname = required_table
        and relation.relkind = 'r'
        and relation.relrowsecurity
    ) then
      raise exception 'Missing Sentinel table or RLS: %', required_table;
    end if;
  end loop;

  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.sentinel_uploads'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) like '%26214400%'
  ) then
    raise exception 'sentinel_uploads byte-size limit is missing';
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.sentinel_import_rows'::regclass
      and conname = 'sentinel_import_rows_upload_source_row_key'
      and contype = 'u'
  ) then
    raise exception 'sentinel_import_rows unique upload/source-row constraint is missing';
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.sentinel_uploads'::regclass
      and conname = 'sentinel_uploads_workspace_investigation_fkey'
      and contype = 'f'
      and pg_get_constraintdef(oid) like '%FOREIGN KEY (workspace_id, investigation_id)%'
  ) or not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.sentinel_import_rows'::regclass
      and conname = 'sentinel_import_rows_workspace_investigation_fkey'
      and contype = 'f'
      and pg_get_constraintdef(oid) like '%FOREIGN KEY (workspace_id, investigation_id)%'
  ) or not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.sentinel_import_rows'::regclass
      and conname = 'sentinel_import_rows_workspace_upload_fkey'
      and contype = 'f'
      and pg_get_constraintdef(oid) like '%FOREIGN KEY (workspace_id, upload_id)%'
  ) then
    raise exception 'Workspace/investigation composite scope constraints are missing';
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.sentinel_activity_events'::regclass
      and conname = 'sentinel_activity_events_workspace_fkey'
      and contype = 'f'
      and pg_get_constraintdef(oid) like '%ON DELETE RESTRICT%'
  ) or not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.sentinel_activity_events'::regclass
      and conname = 'sentinel_activity_events_investigation_fkey'
      and contype = 'f'
      and pg_get_constraintdef(oid) like '%ON DELETE SET NULL%'
  ) then
    raise exception 'Activity event delete behavior must restrict workspaces and null investigations';
  end if;

  if not exists (
    select 1
    from storage.buckets
    where id = 'sentinel-imports'
      and name = 'sentinel-imports'
      and public = false
      and file_size_limit = 26214400
  ) then
    raise exception 'sentinel-imports bucket is not private or has wrong size limit';
  end if;

  if exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename like 'sentinel_%'
      and roles <> array['authenticated']::name[]
  ) then
    raise exception 'Sentinel public policies must target authenticated only';
  end if;

  if not exists (
    select 1
      from pg_policies
      where schemaname = 'public'
        and tablename = 'sentinel_members'
        and policyname = 'sentinel memberships are readable by active members'
        and cmd = 'SELECT'
       and regexp_replace(lower(qual), '[[:space:]]+', '', 'g') like '%user_id=(selectauth.uid()%'
       and lower(qual) like '%sentinel_is_manager%'
   ) then
     raise exception 'Membership SELECT policy is not self-or-manager scoped';
   end if;

  if exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename like 'sentinel_%'
      and replace(
        replace(
          regexp_replace(lower(coalesce(qual, '') || ' ' || coalesce(with_check, '')), '[[:space:]]+', '', 'g'),
          '(selectauth.uid()asuid)',
          ''
        ),
        '(selectauth.uid())',
        ''
      ) like '%auth.uid()%'
  ) then
    raise exception 'Sentinel policies contain direct auth.uid() calls';
  end if;

  if has_column_privilege('authenticated', 'public.sentinel_members', 'invited_email', 'SELECT') then
    raise exception 'Analysts can select sentinel_members.invited_email';
  end if;

  if not exists (
    select 1
    from pg_class as relation
    join pg_namespace as namespace on namespace.oid = relation.relnamespace
    where namespace.nspname = 'public'
      and relation.relname = 'sentinel_manager_roster'
      and relation.relkind = 'v'
      and relation.reloptions @> array['security_invoker=true']
  ) or not has_table_privilege('authenticated', 'public.sentinel_manager_roster', 'SELECT') then
    raise exception 'Manager roster view is missing security-invoker protection or access';
  end if;

  foreach required_policy_table in array array[
    'sentinel_members',
    'sentinel_investigations',
    'sentinel_uploads'
  ] loop
    if exists (
      select 1
      from pg_policies
      where schemaname = 'public'
        and tablename = required_policy_table
        and cmd = 'UPDATE'
    ) and not exists (
      select 1
      from pg_policies
      where schemaname = 'public'
        and tablename = required_policy_table
        and cmd = 'SELECT'
    ) then
      raise exception 'UPDATE policy lacks SELECT pairing: %', required_policy_table;
    end if;
  end loop;

  if not exists (
    select 1
    from pg_proc as routine
    join pg_namespace as namespace on namespace.oid = routine.pronamespace
    where namespace.nspname = 'private'
      and routine.proname = 'sentinel_can_write_import_object'
      and pg_get_function_arguments(routine.oid) = 'object_name text'
      and routine.prosecdef
      and exists (
        select 1
        from unnest(coalesce(routine.proconfig, array[]::text[])) as setting
        where setting = 'search_path=public, pg_temp'
      )
      and has_function_privilege('authenticated', routine.oid, 'EXECUTE')
      and has_function_privilege('service_role', routine.oid, 'EXECUTE')
      and not exists (
        select 1
        from unnest(coalesce(routine.proacl, acldefault('f', routine.proowner))) as privilege
        where privilege::text like '=X/%'
      )
      and btrim(regexp_replace(lower(routine.prosrc), '\s+', ' ', 'g')) like '%object_name ~%'
      and btrim(regexp_replace(lower(routine.prosrc), '\s+', ' ', 'g')) like '%upload.storage_path = object_name%'
      and btrim(regexp_replace(lower(routine.prosrc), '\s+', ' ', 'g')) like '%split_part(object_name, ''/'', 1) = upload.workspace_id::text%'
      and btrim(regexp_replace(lower(routine.prosrc), '\s+', ' ', 'g')) like '%split_part(object_name, ''/'', 2) = upload.investigation_id::text%'
      and btrim(regexp_replace(lower(routine.prosrc), '\s+', ' ', 'g')) like '%split_part(object_name, ''/'', 3) = upload.id::text%'
      and btrim(regexp_replace(lower(routine.prosrc), '\s+', ' ', 'g')) like '%upload.uploaded_by = (select auth.uid())%'
      and btrim(regexp_replace(lower(routine.prosrc), '\s+', ' ', 'g')) like '%upload.status in (''created'', ''uploading'')%'
      and btrim(regexp_replace(lower(routine.prosrc), '\s+', ' ', 'g')) like '%else false%'
      and lower(routine.prosrc) !~ '(^|[^a-z])(or|true)([^a-z]|$)'
  ) then
    raise exception 'Import object write helper schema, security, ACL, or owner/status scope is unsafe';
  end if;

  if not exists (
     select 1
     from pg_policies
     where schemaname = 'public'
       and tablename = 'sentinel_investigations'
       and policyname = 'sentinel investigations can update'
       and cmd = 'UPDATE'
       and roles = array['authenticated']::name[]
       and lower(qual) like '%sentinel_is_manager%'
       and lower(qual) like '%sentinel_is_active_member%'
       and regexp_replace(lower(qual), '[[:space:]]+', '', 'g') like '%owner_id=(selectauth.uid()%'
       and lower(qual) like '%open%'
       and lower(qual) like '%review%'
       and lower(with_check) like '%sentinel_is_manager%'
       and lower(with_check) like '%sentinel_is_active_member%'
        and regexp_replace(lower(with_check), '[[:space:]]+', '', 'g') like '%owner_id=(selectauth.uid()%'
        and lower(with_check) like '%open%'
        and lower(with_check) like '%review%'
    ) then
      raise exception 'Investigation UPDATE policies do not separate manager and analyst status permissions';
    end if;

   if exists (
     select 1
     from (values ('INSERT'::text), ('UPDATE'::text)) as action(cmd)
     where (
       select count(*)
       from pg_policies as policy
       where policy.schemaname = 'public'
         and policy.tablename = 'sentinel_investigations'
         and policy.permissive = 'PERMISSIVE'
         and policy.cmd in (action.cmd, 'ALL')
     ) > 1
   ) then
     raise exception 'Investigation INSERT/UPDATE policies contain duplicate permissive policies';
   end if;

   if exists (
     select 1
     from pg_policies
     where schemaname = 'public'
       and tablename = 'sentinel_investigations'
       and policyname in (
         'sentinel managers can update investigations',
         'sentinel assigned analysts can update open or review investigations'
       )
   ) then
     raise exception 'Obsolete investigation UPDATE policies remain';
   end if;

   if not exists (
     select 1
     from pg_policies
       where schemaname = 'public'
         and tablename = 'sentinel_investigations'
       and policyname = 'sentinel investigations can create'
       and cmd = 'INSERT'
       and roles = array['authenticated']::name[]
       and lower(with_check) like '%sentinel_is_manager%'
       and lower(with_check) like '%sentinel_is_active_member%'
       and lower(with_check) like '%not private.sentinel_is_manager%'
       and regexp_replace(lower(with_check), '[[:space:]]+', '', 'g') like '%created_by=(selectauth.uid()%'
       and regexp_replace(lower(with_check), '[[:space:]]+', '', 'g') like '%owner_id=(selectauth.uid()%'
       and lower(with_check) like '%owner_id is null%'
       and lower(with_check) like '%owner_member.status = ''active''%'
       and lower(with_check) like '%status = ''open''%'
   ) then
     raise exception 'Investigation INSERT policies do not combine manager and analyst role restrictions';
   end if;

   if exists (
     select 1
     from pg_policies
     where schemaname = 'public'
       and tablename = 'sentinel_investigations'
       and policyname in (
         'sentinel analysts create assigned open investigations',
         'sentinel managers can create investigations'
       )
   ) then
     raise exception 'Obsolete investigation INSERT policies remain';
   end if;

  if not has_table_privilege('authenticated', 'public.sentinel_activity_events', 'SELECT')
    or not has_table_privilege('service_role', 'public.sentinel_activity_events', 'INSERT')
    or has_table_privilege('authenticated', 'public.sentinel_activity_events', 'INSERT')
    or has_table_privilege('authenticated', 'public.sentinel_activity_events', 'UPDATE')
    or has_table_privilege('authenticated', 'public.sentinel_activity_events', 'DELETE')
    or has_table_privilege('anon', 'public.sentinel_activity_events', 'UPDATE')
    or has_table_privilege('anon', 'public.sentinel_activity_events', 'DELETE')
    or has_table_privilege('service_role', 'public.sentinel_activity_events', 'UPDATE')
    or has_table_privilege('service_role', 'public.sentinel_activity_events', 'DELETE') then
    raise exception 'Activity event grants are not immutable insert-only server access';
  end if;

  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'sentinel_activity_events'
      and policyname = 'sentinel activity events are readable by active members'
      and cmd = 'SELECT'
      and roles = array['authenticated']::name[]
  ) or exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'sentinel_activity_events'
      and cmd in ('INSERT', 'UPDATE', 'DELETE', 'ALL')
  ) then
    raise exception 'Activity event policies must be member SELECT only';
  end if;

  foreach required_function in array array[
    'sentinel_is_active_member',
    'sentinel_is_manager',
    'sentinel_manager_roster'
  ] loop
    if not exists (
      select 1
      from pg_proc as routine
      join pg_namespace as namespace on namespace.oid = routine.pronamespace
      where namespace.nspname = 'private'
        and routine.proname = required_function
        and routine.prosecdef
        and exists (
          select 1
          from unnest(coalesce(routine.proconfig, array[]::text[])) as setting
          where setting = 'search_path=public, pg_temp'
        )
        and has_function_privilege('authenticated', routine.oid, 'EXECUTE')
        and has_function_privilege('service_role', routine.oid, 'EXECUTE')
        and not exists (
          select 1
          from unnest(coalesce(routine.proacl, acldefault('f', routine.proowner))) as privilege
          where privilege::text like '=X/%'
        )
    ) then
      raise exception 'Private authorization helper permissions or search_path are unsafe: %', required_function;
    end if;
  end loop;

  if not exists (
    select 1
    from pg_proc as routine
    join pg_namespace as namespace on namespace.oid = routine.pronamespace
    where namespace.nspname = 'private'
      and routine.proname = 'sentinel_validate_upload_client_update'
      and exists (
        select 1
        from unnest(coalesce(routine.proconfig, array[]::text[])) as setting
        where setting = 'search_path=public, pg_temp'
      )
      and has_function_privilege('authenticated', routine.oid, 'EXECUTE')
      and has_function_privilege('service_role', routine.oid, 'EXECUTE')
      and not exists (
        select 1
        from unnest(coalesce(routine.proacl, acldefault('f', routine.proowner))) as privilege
        where privilege::text like '=X/%'
      )
  ) then
    raise exception 'Upload staging trigger permissions or search_path are unsafe';
  end if;

  if not has_column_privilege('authenticated', 'public.sentinel_uploads', 'status', 'UPDATE')
    or not has_column_privilege('authenticated', 'public.sentinel_uploads', 'uploaded_at', 'UPDATE') then
    raise exception 'Browser upload staging UPDATE grants are missing';
  end if;

  foreach required_policy_table in array array[
    'row_count',
    'warnings',
    'error_message',
    'processing_started_at',
    'processed_at'
  ] loop
    if has_column_privilege('authenticated', 'public.sentinel_uploads', required_policy_table, 'INSERT')
      or has_column_privilege('authenticated', 'public.sentinel_uploads', required_policy_table, 'UPDATE') then
      raise exception 'Authenticated clients can write parser-owned upload field: %', required_policy_table;
    end if;
  end loop;

  if has_column_privilege('authenticated', 'public.sentinel_uploads', 'status', 'INSERT') then
    raise exception 'Authenticated clients can forge initial upload status';
  end if;

  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
       and tablename = 'sentinel_uploads'
       and policyname = 'sentinel members can create uploads'
       and regexp_replace(lower(with_check), '[[:space:]]+', '', 'g') like '%uploaded_by=(selectauth.uid()%'
       and lower(with_check) like '%status = ''created''%'
       and lower(with_check) like '%row_count = 0%'
  ) or not exists (
    select 1
      from pg_policies
      where schemaname = 'public'
       and tablename = 'sentinel_uploads'
       and policyname = 'sentinel uploaders can update upload staging'
       and regexp_replace(lower(qual), '[[:space:]]+', '', 'g') like '%uploaded_by=(selectauth.uid()%'
       and regexp_replace(lower(with_check), '[[:space:]]+', '', 'g') like '%uploaded_by=(selectauth.uid()%'
       and lower(qual) like '%status%'
      and lower(qual) like '%created%'
      and lower(qual) like '%uploading%'
      and lower(qual) like '%uploaded%'
      and lower(with_check) like '%status%'
      and lower(with_check) like '%created%'
      and lower(with_check) like '%uploading%'
      and lower(with_check) like '%uploaded%'
  ) then
    raise exception 'Upload staging policies do not restrict client status transitions';
  end if;

  if not exists (
    select 1
    from pg_trigger
    where tgrelid = 'public.sentinel_uploads'::regclass
      and tgname = 'sentinel_validate_upload_client_update'
      and not tgisinternal
  ) then
    raise exception 'Upload client staging trigger is missing';
  end if;

   if not exists (
     select 1
     from pg_policies
     where schemaname = 'public'
       and tablename = 'sentinel_investigations'
       and policyname = 'sentinel investigations can create'
       and regexp_replace(lower(with_check), '[[:space:]]+', '', 'g') like '%owner_id=(selectauth.uid()%'
       and regexp_replace(lower(with_check), '[[:space:]]+', '', 'g') like '%created_by=(selectauth.uid()%'
       and lower(with_check) like '%status = ''open''%'
   ) or not exists (
     select 1
     from pg_policies
     where schemaname = 'public'
       and tablename = 'sentinel_investigations'
       and policyname = 'sentinel investigations can create'
       and cmd = 'INSERT'
       and regexp_replace(lower(with_check), '[[:space:]]+', '', 'g') like '%created_by=(selectauth.uid()%'
       and lower(with_check) like '%owner_id is null%'
       and lower(with_check) like '%status%active%'
   ) then
    raise exception 'Investigation insert role restrictions are missing';
  end if;

  if not exists (
    select 1
    from pg_trigger
    where tgrelid = 'public.sentinel_activity_events'::regclass
      and tgname = 'sentinel_validate_activity_event_scope'
      and not tgisinternal
  ) then
    raise exception 'Activity event workspace/investigation scope trigger is missing';
  end if;

  if not exists (
    select 1
    from pg_proc as routine
    join pg_namespace as namespace on namespace.oid = routine.pronamespace
    where namespace.nspname = 'private'
      and routine.proname = 'sentinel_validate_activity_event_scope'
      and has_function_privilege('service_role', routine.oid, 'EXECUTE')
      and exists (
        select 1
        from unnest(coalesce(routine.proconfig, array[]::text[])) as setting
        where setting = 'search_path=public, pg_temp'
      )
      and not exists (
        select 1
        from unnest(coalesce(routine.proacl, acldefault('f', routine.proowner))) as privilege
        where privilege::text like '=X/%'
      )
      and pg_get_functiondef(routine.oid) ilike '%investigation.workspace_id = new.workspace_id%'
  ) then
    raise exception 'Activity event scope function does not enforce workspace consistency';
  end if;

  if not exists (
    select 1
    from pg_trigger as trigger
    join pg_proc as routine on routine.oid = trigger.tgfoid
    join pg_namespace as namespace on namespace.oid = routine.pronamespace
    where trigger.tgrelid = 'public.sentinel_uploads'::regclass
      and trigger.tgname = 'sentinel_validate_upload_storage_path'
      and not trigger.tgisinternal
      and trigger.tgenabled = 'O'
      and trigger.tgtype = 23
      and namespace.nspname = 'private'
      and routine.proname = 'sentinel_validate_upload_storage_path'
      and has_function_privilege('authenticated', routine.oid, 'EXECUTE')
      and has_function_privilege('service_role', routine.oid, 'EXECUTE')
      and exists (
        select 1
        from unnest(coalesce(routine.proconfig, array[]::text[])) as setting
        where setting = 'search_path=public, pg_temp'
      )
      and btrim(regexp_replace(lower(routine.prosrc), '\s+', ' ', 'g')) = btrim(regexp_replace(lower(expected_storage_trigger_body), '\s+', ' ', 'g'))
      and not exists (
        select 1
        from unnest(coalesce(routine.proacl, acldefault('f', routine.proowner))) as privilege
        where privilege::text like '=X/%'
      )
  ) then
    raise exception 'Upload storage_path invariant trigger is missing';
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.sentinel_uploads'::regclass
      and conname = 'sentinel_uploads_storage_path_shape_check'
      and contype = 'c'
      and pg_get_constraintdef(oid) = expected_path_constraint
  ) then
    raise exception 'Upload storage_path CHECK does not enforce exact UUID and safe-filename shape';
  end if;

  if exists (
    select 1
    from pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
      and ('public' = any (roles) or 'anon' = any (roles))
      and (
        lower(coalesce(qual, '') || ' ' || coalesce(with_check, '')) ilike '%sentinel-imports%'
        or lower(coalesce(qual, '') || ' ' || coalesce(with_check, '')) !~ '(^|[^a-z])bucket_id([^a-z]|$)'
        or lower(coalesce(qual, '') || ' ' || coalesce(with_check, '')) ~ '(^|[^a-z])(or|true)([^a-z]|$)'
      )
  ) then
    raise exception 'sentinel-imports has a public or anonymous Storage policy';
  end if;

  if (
    select count(*)
    from pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
      and policyname in (
        'sentinel imports select active workspace members',
        'sentinel imports insert active workspace members',
        'sentinel imports update active workspace members'
      )
  ) <> 3 then
    raise exception 'sentinel-imports Storage policy set has missing intended policies';
  end if;

  if exists (
    select 1
    from pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
      and policyname not in (
        'sentinel imports select active workspace members',
        'sentinel imports insert active workspace members',
        'sentinel imports update active workspace members'
      )
  ) then
    raise exception 'Storage policy set contains policy outside sentinel-imports allowlist';
  end if;

  if exists (
    select 1
    from pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
      and policyname in (
        'sentinel imports select active workspace members',
        'sentinel imports insert active workspace members',
        'sentinel imports update active workspace members'
      )
      and roles <> array['authenticated']::name[]
  ) then
    raise exception 'sentinel-imports Storage policies have unsafe role grants';
  end if;

  if exists (
    select 1
    from pg_policies
      where schemaname = 'storage'
      and tablename = 'objects'
      and cmd in ('ALL', 'DELETE')
  ) then
    raise exception 'Storage ALL, DELETE, or broad policy can affect sentinel-imports';
  end if;

  if exists (
    select 1
    from pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
      and (
        lower(coalesce(qual, '') || ' ' || coalesce(with_check, '')) ~ '(^|[^a-z])(or|true)([^a-z]|$)'
        or lower(coalesce(qual, '') || ' ' || coalesce(with_check, '')) ~ 'bucket_id[[:space:]]*=[[:space:]]*bucket_id'
      )
  ) then
    raise exception 'Storage policy predicates contain broad OR, TRUE, or bucket self-comparison';
  end if;

  if not exists (
    select 1
    from pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
      and policyname = 'sentinel imports select active workspace members'
      and cmd = 'SELECT'
      and roles = array['authenticated']::name[]
      and regexp_replace(lower(qual), '[[:space:]()]', '', 'g') = regexp_replace(lower(expected_storage_policy), '[[:space:]()]', '', 'g')
  ) or not exists (
    select 1
    from pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
      and policyname = 'sentinel imports insert active workspace members'
      and cmd = 'INSERT'
      and roles = array['authenticated']::name[]
       and regexp_replace(lower(with_check), '[[:space:]()]', '', 'g') = regexp_replace(lower(expected_storage_write_policy), '[[:space:]()]', '', 'g')
  ) or not exists (
    select 1
    from pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
      and policyname = 'sentinel imports update active workspace members'
      and cmd = 'UPDATE'
      and roles = array['authenticated']::name[]
       and regexp_replace(lower(qual), '[[:space:]()]', '', 'g') = regexp_replace(lower(expected_storage_write_policy), '[[:space:]()]', '', 'g')
       and regexp_replace(lower(with_check), '[[:space:]()]', '', 'g') = regexp_replace(lower(expected_storage_write_policy), '[[:space:]()]', '', 'g')
  ) then
    raise exception 'sentinel-imports Storage policy shape is unsafe';
  end if;

  if exists (
    select 1
    from pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
      and (
        lower(coalesce(qual, '')) ~ '(^|[^a-z])(or|true)([^a-z]|$)'
        or lower(coalesce(with_check, '')) ~ '(^|[^a-z])(or|true)([^a-z]|$)'
      )
  ) then
    raise exception 'Storage policies contain broad OR or TRUE predicates';
  end if;
end;
$$;
