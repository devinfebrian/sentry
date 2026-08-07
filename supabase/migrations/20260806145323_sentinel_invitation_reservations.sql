create table public.sentinel_invitation_reservations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.sentinel_workspaces(id) on delete cascade,
  email text not null check (email = lower(btrim(email)) and email <> ''),
  auth_user_id uuid references auth.users(id) on delete set null,
  invited_by uuid not null references auth.users(id),
  status text not null default 'reserved' check (status in ('reserved', 'completed', 'failed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index sentinel_invitation_reservations_workspace_email_key
  on public.sentinel_invitation_reservations (workspace_id, lower(email));

create index sentinel_invitation_reservations_workspace_status_idx
  on public.sentinel_invitation_reservations (workspace_id, status);

create index sentinel_invitation_reservations_auth_user_id_idx
  on public.sentinel_invitation_reservations (auth_user_id)
  where auth_user_id is not null;

alter table public.sentinel_invitation_reservations enable row level security;

revoke all on table public.sentinel_invitation_reservations from public, anon, authenticated;
grant select, insert, update on table public.sentinel_invitation_reservations to service_role;
