create or replace function public.sentinel_finalize_upload(
  upload_id uuid,
  workspace_id uuid,
  investigation_id uuid,
  lease_started_at timestamptz,
  rows jsonb,
  warnings jsonb,
  actor_id uuid
)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $function$
declare
  locked_upload public.sentinel_uploads%rowtype;
  row_total integer := jsonb_array_length(coalesce($5, '[]'::jsonb));
  warning_total integer := jsonb_array_length(coalesce($6, '[]'::jsonb));
begin
  select upload.*
    into locked_upload
  from public.sentinel_uploads as upload
  where upload.id = $1
    and upload.workspace_id = $2
    and upload.investigation_id = $3
    and upload.status = 'processing'
    and upload.processing_started_at = $4
  for update;

  if not found then
    raise exception using errcode = 'P0001', message = 'Processing lease lost.';
  end if;

  delete from public.sentinel_import_rows as import_row
  where import_row.upload_id = $1
    and import_row.workspace_id = $2
    and import_row.investigation_id = $3;

  insert into public.sentinel_import_rows (
    workspace_id,
    investigation_id,
    upload_id,
    source_row,
    entity,
    "values"
  )
  select $2,
         $3,
         $1,
         parsed."sourceRow",
         parsed.entity,
         coalesce(parsed."values", '{}'::jsonb)
  from jsonb_to_recordset(coalesce($5, '[]'::jsonb)) as parsed(
    "sourceRow" integer,
    entity text,
    "values" jsonb
  );

  update public.sentinel_uploads as upload
  set status = 'parsed',
      row_count = row_total,
      warnings = coalesce($6, '[]'::jsonb),
      error_message = null,
      processed_at = now()
  where upload.id = locked_upload.id;

  insert into public.sentinel_activity_events (
    workspace_id,
    investigation_id,
    actor_id,
    event_type,
    metadata
  )
  values (
    $2,
    $3,
    $7,
    'parse-completed',
    jsonb_build_object(
      'rowCount', row_total,
      'warningCount', warning_total,
      'upload_id', $1::text
    )
  );

  select upload.*
    into locked_upload
  from public.sentinel_uploads as upload
  where upload.id = $1;

  return jsonb_build_object(
    'status', locked_upload.status,
    'row_count', locked_upload.row_count,
    'warnings', locked_upload.warnings,
    'processed_at', locked_upload.processed_at
  );
end;
$function$;

create or replace function public.sentinel_fail_upload(
  upload_id uuid,
  workspace_id uuid,
  investigation_id uuid,
  lease_started_at timestamptz,
  actor_id uuid,
  error_text text
)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $function$
declare
  locked_upload public.sentinel_uploads%rowtype;
  failure_message text := coalesce($6, 'Unable to parse upload. You can retry this upload.');
begin
  select upload.*
    into locked_upload
  from public.sentinel_uploads as upload
  where upload.id = $1
    and upload.workspace_id = $2
    and upload.investigation_id = $3
    and upload.status = 'processing'
    and upload.processing_started_at = $4
  for update;

  if not found then
    raise exception using errcode = 'P0001', message = 'Processing lease lost.';
  end if;

  delete from public.sentinel_import_rows as import_row
  where import_row.upload_id = $1
    and import_row.workspace_id = $2
    and import_row.investigation_id = $3;

  update public.sentinel_uploads as upload
  set status = 'failed',
      error_message = failure_message,
      processed_at = now()
  where upload.id = locked_upload.id;

  insert into public.sentinel_activity_events (
    workspace_id,
    investigation_id,
    actor_id,
    event_type,
    metadata
  )
  values (
    $2,
    $3,
    $5,
    'parse-failed',
    jsonb_build_object(
      'status', 'failed',
      'upload_id', $1::text
    )
  );

  return jsonb_build_object(
    'status', 'failed',
    'error_message', failure_message,
    'processed_at', now()
  );
end;
$function$;

create or replace function public.sentinel_reconcile_parse_event(
  upload_id uuid,
  workspace_id uuid,
  investigation_id uuid,
  actor_id uuid,
  row_count integer,
  warning_count integer
)
returns boolean
language plpgsql
security invoker
set search_path = public, pg_temp
as $function$
declare
  locked_upload public.sentinel_uploads%rowtype;
begin
  select upload.*
    into locked_upload
  from public.sentinel_uploads as upload
  where upload.id = $1
    and upload.workspace_id = $2
    and upload.investigation_id = $3
    and upload.status = 'parsed'
  for update;

  if not found then
    return false;
  end if;

  if exists (
    select 1
    from public.sentinel_activity_events as event
    where event.workspace_id = $2
      and event.investigation_id = $3
      and event.event_type = 'parse-completed'
      and event.metadata ->> 'upload_id' = $1::text
  ) then
    return false;
  end if;

  insert into public.sentinel_activity_events (
    workspace_id,
    investigation_id,
    actor_id,
    event_type,
    metadata
  )
  values (
    $2,
    $3,
    $4,
    'parse-completed',
    jsonb_build_object(
      'rowCount', $5,
      'warningCount', $6,
      'upload_id', $1::text
    )
  );

  return true;
end;
$function$;

revoke execute on function public.sentinel_finalize_upload(uuid, uuid, uuid, timestamptz, jsonb, jsonb, uuid) from public, anon, authenticated;
revoke execute on function public.sentinel_fail_upload(uuid, uuid, uuid, timestamptz, uuid, text) from public, anon, authenticated;
revoke execute on function public.sentinel_reconcile_parse_event(uuid, uuid, uuid, uuid, integer, integer) from public, anon, authenticated;

grant execute on function public.sentinel_finalize_upload(uuid, uuid, uuid, timestamptz, jsonb, jsonb, uuid) to service_role;
grant execute on function public.sentinel_fail_upload(uuid, uuid, uuid, timestamptz, uuid, text) to service_role;
grant execute on function public.sentinel_reconcile_parse_event(uuid, uuid, uuid, uuid, integer, integer) to service_role;
