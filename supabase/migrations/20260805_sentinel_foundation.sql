do $$
begin
  if to_regclass('public.events') is not null
    and to_regclass('public.event_attendees') is not null
    and to_regclass('public.profiles') is not null then
    raise exception 'Sentinel migration refused: unrelated public.events, public.event_attendees, and public.profiles tables already exist';
  end if;
end;
$$;

create schema if not exists private;

revoke all on schema private from public;

create table public.sentinel_workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now()
);

create table public.sentinel_members (
  workspace_id uuid not null references public.sentinel_workspaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('analyst', 'manager')),
  status text not null check (status in ('active', 'pending')),
  invited_email text,
  created_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);

create table public.sentinel_investigations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.sentinel_workspaces(id) on delete cascade,
  reference text not null,
  entity text not null,
  owner_id uuid references auth.users(id),
  status text not null default 'open' check (status in ('open', 'review', 'approved', 'closed')),
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint sentinel_investigations_workspace_reference_key
    unique (workspace_id, reference),
  constraint sentinel_investigations_workspace_id_key
    unique (workspace_id, id)
);

create table public.sentinel_uploads (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.sentinel_workspaces(id) on delete cascade,
  investigation_id uuid not null references public.sentinel_investigations(id) on delete cascade,
  -- Browser path contract: workspace_id/investigation_id/upload_id/safe_filename.
  storage_path text not null unique,
  original_name text not null,
  extension text not null check (extension in ('csv', 'xls', 'xlsx')),
  mime_type text,
  byte_size bigint not null check (byte_size > 0 and byte_size <= 26214400),
  status text not null default 'created' check (status in ('created', 'uploading', 'uploaded', 'processing', 'parsed', 'failed')),
  row_count integer not null default 0 check (row_count >= 0),
  warnings jsonb not null default '[]'::jsonb,
  error_message text,
  uploaded_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  uploaded_at timestamptz,
  processing_started_at timestamptz,
  processed_at timestamptz,
  constraint sentinel_uploads_workspace_id_key
    unique (workspace_id, id),
  constraint sentinel_uploads_storage_path_shape_check
    check (
      storage_path ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/[A-Za-z0-9][A-Za-z0-9._-]{0,254}$'
    ),
  constraint sentinel_uploads_workspace_investigation_fkey
    foreign key (workspace_id, investigation_id)
    references public.sentinel_investigations (workspace_id, id)
    on delete cascade
);

create table public.sentinel_import_rows (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.sentinel_workspaces(id) on delete cascade,
  investigation_id uuid not null references public.sentinel_investigations(id) on delete cascade,
  upload_id uuid not null references public.sentinel_uploads(id) on delete cascade,
  source_row integer not null check (source_row >= 2),
  entity text not null,
  "values" jsonb not null,
  created_at timestamptz not null default now(),
  constraint sentinel_import_rows_workspace_investigation_fkey
    foreign key (workspace_id, investigation_id)
    references public.sentinel_investigations (workspace_id, id)
    on delete cascade,
  constraint sentinel_import_rows_workspace_upload_fkey
    foreign key (workspace_id, upload_id)
    references public.sentinel_uploads (workspace_id, id)
    on delete cascade,
  constraint sentinel_import_rows_upload_source_row_key
    unique (upload_id, source_row)
);

create table public.sentinel_activity_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  investigation_id uuid,
  actor_id uuid references auth.users(id),
  event_type text not null check (event_type in ('investigation-created', 'upload-created', 'parse-started', 'parse-completed', 'parse-failed', 'member-invited')),
  rationale text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint sentinel_activity_events_workspace_fkey
    foreign key (workspace_id)
    references public.sentinel_workspaces(id)
    on delete restrict,
  constraint sentinel_activity_events_investigation_fkey
    foreign key (investigation_id)
    references public.sentinel_investigations(id)
    on delete set null
);

create index sentinel_members_user_id_idx
  on public.sentinel_members (user_id, workspace_id);

create index sentinel_investigations_owner_id_idx
  on public.sentinel_investigations (owner_id, workspace_id);

create index sentinel_uploads_status_idx
  on public.sentinel_uploads (workspace_id, status);

create index sentinel_uploads_workspace_investigation_idx
  on public.sentinel_uploads (workspace_id, investigation_id);

create index sentinel_import_rows_upload_id_idx
  on public.sentinel_import_rows (upload_id);

create index sentinel_import_rows_workspace_investigation_idx
  on public.sentinel_import_rows (workspace_id, investigation_id);

create index sentinel_import_rows_workspace_upload_idx
  on public.sentinel_import_rows (workspace_id, upload_id);

create or replace function private.sentinel_is_active_member(p_workspace_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.sentinel_members as member
    where member.workspace_id = p_workspace_id
      and member.user_id = auth.uid()
      and member.status = 'active'
  );
$$;

create or replace function private.sentinel_is_manager(p_workspace_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.sentinel_members as member
    where member.workspace_id = p_workspace_id
      and member.user_id = auth.uid()
      and member.status = 'active'
      and member.role = 'manager'
  );
$$;

create or replace function private.sentinel_manager_roster()
returns table (
  workspace_id uuid,
  user_id uuid,
  role text,
  status text,
  invited_email text,
  created_at timestamptz
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select member.workspace_id,
         member.user_id,
         member.role,
         member.status,
         member.invited_email,
         member.created_at
  from public.sentinel_members as member
  where private.sentinel_is_manager(member.workspace_id);
$$;

create or replace function private.sentinel_validate_upload_client_update()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if auth.role() = 'authenticated' then
    if new.row_count is distinct from old.row_count
      or new.warnings is distinct from old.warnings
      or new.error_message is distinct from old.error_message
      or new.processing_started_at is distinct from old.processing_started_at
      or new.processed_at is distinct from old.processed_at then
      raise exception 'Parser-owned upload fields cannot be changed by clients';
    end if;

    if old.status in ('parsed', 'failed') then
      raise exception 'Terminal upload status cannot be changed by clients';
    end if;

    if old.status = 'created'
      and new.status not in ('created', 'uploading', 'uploaded') then
      raise exception 'Invalid client upload staging transition';
    end if;

    if old.status = 'uploading'
      and new.status not in ('uploading', 'uploaded') then
      raise exception 'Invalid client upload staging transition';
    end if;

    if old.status = 'uploaded' and new.status <> 'uploaded' then
      raise exception 'Uploaded files cannot return to staging';
    end if;
  end if;

  return new;
end;
$$;

create or replace function private.sentinel_validate_activity_event_scope()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.investigation_id is not null and not exists (
    select 1
    from public.sentinel_investigations as investigation
    where investigation.id = new.investigation_id
      and investigation.workspace_id = new.workspace_id
  ) then
    raise exception 'Activity event investigation must belong to event workspace';
  end if;

  return new;
end;
$$;

create or replace function private.sentinel_validate_upload_storage_path()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.storage_path !~ '^[^/]+/[^/]+/[^/]+/[A-Za-z0-9][A-Za-z0-9._-]{0,254}$'
    or split_part(new.storage_path, '/', 1) <> new.workspace_id::text
    or split_part(new.storage_path, '/', 2) <> new.investigation_id::text
    or split_part(new.storage_path, '/', 3) <> new.id::text then
    raise exception 'Upload storage_path must be workspace/investigation/upload/safe-filename';
  end if;

  return new;
end;
$$;

revoke all on function private.sentinel_is_active_member(uuid) from public;
revoke all on function private.sentinel_is_manager(uuid) from public;
revoke all on function private.sentinel_manager_roster() from public;
revoke all on function private.sentinel_validate_upload_client_update() from public;
revoke all on function private.sentinel_validate_activity_event_scope() from public;
revoke all on function private.sentinel_validate_upload_storage_path() from public;
grant execute on function private.sentinel_is_active_member(uuid) to authenticated, service_role;
grant execute on function private.sentinel_is_manager(uuid) to authenticated, service_role;
grant execute on function private.sentinel_manager_roster() to authenticated, service_role;
grant execute on function private.sentinel_validate_upload_client_update() to authenticated, service_role;
grant execute on function private.sentinel_validate_activity_event_scope() to service_role;
grant execute on function private.sentinel_validate_upload_storage_path() to authenticated, service_role;
grant usage on schema private to authenticated, service_role;

revoke all on table public.sentinel_members from public, anon, authenticated;
grant select (workspace_id, user_id, role, status, created_at)
  on table public.sentinel_members to authenticated;
grant update (role, status)
  on table public.sentinel_members to authenticated;
grant all on table public.sentinel_members to service_role;

revoke all on table public.sentinel_uploads from public, anon, authenticated;
grant select on table public.sentinel_uploads to authenticated;
grant insert (
  id,
  workspace_id,
  investigation_id,
  storage_path,
  original_name,
  extension,
  mime_type,
  byte_size,
  uploaded_by
)
  on table public.sentinel_uploads to authenticated;
grant update (status, uploaded_at)
  on table public.sentinel_uploads to authenticated;
grant all on table public.sentinel_uploads to service_role;

revoke all on table public.sentinel_workspaces from public, anon, authenticated;
grant select on table public.sentinel_workspaces to authenticated;
grant all on table public.sentinel_workspaces to service_role;

revoke all on table public.sentinel_investigations from public, anon, authenticated;
grant select on table public.sentinel_investigations to authenticated;
grant insert (
  id,
  workspace_id,
  reference,
  entity,
  owner_id,
  status,
  created_by
)
  on table public.sentinel_investigations to authenticated;
grant update (reference, entity, owner_id, status, updated_at)
  on table public.sentinel_investigations to authenticated;
grant all on table public.sentinel_investigations to service_role;

revoke all on table public.sentinel_import_rows from public, anon, authenticated;
grant select on table public.sentinel_import_rows to authenticated;
grant all on table public.sentinel_import_rows to service_role;

revoke all on table public.sentinel_activity_events from public, anon, authenticated, service_role;
grant select on table public.sentinel_activity_events to authenticated;
grant insert on table public.sentinel_activity_events to service_role;

alter table public.sentinel_workspaces enable row level security;
alter table public.sentinel_members enable row level security;
alter table public.sentinel_investigations enable row level security;
alter table public.sentinel_uploads enable row level security;
alter table public.sentinel_import_rows enable row level security;
alter table public.sentinel_activity_events enable row level security;

create trigger sentinel_validate_upload_client_update
  before update on public.sentinel_uploads
  for each row
  execute function private.sentinel_validate_upload_client_update();

create trigger sentinel_validate_activity_event_scope
  before insert or update on public.sentinel_activity_events
  for each row
  execute function private.sentinel_validate_activity_event_scope();

create trigger sentinel_validate_upload_storage_path
  before insert or update on public.sentinel_uploads
  for each row
  execute function private.sentinel_validate_upload_storage_path();

create policy "sentinel workspaces are readable by active members"
  on public.sentinel_workspaces
  for select
  to authenticated
  using (private.sentinel_is_active_member(id));

create policy "sentinel memberships are readable by active members"
  on public.sentinel_members
  for select
  to authenticated
  using (
    user_id = auth.uid()
    or private.sentinel_is_manager(workspace_id)
  );

create policy "sentinel memberships are manageable by managers"
  on public.sentinel_members
  for update
  to authenticated
  using (private.sentinel_is_manager(workspace_id))
  with check (private.sentinel_is_manager(workspace_id));

create policy "sentinel investigations are readable by active members"
  on public.sentinel_investigations
  for select
  to authenticated
  using (private.sentinel_is_active_member(workspace_id));

create policy "sentinel analysts create assigned open investigations"
  on public.sentinel_investigations
  for insert
  to authenticated
  with check (
    private.sentinel_is_active_member(workspace_id)
    and not private.sentinel_is_manager(workspace_id)
    and created_by = auth.uid()
    and owner_id = auth.uid()
    and status = 'open'
  );

create policy "sentinel managers can create investigations"
  on public.sentinel_investigations
  for insert
  to authenticated
  with check (
    private.sentinel_is_manager(workspace_id)
    and created_by = auth.uid()
    and (
      owner_id is null
      or exists (
        select 1
        from public.sentinel_members as owner_member
        where owner_member.workspace_id = sentinel_investigations.workspace_id
          and owner_member.user_id = sentinel_investigations.owner_id
          and owner_member.status = 'active'
      )
    )
  );

create policy "sentinel managers can update investigations"
  on public.sentinel_investigations
  for update
  to authenticated
  using (private.sentinel_is_manager(workspace_id))
  with check (private.sentinel_is_manager(workspace_id));

create policy "sentinel assigned analysts can update open or review investigations"
  on public.sentinel_investigations
  for update
  to authenticated
  using (
    private.sentinel_is_active_member(workspace_id)
    and owner_id = auth.uid()
    and status in ('open', 'review')
  )
  with check (
    private.sentinel_is_active_member(workspace_id)
    and owner_id = auth.uid()
    and status in ('open', 'review')
  );

create policy "sentinel uploads are readable by active members"
  on public.sentinel_uploads
  for select
  to authenticated
  using (private.sentinel_is_active_member(workspace_id));

create policy "sentinel members can create uploads"
  on public.sentinel_uploads
  for insert
  to authenticated
  with check (
    private.sentinel_is_active_member(workspace_id)
    and uploaded_by = auth.uid()
    and status = 'created'
    and row_count = 0
    and warnings = '[]'::jsonb
    and error_message is null
    and uploaded_at is null
    and processing_started_at is null
    and processed_at is null
    and exists (
      select 1
      from public.sentinel_investigations as investigation
      where investigation.id = sentinel_uploads.investigation_id
        and investigation.workspace_id = sentinel_uploads.workspace_id
    )
  );

create policy "sentinel uploaders can update upload staging"
  on public.sentinel_uploads
  for update
  to authenticated
  using (
    private.sentinel_is_active_member(workspace_id)
    and uploaded_by = auth.uid()
    and status in ('created', 'uploading', 'uploaded')
  )
  with check (
    private.sentinel_is_active_member(workspace_id)
    and uploaded_by = auth.uid()
    and status in ('created', 'uploading', 'uploaded')
    and exists (
      select 1
      from public.sentinel_investigations as investigation
      where investigation.id = sentinel_uploads.investigation_id
        and investigation.workspace_id = sentinel_uploads.workspace_id
    )
  );

create policy "sentinel import rows are readable by active members"
  on public.sentinel_import_rows
  for select
  to authenticated
  using (private.sentinel_is_active_member(workspace_id));

create policy "sentinel activity events are readable by active members"
  on public.sentinel_activity_events
  for select
  to authenticated
  using (private.sentinel_is_active_member(workspace_id));

create view public.sentinel_manager_roster
with (security_invoker = true)
as
select workspace_id, user_id, role, status, invited_email, created_at
from private.sentinel_manager_roster();

revoke all on table public.sentinel_manager_roster from public, anon, authenticated;
grant select on table public.sentinel_manager_roster to authenticated;

insert into storage.buckets (id, name, public, file_size_limit)
values ('sentinel-imports', 'sentinel-imports', false, 26214400)
on conflict (id) do update
set name = excluded.name,
    public = false,
    file_size_limit = 26214400;

create policy "sentinel imports select active workspace members"
  on storage.objects
  for select
  to authenticated
  using (
    bucket_id = 'sentinel-imports'
    and case
      when (storage.foldername(name))[1] ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
        then private.sentinel_is_active_member(((storage.foldername(name))[1])::uuid)
      else false
    end
  );

create policy "sentinel imports insert active workspace members"
  on storage.objects
  for insert
  to authenticated
  with check (
    bucket_id = 'sentinel-imports'
    and case
      when (storage.foldername(name))[1] ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
        then private.sentinel_is_active_member(((storage.foldername(name))[1])::uuid)
      else false
    end
  );

create policy "sentinel imports update active workspace members"
  on storage.objects
  for update
  to authenticated
  using (
    bucket_id = 'sentinel-imports'
    and case
      when (storage.foldername(name))[1] ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
        then private.sentinel_is_active_member(((storage.foldername(name))[1])::uuid)
      else false
    end
  )
  with check (
    bucket_id = 'sentinel-imports'
    and case
      when (storage.foldername(name))[1] ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
        then private.sentinel_is_active_member(((storage.foldername(name))[1])::uuid)
      else false
    end
  );
