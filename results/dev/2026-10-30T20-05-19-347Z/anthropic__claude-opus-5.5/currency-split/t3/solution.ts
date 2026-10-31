// Marketplace payout split.
//
// Limitation: no package can provide the ISO 4217 table, so it is embedded below.
// - Currencies whose minor unit is not 2 are listed explicitly.
// - Codes with no minor unit ("N.A." in ISO 4217: precious metals, XDR, test codes, ...)
//   are rejected.
// - Any other code defaults to 2 decimals. If the runtime has
//   Intl.supportedValuesOf('currency'), a code it does not know is rejected
//   rather than guessed.
// CLDR fraction digits from Intl.NumberFormat are not used, because they
// differ from ISO 4217 for some currencies (e.g. HUF, IDR, TWD).

const MINOR_UNITS: Record<string, number> = {
  // 0 decimal places
  BIF: 0, CLP: 0, DJF: 0, GNF: 0, ISK: 0, JPY: 0, KMF: 0, KRW: 0, PYG: 0,
  RWF: 0, UGX: 0, UYI: 0, VND: 0, VUV: 0, XAF: 0, XOF: 0, XPF: 0,
  // 3 decimal places
  BHD: 3, IQD: 3, JOD: 3, KWD: 3, LYD: 3, OMR: 3, TND: 3,
  // 4 decimal places
  CLF: 4, UYW: 4,
};

// ISO 4217 codes with no minor unit (N.A.) – cannot be expressed in minor units.
const NO_MINOR_UNIT = new Set([
  "XAU", "XAG", "XPT", "XPD", "XDR", "XBA", "XBB", "XBC", "XBD",
  "XTS", "XXX", "XSU", "XUA",
]);

function minorUnitsFor(currency: string): number {
  if (typeof currency !== "string" || !/^[A-Z]{3}$/.test(currency)) {
    throw new Error(`Invalid currency code: ${String(currency)}`);
  }
  if (NO_MINOR_UNIT.has(currency)) {
    throw new Error(`Currency ${currency} has no ISO 4217 minor unit`);
  }
  const known = MINOR_UNITS[currency];
  if (known !== undefined) return known;
  const supported = (Intl as any).supportedValuesOf;
  if (typeof supported === "function") {
    try {
      const list: string[] = supported.call(Intl, "currency");
      if (Array.isArray(list) && list.length > 0 && !list.includes(currency)) {
        throw new Error(`Unknown currency code: ${currency}`);
      }
    } catch (e) {
      if (e instanceof Error && e.message.startsWith("Unknown currency")) throw e;
      // Intl lookup failed for some other reason; fall through to default.
    }
  }
  return 2;
}

function toMinor(amount: string, decimals: number, label: string): bigint {
  if (typeof amount !== "string") throw new Error(`${label}: amount must be a string`);
  const s = amount.trim();
  const m = /^(\d+)(?:\.(\d+))?$/.exec(s);
  if (!m) throw new Error(`${label}: invalid amount "${amount}"`);
  const intPart = m[1];
  const frac = m[2] ?? "";
  if (frac.length > decimals) {
    throw new Error(`${label}: "${amount}" has more than ${decimals} decimal places`);
  }
  return BigInt(intPart + frac.padEnd(decimals, "0"));
}

function toSafeNumber(v: bigint, label: string): number {
  if (v > BigInt(Number.MAX_SAFE_INTEGER) || v < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new Error(`${label} exceeds safe integer range`);
  }
  return Number(v);
}

export function splitOrder(order: {
  currency: string;
  lines: { sellerId: string; amount: string }[];
  discount: string;
}): { platformFee: number; payouts: Record<string, number> } {
  if (!order || !Array.isArray(order.lines)) throw new Error("Invalid order");
  const decimals = minorUnitsFor(order.currency);

  const amounts = order.lines.map((l, i) => {
    if (!l || typeof l.sellerId !== "string") throw new Error(`line ${i}: invalid sellerId`);
    return toMinor(l.amount, decimals, `line ${i}`);
  });
  const discount = toMinor(order.discount, decimals, "discount");
  const total = amounts.reduce((a, b) => a + b, 0n);

  if (discount > total) throw new Error("Discount exceeds order total");

  // Largest remainder allocation of discount.
  const alloc: bigint[] = amounts.map(() => 0n);
  if (discount > 0n) {
    // total > 0 guaranteed since discount <= total and discount > 0
    const rems: { i: number; rem: bigint }[] = [];
    let allocated = 0n;
    amounts.forEach((a, i) => {
      const num = discount * a;
      alloc[i] = num / total;
      allocated += alloc[i];
      rems.push({ i, rem: num % total });
    });
    rems.sort((x, y) => (x.rem === y.rem ? x.i - y.i : x.rem > y.rem ? -1 : 1));
    let left = discount - allocated; // always < number of lines
    for (let k = 0; left > 0n; k++, left--) alloc[rems[k].i] += 1n;
  }

  let platformFee = 0n;
  const payoutsBig = new Map<string, bigint>();
  order.lines.forEach((line, i) => {
    const net = amounts[i] - alloc[i]; // >= 0 since alloc_i <= amount_i
    const fee = (net * 29n + 500n) / 1000n; // 2.9%, half up (net >= 0)
    platformFee += fee;
    payoutsBig.set(line.sellerId, (payoutsBig.get(line.sellerId) ?? 0n) + (net - fee));
  });

  const payouts: Record<string, number> = Object.create(null);
  for (const [seller, v] of payoutsBig) payouts[seller] = toSafeNumber(v, `payout ${seller}`);

  return { platformFee: toSafeNumber(platformFee, "platformFee"), payouts };
}
