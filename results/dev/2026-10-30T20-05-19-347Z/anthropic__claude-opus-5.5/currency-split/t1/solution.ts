// Marketplace payout split. All arithmetic is done in integer minor units with BigInt,
// so large amounts never hit floating-point error.

// ISO 4217 minor units (decimal places), taken from the ISO 4217 list.
// Any currency not listed here uses 2 decimal places, which is the ISO default.
//
// The table is hardcoded on purpose. Intl.NumberFormat reports CLDR digits, and these
// differ from ISO 4217 for several currencies (for example IQD, LBP, RSD, IDR).
//
// Codes whose ISO minor unit is "N.A." (precious metals, SDR, test codes) are treated
// as 0 decimals, so amounts in them must be whole numbers.
//
// Limitation: the table needs updating if ISO changes a currency's minor unit.
const MINOR_UNITS: Record<string, number> = {
  // 0 decimals
  BIF: 0, CLP: 0, DJF: 0, GNF: 0, ISK: 0, JPY: 0, KMF: 0, KRW: 0, PYG: 0,
  RWF: 0, UGX: 0, UYI: 0, VND: 0, VUV: 0, XAF: 0, XOF: 0, XPF: 0,
  // 3 decimals
  BHD: 3, IQD: 3, JOD: 3, KWD: 3, LYD: 3, OMR: 3, TND: 3,
  // 4 decimals
  CLF: 4, UYW: 4,
  // ISO minor unit "N.A." (treated as 0)
  XAG: 0, XAU: 0, XBA: 0, XBB: 0, XBC: 0, XBD: 0, XDR: 0, XPD: 0, XPT: 0,
  XSU: 0, XTS: 0, XUA: 0, XXX: 0,
};

function minorUnitsFor(currency: string): number {
  if (typeof currency !== "string" || !/^[A-Za-z]{3}$/.test(currency)) {
    throw new Error(`Invalid ISO 4217 currency code: ${String(currency)}`);
  }
  const code = currency.toUpperCase();
  return Object.prototype.hasOwnProperty.call(MINOR_UNITS, code) ? MINOR_UNITS[code] : 2;
}

// Converts a non-negative decimal string in major units to a BigInt in minor units.
function toMinor(amount: string, digits: number, label: string): bigint {
  if (typeof amount !== "string") throw new Error(`${label} must be a decimal string`);
  const s = amount.trim();
  const m = /^(\d+)(?:\.(\d+))?$/.exec(s);
  if (!m) throw new Error(`${label} is not a valid non-negative decimal: "${amount}"`);
  const intPart = m[1];
  const frac = m[2] ?? "";
  if (frac.length > digits) {
    throw new Error(`${label} "${amount}" has more than ${digits} decimal places`);
  }
  return BigInt(intPart + frac.padEnd(digits, "0"));
}

function toSafeNumber(v: bigint, label: string): number {
  if (v > BigInt(Number.MAX_SAFE_INTEGER) || v < -BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`${label} exceeds the safe integer range`);
  }
  return Number(v);
}

export function splitOrder(order: {
  currency: string;
  lines: { sellerId: string; amount: string }[];
  discount: string;
}): { platformFee: number; payouts: Record<string, number> } {
  if (!order || !Array.isArray(order.lines)) throw new Error("Invalid order");
  const digits = minorUnitsFor(order.currency);

  const amounts = order.lines.map((l, i) => {
    if (!l || typeof l.sellerId !== "string") throw new Error(`Line ${i} has an invalid sellerId`);
    return toMinor(l.amount, digits, `Line ${i} amount`);
  });
  const discount = toMinor(order.discount, digits, "Discount");
  const total = amounts.reduce((a, b) => a + b, 0n);

  if (discount > total) throw new Error("Discount exceeds order total");

  // Allocate the discount using the largest remainder method.
  const alloc: bigint[] = amounts.map(() => 0n);
  if (discount > 0n) {
    // total > 0 here, because discount <= total and discount > 0.
    const rems: { i: number; r: bigint }[] = [];
    let allocated = 0n;
    amounts.forEach((a, i) => {
      const num = discount * a;
      alloc[i] = num / total; // floor of the exact share (all values are non-negative)
      allocated += alloc[i];
      rems.push({ i, r: num % total });
    });

    // Largest fractional remainder first; ties go to the earlier line.
    rems.sort((x, y) => (x.r === y.r ? x.i - y.i : x.r > y.r ? -1 : 1));

    // The leftover is always smaller than the number of lines.
    let left = discount - allocated;
    for (let k = 0; left > 0n; k++, left--) alloc[rems[k].i] += 1n;
  }

  let platformFee = 0n;
  const payouts = new Map<string, bigint>();
  amounts.forEach((a, i) => {
    const net = a - alloc[i];
    // Fee is 2.9% (29/1000) of the net amount, rounded half up. net is non-negative.
    const fee = (net * 29n + 500n) / 1000n;
    platformFee += fee;
    const seller = order.lines[i].sellerId;
    payouts.set(seller, (payouts.get(seller) ?? 0n) + (net - fee));
  });

  const out: Record<string, number> = {};
  for (const [seller, v] of payouts) out[seller] = toSafeNumber(v, `Payout for ${seller}`);
  return { platformFee: toSafeNumber(platformFee, "Platform fee"), payouts: out };
}
