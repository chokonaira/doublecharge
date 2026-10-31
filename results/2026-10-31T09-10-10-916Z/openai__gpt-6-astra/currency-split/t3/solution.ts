// ISO 4217 minor-unit exceptions. Other currencies with a defined minor unit
// use two decimal places. Keep these lists updated when ISO changes its data.
// Intl.NumberFormat defaults are not a substitute: CLDR formatting precision
// can differ from the ISO accounting minor unit.
const ZERO_DECIMAL_CURRENCIES = new Set(
  "BIF CLP DJF GNF ISK JPY KMF KRW PYG RWF UGX UYI VND VUV XAF XOF XPF".split(" "),
);
const THREE_DECIMAL_CURRENCIES = new Set(
  "BHD IQD JOD KWD LYD OMR TND".split(" "),
);
const FOUR_DECIMAL_CURRENCIES = new Set(["CLF", "UYW"]);
const NO_MINOR_UNIT_CODES = new Set(
  "XAG XAU XBA XBB XBC XBD XDR XPD XPT XSU XTS XUA XXX".split(" "),
);

function minorUnitDigits(currency: string): number {
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new RangeError("Currency must be an uppercase ISO 4217 code");
  }

  // These ISO codes have minor unit "N.A.", so the requested integer-minor-unit
  // calculation cannot be defined without an additional business convention.
  if (NO_MINOR_UNIT_CODES.has(currency)) {
    throw new RangeError(`${currency} has no defined ISO 4217 minor unit`);
  }

  if (ZERO_DECIMAL_CURRENCIES.has(currency)) return 0;
  if (THREE_DECIMAL_CURRENCIES.has(currency)) return 3;
  if (FOUR_DECIMAL_CURRENCIES.has(currency)) return 4;
  return 2; // The caller guarantees that currency is an ISO 4217 currency.
}

function parseAmount(value: string, digits: number, label: string): bigint {
  if (typeof value !== "string" || !/^[0-9]+(?:\.[0-9]+)?$/.test(value)) {
    throw new RangeError(`${label} must be a nonnegative decimal string`);
  }

  const [whole, fraction = ""] = value.split(".");
  if (fraction.length > digits) {
    throw new RangeError(`${label} exceeds the currency's decimal precision`);
  }

  const scale = 10n ** BigInt(digits);
  return (
    BigInt(whole) * scale +
    (fraction.length === 0 ? 0n : BigInt(fraction.padEnd(digits, "0")))
  );
}

function toSafeNumber(value: bigint, label: string): number {
  // The required number return type cannot represent arbitrary integer amounts
  // exactly. Reject unsafe results rather than silently losing minor units.
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
  const amounts = order.lines.map((line, index) =>
    parseAmount(line.amount, digits, `lines[${index}].amount`),
  );
  const discount = parseAmount(order.discount, digits, "discount");
  const total = amounts.reduce((sum, amount) => sum + amount, 0n);

  if (discount > total) {
    throw new RangeError("Discount cannot exceed the order total");
  }

  const allocations = amounts.map(() => 0n);

  if (discount > 0n) {
    // A positive discount implies a positive total after validation.
    let allocated = 0n;
    const ranked = amounts.map((amount, index) => {
      const numerator = discount * amount;
      const floor = numerator / total;
      allocations[index] = floor;
      allocated += floor;
      return { index, remainder: numerator % total };
    });

    ranked.sort((a, b) => {
      if (a.remainder > b.remainder) return -1;
      if (a.remainder < b.remainder) return 1;
      return a.index - b.index;
    });

    // The sum of fractional remainders is an integer smaller than line count.
    let remaining = discount - allocated;
    for (let i = 0; remaining > 0n; i++, remaining--) {
      allocations[ranked[i].index] += 1n;
    }
  }

  let platformFee = 0n;
  const sellerPayouts = new Map<string, bigint>();

  for (let i = 0; i < order.lines.length; i++) {
    const net = amounts[i] - allocations[i];
    // 2.9% = 29/1000; adding half the denominator gives half-up rounding.
    const fee = (net * 29n + 500n) / 1000n;
    platformFee += fee;

    const sellerId = order.lines[i].sellerId;
    sellerPayouts.set(
      sellerId,
      (sellerPayouts.get(sellerId) ?? 0n) + net - fee,
    );
  }

  // fromEntries creates own data properties safely even for "__proto__".
  const payouts: Record<string, number> = Object.fromEntries(
    Array.from(sellerPayouts, ([sellerId, amount]) => [
      sellerId,
      toSafeNumber(amount, `Payout for ${sellerId}`),
    ]),
  );

  return {
    platformFee: toSafeNumber(platformFee, "Platform fee"),
    payouts,
  };
}
