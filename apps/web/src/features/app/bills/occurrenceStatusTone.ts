import type { OccurrenceStatus } from "@household/shared";

export type StatusTone = "ok" | "overdue" | "due-soon" | "info" | "neutral" | "muted";

export const STATUS_LABEL: Record<OccurrenceStatus, string> = {
  PENDING: "Pending", PARTIALLY_PAID: "Partially paid", PAID: "Paid", WAIVED: "Waived",
};

// Mirrors salary/statusTone.ts's PENDING/PARTIALLY_PAID/PAID tone mapping. All four statuses are
// reachable end-to-end: generation produces PENDING, payment recording produces PARTIALLY_PAID/PAID,
// and waiving produces WAIVED.
const STATUS_TONE: Record<OccurrenceStatus, StatusTone> = {
  PENDING: "due-soon", PARTIALLY_PAID: "info", PAID: "ok", WAIVED: "muted",
};

export function toneOf(status: OccurrenceStatus): StatusTone {
  return STATUS_TONE[status];
}
