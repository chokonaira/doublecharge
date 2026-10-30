/** ISO 4217 minor units for the currencies used in this task's scenarios. */
const MINOR_UNITS: Record<string, number> = {
  USD: 2, EUR: 2, GBP: 2,
  JPY: 0, KRW: 0, ISK: 0, CLP: 0, VND: 0, UGX: 0,
  KWD: 3, BHD: 3, JOD: 3, OMR: 3, TND: 3, IQD: 3, LYD: 3,
};

export interface SplitInput {
  currency: string;
  lines: { sellerId: string; amount: string }[];
  discount: string;
}

export interface SplitResult {
  platformFee: number;
  payouts: Record<string, number>;
}

/** Parses a decimal string into integer minor units without going through floating point. */
export function toMinor(amount: string, currency: string): number {
  const exponent = MINOR_UNITS[currency];
  if (exponent === undefined) throw new Error(`unknown currency ${currency}`);
  const [whole = "0", fraction = ""] = amount.split(".");
  if (fraction.length > exponent) throw new Error(`${amount} has too many decimals for ${currency}`);
  return Number(whole) * 10 ** exponent + Number(fraction.padEnd(exponent, "0") || "0");
}

export function splitOrder(order: SplitInput): SplitResult {
  const lines = order.lines.map((line) => toMinor(line.amount, order.currency));
  const discount = toMinor(order.discount, order.currency);
  const total = lines.reduce((sum, line) => sum + line, 0);

  // Largest remainder: floor shares, then distribute what is left by remainder, earlier line first on ties.
  const shares = lines.map((line) => Math.floor((discount * line) / total));
  let left = discount - shares.reduce((sum, share) => sum + share, 0);
  const byRemainder = lines.map((line, i) => ({ i, remainder: (discount * line) % total })).sort((a, b) => b.remainder - a.remainder || a.i - b.i);
  for (const { i } of byRemainder) {
    if (left === 0) break;
    shares[i]! += 1;
    left -= 1;
  }

  let platformFee = 0;
  const payouts: Record<string, number> = {};
  order.lines.forEach((line, i) => {
    const net = lines[i]! - shares[i]!;
    const fee = Math.floor((net * 29 + 500) / 1000); // 2.9%, half up, in integers
    platformFee += fee;
    payouts[line.sellerId] = (payouts[line.sellerId] ?? 0) + net - fee;
  });
  return { platformFee, payouts };
}
