// ISO 4217 minor units (exponents) for currencies whose exponent is not 2.
// Any other well-formed 3-letter code is assumed to have exponent 2.
// Limitation: no packages may be imported, so this table is embedded. A
// currency added to ISO 4217 later with a non-2 exponent will be wrong
// until the table is updated. Intl is not used: its CLDR digit data
// differs from ISO 4217 for some codes (e.g. IQD).
const NON_DEFAULT_EXPONENTS: Record<string, number> = {
  // exponent 0
  BIF: 0, CLP: 0, DJF: 0, GNF: 0, ISK: 0, JPY: 0, KMF: 0, KRW: 0, PYG: 0,
  RWF: 0, UGX: 0, UYI: 0, VND: 0, VUV: 0, XAF: 0, XOF: 0, XPF: 0,
  // exponent 3
  BHD: 3, IQD: 3, JOD: 3, KWD: 3, LYD: 3, OMR: 3, TND: 3,
  // exponent 4
  CLF: 4, UYW: 4,
};

// ISO 4217 codes with no minor unit defined ("N.A."): splitting into minor units is meaningless.
const NOT_APPLICABLE = new Set([
  "XAU", "XAG", "XPT", "XPD", "XDR", "XSU", "XUA", "XBA", "XBB", "XBC", "XBD", "XTS", "XXX",
]);

function minorUnits(currency: string): number {
  if (typeof currency !== "string" || !/^[A-Z]{3}$/.test(currency)) {
    throw new Error(`Invalid ISO 4217 currency code: ${String(currency)}`);
  }
  if (NOT_APPLICABLE.has(currency)) {
    throw new Error(`Currency ${currency} has no ISO 4217 minor unit`);
  }
  return Object.prototype.hasOwnProperty.call(NON_DEFAULT_EXPONENTS, currency)
    ? NON_DEFAULT_EXPONENTS[currency]
    : 2;
}

function toMinor(amount: string, exp: number): bigint {
  if (typeof amount !== "string") throw new Error(`Amount must be a string`);
  const m = /^(\d+)(?:\.(\d+))?$/.exec(amount.trim());
  if (!m) throw new Error(`Invalid amount: ${amount}`);
  const frac = m[2] ?? "";
  if (frac.length > exp) {
    throw new Error(`Amount ${amount} has more decimal places than the currency allows (${exp})`);
  }
  return BigInt(m[1] + frac.padEnd(exp, "0"));
}

function toSafeNumber(v: bigint): number {
  const n = Number(v);
  if (!Number.isSafeInteger(n)) throw new Error(`Amount ${v} exceeds safe integer range`);
  return n;
}

export function splitOrder(order: {
  currency: string;
  lines: { sellerId: string; amount: string }[];
  discount: string;
}): { platformFee: number; payouts: Record<string, number> } {
  const exp = minorUnits(order.currency);
  const lines = order.lines ?? [];
  const amounts = lines.map((l) => toMinor(l.amount, exp));
  const discount = toMinor(order.discount, exp);
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
    // Sort by remainder descending; ties go to the earlier line.
    rems.sort((x, y) => (x.r === y.r ? x.i - y.i : x.r > y.r ? -1 : 1));
    let left = discount - allocated; // always < number of lines
    for (let k = 0; left > 0n; k++, left--) alloc[rems[k].i] += 1n;
  }

  let platformFee = 0n;
  const payouts = new Map<string, bigint>();
  lines.forEach((line, i) => {
    const net = amounts[i] - alloc[i];
    // 2.9% rounded half up (net is non-negative).
    const fee = (net * 29n + 500n) / 1000n;
    platformFee += fee;
    payouts.set(line.sellerId, (payouts.get(line.sellerId) ?? 0n) + (net - fee));
  });

  return {
    platformFee: toSafeNumber(platformFee),
    // Object.fromEntries defines own data properties, so ids like "__proto__" are safe.
    payouts: Object.fromEntries([...payouts].map(([k, v]) => [k, toSafeNumber(v)])),
  };
}
