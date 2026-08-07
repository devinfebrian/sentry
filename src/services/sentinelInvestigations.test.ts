import { afterEach, describe, expect, it, vi } from "vitest";
import type { PostgrestMaybeSingleResponse, PostgrestSingleResponse } from "@supabase/supabase-js";
import type { Database } from "../lib/database.types";
import { createSentinelInvestigationService, type SentinelInvestigationClient } from "./sentinelInvestigations";

type InvestigationRow = Database["public"]["Tables"]["sentinel_investigations"]["Row"];
type InvestigationInsert = Database["public"]["Tables"]["sentinel_investigations"]["Insert"];
type InvestigationTable = ReturnType<SentinelInvestigationClient["from"]>;
type InvestigationReadQuery = ReturnType<InvestigationTable["select"]>;
type InvestigationInsertQuery = ReturnType<InvestigationTable["insert"]>;

const context = { workspaceId: "workspace-1", userId: "user-1" };

const row: InvestigationRow = {
  id: "database-id-1",
  workspace_id: context.workspaceId,
  reference: "INV-AB12CD34",
  entity: "Northstar Ltd",
  owner_id: "owner-1",
  status: "open",
  created_by: context.userId,
  created_at: "2026-08-05T08:00:00.000Z",
  updated_at: "2026-08-09T08:30:00.000Z",
};

function successResponse<T>(data: T): PostgrestSingleResponse<T> {
  return { data, error: null, status: 200, statusText: "OK", success: true, count: null };
}

function errorResponse<T>(code: string, message: string): PostgrestSingleResponse<T> {
  return {
    data: null,
    error: { code, message, details: "", hint: "", name: "PostgrestError", toJSON: () => ({ name: "PostgrestError", message, details: "", hint: "", code }) },
    status: 403,
    statusText: "Forbidden",
    success: false,
    count: null,
  };
}

function fakeReadQuery(
  listResponse: PostgrestSingleResponse<InvestigationRow[]>,
  maybeSingleResponse: PostgrestMaybeSingleResponse<InvestigationRow>,
) {
  let query!: InvestigationReadQuery;
  const eq = vi.fn((_column: "workspace_id" | "reference", _value: string): InvestigationReadQuery => query);
  const order = vi.fn((_column: "created_at", _options: { ascending: boolean }) => Promise.resolve(listResponse));
  const maybeSingle = vi.fn(() => Promise.resolve(maybeSingleResponse));
  const adapter = { eq, order, maybeSingle } satisfies InvestigationReadQuery;
  query = adapter;
  return { query: adapter, eq, order, maybeSingle };
}

function fakeInsertQuery(response: PostgrestSingleResponse<InvestigationRow>) {
  let query!: InvestigationInsertQuery;
  const select = vi.fn((_columns: "*"): InvestigationInsertQuery => query);
  const single = vi.fn(() => Promise.resolve(response));
  const adapter = { select, single } satisfies InvestigationInsertQuery;
  query = adapter;
  return { query: adapter, select, single };
}

function fakeReadClient(query: InvestigationReadQuery) {
  const select = vi.fn((_columns: "*"): InvestigationReadQuery => query);
  const insert = vi.fn((_values: InvestigationInsert): never => {
    throw new Error("Unexpected insert in read test.");
  });
  const from = vi.fn((_table: "sentinel_investigations") => ({ select, insert }));
  const client = { from } satisfies SentinelInvestigationClient;
  return {
    client,
    from,
  };
}

function fakeInsertClient(query: InvestigationInsertQuery) {
  const select = vi.fn((_columns: "*"): never => {
    throw new Error("Unexpected select in insert test.");
  });
  const insert = vi.fn((_values: InvestigationInsert): InvestigationInsertQuery => query);
  const from = vi.fn((_table: "sentinel_investigations") => ({ select, insert }));
  const client = { from } satisfies SentinelInvestigationClient;
  return { client, from, insert };
}

function fakeInsertClientSequence(queries: InvestigationInsertQuery[]) {
  let index = 0;
  const inserts = queries.map((query) => vi.fn((_values: InvestigationInsert): InvestigationInsertQuery => query));
  const select = vi.fn((_columns: "*"): never => {
    throw new Error("Unexpected select in insert test.");
  });
  const from = vi.fn((_table: "sentinel_investigations") => ({
    select,
    insert: inserts[Math.min(index++, inserts.length - 1)],
  }));
  const client = { from } satisfies SentinelInvestigationClient;
  return {
    client,
    from,
    inserts,
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("createSentinelInvestigationService", () => {
  it("lists workspace investigations without inventing risk or stage claims", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-10T08:00:00.000Z"));
    const { query } = fakeReadQuery(successResponse([row]), successResponse<InvestigationRow | null>(null));
    const { client, from } = fakeReadClient(query);
    const service = createSentinelInvestigationService(client, context);

    const result = await service.list();

    expect(from).toHaveBeenCalledWith("sentinel_investigations");
    expect(query.eq).toHaveBeenCalledWith("workspace_id", context.workspaceId);
    expect(query.order).toHaveBeenCalledWith("created_at", { ascending: false });
    expect(result).toEqual([
      {
        id: row.reference,
        databaseId: row.id,
        entity: row.entity,
        owner: row.owner_id,
        risk: "not-assessed",
        stageId: "not-started",
        status: row.status,
        ageDays: 5,
        lastActivity: row.updated_at,
        analysisStatus: "not-started",
      },
    ]);
  });

  it("creates a scoped investigation with a generated reference and creator context", async () => {
    const { query } = fakeInsertQuery(successResponse(row));
    const { client, from, insert } = fakeInsertClient(query);
    const service = createSentinelInvestigationService(client, context);

    const result = await service.create({ entity: "Northstar Ltd", ownerId: "owner-1" });
    const payload = insert.mock.calls[0][0];

    expect(from).toHaveBeenCalledWith("sentinel_investigations");
    expect(payload).toMatchObject({
      workspace_id: context.workspaceId,
      created_by: context.userId,
      entity: "Northstar Ltd",
      owner_id: "owner-1",
      status: "open",
    });
    expect(payload.reference).toMatch(/^INV-[0-9A-F]{12}$/);
    expect(result.analysisStatus).toBe("not-started");
  });

  it("retries a unique reference collision and returns the inserted investigation", async () => {
    const { query: collisionQuery } = fakeInsertQuery(errorResponse<InvestigationRow>("23505", "duplicate key value violates unique constraint"));
    const { query: successQuery } = fakeInsertQuery(successResponse(row));
    const { client, from, inserts } = fakeInsertClientSequence([collisionQuery, successQuery]);
    const service = createSentinelInvestigationService(client, context);

    await expect(service.create({ entity: "Northstar Ltd", ownerId: "owner-1" })).resolves.toMatchObject({ id: row.reference });

    expect(from).toHaveBeenCalledTimes(2);
    expect(from).toHaveBeenNthCalledWith(1, "sentinel_investigations");
    expect(from).toHaveBeenNthCalledWith(2, "sentinel_investigations");
    expect(inserts[0].mock.calls[0][0].reference).toMatch(/^INV-[0-9A-F]{12}$/);
    expect(inserts[1].mock.calls[0][0].reference).toMatch(/^INV-[0-9A-F]{12}$/);
  });

  it("surfaces an exhausted unique reference collision after bounded retries", async () => {
    const collision = () => fakeInsertQuery(errorResponse<InvestigationRow>("23505", "duplicate key value violates unique constraint")).query;
    const { client, from } = fakeInsertClientSequence([collision(), collision(), collision()]);
    const service = createSentinelInvestigationService(client, context);

    await expect(service.create({ entity: "Northstar Ltd", ownerId: "owner-1" })).rejects.toThrow(
      "Unable to create investigation: duplicate key value violates unique constraint",
    );
    expect(from).toHaveBeenCalledTimes(3);
  });

  it("does not retry non-unique create errors", async () => {
    const { query } = fakeInsertQuery(errorResponse<InvestigationRow>("42501", "permission denied"));
    const { client, from } = fakeInsertClient(query);
    const service = createSentinelInvestigationService(client, context);

    await expect(service.create({ entity: "Northstar Ltd", ownerId: "owner-1" })).rejects.toThrow(
      "Unable to create investigation: permission denied",
    );
    expect(from).toHaveBeenCalledTimes(1);
  });

  it("maps an unowned investigation and returns null for a missing reference", async () => {
    const { query, maybeSingle } = fakeReadQuery(successResponse<InvestigationRow[]>([]), successResponse<InvestigationRow | null>(null));
    const { client, from } = fakeReadClient(query);
    const service = createSentinelInvestigationService(client, context);

    await expect(service.getById("INV-MISSING1")).resolves.toBeNull();
    expect(from).toHaveBeenCalledWith("sentinel_investigations");
    expect(query.eq).toHaveBeenNthCalledWith(1, "workspace_id", context.workspaceId);
    expect(query.eq).toHaveBeenNthCalledWith(2, "reference", "INV-MISSING1");

    maybeSingle.mockResolvedValue(successResponse<InvestigationRow | null>({ ...row, owner_id: null }));
    await expect(service.getById(row.reference)).resolves.toMatchObject({ owner: "Unassigned" });
  });

  it("adds operation context when Supabase returns an error", async () => {
    const { query } = fakeReadQuery(errorResponse<InvestigationRow[]>("42501", "permission denied"), successResponse<InvestigationRow | null>(null));
    const { client, from } = fakeReadClient(query);
    const service = createSentinelInvestigationService(client, context);

    await expect(service.list()).rejects.toThrow("Unable to list investigations: permission denied");
    expect(from).toHaveBeenCalledWith("sentinel_investigations");
  });
});
