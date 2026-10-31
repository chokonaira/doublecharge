// ISO 4217 currencies with numeric minor units use two decimal places,
// except for these currencies.
const MINOR_UNIT_EXCEPTIONS: ReadonlyMap<string, number> = new Map([
  ...[
    "BIF", "CLP", "DJF", "GNF", "ISK", "JPY", "KMF", "KRW", "PYG",
    "RWF", "UGX", "UYI", "VND", "VUV", "XAF", "XOF", "XPF",
  ].map((code): [string, number] => [code, 0]),
  ...["BHD", "IQD", "JOD", "KWD", "LYD", "OMR", "TND"].map(
    (code): [string, number] => [code, 3],
  ),
  ["CLF", 4],
  ["UYW", 4],
]);

const NO_MINOR_UNIT = new Set([
  "XAG", "XAU", "XBA", "XBB", "XBC", "XBD", "XDR",
  "XPD", "XPT", "XSU", "XTS", "XUA", "XXX",
]);

function minorUnitDigits(currency: string): number {
  if (typeof currency !== "string" || !/^[A-Z]{3}$/.test(currency)) {
    throw new TypeError("currency must be an uppercase ISO 4217 code");
  }

  // Some ISO 4217 codes have minor unit "N.A.". There is no ISO-defined
  // integer minor unit for those codes, so reject rather than invent one.
  if (NO_MINOR_UNIT.has(currency)) {
    throw new RangeError(`${currency} has no ISO-defined minor unit`);
  }

  // The input contract supplies a valid ISO currency code. This is not
  // a complete registry validator; update the table if ISO changes exponents.
  return MINOR_UNIT_EXCEPTIONS.get(currency) ?? 2;
}

function parseAmount(
  value: string,
  digits: number,
  scale: bigint,
  label: string,
): bigint {
  // Negative amounts/discounts do not define a nonnegative proportional
  // allocation, so reject them. Never parse money through floating point.
  if (
    typeof value !== "string" ||
    !/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(value)
  ) {
    throw new TypeError(`${label} must be a nonnegative decimal string`);
  }

  const [whole, fraction = ""] = value.split(".");
  if (fraction.length > digits) {
    throw new RangeError(`${label} exceeds the currency's decimal precision`);
  }

  return (
    BigInt(whole || "0") * scale +
    BigInt(fraction.padEnd(digits, "0") || "0")
  );
}

function toSafeNumber(value: bigint, label: string): number {
  // The required number return type cannot represent arbitrary integer
  // amounts exactly. Reject unsafe results instead of silently rounding.
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError(`${label} is outside the safe integer range`);
  }
  return Number(value);
}

export function splitOrder(order: {
  currency: string;
  lines: { sellerId: string; amount: string }[];
  discount: string;
}): { platformFee: number; payouts: Record<string, number> } {
  const digits = minorUnitDigits(order.currency);
  const scale = 10n ** BigInt(digits);

  const lines = order.lines.map((line, index) => {
    if (typeof line.sellerId !== "string") {
      throw new TypeError(`lines[${index}].sellerId must be a string`);
    }

    return {
      sellerId: line.sellerId,
      index,
      amount: parseAmount(
        line.amount,
        digits,
        scale,
        `lines[${index}].amount`,
      ),
      allocatedDiscount: 0n,
      remainder: 0n,
    };
  });

  const discount = parseAmount(order.discount, digits, scale, "discount");
  const total = lines.reduce((sum, line) => sum + line.amount, 0n);

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

    // All exact shares have the same denominator, so compare their integer
    // remainders directly. Explicitly resolve ties by original line order.
    const ranked = [...lines].sort((a, b) => {
      if (a.remainder > b.remainder) return -1;
      if (a.remainder < b.remainder) return 1;
      return a.index - b.index;
    });

    // The sum of fractional shares is an integer smaller than lines.length,
    // making this conversion safe regardless of the monetary amounts.
    const remaining = Number(discount - allocated);
    for (let i = 0; i < remaining; i++) {
      ranked[i]!.allocatedDiscount += 1n;
    }
  }

  let platformFee = 0n;
  const sellerTotals = new Map<string, bigint>();

  for (const line of lines) {
    const net = line.amount - line.allocatedDiscount;

    // 2.9% = 29/1000; adding half the denominator implements half-up
    // rounding for these nonnegative amounts.
    const fee = (net * 29n + 500n) / 1000n;
    platformFee += fee;

    sellerTotals.set(
      line.sellerId,
      (sellerTotals.get(line.sellerId) ?? 0n) + net - fee,
    );
  }

  // fromEntries creates own data properties safely, including "__proto__".
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
