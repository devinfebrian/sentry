-- A case can now carry a decision somebody actually made.
--
-- status has held 'open' on every investigation ever created: create() writes it once and
-- nothing has moved it since, so the CaseHeader badge reports a constant as though it were
-- state. The two-role chain below is not new either — the foundation migration wrote an
-- analyst update policy bounded on both sides by status in ('open','review') and a manager
-- policy without that bound, then never exercised either.

-- --------------------------------------------------------------------------------------
-- 1. Decisions join the audit vocabulary
-- --------------------------------------------------------------------------------------

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
    'member-invite-rejected',
    'analysis-completed',
    'analysis-failed',
    'case-recommended',
    'case-approved',
    'case-rejected',
    'case-evidence-requested'
  ));

-- --------------------------------------------------------------------------------------
-- 2. The rationale column gains a bound before anything writes to it
-- --------------------------------------------------------------------------------------
-- Declared 2026-08-05 and never written to, so this constraint cannot fail against existing
-- rows: every one of them is null.

alter table public.sentinel_activity_events
  drop constraint if exists sentinel_activity_events_rationale_check;

alter table public.sentinel_activity_events
  add constraint sentinel_activity_events_rationale_check
  check (rationale is null or (btrim(rationale) <> '' and length(rationale) <= 2000));

comment on column public.sentinel_activity_events.rationale is
  'The actor''s own words for a decision, stored verbatim. Null on machine-generated events, which have no author to quote.';

-- --------------------------------------------------------------------------------------
-- 3. The decision itself
-- --------------------------------------------------------------------------------------

/**
 * Records one decision: a status write and an audit event, in one transaction, so the case
 * and its trail cannot disagree about what happened.
 *
 * security definer is forced rather than chosen. sentinel_activity_events has a select
 * policy and no insert policy for authenticated, so every audit write in this system goes
 * through a definer function or the service role. The consequence is that RLS does not
 * enforce the two-role split from inside here, so the guards below do, matching the
 * foundation migration's update policies rather than inventing a second rule.
 *
 * The actor is auth.uid() and is deliberately not a parameter. sentinel_record_analysis
 * takes p_actor_id because an edge function calls it with the service role and has no
 * session to read; this one is called straight from the browser, where an actor argument
 * would let any member sign a colleague's name to a decision.
 */
create or replace function public.sentinel_record_decision(
  p_investigation_id uuid,
  p_workspace_id uuid,
  p_action text,
  p_rationale text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_actor uuid := auth.uid();
  v_is_manager boolean;
  v_owner_id uuid;
  v_status text;
  v_next_status text;
  v_event_type text;
  v_recommendation text;
  v_rationale text := btrim(coalesce(p_rationale, ''));
  v_last_recommender uuid;
  v_event_id uuid;
begin
  -- Guard 1: membership.
  if v_actor is null or not private.sentinel_is_active_member(p_workspace_id) then
    raise exception using errcode = 'P0001', message = 'Active workspace membership required.';
  end if;

  v_is_manager := private.sentinel_is_manager(p_workspace_id);

  -- Guard 2: the case exists here. `for update` also serialises two decisions racing on one
  -- case — the second waits, re-reads the status this one wrote, and fails guard 8 rather
  -- than reading a stale recommender for guard 9.
  select i.owner_id, i.status
  into v_owner_id, v_status
  from public.sentinel_investigations as i
  where i.id = p_investigation_id
    and i.workspace_id = p_workspace_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'Investigation not found.';
  end if;

  -- Guard 3: known action.
  if p_action not in ('recommend-approve', 'recommend-reject', 'approve', 'reject', 'request-evidence') then
    raise exception using errcode = 'P0001', message = 'Unknown decision action.';
  end if;

  -- Guard 4: the rationale is the deliverable, so it is required on every action.
  if v_rationale = '' then
    raise exception using errcode = 'P0001', message = 'Record why you are making this decision.';
  end if;

  if length(v_rationale) > 2000 then
    raise exception using errcode = 'P0001', message = 'Rationale must be 2000 characters or fewer.';
  end if;

  -- Guard 5: nothing to decide about. This is the same condition the queue view calls
  -- 'awaiting-import' (pipeline.uploads is null or 0), asked directly rather than restated.
  if not exists (
    select 1
    from public.sentinel_uploads as u
    where u.investigation_id = p_investigation_id
      and u.workspace_id = p_workspace_id
  ) then
    raise exception using errcode = 'P0001', message = 'Import data before deciding this case.';
  end if;

  -- Guards 6 and 7: who may do what. Guard 6 mirrors the analyst update policy's
  -- owner_id = auth.uid() rather than inventing a parallel rule.
  if p_action in ('recommend-approve', 'recommend-reject') then
    if not v_is_manager and v_owner_id is distinct from v_actor then
      raise exception using errcode = 'P0001',
        message = 'Only the assigned analyst or a manager can recommend on this case.';
    end if;
  else
    if not v_is_manager then
      raise exception using errcode = 'P0001',
        message = 'Manager membership required to decide this case.';
    end if;
  end if;

  -- Guard 8: the action's status precondition, and what it writes.
  if p_action in ('recommend-approve', 'recommend-reject') then
    if v_status <> 'open' then
      raise exception using errcode = 'P0001',
        message = 'This case already has a recommendation awaiting review.';
    end if;
    v_next_status := 'review';
    v_event_type := 'case-recommended';
    v_recommendation := case when p_action = 'recommend-approve' then 'approve' else 'reject' end;

  elsif p_action in ('approve', 'reject') then
    if v_status <> 'review' then
      raise exception using errcode = 'P0001', message = 'This case has no recommendation to decide.';
    end if;
    v_next_status := case when p_action = 'approve' then 'approved' else 'closed' end;
    v_event_type := case when p_action = 'approve' then 'case-approved' else 'case-rejected' end;
    v_recommendation := p_action;

  else
    -- request-evidence. approved and closed are reachable-from rather than terminal: a
    -- review system that cannot correct itself records its mistakes as permanent, and the
    -- original decision survives in the trail either way.
    if v_status not in ('review', 'approved', 'closed') then
      raise exception using errcode = 'P0001', message = 'This case is already back with the analyst.';
    end if;
    v_next_status := 'open';
    v_event_type := 'case-evidence-requested';
    v_recommendation := 'request-evidence';
  end if;

  -- Guard 9: separation of duties. This fails closed rather than trusting guard 8's status
  -- check to guarantee a recommender exists: 'review' is reachable by more than this
  -- function's own transitions. The merged RLS policy in
  -- 20260806044722_sentinel_rls_performance_hardening.sql grants authenticated a direct
  -- UPDATE on sentinel_investigations (any manager unconditionally, the assigned analyst
  -- while status is in ('open','review')), so a manager could PATCH status to 'review'
  -- directly and then call approve/reject with no case-recommended event on record. Section
  -- 4 below closes that specific hole by revoking UPDATE(status) from authenticated, but
  -- guard 9 does not lean on that alone — a select that finds nothing must refuse, not
  -- silently pass through a null recommender.
  if p_action in ('approve', 'reject') then
    select e.actor_id
    into v_last_recommender
    from public.sentinel_activity_events as e
    where e.investigation_id = p_investigation_id
      and e.event_type = 'case-recommended'
    order by e.created_at desc, e.id desc
    limit 1;

    if v_last_recommender is null then
      raise exception using errcode = 'P0001', message = 'This case has no recommendation to decide.';
    end if;

    if v_last_recommender is not distinct from v_actor then
      raise exception using errcode = 'P0001',
        message = 'You recommended this case. Another manager must decide it.';
    end if;
  end if;

  update public.sentinel_investigations as i
  set status = v_next_status,
      updated_at = now()
  where i.id = p_investigation_id;

  insert into public.sentinel_activity_events (
    workspace_id, investigation_id, actor_id, event_type, rationale, metadata
  ) values (
    p_workspace_id,
    p_investigation_id,
    v_actor,
    v_event_type,
    v_rationale,
    jsonb_build_object(
      'from_status', v_status,
      'to_status', v_next_status,
      'recommendation', v_recommendation
    )
  )
  returning id into v_event_id;

  return jsonb_build_object('status', v_next_status, 'event_id', v_event_id);
end;
$function$;

revoke all on function public.sentinel_record_decision(uuid, uuid, text, text) from public, anon;
grant execute on function public.sentinel_record_decision(uuid, uuid, text, text) to authenticated;

-- --------------------------------------------------------------------------------------
-- 4. status leaves the direct-PATCH surface
-- --------------------------------------------------------------------------------------
-- The merged policy in 20260806044722_sentinel_rls_performance_hardening.sql still grants
-- authenticated a direct UPDATE on sentinel_investigations (any manager unconditionally,
-- the assigned analyst while status is in ('open','review')), which let a manager PATCH
-- status straight to 'review' or 'approved' with nothing in the audit trail. Nothing in the
-- app updates status through that surface — create() inserts it once, and from here on only
-- sentinel_record_decision moves it, as the owner of its security definer privilege — so
-- this costs the app nothing. Every other column stays updatable through the existing
-- policy. Same technique as invited_email on sentinel_members: a column-level revoke,
-- not a narrower policy, because the column needs to disappear for every role at once
-- rather than be re-litigated per policy.

revoke update (status) on public.sentinel_investigations from authenticated;
