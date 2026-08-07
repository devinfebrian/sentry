alter policy "sentinel memberships are readable by active members"
  on public.sentinel_members
  using (
    user_id = (select auth.uid())
    or private.sentinel_is_manager(workspace_id)
  );

alter policy "sentinel members can create uploads"
  on public.sentinel_uploads
  with check (
    private.sentinel_is_active_member(workspace_id)
    and uploaded_by = (select auth.uid())
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

alter policy "sentinel uploaders can update upload staging"
  on public.sentinel_uploads
  using (
    private.sentinel_is_active_member(workspace_id)
    and uploaded_by = (select auth.uid())
    and status in ('created', 'uploading', 'uploaded')
  )
  with check (
    private.sentinel_is_active_member(workspace_id)
    and uploaded_by = (select auth.uid())
    and status in ('created', 'uploading', 'uploaded')
    and exists (
      select 1
      from public.sentinel_investigations as investigation
      where investigation.id = sentinel_uploads.investigation_id
        and investigation.workspace_id = sentinel_uploads.workspace_id
    )
  );

drop policy if exists "sentinel analysts create assigned open investigations"
  on public.sentinel_investigations;

drop policy if exists "sentinel managers can create investigations"
  on public.sentinel_investigations;

create policy "sentinel investigations can create"
  on public.sentinel_investigations
  for insert
  to authenticated
  with check (
    (
      private.sentinel_is_manager(workspace_id)
      and created_by = (select auth.uid())
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
    )
    or (
      private.sentinel_is_active_member(workspace_id)
      and not private.sentinel_is_manager(workspace_id)
      and created_by = (select auth.uid())
      and owner_id = (select auth.uid())
      and status = 'open'
    )
  );

drop policy if exists "sentinel managers can update investigations"
  on public.sentinel_investigations;

drop policy if exists "sentinel assigned analysts can update open or review investigations"
  on public.sentinel_investigations;

create policy "sentinel investigations can update"
  on public.sentinel_investigations
  for update
  to authenticated
  using (
    private.sentinel_is_manager(workspace_id)
    or (
      private.sentinel_is_active_member(workspace_id)
      and owner_id = (select auth.uid())
      and status in ('open', 'review')
    )
  )
  with check (
    private.sentinel_is_manager(workspace_id)
    or (
      private.sentinel_is_active_member(workspace_id)
      and owner_id = (select auth.uid())
      and status in ('open', 'review')
    )
  );
