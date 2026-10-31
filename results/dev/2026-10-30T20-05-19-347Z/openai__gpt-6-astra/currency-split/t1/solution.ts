// ISO 4217 minor-unit exponents. Includes commonly encountered retired codes
// so that persisted orders in those currencies can still be processed.
// Do not use Intl.NumberFormat as an ISO registry: unknown codes can default
// silently to two decimal places.
const MINOR_UNITS = new Map<string, number>();

const CURRENCIES_BY_EXPONENT: readonly [number, string][] = [
  [
    2,
    `AED AFN ALL AMD ANG AOA ARS AUD AWG AZN
     BAM BBD BDT BGN BMD BND BOB BOV BRL BSD BTN BWP BYN BZD
     CAD CDF CHE CHF CHW CNY COP COU CRC CUC CUP CVE CZK
     DKK DOP DZD EGP ERN ETB EUR FJD FKP
     GBP GEL GHS GIP GMD GTQ GYD HKD HNL HRK HTG HUF
     IDR ILS INR IRR JMD KES KGS KHR KPW KYD KZT
     LAK LBP LKR LRD LSL
     MAD MDL MGA MKD MMK MNT MOP MRO MRU MUR MVR MWK MXN MXV MYR MZN
     NAD NGN NIO NOK NPR NZD PAB PEN PGK PHP PKR PLN QAR
     RON RSD RUB SAR SBD SCR SDG SEK SGD SHP SLE SLL SOS SRD SSP STD STN SVC SYP SZL
     THB TJS TMT TOP TRY TTD TWD TZS UAH USD USN UYU UZS
     VED VEF VES WST XCD XCG YER ZAR ZMW ZWG ZWL`,
  ],
  [0, "BIF BYR CLP DJF GNF ISK JPY KMF KRW PYG RWF UGX UYI VND VUV XAF XOF XPF"],
  [3, "BHD IQD JOD KWD LYD OMR TND"],
  [4, "CLF UYW"],
];

for (const [exponent, codes] of CURRENCIES_BY_EXPONENT) {
  for (const code of codes.trim().split(/\s+/)) {
    MINOR_UNITS.set(code, exponent);
  }
}

// ISO assigns no minor-unit exponent to these codes. An integer-minor-unit
// result is undefined for them, so rejecting is safer than inventing a scale.
const NO_MINOR_UNIT = new Set(
  "XAG XAU XBA XBB XBC XBD XDR XPD XPT XSU XTS XUA XXX".split(" "),
);

function parseMinorUnits(
  value: string,
  exponent: number,
  label: string,
): bigint {
  if (typeof value !== "string" || !/^\d+(?:\.\d+)?$/.test(value)) {
    throw new TypeError(`${label} must be a nonnegative decimal string`);
  }

  const [whole, fraction = ""] = value.split(".");
  if (fraction.length > exponent) {
    throw new RangeError(`${label} exceeds the currency's decimal precision`);
  }

  const scale = 10n ** BigInt(exponent);
  return (
    BigInt(whole) * scale +
    BigInt(fraction.padEnd(exponent, "0") || "0")
  );
}

function toSafeNumber(value: bigint, label: string): number {
  // The required number return type cannot represent every integer exactly.
  // Reject oversized results rather than silently losing minor units.
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
  if (
    !order ||
    typeof order.currency !== "string" ||
    !Array.isArray(order.lines)
  ) {
    throw new TypeError("Invalid order");
  }

  if (NO_MINOR_UNIT.has(order.currency)) {
    throw new RangeError(
      `${order.currency} has no ISO 4217 minor-unit exponent`,
    );
  }

  const exponent = MINOR_UNITS.get(order.currency);
  if (exponent === undefined) {
    // ISO codes can change; new codes require an explicit registry update.
    throw new RangeError(`Unsupported ISO 4217 currency: ${order.currency}`);
  }

  const lines = order.lines.map((line, index) => {
    if (!line || typeof line.sellerId !== "string") {
      throw new TypeError(`lines[${index}].sellerId must be a string`);
    }

    return {
      sellerId: line.sellerId,
      index,
      amount: parseMinorUnits(
        line.amount,
        exponent,
        `lines[${index}].amount`,
      ),
      allocatedDiscount: 0n,
      remainder: 0n,
    };
  });

  const discount = parseMinorUnits(order.discount, exponent, "discount");
  const total = lines.reduce((sum, line) => sum + line.amount, 0n);

  // Negative amounts and discounts exceeding the subtotal would require
  // refund/credit semantics not specified by the allocation rules.
  if (discount > total) {
    throw new RangeError("discount must not exceed the order subtotal");
  }

  if (total > 0n && discount > 0n) {
    let remaining = discount;

    for (const line of lines) {
      const numerator = discount * line.amount;
      line.allocatedDiscount = numerator / total;
      line.remainder = numerator % total;
      remaining -= line.allocatedDiscount;
    }

    // All shares have the same denominator, so integer remainders suffice.
    const ranked = [...lines].sort((a, b) => {
      if (a.remainder > b.remainder) return -1;
      if (a.remainder < b.remainder) return 1;
      return a.index - b.index;
    });

    // The sum of fractional parts is an integer strictly below line count.
    for (let i = 0; remaining > 0n; i++, remaining--) {
      ranked[i].allocatedDiscount += 1n;
    }
  }

  let platformFee = 0n;
  const sellerTotals = new Map<string, bigint>();

  for (const line of lines) {
    const net = line.amount - line.allocatedDiscount;
    // 2.9% = 29/1000; adding half the denominator implements half-up
    // rounding exactly for nonnegative amounts.
    const fee = (net * 29n + 500n) / 1000n;

    platformFee += fee;
    sellerTotals.set(
      line.sellerId,
      (sellerTotals.get(line.sellerId) ?? 0n) + net - fee,
    );
  }

  // Object.fromEntries creates own data properties safely, including for
  // seller IDs such as "__proto__" and "constructor".
  const payouts: Record<string, number> = Object.fromEntries(
    [...sellerTotals].map(([sellerId, amount]) => [
      sellerId,
      toSafeNumber(amount, `Payout for ${JSON.stringify(sellerId)}`),
    ]),
  );

  return {
    platformFee: toSafeNumber(platformFee, "platformFee"),
    payouts,
  };
}
