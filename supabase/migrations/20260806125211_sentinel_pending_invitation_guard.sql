create unique index sentinel_members_pending_workspace_invited_email_key
  on public.sentinel_members (workspace_id, lower(invited_email))
  where status = 'pending' and invited_email is not null;
