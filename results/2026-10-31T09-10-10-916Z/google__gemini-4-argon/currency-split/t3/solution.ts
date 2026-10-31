/**
 * ISO 4217 minor unit overrides for currencies that do not use 2 decimal places.
 * Ensures accuracy across runtimes regardless of ICU data version, while falling
 * back to Intl.NumberFormat for standard or newly introduced currencies.
 */
const CURRENCY_DECIMALS: Record<string, number> = {
  // 0 decimal places
  BIF: 0, CLP: 0, DJF: 0, GNF: 0, ISK: 0, JPY: 0, KMF: 0, KRW: 0,
  PYG: 0, RWF: 0, UGX: 0, UYI: 0, VND: 0, VUV: 0, XAF: 0, XOF: 0, XPF: 0,
  // 3 decimal places
  BHD: 3, IQD: 3, JOD: 3, KWD: 3, LYD: 3, OMR: 3, TND: 3,
  // 4 decimal places
  CLF: 4, UYW: 4,
};

function getMinorUnitDigits(currency: string): number {
  const code = currency.toUpperCase();
  if (Object.prototype.hasOwnProperty.call(CURRENCY_DECIMALS, code)) {
    return CURRENCY_DECIMALS[code];
  }
  try {
    const resolved = new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: code,
    }).resolvedOptions();
    return resolved.maximumFractionDigits ?? 2;
  } catch {
    return 2;
  }
}

/**
 * Converts a major-unit decimal string into integer minor units using BigInt
 * to avoid any floating-point representation errors.
 */
function parseToMinorUnits(amountStr: string, decimals: number): bigint {
  const trimmed = amountStr.trim();
  const match = /^([+-])?(\d+)(?:\.(\d+))?$/.exec(trimmed);
  if (!match) {
    throw new Error(`Invalid amount format: "${amountStr}"`);
  }

  const sign = match[1] === '-' ? -1n : 1n;
  const intPart = match[2];
  const fracPart = match[3] ?? '';

  if (fracPart.length > decimals) {
    throw new Error(
      `Amount "${amountStr}" has more decimal places than allowed (${decimals})`
    );
  }

  const paddedFrac = fracPart.padEnd(decimals, '0');
  const combined = intPart + paddedFrac;
  return sign * BigInt(combined);
}

export function splitOrder(order: {
  currency: string; // ISO 4217 code
  lines: { sellerId: string; amount: string }[];
  discount: string;
}): { platformFee: number; payouts: Record<string, number> } {
  const decimals = getMinorUnitDigits(order.currency);
  const discountMinor = parseToMinorUnits(order.discount, decimals);

  if (order.lines.length === 0) {
    return { platformFee: 0, payouts: {} };
  }

  const lineAmounts = order.lines.map((line) =>
    parseToMinorUnits(line.amount, decimals)
  );
  const totalAmount = lineAmounts.reduce((acc, val) => acc + val, 0n);

  // Allocate discount across lines using the largest remainder method.
  // Exact share for line i: (lineAmounts[i] * discountMinor) / totalAmount
  const allocatedDiscounts = new Array<bigint>(order.lines.length).fill(0n);

  if (discountMinor > 0n && totalAmount > 0n) {
    const remainders: { index: number; rem: bigint }[] = [];
    let allocatedSum = 0n;

    for (let i = 0; i < lineAmounts.length; i++) {
      const numerator = lineAmounts[i] * discountMinor;
      const floorShare = numerator / totalAmount;
      const rem = numerator % totalAmount;

      allocatedDiscounts[i] = floorShare;
      allocatedSum += floorShare;
      remainders.push({ index: i, rem });
    }

    const leftover = Number(discountMinor - allocatedSum);

    // Sort descending by fractional remainder (rem / totalAmount).
    // Since totalAmount is constant, comparing `rem` directly is exact.
    // Break ties in favour of the earlier line (smaller index).
    remainders.sort((a, b) => {
      if (b.rem !== a.rem) {
        return b.rem > a.rem ? 1 : -1;
      }
      return a.index - b.index;
    });

    for (let i = 0; i < leftover; i++) {
      allocatedDiscounts[remainders[i].index] += 1n;
    }
  }

  let totalPlatformFee = 0n;
  const payoutsMap: Record<string, bigint> = Object.create(null);

  for (let i = 0; i < order.lines.length; i++) {
    const { sellerId } = order.lines[i];
    const netAmount = lineAmounts[i] - allocatedDiscounts[i];

    // Platform fee = 2.9% of net line amount = (netAmount * 29) / 1000
    // Round half up to a whole minor unit: floor((netAmount * 29 + 500) / 1000)
    const fee =
      netAmount >= 0n
        ? (netAmount * 29n + 500n) / 1000n
        : -((-netAmount * 29n + 500n) / 1000n);

    const sellerLinePayout = netAmount - fee;

    totalPlatformFee += fee;
    payoutsMap[sellerId] = (payoutsMap[sellerId] ?? 0n) + sellerLinePayout;
  }

  const payouts: Record<string, number> = {};
  for (const [sellerId, amount] of Object.entries(payoutsMap)) {
    payouts[sellerId] = Number(amount);
  }

  return {
    platformFee: Number(totalPlatformFee),
    payouts,
  };
}
