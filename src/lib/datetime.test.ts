import { describe, expect, it } from "vitest";
import { formatDate, formatRelative, UNKNOWN_DATE } from "./datetime";

const now = Date.parse("2026-08-08T12:00:00.000Z");
const ago = (ms: number) => new Date(now - ms).toISOString();

describe("formatDate", () => {
  it("renders an ISO timestamp as a calendar date", () => {
    expect(formatDate("2026-08-06T10:04:22.113Z")).toBe("2026-08-06");
  });

  it("degrades rather than printing NaN for unusable input", () => {
    expect(formatDate("not a date")).toBe(UNKNOWN_DATE);
    expect(formatDate(null)).toBe(UNKNOWN_DATE);
    expect(formatDate(undefined)).toBe(UNKNOWN_DATE);
    expect(formatDate("")).toBe(UNKNOWN_DATE);
  });
});

describe("formatRelative", () => {
  it("describes recent activity in minutes and hours", () => {
    expect(formatRelative(ago(12 * 60_000), now)).toBe("12 min ago");
    expect(formatRelative(ago(60 * 60_000), now)).toBe("1 hour ago");
    expect(formatRelative(ago(5 * 60 * 60_000), now)).toBe("5 hours ago");
  });

  it("switches to days, then to a plain date once relative stops helping", () => {
    expect(formatRelative(ago(24 * 60 * 60_000), now)).toBe("1 day ago");
    expect(formatRelative(ago(3 * 24 * 60 * 60_000), now)).toBe("3 days ago");
    // Past a week "37 days ago" is harder to read than the date itself.
    expect(formatRelative("2026-06-01T09:00:00.000Z", now)).toBe("2026-06-01");
  });

  it("does not read as the future when the local clock runs ahead of the server", () => {
    expect(formatRelative(new Date(now + 30_000).toISOString(), now)).toBe("just now");
  });

  it("degrades on unusable input", () => {
    expect(formatRelative("not a date", now)).toBe(UNKNOWN_DATE);
    expect(formatRelative(null, now)).toBe(UNKNOWN_DATE);
  });
});
