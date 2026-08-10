import { describe, expect, it, vi } from "vitest";
import type { PostgrestResponse } from "@supabase/supabase-js";
import type { Database } from "../lib/database.types";
import {
  ACTIVITY_COLUMNS,
  createSentinelActivityService,
  DEFAULT_ACTIVITY_LIMIT,
  type SentinelActivityClient,
  type SentinelActivityReadQuery,
} from "./sentinelActivity";

type ActivityRow = Database["public"]["Tables"]["sentinel_activity_events"]["Row"];

const workspaceId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const investigationId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const row: ActivityRow = {
  id: "event-1",
  workspace_id: workspaceId,
  investigation_id: investigationId,
  actor_id: "actor-1",
  event_type: "parse-completed",
  rationale: null,
  metadata: { rowCount: 3, warningCount: 0 },
  created_at: "2026-08-09T09:00:00.000Z",
};

function listResponse(data: ActivityRow[]): PostgrestResponse<ActivityRow> {
  return { data, error: null, status: 200, statusText: "OK", success: true, count: data.length };
}

function createClient(response: PromiseLike<PostgrestResponse<ActivityRow>>) {
  let query!: SentinelActivityReadQuery;
  const eq = vi.fn((_column: "workspace_id" | "investigation_id", _value: string): SentinelActivityReadQuery => query);
  const order = vi.fn((_column: "created_at", _options: { ascending: boolean }): SentinelActivityReadQuery => query);
  const limit = vi.fn((_count: number) => response);
  query = { eq, order, limit } satisfies SentinelActivityReadQuery;

  const select = vi.fn((_columns: string) => query);
  const from = vi.fn((_table: "sentinel_activity_events") => ({ select }));
  const client = { from } satisfies SentinelActivityClient;
  return { client, from, select, eq, order, limit };
}

function serviceFor(response: PromiseLike<PostgrestResponse<ActivityRow>> = Promise.resolve(listResponse([row]))) {
  const fake = createClient(response);
  return { ...fake, service: createSentinelActivityService(fake.client, { workspaceId }) };
}

describe("createSentinelActivityService", () => {
  it("reads the newest events for the active workspace", async () => {
    const fake = serviceFor();

    await expect(fake.service.list()).resolves.toEqual([
      {
        id: "event-1",
        investigationId,
        actorId: "actor-1",
        type: "parse-completed",
        rationale: null,
        metadata: { rowCount: 3, warningCount: 0 },
        occurredAt: "2026-08-09T09:00:00.000Z",
      },
    ]);

    expect(fake.from).toHaveBeenCalledWith("sentinel_activity_events");
    expect(fake.select).toHaveBeenCalledWith(ACTIVITY_COLUMNS);
    expect(fake.eq).toHaveBeenCalledWith("workspace_id", workspaceId);
    expect(fake.order).toHaveBeenCalledWith("created_at", { ascending: false });
  });

  it("bounds the read even when no limit is asked for", async () => {
    // An audit table only grows; an unbounded read would degrade quietly rather than fail.
    const fake = serviceFor();

    await fake.service.list();

    expect(fake.limit).toHaveBeenCalledWith(DEFAULT_ACTIVITY_LIMIT);
  });

  it("passes an explicit limit through", async () => {
    const fake = serviceFor();

    await fake.service.list({ limit: 5 });

    expect(fake.limit).toHaveBeenCalledWith(5);
  });

  it("narrows to one investigation when asked", async () => {
    const fake = serviceFor();

    await fake.service.list({ investigationId });

    expect(fake.eq).toHaveBeenNthCalledWith(1, "workspace_id", workspaceId);
    expect(fake.eq).toHaveBeenNthCalledWith(2, "investigation_id", investigationId);
  });

  it("does not filter by investigation when none is given", async () => {
    const fake = serviceFor();

    await fake.service.list();

    expect(fake.eq).toHaveBeenCalledTimes(1);
  });

  it("treats non-object metadata as empty rather than trusting jsonb", async () => {
    const fake = serviceFor(Promise.resolve(listResponse([{ ...row, metadata: "unexpected" as never }])));

    await expect(fake.service.list()).resolves.toMatchObject([{ metadata: {} }]);
  });

  it("wraps a denied read in a readable message", async () => {
    const denied = {
      data: null,
      error: { code: "42501", message: "events denied", details: "", hint: "", name: "PostgrestError" },
      status: 403,
      statusText: "Forbidden",
      success: false,
      count: null,
    } as unknown as PostgrestResponse<ActivityRow>;

    await expect(serviceFor(Promise.resolve(denied)).service.list())
      .rejects.toThrow("Unable to load activity: events denied");
  });
});
