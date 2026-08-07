# Sentinel Invitation Reservations Design

## Goal

Prevent duplicate Auth invitations when concurrent or retried manager invite requests race with membership and event writes.

## Data model

`public.sentinel_invitation_reservations` stores one normalized invitation attempt per workspace/email. It has UUID identity, workspace cascade FK, nullable Auth user FK, inviter Auth FK, `reserved|completed|failed` status, and created/updated timestamps. A unique expression index on `(workspace_id, lower(email))` arbitrates concurrent callers. RLS is enabled; public, anon, and authenticated receive no table privileges; service_role receives only required reservation CRUD access.

## Invite flow

After manager authorization and payload parsing, the Edge Function inserts a `reserved` row. A unique conflict reloads the existing row. A new row may call Auth once. The returned Auth user ID is persisted before membership insertion. Existing rows never call Auth when an Auth ID is stored. A failed reservation transitions back to reserved immediately on retry. Membership insertion uses stored Auth ID, then marks reservation completed. Existing or repaired member-invited events are identified by `metadata.member_user_id`; the existing unique event guard remains authoritative.

All duplicate/pending paths return generic `409` responses. Reservation, membership, and event failures return generic server errors. The function never deletes Auth users, exposes account existence, or logs sensitive values.

## CORS

Local development keeps localhost defaults. Hosted execution requires explicit `SENTINEL_ALLOWED_ORIGINS`; wildcard values are ignored/rejected, and unconfigured hosted origins receive `403`. Function documentation includes the exact hosted secret command.

## Verification

Tests prove reservation-before-Auth, unique-conflict reuse, membership-failure retry without a second Auth call, event repair, and configured/unconfigured CORS. Focused tests run RED before implementation, then GREEN; full Vitest, TypeScript/Vite build, and available Deno checks follow.
