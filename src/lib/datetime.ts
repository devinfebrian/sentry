/**
 * The one place timestamps become text. Everything the API returns is machine-generated
 * ISO-8601 in UTC, and it used to reach the screen raw in the case queue and case header.
 *
 * `now` is injectable so relative output is testable without freezing the clock.
 */

export const UNKNOWN_DATE = "Unknown";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function parse(value: string | null | undefined) {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Calendar date, e.g. `2026-08-08`. ISO order so it sorts and reads the same everywhere. */
export function formatDate(value: string | null | undefined) {
  const parsed = parse(value);
  return parsed === null ? UNKNOWN_DATE : new Date(parsed).toISOString().slice(0, 10);
}

/**
 * How long ago something happened, e.g. `12 min ago`. Falls back to a calendar date past a
 * week, where "37 days ago" stops being easier to read than the date itself.
 */
export function formatRelative(value: string | null | undefined, now: number = Date.now()) {
  const parsed = parse(value);
  if (parsed === null) return UNKNOWN_DATE;

  const elapsed = now - parsed;
  // A clock skewed a little ahead of the server should not read as the future.
  if (elapsed < MINUTE) return "just now";
  if (elapsed < HOUR) {
    const minutes = Math.floor(elapsed / MINUTE);
    return `${minutes} min ago`;
  }
  if (elapsed < DAY) {
    const hours = Math.floor(elapsed / HOUR);
    return `${hours} ${hours === 1 ? "hour" : "hours"} ago`;
  }
  if (elapsed < 7 * DAY) {
    const days = Math.floor(elapsed / DAY);
    return `${days} ${days === 1 ? "day" : "days"} ago`;
  }
  return formatDate(value);
}
