// ISO 4217 numeric minor-unit exceptions; all other currencies with a
// defined numeric minor unit use two decimal places.
const ZERO_DECIMAL_CURRENCIES = new Set([
  "BIF", "CLP", "DJF", "GNF", "ISK", "JPY", "KMF", "KRW", "PYG",
  "RWF", "UGX", "UYI", "VND", "VUV", "XAF", "XOF", "XPF",
]);

const THREE_DECIMAL_CURRENCIES = new Set([
  "BHD", "IQD", "JOD", "KWD", "LYD", "OMR", "TND",
]);

const FOUR_DECIMAL_CURRENCIES = new Set(["CLF", "UYW"]);

const UNDEFINED_MINOR_UNIT_CODES = new Set([
  "XAG", "XAU", "XBA", "XBB", "XBC", "XBD", "XDR",
  "XPD", "XPT", "XSU", "XTS", "XUA", "XXX",
]);

function minorUnitDigits(currency: string): number {
  if (typeof currency !== "string" || !/^[A-Z]{3}$/.test(currency)) {
    throw new TypeError("currency must be an uppercase ISO 4217 code");
  }

  // These ISO codes have minor unit "N.A.", so the requested integer-minor-
  // unit calculation is undefined. Reject rather than invent a precision.
  if (UNDEFINED_MINOR_UNIT_CODES.has(currency)) {
    throw new RangeError(`${currency} has no defined ISO 4217 minor unit`);
  }

  if (ZERO_DECIMAL_CURRENCIES.has(currency)) return 0;
  if (THREE_DECIMAL_CURRENCIES.has(currency)) return 3;
  if (FOUR_DECIMAL_CURRENCIES.has(currency)) return 4;

  // The caller supplies a valid ISO currency. This static ISO table must
  // be updated if future ISO amendments introduce new precision exceptions.
  return 2;
}

function parseAmount(value: string, digits: number, label: string): bigint {
  if (typeof value !== "string") {
    throw new TypeError(`${label} must be a decimal string`);
  }

  const match = /^([0-9]+)(?:\.([0-9]+))?$/.exec(value);
  if (!match) {
    throw new TypeError(`${label} must be a nonnegative decimal string`);
  }

  const fraction = match[2] ?? "";
  if (fraction.length > digits) {
    throw new RangeError(`${label} exceeds the currency's decimal precision`);
  }

  const scale = 10n ** BigInt(digits);
  return (
    BigInt(match[1]) * scale +
    BigInt(fraction.padEnd(digits, "0") || "0")
  );
}

function toSafeNumber(value: bigint, label: string): number {
  // The requested number return type cannot represent arbitrary-sized
  // integer amounts exactly. Reject unsafe results rather than lose money.
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError(`${label} cannot be represented as a safe integer`);
  }
  return Number(value);
}

export function splitOrder(order: {
  currency: string;
  lines: { sellerId: string; amount: string }[];
  discount: string;
}): { platformFee: number; payouts: Record<string, number> } {
  const digits = minorUnitDigits(order.currency);

  const lines = order.lines.map((line, index) => {
    if (typeof line.sellerId !== "string") {
      throw new TypeError(`lines[${index}].sellerId must be a string`);
    }

    return {
      sellerId: line.sellerId,
      amount: parseAmount(line.amount, digits, `lines[${index}].amount`),
      allocatedDiscount: 0n,
      remainder: 0n,
      index,
    };
  });

  const total = lines.reduce((sum, line) => sum + line.amount, 0n);
  const discount = parseAmount(order.discount, digits, "discount");

  if (discount > total) {
    throw new RangeError("discount cannot exceed the total line amount");
  }

  if (total > 0n && discount > 0n) {
    let allocated = 0n;

    for (const line of lines) {
      const numerator = discount * line.amount;
      line.allocatedDiscount = numerator / total;
      line.remainder = numerator % total;
      allocated += line.allocatedDiscount;
    }

    const ranked = [...lines].sort((a, b) => {
      if (a.remainder > b.remainder) return -1;
      if (a.remainder < b.remainder) return 1;
      return a.index - b.index;
    });

    // The sum of fractional shares is an integer smaller than lines.length,
    // so this conversion is exact and each winning line receives one unit.
    const remaining = Number(discount - allocated);
    for (let i = 0; i < remaining; i++) {
      ranked[i].allocatedDiscount += 1n;
    }
  }

  let platformFee = 0n;
  const sellerTotals = new Map<string, bigint>();

  for (const line of lines) {
    const net = line.amount - line.allocatedDiscount;

    // 2.9% = 29/1000; adding half the denominator rounds half up.
    const fee = (net * 29n + 500n) / 1000n;
    platformFee += fee;

    sellerTotals.set(
      line.sellerId,
      (sellerTotals.get(line.sellerId) ?? 0n) + net - fee,
    );
  }

  // fromEntries creates own data properties safely even for seller IDs
  // such as "__proto__" and "constructor".
  const payouts: Record<string, number> = Object.fromEntries(
    Array.from(sellerTotals, ([sellerId, amount]) => [
      sellerId,
      toSafeNumber(amount, `payout for ${JSON.stringify(sellerId)}`),
    ]),
  );

  return {
    platformFee: toSafeNumber(platformFee, "platformFee"),
    payouts,
  };
}
