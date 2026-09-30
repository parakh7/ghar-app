import type { AttendanceStatus } from "@household/shared";

export type StatusTone = "ok" | "overdue" | "due-soon" | "info" | "neutral" | "muted";

export const STATUS_LABEL: Record<AttendanceStatus, string> = {
  PRESENT: "Present", ABSENT: "Absent", HALF_DAY: "Half-day", LEAVE: "Leave", HOLIDAY: "Holiday",
};

const STATUS_TONE: Record<AttendanceStatus, StatusTone> = {
  PRESENT: "ok", ABSENT: "overdue", HALF_DAY: "due-soon", LEAVE: "info", HOLIDAY: "neutral",
};

export function toneOf(status: AttendanceStatus | null): StatusTone {
  return status ? STATUS_TONE[status] : "muted";
}
