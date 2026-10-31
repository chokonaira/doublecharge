// ISO 4217 minor units. Codes not listed here use 2, which is ISO's value for
// almost every active currency. Keep this table in sync with ISO 4217 amendments.
const MINOR_UNITS: Record<string, number> = {
  // 0 decimal places
  BIF: 0, CLP: 0, DJF: 0, GNF: 0, ISK: 0, JPY: 0, KMF: 0, KRW: 0, PYG: 0,
  RWF: 0, UGX: 0, UYI: 0, VND: 0, VUV: 0, XAF: 0, XOF: 0, XPF: 0,
  // 3 decimal places
  BHD: 3, IQD: 3, JOD: 3, KWD: 3, LYD: 3, OMR: 3, TND: 3,
  // 4 decimal places
  CLF: 4, UYW: 4,
};

// Codes whose ISO 4217 minor unit is "N.A." (metals, SDR, testing, no currency).
const NO_MINOR_UNIT = new Set([
  "XAU", "XAG", "XPT", "XPD", "XBA", "XBB", "XBC", "XBD", "XDR", "XSU", "XUA", "XTS", "XXX",
]);

function minorUnitsFor(currency: string): number {
  const code = String(currency).toUpperCase();
  if (!/^[A-Z]{3}$/.test(code)) throw new Error(`Invalid currency code: ${currency}`);
  if (NO_MINOR_UNIT.has(code)) {
    throw new Error(`Currency ${code} has no ISO 4217 minor unit; cannot split`);
  }
  return MINOR_UNITS[code] ?? 2;
}

function toMinor(amount: string, digits: number, label: string): bigint {
  if (typeof amount !== "string") throw new Error(`${label} must be a decimal string`);
  const s = amount.trim();
  const m = /^(\d+)(?:\.(\d*))?$/.exec(s);
  if (!m) throw new Error(`${label} is not a valid non-negative decimal: "${amount}"`);
  const intPart = m[1];
  const frac = m[2] ?? "";
  if (frac.length > digits) {
    throw new Error(`${label} "${amount}" has more than ${digits} decimal places`);
  }
  return BigInt(intPart + frac.padEnd(digits, "0"));
}

function toSafeNumber(v: bigint): number {
  if (v > BigInt(Number.MAX_SAFE_INTEGER) || v < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new Error("Amount exceeds safe integer range");
  }
  return Number(v);
}

export function splitOrder(order: {
  currency: string;
  lines: { sellerId: string; amount: string }[];
  discount: string;
}): { platformFee: number; payouts: Record<string, number> } {
  const digits = minorUnitsFor(order.currency);
  const lines = order.lines ?? [];
  const amounts = lines.map((l, i) => toMinor(l.amount, digits, `lines[${i}].amount`));
  const discount = toMinor(order.discount ?? "0", digits, "discount");

  const total = amounts.reduce((a, b) => a + b, 0n);
  if (discount > total) throw new Error("Discount exceeds order total");

  // Largest remainder allocation of the discount.
  const alloc: bigint[] = amounts.map(() => 0n);
  if (discount > 0n) {
    const rems: { i: number; r: bigint }[] = [];
    let allocated = 0n;
    amounts.forEach((a, i) => {
      const num = discount * a;
      alloc[i] = num / total;
      allocated += alloc[i];
      rems.push({ i, r: num % total });
    });
    rems.sort((x, y) => (x.r === y.r ? x.i - y.i : x.r > y.r ? -1 : 1));
    let left = discount - allocated; // always < number of lines
    for (let k = 0; left > 0n; k++, left--) alloc[rems[k].i] += 1n;
  }

  let platformFee = 0n;
  const payouts = new Map<string, bigint>();
  lines.forEach((l, i) => {
    const net = amounts[i] - alloc[i]; // >= 0 since alloc <= amount
    const fee = (net * 29n + 500n) / 1000n; // 2.9%, half up (net >= 0)
    platformFee += fee;
    payouts.set(l.sellerId, (payouts.get(l.sellerId) ?? 0n) + (net - fee));
  });

  const out: Record<string, number> = {};
  for (const [k, v] of payouts) out[k] = toSafeNumber(v);
  return { platformFee: toSafeNumber(platformFee), payouts: out };
}
