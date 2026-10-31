// Explicit ISO minor units are used because Intl/ICU currency formatting
// conventions do not always match ISO 4217 (for example, AFN and MGA).
// Includes current currencies and several recently withdrawn codes.
// ISO amendments require updating this table; unknown codes are rejected
// rather than silently assuming two decimal places.
const CURRENCIES_BY_MINOR_UNIT: ReadonlyArray<readonly [number, string]> = [
  [
    0,
    "BIF CLP DJF GNF ISK JPY KMF KRW PYG RWF UGX UYI VND VUV XAF XOF XPF",
  ],
  [
    2,
    `AED AFN ALL AMD ANG AOA ARS AUD AWG AZN
     BAM BBD BDT BGN BMD BND BOB BOV BRL BSD BTN BWP BYN BZD
     CAD CDF CHE CHF CHW CNY COP COU CRC CUP CVE CZK
     DKK DOP DZD EGP ERN ETB EUR FJD FKP
     GBP GEL GHS GIP GMD GTQ GYD HKD HNL HTG HUF
     IDR ILS INR IRR JMD KES KGS KHR KPW KYD KZT
     LAK LBP LKR LRD LSL MAD MDL MGA MKD MMK MNT MOP
     MRU MUR MVR MWK MXN MXV MYR MZN NAD NGN NIO NOK NPR NZD
     PAB PEN PGK PHP PKR PLN QAR RON RSD RUB
     SAR SBD SCR SDG SEK SGD SHP SLE SLL SOS SRD SSP STN SVC SYP SZL
     THB TJS TMT TOP TRY TTD TWD TZS UAH USD USN UYU UZS
     VED VES WST XAD XCD XCG YER ZAR ZMW ZWG ZWL`,
  ],
  [3, "BHD IQD JOD KWD LYD OMR TND"],
  [4, "CLF UYW"],
];

const MINOR_UNITS = new Map<string, number>(
  CURRENCIES_BY_MINOR_UNIT.flatMap(([digits, codes]) =>
    codes.trim().split(/\s+/).map((code): [string, number] => [code, digits]),
  ),
);

// These ISO codes have minor unit "N.A.", not zero decimal places.
// There is no ISO-defined minor-unit conversion for them, so reject them.
const NO_DEFINED_MINOR_UNIT = new Set(
  "XAG XAU XBA XBB XBC XBD XDR XPD XPT XSU XTS XUA XXX".split(" "),
);

const MAX_SAFE_INTEGER = BigInt(Number.MAX_SAFE_INTEGER);

function parseAmount(
  value: string,
  digits: number,
  scale: bigint,
  label: string,
): bigint {
  if (typeof value !== "string") {
    throw new TypeError(`${label} must be a decimal string`);
  }

  // Accept plain nonnegative decimals, including ".5" and "1.".
  // Exponents, grouping separators, whitespace and negative amounts are invalid.
  const match = /^(?:([0-9]+)(?:\.([0-9]*))?|\.([0-9]+))$/.exec(value);
  if (!match) {
    throw new RangeError(`${label} must be a nonnegative decimal amount`);
  }

  const whole = match[1] ?? "0";
  const fraction = match[2] ?? match[3] ?? "";

  if (fraction.length > digits) {
    throw new RangeError(`${label} exceeds the currency's decimal precision`);
  }

  return (
    BigInt(whole) * scale +
    BigInt(fraction.padEnd(digits, "0") || "0")
  );
}

function toSafeNumber(value: bigint, label: string): number {
  // The requested number return type cannot represent larger integers exactly.
  if (value < 0n || value > MAX_SAFE_INTEGER) {
    throw new RangeError(`${label} cannot be represented as a safe integer`);
  }
  return Number(value);
}

export function splitOrder(order: {
  currency: string;
  lines: { sellerId: string; amount: string }[];
  discount: string;
}): { platformFee: number; payouts: Record<string, number> } {
  if (NO_DEFINED_MINOR_UNIT.has(order.currency)) {
    throw new RangeError(
      `${order.currency} has no ISO 4217-defined minor unit`,
    );
  }

  const digits = MINOR_UNITS.get(order.currency);
  if (digits === undefined) {
    throw new RangeError(`Unsupported ISO 4217 currency: ${order.currency}`);
  }
  if (!Array.isArray(order.lines)) {
    throw new TypeError("lines must be an array");
  }

  const scale = 10n ** BigInt(digits);
  const discount = parseAmount(order.discount, digits, scale, "discount");

  const lines = order.lines.map((line, index) => {
    if (typeof line.sellerId !== "string") {
      throw new TypeError(`lines[${index}].sellerId must be a string`);
    }

    return {
      index,
      sellerId: line.sellerId,
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

  const subtotal = lines.reduce((sum, line) => sum + line.amount, 0n);
  if (discount > subtotal) {
    throw new RangeError("discount cannot exceed the order subtotal");
  }

  if (subtotal > 0n && discount > 0n) {
    let allocated = 0n;

    for (const line of lines) {
      const numerator = discount * line.amount;
      line.allocatedDiscount = numerator / subtotal;
      line.remainder = numerator % subtotal;
      allocated += line.allocatedDiscount;
    }

    const ranked = [...lines].sort((a, b) => {
      if (a.remainder !== b.remainder) {
        return a.remainder > b.remainder ? -1 : 1;
      }
      return a.index - b.index;
    });

    // The sum of fractional shares is an integer strictly below lines.length,
    // so this conversion is safe even when monetary values are very large.
    const remaining = Number(discount - allocated);
    for (let i = 0; i < remaining; i++) {
      ranked[i]!.allocatedDiscount += 1n;
    }
  }

  let platformFee = 0n;
  const sellerPayouts = new Map<string, bigint>();

  for (const line of lines) {
    const net = line.amount - line.allocatedDiscount;

    // 2.9% = 29/1000. Adding half the denominator implements half-up
    // rounding exactly for nonnegative integer minor-unit amounts.
    const fee = (net * 29n + 500n) / 1000n;

    platformFee += fee;
    sellerPayouts.set(
      line.sellerId,
      (sellerPayouts.get(line.sellerId) ?? 0n) + net - fee,
    );
  }

  // fromEntries creates own data properties safely even for seller IDs such
  // as "__proto__" and "constructor".
  const payouts: Record<string, number> = Object.fromEntries(
    Array.from(sellerPayouts, ([sellerId, payout]) => [
      sellerId,
      toSafeNumber(payout, `Payout for seller ${sellerId}`),
    ]),
  );

  return {
    platformFee: toSafeNumber(platformFee, "platformFee"),
    payouts,
  };
}
