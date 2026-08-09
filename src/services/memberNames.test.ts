import { describe, expect, it, vi } from "vitest";
import type { SentinelMember } from "../domain/types";
import { createMemberNameLookup } from "./memberNames";

const member = (userId: string, displayName: string | null): SentinelMember => ({
  userId,
  email: null,
  displayName,
  role: "analyst",
  status: "active",
  joinedAt: "2026-08-01T09:00:00.000Z",
  isSelf: false,
});

function roster(members: SentinelMember[]) {
  return { list: vi.fn(async () => members) };
}

describe("createMemberNameLookup", () => {
  it("maps member ids to display names", async () => {
    const lookup = createMemberNameLookup(roster([member("u1", "ada.lovelace"), member("u2", "grace.hopper")]));

    const names = await lookup();

    expect(names.get("u1")).toBe("ada.lovelace");
    expect(names.get("u2")).toBe("grace.hopper");
  });

  it("omits members with no display name rather than mapping them to nothing", async () => {
    const lookup = createMemberNameLookup(roster([member("u1", null)]));

    expect((await lookup()).has("u1")).toBe(false);
  });

  it("issues one request for concurrent callers", async () => {
    // The case workspace resolves owners and activity actors in the same render; without
    // sharing the in-flight promise that is two roster queries per navigation.
    const members = roster([member("u1", "ada.lovelace")]);
    const lookup = createMemberNameLookup(members);

    const [first, second] = await Promise.all([lookup(), lookup()]);

    expect(members.list).toHaveBeenCalledOnce();
    expect(first).toBe(second);
  });

  it("reuses the result across sequential calls", async () => {
    const members = roster([member("u1", "ada.lovelace")]);
    const lookup = createMemberNameLookup(members);

    await lookup();
    await lookup();

    expect(members.list).toHaveBeenCalledOnce();
  });

  it("reloads after invalidation, so a rename is picked up", async () => {
    const members = roster([member("u1", "ada.lovelace")]);
    const lookup = createMemberNameLookup(members);
    await lookup();

    members.list.mockResolvedValueOnce([member("u1", "ada")]);
    lookup.invalidate();

    expect((await lookup()).get("u1")).toBe("ada");
    expect(members.list).toHaveBeenCalledTimes(2);
  });

  it("does not cache a failure, so one blip cannot poison every later read", async () => {
    const members = roster([member("u1", "ada.lovelace")]);
    members.list.mockRejectedValueOnce(new Error("Unable to list members: denied"));
    const lookup = createMemberNameLookup(members);

    await expect(lookup()).rejects.toThrow("denied");
    await expect(lookup()).resolves.toEqual(new Map([["u1", "ada.lovelace"]]));
  });
});
