import type { BillDTO } from "@household/shared";

const UNIT_LABEL: Record<string, string> = { day: "day", week: "week", month: "month" };

export function formatBillFrequency(b: Pick<BillDTO, "frequency" | "intervalCount" | "intervalUnit">): string {
  switch (b.frequency) {
    case "ONE_TIME": return "One-time";
    case "WEEKLY": return "Weekly";
    case "MONTHLY": return "Monthly";
    case "QUARTERLY": return "Quarterly";
    case "HALF_YEARLY": return "Half-yearly";
    case "YEARLY": return "Yearly";
    case "CUSTOM": {
      const unit = b.intervalUnit ? UNIT_LABEL[b.intervalUnit] ?? b.intervalUnit : "day";
      return `Every ${b.intervalCount} ${unit}${b.intervalCount === 1 ? "" : "s"}`;
    }
  }
}

export const FREQUENCY_OPTIONS = [
  { value: "ONE_TIME", label: "One-time" },
  { value: "WEEKLY", label: "Weekly" },
  { value: "MONTHLY", label: "Monthly" },
  { value: "QUARTERLY", label: "Quarterly" },
  { value: "HALF_YEARLY", label: "Half-yearly" },
  { value: "YEARLY", label: "Yearly" },
  { value: "CUSTOM", label: "Custom interval" },
] as const;

export const PAYMENT_METHOD_OPTIONS = [
  { value: "CASH", label: "Cash" },
  { value: "UPI", label: "UPI" },
  { value: "BANK_TRANSFER", label: "Bank transfer" },
  { value: "CARD", label: "Card" },
  { value: "AUTO_DEBIT", label: "Auto-debit" },
  { value: "CHEQUE", label: "Cheque" },
  { value: "OTHER", label: "Other" },
] as const;
