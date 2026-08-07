import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { HttpError, MAX_JSON_BODY_BYTES } from "../_shared/cors";
import type { Database } from "../../../src/lib/database.types";

const authMocks = vi.hoisted(() => ({
  createAdminClient: vi.fn(),
  requireUser: vi.fn(),
}));

vi.mock("../_shared/auth.ts", () => authMocks);

type QueryResult = { data: unknown; error: { code?: string } | null };
type ActivityEventInsert = Database["public"]["Tables"]["sentinel_activity_events"]["Insert"];
type Reservation = {
  id: string;
  workspace_id: string;
  email: string;
  auth_user_id: string | null;
  invited_by: string;
  status: "reserved" | "completed" | "failed";
  updated_at: string;
};

function staleReservationTimestamp() {
  return new Date(Date.now() - 16 * 60 * 1000).toISOString();
}

function exactLeaseBoundaryTimestamp() {
  return new Date(Date.now() - 15 * 60 * 1000).toISOString();
}

class InterleavingEventAdapter {
  readonly attempts: ActivityEventInsert[] = [];
  readonly persisted: ActivityEventInsert[] = [];
  private readonly errors: Array<{ code: string } | null> = [null, { code: "23505" }];

  async insert(row: ActivityEventInsert) {
    this.attempts.push(row);
    const error = this.errors.shift() ?? null;
    if (!error) {
      this.persisted.push(row);
    }
    return { error };
  }
}

function selectQuery(result: QueryResult | (() => QueryResult)) {
  const query = {
    select: vi.fn(() => query),
    eq: vi.fn(() => query),
    contains: vi.fn(() => query),
    limit: vi.fn(async () => (typeof result === "function" ? result() : result)),
    maybeSingle: vi.fn(async () => (typeof result === "function" ? result() : result)),
  };

  return query;
}

type ReservationPredicate = { column: string; operator: "eq" | "lt" | "lte"; value: unknown };

function matchesReservationPredicate(reservation: Reservation, predicate: ReservationPredicate) {
  const actual = reservation[predicate.column as keyof Reservation];
  if (predicate.operator === "eq") {
    return actual === predicate.value;
  }

  if (predicate.column === "updated_at") {
    const actualTime = Date.parse(String(actual));
    const expectedTime = Date.parse(String(predicate.value));
    return predicate.operator === "lte" ? actualTime <= expectedTime : actualTime < expectedTime;
  }

  return predicate.operator === "lte" ? String(actual) <= String(predicate.value) : String(actual) < String(predicate.value);
}

function reservationSelectQuery(getReservation: () => Reservation | null) {
  const predicates: ReservationPredicate[] = [];
  const query = {
    select: vi.fn(() => query),
    eq: vi.fn((column: string, value: unknown) => {
      predicates.push({ column, operator: "eq", value });
      return query;
    }),
    lt: vi.fn((column: string, value: unknown) => {
      predicates.push({ column, operator: "lt", value });
      return query;
    }),
    lte: vi.fn((column: string, value: unknown) => {
      predicates.push({ column, operator: "lte", value });
      return query;
    }),
    maybeSingle: vi.fn(async () => {
      const reservation = getReservation();
      return {
        data: reservation && predicates.every((predicate) => matchesReservationPredicate(reservation, predicate)) ? reservation : null,
        error: null,
      };
    }),
  };

  return query;
}

function reservationUpdateQuery(
  values: Record<string, unknown>,
  getReservation: () => Reservation | null,
  setReservation: (reservation: Reservation) => void,
  predicateLog: ReservationPredicate[][] = [],
) {
  const predicates: ReservationPredicate[] = [];
  const query = {
    select: vi.fn(() => query),
    eq: vi.fn((column: string, value: unknown) => {
      predicates.push({ column, operator: "eq", value });
      return query;
    }),
    lt: vi.fn((column: string, value: unknown) => {
      predicates.push({ column, operator: "lt", value });
      return query;
    }),
    lte: vi.fn((column: string, value: unknown) => {
      predicates.push({ column, operator: "lte", value });
      return query;
    }),
    maybeSingle: vi.fn(async () => {
      predicateLog.push([...predicates]);
      const reservation = getReservation();
      if (!reservation || !predicates.every((predicate) => matchesReservationPredicate(reservation, predicate))) {
        return { data: null, error: null };
      }

      const updated = { ...reservation, ...values } as Reservation;
      setReservation(updated);
      return { data: updated, error: null };
    }),
  };

  return query;
}

function request({ method = "POST", origin, body = { email: " Analyst@Example.COM ", role: "analyst" } } = {}) {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (origin) {
    headers.set("Origin", origin);
  }

  const init: RequestInit = { method, headers };
  if (method !== "GET" && method !== "HEAD") {
    init.body = JSON.stringify(body);
  }

  return new Request("http://localhost/functions/v1/invite-member", init);
}

function userClient(events: unknown[] = [], role: "manager" | "analyst" = "manager") {
  const memberships = selectQuery({
    data: [{ workspace_id: "workspace-1", role, status: "active" }],
    error: null,
  });
  const activity = {
    select: vi.fn(() => selectQuery(() => ({ data: events, error: null }))),
  };

  return {
    from: vi.fn((table: string) => (table === "sentinel_members" ? memberships : activity)),
    activity,
  };
}

function adminClient({
  pending = null,
  events = [] as unknown[],
  memberError = null,
  eventError = null,
  reservation = {
    id: "reservation-1",
    workspace_id: "workspace-1",
    email: "analyst@example.com",
    auth_user_id: null,
    invited_by: "manager-1",
    status: "reserved",
    updated_at: new Date().toISOString(),
  } as Reservation,
  reservationInsertError = null as { code?: string } | null,
} = {}) {
  const members = {
    select: vi.fn(() => selectQuery(() => ({ data: pending ? [pending] : [], error: null }))),
    insert: vi.fn(async () => ({ error: memberError })),
  };
  let storedReservation: Reservation | null = reservation;
  let reservationInsertAttempts = 0;
  const reservationUpdatePredicates: ReservationPredicate[][] = [];
  const reservations = {
    insert: vi.fn(() => {
      reservationInsertAttempts += 1;
      if (reservationInsertAttempts === 1 && !reservationInsertError) {
        storedReservation = reservation;
      }
      return selectQuery(
        reservationInsertError
          ? { data: null, error: reservationInsertError }
          : reservationInsertAttempts === 1
            ? { data: reservation, error: null }
            : { data: null, error: { code: "23505" } },
      );
    }),
    select: vi.fn(() => reservationSelectQuery(() => storedReservation)),
    update: vi.fn((values: Record<string, unknown>) => reservationUpdateQuery(
      values,
      () => storedReservation,
      (next) => {
        storedReservation = next;
      },
      reservationUpdatePredicates,
    )),
  };
  const activity = {
    select: vi.fn(() => selectQuery({ data: events, error: null })),
    insert: vi.fn(async () => ({ error: eventError })),
  };

  return {
    auth: {
      admin: {
        inviteUserByEmail: vi.fn(async () => ({ data: { user: { id: "member-1" } }, error: null })),
        listUsers: vi.fn(async () => ({ data: { users: [] }, error: null })),
      },
    },
    from: vi.fn((table: string) => {
      if (table === "sentinel_members") return members;
      if (table === "sentinel_invitation_reservations") return reservations;
      return activity;
    }),
    members,
    reservations,
    reservationUpdatePredicates,
    activity,
  };
}

async function responseBody(response: Response) {
  return (await response.json()) as Record<string, unknown>;
}

let handleRequest: (request: Request) => Promise<Response>;
let handleRoute: (request: Request) => Promise<Response>;

beforeAll(async () => {
  vi.stubGlobal("Deno", { serve: vi.fn() });
  ({ handleRequest, handleRoute } = await import("./index.ts"));
});

afterEach(() => {
  vi.clearAllMocks();
});

afterAll(() => {
  vi.unstubAllGlobals();
});

describe("invite-member idempotency", () => {
  it("reserves before Auth and persists returned user before membership insert", async () => {
    const calls: string[] = [];
    const reservation: Reservation = {
      id: "reservation-1",
      workspace_id: "workspace-1",
      email: "analyst@example.com",
      auth_user_id: null,
      invited_by: "manager-1",
      status: "reserved",
      updated_at: new Date().toISOString(),
    };
    const admin = adminClient({ reservation });
    admin.reservations.insert.mockImplementation((row: Record<string, unknown>) => {
      calls.push("reserve");
      expect(row).toEqual({
        workspace_id: "workspace-1",
        email: "analyst@example.com",
        invited_by: "manager-1",
        status: "reserved",
      });
      return selectQuery({ data: reservation, error: null });
    });
    admin.auth.admin.inviteUserByEmail.mockImplementation(async () => {
      calls.push("auth");
      return { data: { user: { id: "member-1" } }, error: null };
    });
    admin.reservations.update.mockImplementation((values: Record<string, unknown>) => {
      calls.push(`reservation-update:${String(values.auth_user_id ?? values.status)}`);
      return selectQuery({ data: { ...reservation, auth_user_id: "member-1" }, error: null });
    });
    admin.members.insert.mockImplementation(async () => {
      calls.push("membership");
      return { error: null };
    });
    authMocks.requireUser.mockResolvedValue({ client: userClient(), user: { id: "manager-1", email: "manager@example.com" } });
    authMocks.createAdminClient.mockResolvedValue(admin);

    const response = await handleRequest(request());

    expect(response.status).toBe(200);
    expect(admin.auth.admin.inviteUserByEmail).toHaveBeenCalledTimes(1);
    expect(calls.indexOf("reserve")).toBeLessThan(calls.indexOf("auth"));
    expect(calls.indexOf("auth")).toBeLessThan(calls.indexOf("reservation-update:member-1"));
    expect(calls.indexOf("reservation-update:member-1")).toBeLessThan(calls.indexOf("membership"));
  });

  it("loads reservation after unique conflict without sending another Auth invite", async () => {
    const reservation: Reservation = {
      id: "reservation-1",
      workspace_id: "workspace-1",
      email: "analyst@example.com",
      auth_user_id: null,
      invited_by: "manager-1",
      status: "reserved",
      updated_at: new Date().toISOString(),
    };
    const admin = adminClient({ reservation, reservationInsertError: { code: "23505" } });
    authMocks.requireUser.mockResolvedValue({ client: userClient(), user: { id: "manager-1", email: "manager@example.com" } });
    authMocks.createAdminClient.mockResolvedValue(admin);

    const response = await handleRequest(request());

    expect(response.status).toBe(409);
    expect(await responseBody(response)).toEqual({ error: "Invitation already pending." });
    expect(admin.reservations.select).toHaveBeenCalledTimes(1);
    expect(admin.auth.admin.inviteUserByEmail).not.toHaveBeenCalled();
    expect(admin.members.insert).not.toHaveBeenCalled();
  });

  it("returns pending to concurrent loser when failed reservation has no Auth user", async () => {
    const reservation: Reservation = {
      id: "reservation-1",
      workspace_id: "workspace-1",
      email: "analyst@example.com",
      auth_user_id: null,
      invited_by: "manager-1",
      status: "failed",
      updated_at: new Date().toISOString(),
    };
    const admin = adminClient({ reservation, reservationInsertError: { code: "23505" } });
    authMocks.requireUser.mockResolvedValue({ client: userClient(), user: { id: "manager-1", email: "manager@example.com" } });
    authMocks.createAdminClient.mockResolvedValue(admin);

    const [firstResponse, secondResponse] = await Promise.all([handleRequest(request()), handleRequest(request())]);

    expect([firstResponse.status, secondResponse.status].sort()).toEqual([200, 409]);
    expect(admin.auth.admin.inviteUserByEmail).toHaveBeenCalledTimes(1);
    expect(admin.members.insert).toHaveBeenCalledTimes(1);
    expect(await responseBody(firstResponse.status === 409 ? firstResponse : secondResponse)).toEqual({
      error: "Invitation already pending.",
    });
  });

  it("reclaims stale reserved reservation without Auth user", async () => {
    const reservation: Reservation = {
      id: "reservation-1",
      workspace_id: "workspace-1",
      email: "analyst@example.com",
      auth_user_id: null,
      invited_by: "manager-1",
      status: "reserved",
      updated_at: staleReservationTimestamp(),
    };
    const admin = adminClient({ reservation, reservationInsertError: { code: "23505" } });
    authMocks.requireUser.mockResolvedValue({ client: userClient(), user: { id: "manager-1", email: "manager@example.com" } });
    authMocks.createAdminClient.mockResolvedValue(admin);

    const response = await handleRequest(request());

    expect(response.status).toBe(200);
    expect(admin.auth.admin.inviteUserByEmail).toHaveBeenCalledTimes(1);
    expect(admin.reservations.update).toHaveBeenCalledWith(expect.objectContaining({ status: "reserved" }));
    expect(admin.reservationUpdatePredicates.flat().some(({ column, operator }) => column === "updated_at" && operator === "lte")).toBe(true);
  });

  it("treats exact 15-minute reservation age as stale and guards post-claim writes", async () => {
    const reservation: Reservation = {
      id: "reservation-1",
      workspace_id: "workspace-1",
      email: "analyst@example.com",
      auth_user_id: null,
      invited_by: "manager-1",
      status: "reserved",
      updated_at: exactLeaseBoundaryTimestamp(),
    };
    const admin = adminClient({ reservation, reservationInsertError: { code: "23505" } });
    authMocks.requireUser.mockResolvedValue({ client: userClient(), user: { id: "manager-1", email: "manager@example.com" } });
    authMocks.createAdminClient.mockResolvedValue(admin);

    const response = await handleRequest(request());

    expect(response.status).toBe(200);
    expect(admin.auth.admin.inviteUserByEmail).toHaveBeenCalledTimes(1);
    expect(admin.reservationUpdatePredicates).toHaveLength(3);
    expect(admin.reservationUpdatePredicates.every((predicates) =>
      predicates.some(({ column, operator }) => column === "updated_at" && operator === "eq"),
    )).toBe(true);
  });

  it("reclaims stale reserved reservation with stored Auth user after crash before membership", async () => {
    const reservation: Reservation = {
      id: "reservation-1",
      workspace_id: "workspace-1",
      email: "analyst@example.com",
      auth_user_id: "member-1",
      invited_by: "manager-1",
      status: "reserved",
      updated_at: staleReservationTimestamp(),
    };
    const admin = adminClient({ reservation, reservationInsertError: { code: "23505" } });
    authMocks.requireUser.mockResolvedValue({ client: userClient(), user: { id: "manager-1", email: "manager@example.com" } });
    authMocks.createAdminClient.mockResolvedValue(admin);

    const response = await handleRequest(request());

    expect(response.status).toBe(200);
    expect(admin.auth.admin.inviteUserByEmail).not.toHaveBeenCalled();
    expect(admin.members.insert).toHaveBeenCalledWith({
      workspace_id: "workspace-1",
      user_id: "member-1",
      role: "analyst",
      status: "pending",
      invited_email: "analyst@example.com",
    });
  });

  it("recovers Auth user after crash before reservation persistence without a second invite", async () => {
    const reservation: Reservation = {
      id: "reservation-1",
      workspace_id: "workspace-1",
      email: "analyst@example.com",
      auth_user_id: null,
      invited_by: "manager-1",
      status: "reserved",
      updated_at: staleReservationTimestamp(),
    };
    const admin = adminClient({ reservation });
    let storedReservation = reservation;
    let insertAttempts = 0;
    let authLookupAttempts = 0;
    let authPersistenceFailed = false;
    admin.reservations.insert.mockImplementation(() => {
      insertAttempts += 1;
      return insertAttempts === 1
        ? selectQuery({ data: reservation, error: null })
        : selectQuery({ data: null, error: { code: "23505" } });
    });
    admin.reservations.select.mockImplementation(() => reservationSelectQuery(() => storedReservation));
    admin.reservations.update.mockImplementation((values: Record<string, unknown>) => {
      if ("auth_user_id" in values && !authPersistenceFailed) {
        authPersistenceFailed = true;
        return selectQuery({ data: null, error: { code: "42501" } });
      }

      return reservationUpdateQuery(values, () => storedReservation, (next) => {
        storedReservation = next;
      });
    });
    admin.auth.admin.listUsers.mockImplementation(async ({ page, perPage }: { page: number; perPage: number }) => {
      expect({ page, perPage }).toEqual({ page: 1, perPage: 100 });
      authLookupAttempts += 1;
      return {
        data: {
          users: authLookupAttempts === 1 ? [] : [{ id: "member-1", email: " Analyst@Example.COM " }],
        },
        error: null,
      };
    });
    authMocks.requireUser.mockResolvedValue({ client: userClient(), user: { id: "manager-1", email: "manager@example.com" } });
    authMocks.createAdminClient.mockResolvedValue(admin);

    const firstResponse = await handleRequest(request());
    const secondResponse = await handleRequest(request());

    expect(firstResponse.status).toBe(500);
    expect(secondResponse.status).toBe(200);
    expect(admin.auth.admin.listUsers).toHaveBeenCalledTimes(2);
    expect(admin.auth.admin.inviteUserByEmail).toHaveBeenCalledTimes(1);
    expect(admin.members.insert).toHaveBeenCalledWith({
      workspace_id: "workspace-1",
      user_id: "member-1",
      role: "analyst",
      status: "pending",
      invited_email: "analyst@example.com",
    });
  });

  it("paginates Auth users until matching email appears after first page", async () => {
    const reservation: Reservation = {
      id: "reservation-1",
      workspace_id: "workspace-1",
      email: "analyst@example.com",
      auth_user_id: null,
      invited_by: "manager-1",
      status: "reserved",
      updated_at: staleReservationTimestamp(),
    };
    const admin = adminClient({ reservation, reservationInsertError: { code: "23505" } });
    const pages: number[] = [];
    admin.auth.admin.listUsers.mockImplementation(async ({ page, perPage }: { page: number; perPage: number }) => {
      pages.push(page);
      expect(perPage).toBe(100);
      return {
        data: {
          users: page === 1
            ? Array.from({ length: 100 }, (_, index) => ({ id: `other-${index}`, email: `other-${index}@example.com` }))
            : [{ id: "member-later", email: " Analyst@Example.COM " }],
        },
        error: null,
      };
    });
    authMocks.requireUser.mockResolvedValue({ client: userClient(), user: { id: "manager-1", email: "manager@example.com" } });
    authMocks.createAdminClient.mockResolvedValue(admin);

    const response = await handleRequest(request());

    expect(response.status).toBe(200);
    expect(pages).toEqual([1, 2]);
    expect(admin.auth.admin.inviteUserByEmail).not.toHaveBeenCalled();
    expect(admin.members.insert).toHaveBeenCalledWith({
      workspace_id: "workspace-1",
      user_id: "member-later",
      role: "analyst",
      status: "pending",
      invited_email: "analyst@example.com",
    });
  });

  it("retries failed membership with stored Auth user without sending another invite", async () => {
    const reservation: Reservation = {
      id: "reservation-1",
      workspace_id: "workspace-1",
      email: "analyst@example.com",
      auth_user_id: "member-1",
      invited_by: "manager-1",
      status: "failed",
      updated_at: new Date().toISOString(),
    };
    const admin = adminClient({ reservation });
    let memberInsertAttempts = 0;
    admin.reservations.insert.mockImplementation(() => selectQuery({ data: null, error: { code: "23505" } }));
    admin.reservations.update.mockImplementation((values: Record<string, unknown>) => {
      const updated = { ...reservation, ...values } as Reservation;
      return selectQuery({ data: updated, error: null });
    });
    admin.members.insert.mockImplementation(async (row: Record<string, unknown>) => {
      memberInsertAttempts += 1;
      expect(row.user_id).toBe("member-1");
      return { error: null };
    });
    authMocks.requireUser.mockResolvedValue({ client: userClient(), user: { id: "manager-1", email: "manager@example.com" } });
    authMocks.createAdminClient.mockResolvedValue(admin);

    const response = await handleRequest(request());

    expect(response.status).toBe(200);
    expect(memberInsertAttempts).toBe(1);
    expect(admin.auth.admin.inviteUserByEmail).not.toHaveBeenCalled();
    expect(admin.reservations.update).toHaveBeenCalledWith(expect.objectContaining({ status: "reserved" }));
    expect(admin.reservations.update).toHaveBeenCalledWith(expect.objectContaining({ status: "completed" }));
  });

  it("marks membership failure failed and retries it without another Auth invite", async () => {
    const initialReservation: Reservation = {
      id: "reservation-1",
      workspace_id: "workspace-1",
      email: "analyst@example.com",
      auth_user_id: null,
      invited_by: "manager-1",
      status: "reserved",
      updated_at: new Date().toISOString(),
    };
    const admin = adminClient({ reservation: initialReservation });
    let reservationStatus: Reservation["status"] = "reserved";
    let authUserId: string | null = null;
    let memberInsertAttempts = 0;
    admin.reservations.insert.mockImplementation(() =>
      reservationStatus === "reserved" && memberInsertAttempts === 0
        ? selectQuery({ data: initialReservation, error: null })
        : selectQuery({ data: null, error: { code: "23505" } }),
    );
    admin.reservations.select.mockImplementation(() => selectQuery({
      data: { ...initialReservation, status: reservationStatus, auth_user_id: authUserId },
      error: null,
    }));
    admin.reservations.update.mockImplementation((values: Record<string, unknown>) => {
      reservationStatus = (values.status as Reservation["status"] | undefined) ?? reservationStatus;
      authUserId = (values.auth_user_id as string | undefined) ?? authUserId;
      return selectQuery({
        data: { ...initialReservation, status: reservationStatus, auth_user_id: authUserId },
        error: null,
      });
    });
    admin.members.insert.mockImplementation(async () => {
      memberInsertAttempts += 1;
      return memberInsertAttempts === 1 ? { error: { code: "42501" } } : { error: null };
    });
    authMocks.requireUser.mockResolvedValue({ client: userClient(), user: { id: "manager-1", email: "manager@example.com" } });
    authMocks.createAdminClient.mockResolvedValue(admin);

    const firstResponse = await handleRequest(request());
    const secondResponse = await handleRequest(request());

    expect(firstResponse.status).toBe(500);
    expect(secondResponse.status).toBe(200);
    expect(admin.auth.admin.inviteUserByEmail).toHaveBeenCalledTimes(1);
    expect(admin.members.insert).toHaveBeenCalledTimes(2);
    expect(admin.reservations.update).toHaveBeenCalledWith(expect.objectContaining({ status: "failed" }));
    expect(admin.reservations.update).toHaveBeenCalledWith(expect.objectContaining({ status: "reserved" }));
    expect(admin.reservations.update).toHaveBeenCalledWith(expect.objectContaining({ status: "completed" }));
  });

  it("repairs missing event from reservation Auth user and returns pending conflict", async () => {
    const reservation: Reservation = {
      id: "reservation-1",
      workspace_id: "workspace-1",
      email: "analyst@example.com",
      auth_user_id: "member-1",
      invited_by: "manager-1",
      status: "completed",
      updated_at: new Date().toISOString(),
    };
    const pendingMembership = {
      workspace_id: "workspace-1",
      user_id: "member-1",
      role: "analyst",
      status: "pending",
      invited_email: "analyst@example.com",
    };
    const admin = adminClient({ reservation, pending: pendingMembership, reservationInsertError: { code: "23505" } });
    const client = userClient();
    authMocks.requireUser.mockResolvedValue({ client, user: { id: "manager-1", email: "manager@example.com" } });
    authMocks.createAdminClient.mockResolvedValue(admin);

    const response = await handleRequest(request());

    expect(response.status).toBe(409);
    expect(await responseBody(response)).toEqual({ error: "Invitation already pending." });
    expect(admin.auth.admin.inviteUserByEmail).not.toHaveBeenCalled();
    expect(client.activity.select).toHaveBeenCalled();
    expect(admin.activity.insert).toHaveBeenCalledWith({
      workspace_id: "workspace-1",
      actor_id: "manager-1",
      event_type: "member-invited",
      metadata: { member_user_id: "member-1", role: "analyst" },
    });
  });

  it("does not invite, insert, or emit again on repeated invite", async () => {
    let pendingMembership: Record<string, unknown> | null = null;
    const events: unknown[] = [];
    const admin = adminClient();
    const client = userClient(events);
    admin.members.select.mockImplementation(() =>
      selectQuery(() => ({ data: pendingMembership ? [pendingMembership] : [], error: null })),
    );
    admin.members.insert.mockImplementation(async (row: Record<string, unknown>) => {
      pendingMembership = { ...row, user_id: "member-1" };
      return { error: null };
    });
    admin.activity.insert.mockImplementation(async (row: unknown) => {
      events.push(row);
      return { error: null };
    });
    authMocks.requireUser.mockResolvedValue({ client, user: { id: "manager-1", email: "manager@example.com" } });
    authMocks.createAdminClient.mockResolvedValue(admin);

    const firstResponse = await handleRequest(request());
    const secondResponse = await handleRequest(request());

    expect(firstResponse.status).toBe(200);
    expect(await responseBody(firstResponse)).toEqual({ invited: true });
    expect(secondResponse.status).toBe(409);
    expect(await responseBody(secondResponse)).toEqual({ error: "Invitation already pending." });
    expect(admin.auth.admin.inviteUserByEmail).toHaveBeenCalledTimes(1);
    expect(admin.members.insert).toHaveBeenCalledTimes(1);
    expect(admin.activity.insert).toHaveBeenCalledTimes(1);
    expect(admin.activity.insert).toHaveBeenCalledWith({
      workspace_id: "workspace-1",
      actor_id: "manager-1",
      event_type: "member-invited",
      metadata: { member_user_id: "member-1", role: "analyst" },
    });
  });

  it("reconciles missing member-invited event without calling Auth invite", async () => {
    const pendingMembership = {
      workspace_id: "workspace-1",
      user_id: "member-1",
      role: "analyst",
      status: "pending",
      invited_email: "analyst@example.com",
    };
    const admin = adminClient({
      pending: pendingMembership,
      reservation: {
        id: "reservation-1",
        workspace_id: "workspace-1",
        email: "analyst@example.com",
        auth_user_id: "member-1",
        invited_by: "manager-1",
        status: "completed",
        updated_at: new Date().toISOString(),
      },
      reservationInsertError: { code: "23505" },
    });
    authMocks.requireUser.mockResolvedValue({ client: userClient(), user: { id: "manager-1", email: "manager@example.com" } });
    authMocks.createAdminClient.mockResolvedValue(admin);

    const response = await handleRequest(request());

    expect(response.status).toBe(409);
    expect(await responseBody(response)).toEqual({ error: "Invitation already pending." });
    expect(admin.auth.admin.inviteUserByEmail).not.toHaveBeenCalled();
    expect(admin.members.insert).not.toHaveBeenCalled();
    expect(admin.activity.select).not.toHaveBeenCalled();
    expect(admin.activity.insert).toHaveBeenCalledWith({
      workspace_id: "workspace-1",
      actor_id: "manager-1",
      event_type: "member-invited",
      metadata: { member_user_id: "member-1", role: "analyst" },
    });
  });

  it("treats unique event identity conflict as successful reconciliation", async () => {
    const pendingMembership = {
      workspace_id: "workspace-1",
      user_id: "member-1",
      role: "analyst",
      status: "pending",
      invited_email: "analyst@example.com",
    };
    const admin = adminClient({
      pending: pendingMembership,
      reservation: {
        id: "reservation-1",
        workspace_id: "workspace-1",
        email: "analyst@example.com",
        auth_user_id: "member-1",
        invited_by: "manager-1",
        status: "completed",
        updated_at: new Date().toISOString(),
      },
      reservationInsertError: { code: "23505" },
    });
    const eventAdapter = new InterleavingEventAdapter();
    const client = userClient();
    admin.activity.insert.mockImplementation((row: unknown) => eventAdapter.insert(row as ActivityEventInsert));
    authMocks.requireUser.mockResolvedValue({ client, user: { id: "manager-1", email: "manager@example.com" } });
    authMocks.createAdminClient.mockResolvedValue(admin);

    const [firstResponse, secondResponse] = await Promise.all([handleRequest(request()), handleRequest(request())]);

    expect([firstResponse.status, secondResponse.status]).toEqual([409, 409]);
    expect(eventAdapter.attempts).toHaveLength(2);
    expect(eventAdapter.persisted).toHaveLength(1);
    expect(eventAdapter.persisted[0]?.metadata).toEqual({ member_user_id: "member-1", role: "analyst" });
    expect(await responseBody(firstResponse)).toEqual({ error: "Invitation already pending." });
    expect(await responseBody(secondResponse)).toEqual({ error: "Invitation already pending." });
  });

  it("reconciles reservation race without sending a second Auth invite", async () => {
    const pendingMembership = {
      workspace_id: "workspace-1",
      user_id: "member-1",
      role: "analyst",
      status: "pending",
      invited_email: "analyst@example.com",
    };
    const events: unknown[] = [];
    const admin = adminClient();
    const client = userClient(events);
    const lookupResults = [
      { data: [], error: null },
      { data: [], error: null },
      { data: [pendingMembership], error: null },
    ];
    let insertAttempts = 0;

    admin.members.select.mockImplementation(() => selectQuery(() => lookupResults.shift() ?? { data: [pendingMembership], error: null }));
    admin.members.insert.mockImplementation(async () => {
      insertAttempts += 1;
      return insertAttempts === 1 ? { error: null } : { error: { code: "23505" } };
    });
    admin.activity.insert.mockImplementation(async (row: unknown) => {
      events.push(row);
      return { error: null };
    });
    authMocks.requireUser.mockResolvedValue({ client, user: { id: "manager-1", email: "manager@example.com" } });
    authMocks.createAdminClient.mockResolvedValue(admin);

    const [firstResponse, secondResponse] = await Promise.all([handleRequest(request()), handleRequest(request())]);

    expect([firstResponse.status, secondResponse.status].sort()).toEqual([200, 409]);
    expect(admin.auth.admin.inviteUserByEmail).toHaveBeenCalledTimes(1);
    expect(admin.members.insert).toHaveBeenCalledTimes(1);
    expect(admin.members.select).toHaveBeenCalledTimes(2);
    expect(client.activity.select).toHaveBeenCalledTimes(0);
    expect(admin.activity.insert).toHaveBeenCalledTimes(1);
    expect(events).toHaveLength(1);
  });
});

describe("invite-member route", () => {
  it("returns 405 for non-POST requests before authentication", async () => {
    const response = await handleRequest(request({ method: "GET" }));

    expect(response.status).toBe(405);
    expect(await responseBody(response)).toEqual({ error: "Method not allowed." });
    expect(authMocks.requireUser).not.toHaveBeenCalled();
  });

  it("returns 401 for unauthenticated POST", async () => {
    authMocks.requireUser.mockRejectedValue(new HttpError("Authentication required.", 401));

    const response = await handleRequest(request());

    expect(response.status).toBe(401);
    expect(await responseBody(response)).toEqual({ error: "Authentication required." });
    expect(authMocks.createAdminClient).not.toHaveBeenCalled();
  });

  it("authenticates before consuming an oversized request body", async () => {
    const requestToAuthenticate = new Request("http://localhost/functions/v1/invite-member", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": String(MAX_JSON_BODY_BYTES + 1),
      },
      body: JSON.stringify({ email: "analyst@example.com", role: "analyst" }),
    });
    authMocks.requireUser.mockRejectedValue(new HttpError("Authentication required.", 401));

    const response = await handleRequest(requestToAuthenticate);

    expect(response.status).toBe(401);
    expect(requestToAuthenticate.bodyUsed).toBe(false);
  });

  it("authorizes manager membership before consuming request JSON", async () => {
    const requestToAuthorize = new Request("http://localhost/functions/v1/invite-member", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not-json",
    });
    authMocks.requireUser.mockResolvedValue({
      client: userClient([], "analyst"),
      user: { id: "analyst-1", email: "analyst@example.com" },
    });

    const response = await handleRequest(requestToAuthorize);

    expect(response.status).toBe(403);
    expect(await responseBody(response)).toEqual({ error: "Manager membership required." });
    expect(requestToAuthorize.bodyUsed).toBe(false);
  });

  it("returns 403 for analyst caller", async () => {
    authMocks.requireUser.mockResolvedValue({
      client: userClient([], "analyst"),
      user: { id: "analyst-1", email: "analyst@example.com" },
    });

    const response = await handleRequest(request());

    expect(response.status).toBe(403);
    expect(await responseBody(response)).toEqual({ error: "Manager membership required." });
    expect(authMocks.createAdminClient).not.toHaveBeenCalled();
  });

  it("keeps CORS OPTIONS wrapper strict", async () => {
    const allowed = await handleRoute(request({ method: "OPTIONS", origin: "http://localhost:5173" }));
    expect(allowed.status).toBe(204);
    expect(allowed.headers.get("Access-Control-Allow-Origin")).toBe("http://localhost:5173");
    expect(authMocks.requireUser).not.toHaveBeenCalled();

    const blocked = await handleRoute(request({ method: "OPTIONS", origin: "https://evil.example" }));
    expect(blocked.status).toBe(403);
    expect(await responseBody(blocked)).toEqual({ error: "Origin not allowed." });
    expect(authMocks.requireUser).not.toHaveBeenCalled();
  });
});

describe("invite-member failure mapping", () => {
  it("returns generic server error when pending membership lookup fails", async () => {
    const admin = adminClient();
    admin.members.select.mockReturnValue(selectQuery({ data: null, error: { code: "42501" } }));
    authMocks.requireUser.mockResolvedValue({ client: userClient(), user: { id: "manager-1", email: "manager@example.com" } });
    authMocks.createAdminClient.mockResolvedValue(admin);

    const response = await handleRequest(request());

    expect(response.status).toBe(500);
    expect(await responseBody(response)).toEqual({ error: "Unable to invite member." });
    expect(admin.auth.admin.inviteUserByEmail).not.toHaveBeenCalled();
  });

  it("returns generic server error when event write fails after membership write", async () => {
    const admin = adminClient({ eventError: { code: "42501" } });
    authMocks.requireUser.mockResolvedValue({ client: userClient(), user: { id: "manager-1", email: "manager@example.com" } });
    authMocks.createAdminClient.mockResolvedValue(admin);

    const response = await handleRequest(request());

    expect(response.status).toBe(500);
    expect(await responseBody(response)).toEqual({ error: "Unable to invite member." });
    expect(admin.members.insert).toHaveBeenCalledWith({
      workspace_id: "workspace-1",
      user_id: "member-1",
      role: "analyst",
      status: "pending",
      invited_email: "analyst@example.com",
    });
  });
});
