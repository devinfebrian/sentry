create unique index sentinel_activity_events_member_invited_member_user_id_key
  on public.sentinel_activity_events (workspace_id, (metadata ->> 'member_user_id'))
  where event_type = 'member-invited'
    and metadata ? 'member_user_id';
