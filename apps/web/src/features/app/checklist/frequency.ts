import type { ChecklistTaskDTO } from "@household/shared";

const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function ordinal(n: number): string {
  const v = n % 100;
  if (v >= 11 && v <= 13) return `${n}th`;
  switch (n % 10) {
    case 1: return `${n}st`;
    case 2: return `${n}nd`;
    case 3: return `${n}rd`;
    default: return `${n}th`;
  }
}

export function formatFrequency(t: ChecklistTaskDTO): string {
  switch (t.frequency) {
    case "DAILY": return "Every day";
    case "WEEKDAYS": return "Weekdays";
    case "WEEKLY": return `Every ${(t.weekdays ?? []).map((d) => DAY_NAMES[d - 1]).join(", ")}`;
    case "MONTHLY": return `Monthly on the ${ordinal(t.dayOfMonth ?? 1)}`;
    case "SPECIFIC_DATE": return `On ${t.specificDate}`;
    case "CUSTOM": return `Every ${t.intervalDays} day${t.intervalDays === 1 ? "" : "s"}`;
  }
}
