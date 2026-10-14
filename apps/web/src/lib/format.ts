import { dateInZone } from "@household/shared";

/** "Tuesday, 29 September" in the household's timezone. */
export function longDate(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-IN", { timeZone, weekday: "long", day: "numeric", month: "long" }).format(instant);
}

export function greeting(instant: Date, timeZone: string): string {
  const hour = Number(new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", hourCycle: "h23" }).format(instant));
  if (hour < 12) return "Good morning";
  if (hour < 17) return "Good afternoon";
  return "Good evening";
}

/** "Parakh Shah" -> "PS". Falls back to the first two letters of a single-word name. */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "";
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return (words[0]![0]! + words[words.length - 1]![0]!).toUpperCase();
}

export { dateInZone };
