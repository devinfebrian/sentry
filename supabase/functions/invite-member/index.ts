import { createAdminClient, requireUser } from "../_shared/auth.ts";
import { canInviteMembers, normalizeEmail, parseInvitePayload, PolicyError } from "../_shared/auth-policy.ts";
import { environmentAllowedOrigins, errorResponse, handleCors, HttpError, jsonResponse, readJson } from "../_shared/cors.ts";

const allowedOrigins = environmentAllowedOrigins();
const genericInviteError = "Unable to invite member.";
const invitationPendingError = "Invitation already pending.";
const alreadyMemberError = "That person is already an active member of this workspace.";

/**
 * A membership that already exists is not always a pending invitation — it is often
 * someone who accepted long ago. Telling a manager to wait for an acceptance that already
 * happened sends them looking for a problem that does not exist.
 */
function existingMemberError(status: string | undefined) {
  return status === "active" ? alreadyMemberError : invitationPendingError;
}
export const RESERVATION_LEASE_MS = 15 * 60 * 1000;
const AUTH_USERS_PAGE_SIZE = 100;
const reservationFields = "id, workspace_id, email, auth_user_id, invited_by, status, updated_at";

type InvitationReservation = {
  id: string;
  workspace_id: string;
  email: string;
  auth_user_id: string | null;
  invited_by: string;
  status: "reserved" | "completed" | "failed";
  updated_at: string;
};

type ReservationClaim = {
  claimed: boolean;
  reservation: InvitationReservation;
};

/** Matches the backfill in 20260809000000_sentinel_identity_and_activity.sql. */
function displayNameFor(email: string) {
  return email.split("@")[0] || email;
}

function responseForError(error: unknown, request: Request) {
  if (error instanceof HttpError || error instanceof PolicyError) {
    return errorResponse(error.message, error.status, request, allowedOrigins);
  }
  return errorResponse("Unable to invite member.", 500, request, allowedOrigins);
}

async function findPendingMembership(admin: Record<string, any>, workspaceId: string, email: string) {
  const { data: pendingMemberships, error } = await admin
    .from("sentinel_members")
    .select("workspace_id, user_id, role, status, invited_email")
    .eq("workspace_id", workspaceId)
    .eq("status", "pending")
    .eq("invited_email", email)
    .limit(1);

  if (error) {
    throw new HttpError(genericInviteError, 500);
  }

  return pendingMemberships?.[0] ?? null;
}

async function findMembershipByUserId(admin: Record<string, any>, workspaceId: string, userId: string) {
  const { data: memberships, error } = await admin
    .from("sentinel_members")
    .select("workspace_id, user_id, role, status, invited_email")
    .eq("workspace_id", workspaceId)
    .eq("user_id", userId)
    .limit(1);

  if (error) {
    throw new HttpError(genericInviteError, 500);
  }

  return memberships?.[0] ?? null;
}

async function findAuthUserByEmail(admin: Record<string, any>, email: string) {
  let page = 1;
  while (true) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: AUTH_USERS_PAGE_SIZE });
    if (error || !Array.isArray(data?.users)) {
      throw new HttpError(genericInviteError, 500);
    }

    const matchingUser = data.users.find((candidate: { id?: unknown; email?: unknown }) =>
      typeof candidate.id === "string" && normalizeEmail(candidate.email) === email,
    );
    if (matchingUser?.id) {
      return matchingUser.id;
    }

    if (data.users.length < AUTH_USERS_PAGE_SIZE) {
      return null;
    }

    page += 1;
  }
}

async function reserveInvitation(
  admin: Record<string, any>,
  workspaceId: string,
  email: string,
  actorId: string,
) {
  const { data: reservation, error: insertError } = await admin
    .from("sentinel_invitation_reservations")
    .insert({ workspace_id: workspaceId, email, invited_by: actorId, status: "reserved" })
    .select(reservationFields)
    .maybeSingle();

  if (!insertError && reservation) {
    return { reservation: reservation as InvitationReservation, created: true };
  }

  if (insertError?.code !== "23505") {
    throw new HttpError(genericInviteError, 500);
  }

  const { data: existingReservation, error: lookupError } = await admin
    .from("sentinel_invitation_reservations")
    .select(reservationFields)
    .eq("workspace_id", workspaceId)
    .eq("email", email)
    .maybeSingle();

  if (lookupError || !existingReservation) {
    throw new HttpError(genericInviteError, 500);
  }

  return { reservation: existingReservation as InvitationReservation, created: false };
}

async function updateReservation(
  admin: Record<string, any>,
  reservationId: string,
  values: Record<string, unknown>,
  expectedStatus?: InvitationReservation["status"],
  expectedUpdatedAt?: string,
) {
  let query = admin
    .from("sentinel_invitation_reservations")
    .update({ ...values, updated_at: new Date().toISOString() })
    .eq("id", reservationId);

  if (expectedStatus) {
    query = query.eq("status", expectedStatus);
  }
  if (expectedUpdatedAt) {
    query = query.eq("updated_at", expectedUpdatedAt);
  }

  const { data, error } = await query.select(reservationFields).maybeSingle();
  if (error || !data) {
    throw new HttpError(genericInviteError, 500);
  }

  return data as InvitationReservation;
}

function reservationNeedsClaim(reservation: InvitationReservation, now = Date.now()) {
  if (reservation.status === "failed") {
    return true;
  }

  if (reservation.status !== "reserved") {
    return false;
  }

  const updatedAt = Date.parse(reservation.updated_at);
  return !Number.isFinite(updatedAt) || now - updatedAt >= RESERVATION_LEASE_MS;
}

async function loadReservation(admin: Record<string, any>, reservationId: string) {
  const { data, error } = await admin
    .from("sentinel_invitation_reservations")
    .select(reservationFields)
    .eq("id", reservationId)
    .maybeSingle();

  if (error || !data) {
    throw new HttpError(genericInviteError, 500);
  }

  return data as InvitationReservation;
}

async function claimReservation(
  admin: Record<string, any>,
  reservation: InvitationReservation,
  now = Date.now(),
): Promise<ReservationClaim> {
  if (!reservationNeedsClaim(reservation, now)) {
    return { claimed: false, reservation };
  }

  let claimQuery = admin
    .from("sentinel_invitation_reservations")
    .update({ status: "reserved", updated_at: new Date(now).toISOString() })
    .eq("id", reservation.id)
    .eq("status", reservation.status)
    .eq("updated_at", reservation.updated_at);

  if (reservation.status === "reserved") {
    claimQuery = claimQuery.lte("updated_at", new Date(now - RESERVATION_LEASE_MS).toISOString());
  }

  const { data: claimedReservation, error: claimError } = await claimQuery.select(reservationFields).maybeSingle();

  if (claimError) {
    throw new HttpError(genericInviteError, 500);
  }

  if (claimedReservation) {
    return { claimed: true, reservation: claimedReservation as InvitationReservation };
  }

  return { claimed: false, reservation: await loadReservation(admin, reservation.id) };
}

async function reconcileInvitationEvent(
  client: Record<string, any>,
  admin: Record<string, any>,
  workspaceId: string,
  actorId: string,
  memberUserId: string,
) {
  const { data: invitationEvents, error: invitationEventLookupError } = await client
    .from("sentinel_activity_events")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("event_type", "member-invited")
    .contains("metadata", { member_user_id: memberUserId })
    .limit(1);

  if (invitationEventLookupError) {
    throw new HttpError(genericInviteError, 500);
  }

  if (!invitationEvents?.[0]) {
    const { error: eventError } = await admin.from("sentinel_activity_events").insert({
      workspace_id: workspaceId,
      actor_id: actorId,
      event_type: "member-invited",
      metadata: { member_user_id: memberUserId, role: "analyst" },
    });

    if (eventError && eventError.code !== "23505") {
      throw new HttpError(genericInviteError, 500);
    }
  }
}

export async function handleRequest(request: Request) {
  if (request.method !== "POST") {
    return errorResponse("Method not allowed.", 405, request, allowedOrigins);
  }

  try {
    const { client, user } = await requireUser(request);
    const { data: memberships, error: membershipError } = await client
      .from("sentinel_members")
      .select("workspace_id, role, status")
      .eq("user_id", user.id)
      .eq("status", "active")
      .limit(1);

    if (membershipError) {
      throw new HttpError("Unable to verify workspace membership.", 500);
    }

    const membership = memberships?.[0];
    if (!canInviteMembers(membership)) {
      return errorResponse("Manager membership required.", 403, request, allowedOrigins);
    }

    const input = parseInvitePayload(await readJson(request));
    const admin = await createAdminClient();

    let { reservation, created } = await reserveInvitation(admin, membership.workspace_id, input.email, user.id);
    let claimedReservation = false;

    if (!created) {
      const claimable = reservationNeedsClaim(reservation);
      const claim = await claimReservation(admin, reservation);
      reservation = claim.reservation;
      claimedReservation = claim.claimed;

      if (claimable && !claimedReservation) {
        return errorResponse(invitationPendingError, 409, request, allowedOrigins);
      }
    }

    if (!created && !claimedReservation) {
      const existingMembership = reservation.auth_user_id
        ? await findMembershipByUserId(admin, membership.workspace_id, reservation.auth_user_id)
        : null;

      if (existingMembership) {
        await reconcileInvitationEvent(client, admin, membership.workspace_id, user.id, existingMembership.user_id);
        if (reservation.status !== "completed") {
          reservation = await updateReservation(admin, reservation.id, { status: "completed" }, reservation.status, reservation.updated_at);
        }
      }

      return errorResponse(existingMemberError(existingMembership?.status), 409, request, allowedOrigins);
    }

    if (created) {
      const pendingMembership = await findPendingMembership(admin, membership.workspace_id, input.email);
      if (pendingMembership) {
        reservation = await updateReservation(admin, reservation.id, { auth_user_id: pendingMembership.user_id }, "reserved", reservation.updated_at);
        reservation = await updateReservation(admin, reservation.id, { status: "completed" }, "reserved", reservation.updated_at);
        await reconcileInvitationEvent(client, admin, membership.workspace_id, user.id, pendingMembership.user_id);
        return errorResponse(invitationPendingError, 409, request, allowedOrigins);
      }
    }

    let memberUserId = reservation.auth_user_id;
    if (!memberUserId) {
      memberUserId = await findAuthUserByEmail(admin, input.email);

      if (memberUserId) {
        reservation = await updateReservation(admin, reservation.id, { auth_user_id: memberUserId }, "reserved", reservation.updated_at);
      } else {
        const { data: inviteData, error: inviteError } = await admin.auth.admin.inviteUserByEmail(input.email);
        if (inviteError || !inviteData?.user?.id) {
          await updateReservation(admin, reservation.id, { status: "failed" }, "reserved", reservation.updated_at);
          return errorResponse("Member could not be invited.", 409, request, allowedOrigins);
        }

        memberUserId = inviteData.user.id;
        reservation = await updateReservation(admin, reservation.id, { auth_user_id: memberUserId }, "reserved", reservation.updated_at);
      }
    }

    const existingMembership = await findMembershipByUserId(admin, membership.workspace_id, memberUserId);
    if (existingMembership) {
      reservation = await updateReservation(admin, reservation.id, { status: "completed" }, "reserved", reservation.updated_at);
      await reconcileInvitationEvent(client, admin, membership.workspace_id, user.id, existingMembership.user_id);
      return errorResponse(existingMemberError(existingMembership.status), 409, request, allowedOrigins);
    }

    const { error: memberError } = await admin.from("sentinel_members").insert({
      workspace_id: membership.workspace_id,
      user_id: memberUserId,
      role: "analyst",
      status: "pending",
      invited_email: reservation.email,
      // Seeded so colleagues have something to call them before they rename themselves.
      // The address itself stays manager-only; only this derived name is widely readable.
      display_name: displayNameFor(reservation.email),
    });
    if (memberError) {
      if (memberError.code === "23505") {
        const conflictedMembership = await findPendingMembership(admin, membership.workspace_id, input.email);
        if (!conflictedMembership) {
          await updateReservation(admin, reservation.id, { status: "failed" }, "reserved", reservation.updated_at);
          throw new HttpError(genericInviteError, 500);
        }

        reservation = await updateReservation(admin, reservation.id, { status: "completed" }, "reserved", reservation.updated_at);
        await reconcileInvitationEvent(client, admin, membership.workspace_id, user.id, conflictedMembership.user_id);
        return errorResponse(invitationPendingError, 409, request, allowedOrigins);
      }

      await updateReservation(admin, reservation.id, { status: "failed" }, "reserved", reservation.updated_at);
      return errorResponse("Member could not be added.", 500, request, allowedOrigins);
    }

    reservation = await updateReservation(admin, reservation.id, { status: "completed" }, "reserved", reservation.updated_at);

    const { error: eventError } = await admin.from("sentinel_activity_events").insert({
      workspace_id: membership.workspace_id,
      actor_id: user.id,
      event_type: "member-invited",
      metadata: { member_user_id: memberUserId, role: "analyst" },
    });
    if (eventError && eventError.code !== "23505") {
      throw new HttpError(genericInviteError, 500);
    }

    return jsonResponse({ invited: true }, 200, request, allowedOrigins);
  } catch (error) {
    return responseForError(error, request);
  }
}

export async function handleRoute(request: Request) {
  const corsResponse = handleCors(request, allowedOrigins);
  return corsResponse ?? (await handleRequest(request));
}

if (typeof Deno !== "undefined" && typeof Deno.serve === "function") {
  Deno.serve(handleRoute);
}
