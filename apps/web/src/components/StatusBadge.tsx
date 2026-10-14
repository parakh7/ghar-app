import type { ReactNode } from "react";

export type StatusTone = "red" | "amber" | "green" | "neutral";

const TONE_CLASS: Record<StatusTone, string> = { red: "overdue", amber: "due-soon", green: "ok", neutral: "neutral" };

/** Reuses the existing `.badge` system (same tones already used across bills/salary/attendance) under the handoff's red/amber/green/neutral vocabulary. */
export function StatusBadge({ tone, children }: { tone: StatusTone; children: ReactNode }) {
  return <span className={`badge badge--${TONE_CLASS[tone]}`}>{children}</span>;
}
