import type { SentinelMemberService } from "../domain/types";

export type MemberNames = ReadonlyMap<string, string>;

/**
 * Resolves member ids to display names, once.
 *
 * Investigations and the activity feed both need this, and both ask for it per read — the
 * case workspace alone would otherwise query the roster twice for a single navigation.
 * Concurrent callers share the in-flight promise, and the result is held until something
 * changes it, which is what `invalidate` is for after a rename.
 */
export interface MemberNameLookup {
  (): Promise<MemberNames>;
  invalidate(): void;
}

export function createMemberNameLookup(members: Pick<SentinelMemberService, "list">): MemberNameLookup {
  let cached: Promise<MemberNames> | null = null;

  const load = async (): Promise<MemberNames> => {
    const roster = await members.list();
    return new Map(
      roster
        .filter((member): member is typeof member & { displayName: string } => Boolean(member.displayName))
        .map((member) => [member.userId, member.displayName]),
    );
  };

  const lookup = (() => {
    if (!cached) {
      cached = load().catch((error: unknown) => {
        // A failed load must not be cached, or one blip would poison every later read.
        cached = null;
        throw error;
      });
    }
    return cached;
  }) as MemberNameLookup;

  lookup.invalidate = () => {
    cached = null;
  };

  return lookup;
}
