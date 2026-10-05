import type { BillStatus } from "@household/shared";

export type StatusTone = "ok" | "overdue" | "due-soon" | "info" | "neutral" | "muted";

export const STATUS_LABEL: Record<BillStatus, string> = {
  ACTIVE: "Active", PAUSED: "Paused", ARCHIVED: "Archived",
};

const STATUS_TONE: Record<BillStatus, StatusTone> = {
  ACTIVE: "ok", PAUSED: "due-soon", ARCHIVED: "muted",
};

export function toneOf(status: BillStatus): StatusTone {
  return STATUS_TONE[status];
}
