# Sentinel Foundation Design

**Date:** 2026-08-05
**Status:** Approved
**Product:** Sentinel

## Goal

Turn Sentinel's fixture-backed frontend into a secure, persisted foundation for a small analyst and manager team: invite-only authentication, investigation creation, private CSV/XLSX retention, asynchronous ingestion, normalized rows, and audit events.

## Scope

The first real product slice includes:

1. A new Supabase project dedicated to Sentinel. The currently connected Supabase project belongs to another application and remains untouched.
2. Invite-only email/password authentication.
3. One shared workspace with `analyst` and `manager` roles.
4. Private retention of original CSV/XLSX files.
5. Investigation and upload persistence.
6. Asynchronous hybrid ingestion: browser Web Worker preview plus server-authoritative parsing.
7. Immutable upload and parsing activity events.
8. Protected frontend routes and role-aware actions.

Agent execution, evidence generation, decision persistence, and report persistence remain fixture-backed until a later slice. New investigations must show `Analysis not started` rather than fabricated agent output.

## Architecture

Use a typed Supabase browser client for normal authenticated reads and writes. Enable RLS on every Sentinel table and enforce roles through `sentinel_members`, never editable user metadata. Keep service-role credentials only inside Edge Functions.

Use a private Storage bucket named `sentinel-imports`. The browser uploads the original file, creates an upload job, and invokes `parse-upload`. The parser validates and normalizes data server-side, inserts rows in batches, and updates upload status. Browser parsing is limited to optional preview and early UX validation in a Web Worker.

Use an Edge Function for manager invitations because inviting users requires privileged Auth operations. The function verifies the caller's manager membership before sending an invitation and creating a pending membership record.

## Data Model

### `sentinel_workspaces`

- `id uuid primary key default gen_random_uuid()`
- `name text not null`
- `created_by uuid not null references auth.users(id)`
- `created_at timestamptz not null default now()`

### `sentinel_members`

- `workspace_id uuid not null references sentinel_workspaces(id) on delete cascade`
- `user_id uuid not null references auth.users(id) on delete cascade`
- `role text not null check (role in ('analyst', 'manager'))`
- `status text not null check (status in ('active', 'pending'))`
- `invited_email text`
- `created_at timestamptz not null default now()`
- primary key `(workspace_id, user_id)`

Pending invitations use the invited user's Auth ID when available. Email is retained for invitation display and reconciliation.

### `sentinel_investigations`

- `id uuid primary key default gen_random_uuid()`
- `workspace_id uuid not null references sentinel_workspaces(id) on delete cascade`
- `reference text not null unique within workspace`
- `entity text not null`
- `owner_id uuid references auth.users(id)`
- `status text not null check (status in ('open', 'review', 'approved', 'closed')) default 'open'`
- `created_by uuid not null references auth.users(id)`
- `created_at timestamptz not null default now()`
- `updated_at timestamptz not null default now()`
- unique `(workspace_id, reference)`

### `sentinel_uploads`

- `id uuid primary key default gen_random_uuid()`
- `workspace_id uuid not null references sentinel_workspaces(id) on delete cascade`
- `investigation_id uuid not null references sentinel_investigations(id) on delete cascade`
- `storage_path text not null unique`
- `original_name text not null`
- `extension text not null check (extension in ('csv', 'xls', 'xlsx'))`
- `mime_type text`
- `byte_size bigint not null check (byte_size > 0 and byte_size <= 26214400)`
- `status text not null check (status in ('created', 'uploading', 'uploaded', 'processing', 'parsed', 'failed')) default 'created'`
- `row_count integer not null default 0 check (row_count >= 0)`
- `warnings jsonb not null default '[]'::jsonb`
- `error_message text`
- `uploaded_by uuid not null references auth.users(id)`
- `created_at timestamptz not null default now()`
- `uploaded_at timestamptz`
- `processing_started_at timestamptz`
- `processed_at timestamptz`

### `sentinel_import_rows`

- `id uuid primary key default gen_random_uuid()`
- `workspace_id uuid not null references sentinel_workspaces(id) on delete cascade`
- `investigation_id uuid not null references sentinel_investigations(id) on delete cascade`
- `upload_id uuid not null references sentinel_uploads(id) on delete cascade`
- `source_row integer not null check (source_row >= 2)`
- `entity text not null`
- `values jsonb not null`
- `created_at timestamptz not null default now()`
- unique `(upload_id, source_row)`

Only `parse-upload` inserts normalized rows. Browser clients have no direct row-insert policy.

### `sentinel_activity_events`

- `id uuid primary key default gen_random_uuid()`
- `workspace_id uuid not null references sentinel_workspaces(id) on delete cascade`
- `investigation_id uuid references sentinel_investigations(id) on delete set null`
- `actor_id uuid references auth.users(id)`
- `event_type text not null check (event_type in ('investigation-created', 'upload-created', 'parse-started', 'parse-completed', 'parse-failed', 'member-invited'))`
- `rationale text`
- `metadata jsonb not null default '{}'::jsonb`
- `created_at timestamptz not null default now()`

Activity rows are immutable. Members can read events; clients cannot update or delete them.

## Permissions

- All active workspace members can read workspace, investigation, upload, import-row, and activity data for their workspace.
- Analysts can create investigations, upload files, and edit investigations assigned to them.
- Managers can create and edit any investigation, approve future decisions, and manage memberships.
- Pending members cannot read workspace data until invitation acceptance and activation.
- RLS policies use membership table lookups and `auth.uid()`.
- Authorization never uses `raw_user_meta_data` or other user-editable JWT metadata.
- Storage policies restrict object access to active members of the matching workspace.
- The bucket is private; no public URLs are generated.

## Authentication and Bootstrap

1. Create the first manager through Supabase Auth Dashboard for the new Sentinel project.
2. Run one-time workspace bootstrap SQL using that authenticated user's email lookup, not a hardcoded generated UUID.
3. The manager signs in through Sentinel's invite-only sign-in screen.
4. Managers invite analysts through `invite-member` Edge Function.
5. The function checks the caller's active manager membership, calls Supabase Auth invitation flow, and creates the pending membership.
6. Accepted users sign in with email/password and become active members.

The browser uses only `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY`. Service-role credentials exist only in Edge Function secrets.

## Async Ingestion

1. Analyst selects a file.
2. Web Worker performs extension, size, header, and first-row preview checks without blocking UI.
3. Sentinel creates investigation and upload metadata.
4. Browser uploads original file to `sentinel-imports/{workspaceId}/{investigationId}/{uploadId}/{safeName}`.
5. Upload status becomes `uploaded`.
6. Browser invokes `parse-upload` with upload ID.
7. Edge Function authenticates caller, verifies workspace membership, downloads the private object, parses the first worksheet, validates `entity` plus at least one numeric transaction/value column, and writes normalized rows in batches.
8. Parser records warnings and row count, emits activity event, and sets `parsed`.
9. On failure, parser records error message, emits `parse-failed`, and sets `failed`; original file remains available for retry.
10. UI polls status while allowing navigation away and supports retry for failed parsing.

CSV may stream during server processing. XLSX must be buffered because its ZIP-based format requires random access. Initial maximum file size is 25 MB. Larger workloads require dedicated worker infrastructure rather than silently increasing browser or Edge Function limits.

## Frontend Boundaries

Create typed service modules for authentication, investigations, uploads, and upload status. Keep components unaware of Supabase query details.

Production pages use persisted Sentinel investigations and imports. Existing fixture components continue to support development and tests for agent pipeline, evidence, decisions, and reports. New cases render an explicit analysis-not-started state.

Required UI states:

- Signed out: sign-in screen.
- Loading: layout-preserving session/data state.
- Uploading: progress and cancel/recovery text.
- Processing: status, row count when available, and navigation-safe polling.
- Parsed: normalized-row preview and case link.
- Failed: plain-language reason and retry action.
- Forbidden: role-specific explanation without exposing unauthorized data.

## Verification

Unit tests cover preview validation, file limits, upload status transitions, and service error mapping.

Supabase integration tests cover authenticated member reads, analyst write scope, manager-only membership actions, cross-workspace denial, private Storage access, parser idempotent retry, and immutable activity events.

Playwright covers:

1. Seeded manager sign-in.
2. Manager invitation screen access.
3. Seeded analyst sign-in.
4. Valid CSV upload, processing, reload, and persisted row preview.
5. Invalid file rejection.
6. Failed parse retry.
7. Analyst inability to use manager actions.
8. Mobile sign-in and upload states.

Run `npm run build`, `npm run test`, and `npm run test:e2e` before claiming completion.

## Out of Scope

- Real agent execution or LLM orchestration.
- Persisted evidence, decisions, or reports.
- ERP integrations.
- Manual transaction entry.
- Multi-tenant organizations.
- Billing.
- Real-time collaboration.
- Large-file dedicated worker infrastructure.
