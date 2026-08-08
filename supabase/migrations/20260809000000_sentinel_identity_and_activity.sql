-- Workspace identity, and an activity signal that actually moves.
--
-- Two problems this closes:
--   1. Members could not see each other at all. The SELECT policy narrowed
--      sentinel_members to the caller's own row unless they were a manager, so the case
--      queue had no way to render an owner as anything but a raw UUID.
--   2. sentinel_investigations.updated_at never changed, because nothing in the product
--      ever updates an investigation row. A trigger on that table would never fire; the
--      signal has to come from the activity events instead.

alter table public.sentinel_members
  add column if not exists display_name text;

-- Readable by every active member. invited_email is deliberately NOT granted: an address
-- stays manager-only through public.sentinel_manager_roster.
grant select (display_name) on table public.sentinel_members to authenticated;

update public.sentinel_members
set display_name = split_part(invited_email, '@', 1)
where display_name is null
  and invited_email is not null
  and split_part(invited_email, '@', 1) <> '';

/**
 * Widen membership visibility to the whole workspace. This is a deliberate loosening: a
 * collaborative tool cannot answer "whose case is this?" while every member is invisible
 * to every other. Column grants are unchanged, so this exposes role, status, and display
 * name — never an email address.
 */
alter policy "sentinel memberships are readable by active members"
  on public.sentinel_members
  using (private.sentinel_is_active_member(workspace_id));

/**
 * The manager roster is a view over a table-returning function whose column list is fixed,
 * so display_name has to be threaded through both. A returns-table signature cannot be
 * changed by CREATE OR REPLACE, and the view depends on it, so both are dropped first.
 */
drop view if exists public.sentinel_manager_roster;
drop function if exists private.sentinel_manager_roster();

create function private.sentinel_manager_roster()
returns table (
  workspace_id uuid,
  user_id uuid,
  role text,
  status text,
  invited_email text,
  display_name text,
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
         member.display_name,
         member.created_at
  from public.sentinel_members as member
  where private.sentinel_is_manager(member.workspace_id);
$$;

revoke all on function private.sentinel_manager_roster() from public;
grant execute on function private.sentinel_manager_roster() to authenticated, service_role;

create view public.sentinel_manager_roster
with (security_invoker = true)
as
select workspace_id, user_id, role, status, invited_email, display_name, created_at
from private.sentinel_manager_roster();

revoke all on table public.sentinel_manager_roster from public, anon, authenticated;
grant select on table public.sentinel_manager_roster to authenticated;

/**
 * Renaming yourself goes through a function, not a table grant. UPDATE on
 * sentinel_members was revoked from `authenticated` on purpose so the RPCs are the only
 * mutation path; re-adding a policy here would reopen exactly that bypass.
 */
create or replace function public.sentinel_set_display_name(p_display_name text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  normalized text := nullif(btrim(coalesce(p_display_name, '')), '');
  updated integer;
begin
  if normalized is null then
    raise exception using errcode = 'P0001', message = 'Enter a display name.';
  end if;
  if length(normalized) > 80 then
    raise exception using errcode = 'P0001', message = 'Display name must be 80 characters or fewer.';
  end if;

  -- Only the caller's own rows, in workspaces where they are still an active member.
  update public.sentinel_members as member
  set display_name = normalized
  where member.user_id = auth.uid()
    and private.sentinel_is_active_member(member.workspace_id);

  get diagnostics updated = row_count;
  if updated = 0 then
    raise exception using errcode = 'P0002', message = 'Member not found.';
  end if;

  return jsonb_build_object('display_name', normalized);
end;
$function$;

revoke execute on function public.sentinel_set_display_name(text) from public, anon;
grant execute on function public.sentinel_set_display_name(text) to authenticated, service_role;

/**
 * investigation-created and upload-created were declared in the event_type CHECK from the
 * beginning but never written by anything. Triggers rather than application code because
 * insert on sentinel_activity_events is granted to service_role only, and a trigger
 * function runs as its owner.
 */
create or replace function private.sentinel_record_investigation_created()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
begin
  insert into public.sentinel_activity_events (
    workspace_id, investigation_id, actor_id, event_type, metadata
  ) values (
    new.workspace_id, new.id, new.created_by, 'investigation-created',
    jsonb_build_object('reference', new.reference, 'entity', new.entity)
  );
  return null;
end;
$function$;

create or replace function private.sentinel_record_upload_created()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
begin
  insert into public.sentinel_activity_events (
    workspace_id, investigation_id, actor_id, event_type, metadata
  ) values (
    new.workspace_id, new.investigation_id, new.uploaded_by, 'upload-created',
    jsonb_build_object('upload_id', new.id::text, 'original_name', new.original_name)
  );
  return null;
end;
$function$;

/**
 * The activity feed is the only thing that knows an investigation moved, so it is what
 * maintains updated_at. Guarded on investigation_id because member events carry none.
 */
create or replace function private.sentinel_touch_investigation_activity()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
begin
  if new.investigation_id is not null then
    update public.sentinel_investigations as investigation
    set updated_at = greatest(investigation.updated_at, new.created_at)
    where investigation.id = new.investigation_id;
  end if;
  return null;
end;
$function$;

revoke all on function private.sentinel_record_investigation_created() from public, anon, authenticated;
revoke all on function private.sentinel_record_upload_created() from public, anon, authenticated;
revoke all on function private.sentinel_touch_investigation_activity() from public, anon, authenticated;

drop trigger if exists sentinel_record_investigation_created on public.sentinel_investigations;
create trigger sentinel_record_investigation_created
  after insert on public.sentinel_investigations
  for each row
  execute function private.sentinel_record_investigation_created();

drop trigger if exists sentinel_record_upload_created on public.sentinel_uploads;
create trigger sentinel_record_upload_created
  after insert on public.sentinel_uploads
  for each row
  execute function private.sentinel_record_upload_created();

drop trigger if exists sentinel_touch_investigation_activity on public.sentinel_activity_events;
create trigger sentinel_touch_investigation_activity
  after insert on public.sentinel_activity_events
  for each row
  execute function private.sentinel_touch_investigation_activity();

-- Bring existing investigations up to date from the events already recorded against them.
update public.sentinel_investigations as investigation
set updated_at = latest.at
from (
  select event.investigation_id, max(event.created_at) as at
  from public.sentinel_activity_events as event
  where event.investigation_id is not null
  group by event.investigation_id
) as latest
where latest.investigation_id = investigation.id
  and latest.at > investigation.updated_at;
