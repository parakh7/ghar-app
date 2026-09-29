/**
 * Money is ALWAYS an integer number of paise. Never floats.
 * ₹999 → 99900. Max safe value ≈ ₹90 trillion, far beyond household needs.
 */
export type Paise = number;

export class MoneyError extends Error {}

export function assertPaise(value: number, label = "amount"): asserts value is Paise {
  if (!Number.isSafeInteger(value)) throw new MoneyError(`${label} must be an integer number of paise`);
}

/** Parse user input like "999", "1,250.50", "₹4,500" into paise. Rejects >2 decimals. */
export function rupeesToPaise(input: string | number): Paise {
  const raw = typeof input === "number" ? input.toString() : input;
  const cleaned = raw.replace(/[₹,\s]/g, "");
  const match = /^(-)?(\d+)(?:\.(\d{1,2}))?$/.exec(cleaned);
  if (!match) throw new MoneyError(`Invalid amount: "${raw}"`);
  const [, sign, whole, frac = ""] = match;
  const paise = Number(whole) * 100 + Number(frac.padEnd(2, "0"));
  assertPaise(paise);
  return sign ? -paise : paise;
}

/** Indian digit grouping: 1234567 paise → "₹12,345.67"; whole rupees drop decimals. */
export function formatINR(paise: Paise, opts: { showPaise?: "auto" | "always" | "never" } = {}): string {
  assertPaise(paise);
  const showPaise = opts.showPaise ?? "auto";
  const negative = paise < 0;
  const abs = Math.abs(paise);
  const rupees = Math.floor(abs / 100);
  const rem = abs % 100;
  const s = rupees.toString();
  const last3 = s.slice(-3);
  const rest = s.slice(0, -3);
  const grouped = rest ? `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ",")},${last3}` : last3;
  const withPaise = showPaise === "always" || (showPaise === "auto" && rem !== 0);
  return `${negative ? "-" : ""}₹${grouped}${withPaise ? `.${rem.toString().padStart(2, "0")}` : ""}`;
}

/**
 * Deterministic proportional amount: total * numerator / denominator, rounded half-up to the paisa.
 * Used for e.g. absence deductions (₹5,000 × 2/26). Uses BigInt so no float drift.
 */
export function prorate(total: Paise, numerator: number, denominator: number): Paise {
  assertPaise(total, "total");
  if (!Number.isInteger(numerator) || !Number.isInteger(denominator) || denominator <= 0) {
    throw new MoneyError("prorate requires integer numerator and positive integer denominator");
  }
  const n = BigInt(total) * BigInt(numerator);
  const d = BigInt(denominator);
  const neg = n < 0n;
  const absN = neg ? -n : n;
  const q = (absN * 2n + d) / (2n * d); // half-up
  return Number(neg ? -q : q);
}

export function sumPaise(values: readonly Paise[]): Paise {
  return values.reduce((acc, v) => {
    assertPaise(v);
    const next = acc + v;
    assertPaise(next, "sum");
    return next;
  }, 0);
}
