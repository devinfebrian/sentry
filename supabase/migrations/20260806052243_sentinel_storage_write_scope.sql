create or replace function private.sentinel_can_write_import_object(object_name text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case
    when object_name ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/[A-Za-z0-9][A-Za-z0-9._-]{0,254}$'
      then exists (
        select 1
        from public.sentinel_uploads as upload
        where upload.storage_path = object_name
          and split_part(object_name, '/', 1) = upload.workspace_id::text
          and split_part(object_name, '/', 2) = upload.investigation_id::text
          and split_part(object_name, '/', 3) = upload.id::text
          and upload.uploaded_by = (select auth.uid())
          and upload.status in ('created', 'uploading')
      )
    else false
  end;
$$;

revoke all on function private.sentinel_can_write_import_object(text) from public;
grant execute on function private.sentinel_can_write_import_object(text) to authenticated, service_role;

drop policy if exists "sentinel imports insert active workspace members"
  on storage.objects;

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
    and private.sentinel_can_write_import_object(name)
  );

drop policy if exists "sentinel imports update active workspace members"
  on storage.objects;

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
    and private.sentinel_can_write_import_object(name)
  )
  with check (
    bucket_id = 'sentinel-imports'
    and case
      when (storage.foldername(name))[1] ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
        then private.sentinel_is_active_member(((storage.foldername(name))[1])::uuid)
      else false
    end
    and private.sentinel_can_write_import_object(name)
  );
