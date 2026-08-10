import { afterEach, describe, expect, it, vi } from "vitest";
import type { PostgrestMaybeSingleResponse, PostgrestSingleResponse } from "@supabase/supabase-js";
import type { Database } from "../lib/database.types";
import { createSentinelInvestigationService, type SentinelInvestigationClient } from "./sentinelInvestigations";

type InvestigationInsert = Database["public"]["Tables"]["sentinel_investigations"]["Insert"];
type InvestigationTable = ReturnType<SentinelInvestigationClient["from"]>;
type InvestigationReadQuery = ReturnType<InvestigationTable["select"]>;
type InvestigationInsertQuery = ReturnType<InvestigationTable["insert"]>;

const context = { workspaceId: "workspace-1", userId: "user-1" };

// The view, not the table. database.types.ts is hand-curated and analysis relations stay
// out of it, so this shape is declared structurally — the same convention sentinelAnalysis
// follows for findings.
type InvestigationRow = {
  id: string;
  workspace_id: string;
  reference: string;
  entity: string;
  owner_id: string | null;
  status: "open" | "review" | "approved" | "closed";
  created_at: string;
  updated_at: string;
  risk: "low" | "medium" | "high" | "not-assessed";
  stage: string;
};

const row: InvestigationRow = {
  id: "database-id-1",
  workspace_id: context.workspaceId,
  reference: "INV-AB12CD34",
  entity: "Northstar Ltd",
  owner_id: "owner-1",
  status: "open",
  created_at: "2026-08-05T08:00:00.000Z",
  updated_at: "2026-08-09T08:30:00.000Z",
  risk: "medium",
  stage: "fraud-review",
};

// What an insert into sentinel_investigations actually returns: the table row, which has
// created_by and neither risk nor stage — the opposite of what the view row above carries.
// create() maps this, so its fakes must be typed as this shape rather than InvestigationRow.
type InvestigationTableRow = Database["public"]["Tables"]["sentinel_investigations"]["Row"];

const tableRow: InvestigationTableRow = {
  id: row.id,
  workspace_id: row.workspace_id,
  reference: row.reference,
  entity: row.entity,
  owner_id: row.owner_id,
  status: row.status,
  created_by: context.userId,
  created_at: row.created_at,
  updated_at: row.updated_at,
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

function fakeInsertQuery(response: PostgrestSingleResponse<InvestigationTableRow>) {
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
  const from = vi.fn((_table: "sentinel_investigations" | "sentinel_investigation_queue") => ({ select, insert }));
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
  const from = vi.fn((_table: "sentinel_investigations" | "sentinel_investigation_queue") => ({ select, insert }));
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
  it("lists workspace investigations with the risk and stage the view derived", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-10T08:00:00.000Z"));
    const { query } = fakeReadQuery(successResponse([row]), successResponse<InvestigationRow | null>(null));
    const { client, from } = fakeReadClient(query);
    const service = createSentinelInvestigationService(client, context);

    const result = await service.list();

    expect(from).toHaveBeenCalledWith("sentinel_investigation_queue");
    expect(query.eq).toHaveBeenCalledWith("workspace_id", context.workspaceId);
    expect(query.order).toHaveBeenCalledWith("created_at", { ascending: false });
    expect(result).toEqual([
      {
        id: row.reference,
        databaseId: row.id,
        entity: row.entity,
        // No name source supplied, so the owner degrades to a recognisable fragment
        // rather than a full UUID.
        owner: `Member ${row.owner_id}`,
        risk: row.risk,
        stageId: row.stage,
        status: row.status,
        ageDays: 5,
        lastActivity: row.updated_at,
      },
    ]);
  });

  it("carries the risk and stage the view derived", async () => {
    const { query } = fakeReadQuery(successResponse([row]), successResponse(row));
    const { client } = fakeReadClient(query);
    const [summary] = await createSentinelInvestigationService(client, context).list();

    expect(summary.risk).toBe("medium");
    expect(summary.stageId).toBe("fraud-review");
  });

  it("reads the queue view rather than the investigations table", async () => {
    const { query } = fakeReadQuery(successResponse([row]), successResponse(row));
    const { client, from } = fakeReadClient(query);
    await createSentinelInvestigationService(client, context).list();

    expect(from).toHaveBeenCalledWith("sentinel_investigation_queue");
  });

  it("reports a stage the view did not produce as awaiting-import rather than rendering a raw slug", async () => {
    // The view is constrained, but the client cannot prove that. An unknown value must land
    // somewhere honest instead of reaching a table cell.
    const { query } = fakeReadQuery(successResponse([{ ...row, stage: "something-new" }]), successResponse(row));
    const { client } = fakeReadClient(query);
    const [summary] = await createSentinelInvestigationService(client, context).list();

    expect(summary.stageId).toBe("awaiting-import");
  });

  it("creates a case as unassessed and awaiting import", async () => {
    const { query } = fakeInsertQuery(successResponse(tableRow));
    const { client } = fakeInsertClient(query);
    const created = await createSentinelInvestigationService(client, context).create({ entity: "New Co", ownerId: "" });

    expect(created.risk).toBe("not-assessed");
    expect(created.stageId).toBe("awaiting-import");
  });

  it("creates a scoped investigation with a generated reference and creator context", async () => {
    const { query } = fakeInsertQuery(successResponse(tableRow));
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
    expect(result.risk).toBe("not-assessed");
    expect(result.stageId).toBe("awaiting-import");
  });

  it("retries a unique reference collision and returns the inserted investigation", async () => {
    const { query: collisionQuery } = fakeInsertQuery(errorResponse<InvestigationTableRow>("23505", "duplicate key value violates unique constraint"));
    const { query: successQuery } = fakeInsertQuery(successResponse(tableRow));
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
    const collision = () => fakeInsertQuery(errorResponse<InvestigationTableRow>("23505", "duplicate key value violates unique constraint")).query;
    const { client, from } = fakeInsertClientSequence([collision(), collision(), collision()]);
    const service = createSentinelInvestigationService(client, context);

    await expect(service.create({ entity: "Northstar Ltd", ownerId: "owner-1" })).rejects.toThrow(
      "Unable to create investigation: duplicate key value violates unique constraint",
    );
    expect(from).toHaveBeenCalledTimes(3);
  });

  it("does not retry non-unique create errors", async () => {
    const { query } = fakeInsertQuery(errorResponse<InvestigationTableRow>("42501", "permission denied"));
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
    expect(from).toHaveBeenCalledWith("sentinel_investigation_queue");
    expect(query.eq).toHaveBeenNthCalledWith(1, "workspace_id", context.workspaceId);
    expect(query.eq).toHaveBeenNthCalledWith(2, "reference", "INV-MISSING1");

    maybeSingle.mockResolvedValue(successResponse<InvestigationRow | null>({ ...row, owner_id: null }));
    await expect(service.getById(row.reference)).resolves.toMatchObject({ owner: "Unassigned" });
  });

  describe("owner names", () => {
    it("renders a known owner by display name", async () => {
      const { query } = fakeReadQuery(successResponse<InvestigationRow[]>([row]), successResponse<InvestigationRow | null>(null));
      const { client } = fakeReadClient(query);
      const service = createSentinelInvestigationService(client, {
        ...context,
        loadOwnerNames: async () => new Map([[row.owner_id as string, "ada.lovelace"]]),
      });

      await expect(service.list()).resolves.toMatchObject([{ owner: "ada.lovelace" }]);
    });

    it("falls back to a fragment for an owner the roster does not cover", async () => {
      const { query } = fakeReadQuery(successResponse<InvestigationRow[]>([row]), successResponse<InvestigationRow | null>(null));
      const { client } = fakeReadClient(query);
      const service = createSentinelInvestigationService(client, {
        ...context,
        loadOwnerNames: async () => new Map([["someone-else", "grace.hopper"]]),
      });

      await expect(service.list()).resolves.toMatchObject([{ owner: `Member ${row.owner_id}` }]);
    });

    it("still lists cases when the name lookup fails", async () => {
      // Owner labels are a nicety; losing them must not take the case queue down with them.
      const { query } = fakeReadQuery(successResponse<InvestigationRow[]>([row]), successResponse<InvestigationRow | null>(null));
      const { client } = fakeReadClient(query);
      const service = createSentinelInvestigationService(client, {
        ...context,
        loadOwnerNames: async () => {
          throw new Error("Unable to list members: denied");
        },
      });

      await expect(service.list()).resolves.toMatchObject([{ owner: `Member ${row.owner_id}` }]);
    });
  });

  it("adds operation context when Supabase returns an error", async () => {
    const { query } = fakeReadQuery(errorResponse<InvestigationRow[]>("42501", "permission denied"), successResponse<InvestigationRow | null>(null));
    const { client, from } = fakeReadClient(query);
    const service = createSentinelInvestigationService(client, context);

    await expect(service.list()).rejects.toThrow("Unable to list investigations: permission denied");
    expect(from).toHaveBeenCalledWith("sentinel_investigation_queue");
  });
});
