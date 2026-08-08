-- Membership lifecycle events join the audit vocabulary.
alter table public.sentinel_activity_events
  drop constraint if exists sentinel_activity_events_event_type_check;

alter table public.sentinel_activity_events
  add constraint sentinel_activity_events_event_type_check
  check (event_type in (
    'investigation-created',
    'upload-created',
    'parse-started',
    'parse-completed',
    'parse-failed',
    'member-invited',
    'member-activated',
    'member-role-changed',
    'member-invite-rejected'
  ));

/**
 * Every membership mutation serializes on one advisory lock per workspace.
 * Row-level ordering is not enough: each function locks its target row before
 * the last-manager guard runs, so two concurrent demotions of different
 * managers would deadlock holding each other's target.
 */
create or replace function public.sentinel_activate_member(
  p_workspace_id uuid,
  p_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  target public.sentinel_members%rowtype;
begin
  perform pg_advisory_xact_lock(hashtext('sentinel_members:' || p_workspace_id::text));

  if not private.sentinel_is_manager(p_workspace_id) then
    raise exception using errcode = '42501', message = 'Manager membership required.';
  end if;

  select member.* into target
  from public.sentinel_members as member
  where member.workspace_id = p_workspace_id
    and member.user_id = p_user_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'Member not found.';
  end if;

  -- Already active: idempotent, and deliberately writes no second event.
  if target.status = 'active' then
    return jsonb_build_object(
      'workspace_id', target.workspace_id,
      'user_id', target.user_id,
      'role', target.role,
      'status', target.status
    );
  end if;

  update public.sentinel_members as member
  set status = 'active'
  where member.workspace_id = p_workspace_id
    and member.user_id = p_user_id;

  insert into public.sentinel_activity_events (
    workspace_id, investigation_id, actor_id, event_type, metadata
  ) values (
    p_workspace_id, null, auth.uid(), 'member-activated',
    jsonb_build_object('member_user_id', p_user_id::text)
  );

  return jsonb_build_object(
    'workspace_id', p_workspace_id,
    'user_id', p_user_id,
    'role', target.role,
    'status', 'active'
  );
end;
$function$;

create or replace function public.sentinel_set_member_role(
  p_workspace_id uuid,
  p_user_id uuid,
  p_role text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  target public.sentinel_members%rowtype;
  manager_count integer;
begin
  perform pg_advisory_xact_lock(hashtext('sentinel_members:' || p_workspace_id::text));

  if not private.sentinel_is_manager(p_workspace_id) then
    raise exception using errcode = '42501', message = 'Manager membership required.';
  end if;

  if p_role not in ('analyst', 'manager') then
    raise exception using errcode = 'P0001', message = 'Role must be analyst or manager.';
  end if;

  select member.* into target
  from public.sentinel_members as member
  where member.workspace_id = p_workspace_id
    and member.user_id = p_user_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'Member not found.';
  end if;

  if target.role = p_role then
    return jsonb_build_object(
      'workspace_id', target.workspace_id,
      'user_id', target.user_id,
      'role', target.role,
      'status', target.status
    );
  end if;

  -- Losing the last active manager locks the workspace out of invitation and
  -- activation permanently, with no in-product recovery path.
  if target.role = 'manager' and target.status = 'active' then
    select count(*) into manager_count
    from (
      select 1
      from public.sentinel_members as member
      where member.workspace_id = p_workspace_id
        and member.role = 'manager'
        and member.status = 'active'
      for update
    ) as locked;

    if manager_count <= 1 then
      raise exception using errcode = 'P0001',
        message = 'Workspace must keep at least one manager.';
    end if;
  end if;

  update public.sentinel_members as member
  set role = p_role
  where member.workspace_id = p_workspace_id
    and member.user_id = p_user_id;

  insert into public.sentinel_activity_events (
    workspace_id, investigation_id, actor_id, event_type, metadata
  ) values (
    p_workspace_id, null, auth.uid(), 'member-role-changed',
    jsonb_build_object('member_user_id', p_user_id::text, 'from', target.role, 'to', p_role)
  );

  return jsonb_build_object(
    'workspace_id', p_workspace_id,
    'user_id', p_user_id,
    'role', p_role,
    'status', target.status
  );
end;
$function$;

create or replace function public.sentinel_reject_invitation(
  p_workspace_id uuid,
  p_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  target public.sentinel_members%rowtype;
begin
  perform pg_advisory_xact_lock(hashtext('sentinel_members:' || p_workspace_id::text));

  if not private.sentinel_is_manager(p_workspace_id) then
    raise exception using errcode = '42501', message = 'Manager membership required.';
  end if;

  select member.* into target
  from public.sentinel_members as member
  where member.workspace_id = p_workspace_id
    and member.user_id = p_user_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'Member not found.';
  end if;

  if target.status <> 'pending' then
    raise exception using errcode = 'P0001',
      message = 'Only pending invitations can be rejected.';
  end if;

  delete from public.sentinel_members as member
  where member.workspace_id = p_workspace_id
    and member.user_id = p_user_id;

  -- claimReservation treats a failed reservation as immediately re-claimable,
  -- so the same address can be invited again without deleting the row.
  if target.invited_email is not null then
    update public.sentinel_invitation_reservations as reservation
    set status = 'failed', updated_at = now()
    where reservation.workspace_id = p_workspace_id
      and lower(reservation.email) = lower(target.invited_email);
  end if;

  -- member_user_id only: activity events are readable by every active member,
  -- but invited_email is withheld from analysts by column grant.
  insert into public.sentinel_activity_events (
    workspace_id, investigation_id, actor_id, event_type, metadata
  ) values (
    p_workspace_id, null, auth.uid(), 'member-invite-rejected',
    jsonb_build_object('member_user_id', p_user_id::text)
  );

  return null::jsonb;
end;
$function$;

revoke execute on function public.sentinel_activate_member(uuid, uuid) from public, anon;
revoke execute on function public.sentinel_set_member_role(uuid, uuid, text) from public, anon;
revoke execute on function public.sentinel_reject_invitation(uuid, uuid) from public, anon;

grant execute on function public.sentinel_activate_member(uuid, uuid) to authenticated, service_role;
grant execute on function public.sentinel_set_member_role(uuid, uuid, text) to authenticated, service_role;
grant execute on function public.sentinel_reject_invitation(uuid, uuid) to authenticated, service_role;

-- Direct table UPDATE on role/status let any manager bypass the RPCs above
-- (advisory lock, last-manager guard, and audit event) entirely, e.g. via
-- PATCH /rest/v1/sentinel_members. The three RPCs are now the only mutation path.
revoke update (role, status) on table public.sentinel_members from authenticated;

drop policy if exists "sentinel memberships are manageable by managers" on public.sentinel_members;

-- service_role can already UPDATE any reservation to any status (see the grant in
-- 20260806145323_sentinel_invitation_reservations.sql), so DELETE adds no meaningful
-- surface beyond that -- it just lets test/ops tooling actually remove a reservation row
-- instead of silently 403ing (42501) on every attempt.
grant delete on table public.sentinel_invitation_reservations to service_role;
