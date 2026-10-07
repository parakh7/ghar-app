import type { OccurrenceStatus } from "@household/shared";

export type StatusTone = "ok" | "overdue" | "due-soon" | "info" | "neutral" | "muted";

export const STATUS_LABEL: Record<OccurrenceStatus, string> = {
  PENDING: "Pending", PARTIALLY_PAID: "Partially paid", PAID: "Paid", WAIVED: "Waived",
};

// Mirrors salary/statusTone.ts's PENDING/PARTIALLY_PAID/PAID tone mapping (this spec can only ever
// produce PENDING end-to-end right now — payment recording and waiving land in Spec 3 — but the
// DTO's status type covers all four, so every tone is mapped regardless of what's reachable today).
const STATUS_TONE: Record<OccurrenceStatus, StatusTone> = {
  PENDING: "due-soon", PARTIALLY_PAID: "info", PAID: "ok", WAIVED: "muted",
};

export function toneOf(status: OccurrenceStatus): StatusTone {
  return STATUS_TONE[status];
}
