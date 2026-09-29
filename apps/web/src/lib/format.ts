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

export { dateInZone };
