/** Calendar dates are "YYYY-MM-DD" strings in the HOUSEHOLD's timezone. Never derive them from server-local time. */
export type ISODate = string;

export const DEFAULT_TIMEZONE = "Asia/Kolkata";

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** The calendar date at `instant` as seen in `timeZone`. */
export function dateInZone(instant: Date, timeZone: string): ISODate {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(instant);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** Hour-of-day (0–23) at `instant` in `timeZone` — used for "send at 11 AM household time". */
export function hourInZone(instant: Date, timeZone: string): number {
  const h = new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", hourCycle: "h23" }).format(instant);
  return Number(h);
}

/** Whole days from a→b, both ISO calendar dates (timezone-free arithmetic on UTC midnight). */
export function daysBetween(a: ISODate, b: ISODate): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

export function addDays(d: ISODate, n: number): ISODate {
  const t = new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000);
  return t.toISOString().slice(0, 10);
}
