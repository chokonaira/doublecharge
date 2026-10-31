/**
 * ISO 4217 currency minor unit overrides.
 * Most currencies use 2 decimal places; this table lists standard ISO 4217
 * exceptions (0, 3, and 4 decimal places). `Intl.NumberFormat` is used as a
 * primary source, with this table acting as an authoritative override since
 * CLDR data in some Node versions differs from ISO 4217 for a few currencies
 * (e.g. CLF, UYW, IQD, IRR, MGA, MRU).
 */
const ISO_4217_DECIMALS: Record<string, number> = {
  // 0 decimal places
  BIF: 0,
  CLP: 0,
  DJF: 0,
  GNF: 0,
  ISK: 0,
  JPY: 0,
  KMF: 0,
  KRW: 0,
  PYG: 0,
  RWF: 0,
  UGX: 0,
  UYI: 0,
  VND: 0,
  VUV: 0,
  XAF: 0,
  XOF: 0,
  XPF: 0,

  // 3 decimal places
  BHD: 3,
  IQD: 3,
  JOD: 3,
  KWD: 3,
  LYD: 3,
  OMR: 3,
  TND: 3,

  // 4 decimal places
  CLF: 4,
  UYW: 4,
};

function getCurrencyDecimals(currency: string): number {
  const code = currency.toUpperCase();
  if (Object.prototype.hasOwnProperty.call(ISO_4217_DECIMALS, code)) {
    return ISO_4217_DECIMALS[code];
  }
  try {
    const resolved = new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: code,
    }).resolvedOptions();
    if (typeof resolved.maximumFractionDigits === "number") {
      return resolved.maximumFractionDigits;
    }
  } catch {
    // Fallback to 2 if Intl does not recognize the currency code
  }
  return 2;
}

/**
 * Parses a decimal string in major units into integer minor units using BigInt
 * to avoid floating-point inaccuracies.
 */
function parseToMinorUnits(amountStr: string, decimals: number): bigint {
  const trimmed = amountStr.trim();
  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) {
    throw new Error(`Invalid amount format: "${amountStr}"`);
  }

  const isNegative = trimmed.startsWith("-");
  const clean = isNegative ? trimmed.slice(1) : trimmed;
  const [wholePart, fracPart = ""] = clean.split(".");

  if (fracPart.length > decimals) {
    throw new Error(
      `Amount "${amountStr}" has more decimal places than allowed (${decimals})`
    );
  }

  const paddedFrac = fracPart.padEnd(decimals, "0");
  const combined = wholePart + paddedFrac;
  const value = BigInt(combined);

  return isNegative ? -value : value;
}

export function splitOrder(order: {
  currency: string; // ISO 4217 code
  lines: { sellerId: string; amount: string }[];
  discount: string;
}): { platformFee: number; payouts: Record<string, number> } {
  const decimals = getCurrencyDecimals(order.currency);
  const discountMinor = parseToMinorUnits(order.discount, decimals);

  if (order.lines.length === 0) {
    return { platformFee: 0, payouts: {} };
  }

  const lineAmounts = order.lines.map((line) =>
    parseToMinorUnits(line.amount, decimals)
  );
  const totalAmount = lineAmounts.reduce((acc, val) => acc + val, 0n);

  // Allocate discount across lines using the Largest Remainder Method
  const allocatedDiscounts: bigint[] = new Array(order.lines.length).fill(0n);

  if (discountMinor > 0n && totalAmount > 0n) {
    const remainders: { index: number; remainder: bigint }[] = [];
    let allocatedSum = 0n;

    for (let i = 0; i < lineAmounts.length; i++) {
      const numerator = discountMinor * lineAmounts[i];
      const floorShare = numerator / totalAmount;
      const remainder = numerator % totalAmount;

      allocatedDiscounts[i] = floorShare;
      allocatedSum += floorShare;
      remainders.push({ index: i, remainder });
    }

    const leftover = Number(discountMinor - allocatedSum);

    // Sort descending by remainder, breaking ties in favour of the earlier line
    remainders.sort((a, b) => {
      if (b.remainder !== a.remainder) {
        return b.remainder > a.remainder ? 1 : -1;
      }
      return a.index - b.index;
    });

    for (let i = 0; i < leftover; i++) {
      allocatedDiscounts[remainders[i].index] += 1n;
    }
  }

  let totalPlatformFee = 0n;
  const payouts: Record<string, number> = {};

  for (let i = 0; i < order.lines.length; i++) {
    const { sellerId } = order.lines[i];
    const netLineAmount = lineAmounts[i] - allocatedDiscounts[i];

    // Platform fee = 2.9% of net line amount = netLineAmount * 29 / 1000
    // Round half up: floor((netLineAmount * 29 + 500) / 1000)
    const lineFee =
      netLineAmount >= 0n
        ? (netLineAmount * 29n + 500n) / 1000n
        : -((-netLineAmount * 29n + 500n) / 1000n);

    const linePayout = netLineAmount - lineFee;

    totalPlatformFee += lineFee;
    payouts[sellerId] = (payouts[sellerId] ?? 0) + Number(linePayout);
  }

  return {
    platformFee: Number(totalPlatformFee),
    payouts,
  };
}
