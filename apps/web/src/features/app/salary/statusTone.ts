import type { SettlementStatus } from "@household/shared";

export type StatusTone = "ok" | "overdue" | "due-soon" | "info" | "neutral" | "muted";

export const STATUS_LABEL: Record<SettlementStatus, string> = {
  PENDING: "Pending", PARTIALLY_PAID: "Partially paid", PAID: "Paid", CANCELLED: "Cancelled",
};

const STATUS_TONE: Record<SettlementStatus, StatusTone> = {
  PENDING: "due-soon", PARTIALLY_PAID: "info", PAID: "ok", CANCELLED: "muted",
};

export function toneOf(status: SettlementStatus): StatusTone {
  return STATUS_TONE[status];
}
