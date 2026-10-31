// ISO 4217 minor-unit exponents. Includes commonly encountered recently
// withdrawn codes; unknown codes are rejected rather than assigned a guess.
const minorUnits = new Map<string, number>();

const currencyGroups: readonly (readonly [number, string])[] = [
  [
    2,
    `AED AFN ALL AMD ANG AOA ARS AUD AWG AZN
     BAM BBD BDT BGN BMD BND BOB BOV BRL BSD BTN BWP BYN BZD
     CAD CDF CHE CHF CHW CNY COP COU CRC CUC CUP CVE CZK
     DKK DOP DZD EGP ERN ETB EUR FJD FKP
     GBP GEL GHS GIP GMD GTQ GYD HKD HNL HRK HTG HUF
     IDR ILS INR IRR JMD KES KGS KHR KPW KYD KZT
     LAK LBP LKR LRD LSL
     MAD MDL MGA MKD MMK MNT MOP MRU MUR MVR MWK MXN MXV MYR MZN
     NAD NGN NIO NOK NPR NZD PAB PEN PGK PHP PKR PLN QAR
     RON RSD RUB SAR SBD SCR SDG SEK SGD SHP SLE SLL SOS SRD SSP
     STN SVC SYP SZL THB TJS TMT TOP TRY TTD TWD TZS
     UAH USD USN UYU UZS VED VES WST XCD XCG YER ZAR ZMW ZWG ZWL`,
  ],
  [
    0,
    `BIF CLP DJF GNF ISK JPY KMF KRW PYG RWF UGX UYI VND VUV XAF XOF XPF`,
  ],
  [3, "BHD IQD JOD KWD LYD OMR TND"],
  [4, "CLF UYW"],
];

for (const [digits, codes] of currencyGroups) {
  for (const code of codes.trim().split(/\s+/)) {
    minorUnits.set(code, digits);
  }
}

const noMinorUnit = new Set(
  "XAG XAU XBA XBB XBC XBD XDR XPD XPT XSU XTS XUA XXX".split(" "),
);

const MAX_SAFE_INTEGER = BigInt(Number.MAX_SAFE_INTEGER);

function toSafeNumber(value: bigint): number {
  // The requested number return type cannot represent arbitrary integers.
  // Reject unrepresentable results instead of silently losing minor units.
  if (value < 0n || value > MAX_SAFE_INTEGER) {
    throw new RangeError("Result exceeds the safe integer range");
  }
  return Number(value);
}

export function splitOrder(order: {
  currency: string;
  lines: { sellerId: string; amount: string }[];
  discount: string;
}): { platformFee: number; payouts: Record<string, number> } {
  const currency = order.currency.toUpperCase();

  // Some ISO 4217 codes have minor unit "N.A.". The requested computation
  // is undefined for them without an additional denomination convention.
  if (noMinorUnit.has(currency)) {
    throw new RangeError(`${currency} has no defined ISO 4217 minor unit`);
  }

  const digits = minorUnits.get(currency);
  if (digits === undefined) {
    // ISO assignments can change; this table must be updated for new codes.
    throw new RangeError(`Unsupported ISO 4217 currency: ${currency}`);
  }

  const scale = 10n ** BigInt(digits);

  function parseAmount(value: string): bigint {
    if (typeof value !== "string" || !/^\d+(?:\.\d+)?$/.test(value)) {
      throw new TypeError("Amounts must be nonnegative decimal strings");
    }

    const [whole, fraction = ""] = value.split(".");
    if (fraction.length > digits!) {
      throw new RangeError(`Too many decimal places for ${currency}`);
    }

    return (
      BigInt(whole) * scale +
      BigInt(fraction.padEnd(digits!, "0") || "0")
    );
  }

  const lines = order.lines.map((line, index) => ({
    sellerId: line.sellerId,
    index,
    amount: parseAmount(line.amount),
    allocatedDiscount: 0n,
    remainder: 0n,
  }));

  const discount = parseAmount(order.discount);
  const total = lines.reduce((sum, line) => sum + line.amount, 0n);

  if (discount > total) {
    throw new RangeError("Discount cannot exceed the order total");
  }

  if (total > 0n) {
    let allocated = 0n;

    for (const line of lines) {
      const numerator = discount * line.amount;
      line.allocatedDiscount = numerator / total;
      line.remainder = numerator % total;
      allocated += line.allocatedDiscount;
    }

    // All fractional shares have the same denominator, so compare their
    // integer remainders directly. Explicit index comparison resolves ties.
    const ranked = [...lines].sort((a, b) => {
      if (a.remainder > b.remainder) return -1;
      if (a.remainder < b.remainder) return 1;
      return a.index - b.index;
    });

    // The sum of fractional remainders is strictly less than line count.
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

  // fromEntries creates own data properties safely even for "__proto__".
  const payouts: Record<string, number> = Object.fromEntries(
    [...sellerTotals].map(([sellerId, amount]) => [
      sellerId,
      toSafeNumber(amount),
    ]),
  );

  return { platformFee: toSafeNumber(platformFee), payouts };
}
