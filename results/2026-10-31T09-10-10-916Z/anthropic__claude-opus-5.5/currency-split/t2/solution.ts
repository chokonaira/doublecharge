// Marketplace payout split.
//
// All arithmetic is done in BigInt integer minor units, so there is no
// floating-point error. Results are converted to `number` only at the end,
// and the code throws if a value would exceed Number.MAX_SAFE_INTEGER.
//
// Limitation: the JS runtime has no built-in ISO 4217 minor-unit table.
// Intl uses CLDR data, which differs from ISO for some currencies
// (for example IQD and MGA). So the ISO exceptions are listed explicitly
// below, and every other valid code uses ISO's default of 2 decimals.
// If ISO amends a currency's minor unit, this table must be updated.

const ISO_MINOR_UNIT_EXCEPTIONS: Record<string, number> = {
  // 0 decimals
  BIF: 0, CLP: 0, DJF: 0, GNF: 0, ISK: 0, JPY: 0, KMF: 0, KRW: 0, PYG: 0,
  RWF: 0, UGX: 0, UYI: 0, VND: 0, VUV: 0, XAF: 0, XOF: 0, XPF: 0,
  // 3 decimals
  BHD: 3, IQD: 3, JOD: 3, KWD: 3, LYD: 3, OMR: 3, TND: 3,
  // 4 decimals
  CLF: 4, UYW: 4,
};

// ISO 4217 codes whose minor unit is "N.A." (metals, funds, testing codes).
// Their amounts cannot be expressed in minor units, so they are rejected.
const ISO_NO_MINOR_UNIT = new Set([
  "XAU", "XAG", "XPT", "XPD", "XDR", "XBA", "XBB", "XBC", "XBD",
  "XTS", "XXX", "XSU", "XUA",
]);

function minorUnitsFor(currency: string): number {
  if (typeof currency !== "string" || !/^[A-Z]{3}$/.test(currency)) {
    throw new Error(`Invalid ISO 4217 currency code: ${String(currency)}`);
  }
  if (ISO_NO_MINOR_UNIT.has(currency)) {
    throw new Error(`Currency ${currency} has no ISO 4217 minor unit`);
  }
  if (currency in ISO_MINOR_UNIT_EXCEPTIONS) {
    return ISO_MINOR_UNIT_EXCEPTIONS[currency];
  }

  // Reject unknown codes if the runtime can tell us which codes it knows.
  const supportedValuesOf = (Intl as any).supportedValuesOf as
    | ((k: string) => string[])
    | undefined;
  if (typeof supportedValuesOf === "function") {
    try {
      const known = supportedValuesOf("currency");
      if (Array.isArray(known) && known.length > 0 && !known.includes(currency)) {
        throw new Error(`Unknown ISO 4217 currency code: ${currency}`);
      }
    } catch (e) {
      if (e instanceof Error && e.message.startsWith("Unknown")) throw e;
      // If the Intl lookup itself fails, fall through to the ISO default.
    }
  }
  return 2;
}

function toMinor(amount: string, decimals: number, label: string): bigint {
  if (typeof amount !== "string" || !/^\d+(\.\d+)?$/.test(amount)) {
    throw new Error(`Invalid amount for ${label}: ${String(amount)}`);
  }
  const [intPart, fracPart = ""] = amount.split(".");
  if (fracPart.length > decimals) {
    throw new Error(
      `Amount for ${label} has more than ${decimals} decimal places: ${amount}`
    );
  }
  return BigInt(intPart + fracPart.padEnd(decimals, "0"));
}

function toSafeNumber(v: bigint): number {
  if (
    v > BigInt(Number.MAX_SAFE_INTEGER) ||
    v < BigInt(Number.MIN_SAFE_INTEGER)
  ) {
    throw new Error("Amount exceeds safe integer range");
  }
  return Number(v);
}

export function splitOrder(order: {
  currency: string;
  lines: { sellerId: string; amount: string }[];
  discount: string;
}): { platformFee: number; payouts: Record<string, number> } {
  if (!order || !Array.isArray(order.lines)) {
    throw new Error("Invalid order");
  }
  const decimals = minorUnitsFor(order.currency);

  const amounts = order.lines.map((l, i) => {
    if (!l || typeof l.sellerId !== "string") {
      throw new Error(`Invalid sellerId on line ${i}`);
    }
    return toMinor(l.amount, decimals, `line ${i}`);
  });
  const discount = toMinor(order.discount, decimals, "discount");
  const total = amounts.reduce((s, a) => s + a, 0n);

  if (discount > total) {
    throw new Error("Discount exceeds order total");
  }

  // Largest remainder allocation of the discount.
  const alloc: bigint[] = amounts.map(() => 0n);
  if (discount > 0n) {
    // A zero total is impossible here, because discount <= total.
    const rems: { i: number; r: bigint }[] = [];
    let allocated = 0n;
    amounts.forEach((a, i) => {
      const num = discount * a;
      alloc[i] = num / total;
      allocated += alloc[i];
      rems.push({ i, r: num % total });
    });

    // Largest fractional remainder first; ties go to the earlier line.
    rems.sort((x, y) => (x.r === y.r ? x.i - y.i : x.r > y.r ? -1 : 1));

    let leftover = discount - allocated; // always less than the line count
    for (let k = 0; leftover > 0n; k++, leftover--) {
      alloc[rems[k].i] += 1n;
    }
  }

  let platformFee = 0n;
  const payouts = new Map<string, bigint>();
  order.lines.forEach((l, i) => {
    const net = amounts[i] - alloc[i]; // never negative: alloc <= amount
    const fee = (net * 29n + 500n) / 1000n; // 2.9%, rounded half up
    platformFee += fee;
    payouts.set(l.sellerId, (payouts.get(l.sellerId) ?? 0n) + (net - fee));
  });

  // Object.fromEntries defines own properties, so a sellerId such as
  // "__proto__" is stored safely as data.
  return {
    platformFee: toSafeNumber(platformFee),
    payouts: Object.fromEntries(
      [...payouts].map(([k, v]) => [k, toSafeNumber(v)])
    ),
  };
}
