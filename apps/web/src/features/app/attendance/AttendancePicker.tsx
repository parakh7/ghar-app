import type { AttendanceStatus } from "@household/shared";
import { STATUS_LABEL } from "./statusTone";

const OPTIONS: { value: AttendanceStatus | null; label: string }[] = [
  { value: "PRESENT", label: STATUS_LABEL.PRESENT },
  { value: "ABSENT", label: STATUS_LABEL.ABSENT },
  { value: "HALF_DAY", label: STATUS_LABEL.HALF_DAY },
  { value: "LEAVE", label: STATUS_LABEL.LEAVE },
  { value: "HOLIDAY", label: STATUS_LABEL.HOLIDAY },
  { value: null, label: "Not marked" },
];

export function AttendancePicker({ status, onSelect }: { status: AttendanceStatus | null; onSelect: (status: AttendanceStatus | null) => void }) {
  return (
    <div className="chips" role="group" aria-label="Attendance status">
      {OPTIONS.map((opt) => (
        <button key={opt.label} type="button" className="chip" aria-pressed={status === opt.value} onClick={() => onSelect(opt.value)}>
          {opt.label}
        </button>
      ))}
    </div>
  );
}
