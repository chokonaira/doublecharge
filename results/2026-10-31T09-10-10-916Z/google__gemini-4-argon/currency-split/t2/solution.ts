// ISO 4217 currency minor unit mapping for currencies that do not use 2 decimal places.
// Built-in Intl.NumberFormat is used as primary source, with this table as an explicit
// override/fallback to ensure exact standard compliance across all Node environments.
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
  if ( code in CURRENCY_DECIMALS ) {
    return CURRENCY_DECIMALS[code];
  }
  try {
    const resolved = new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: code,
    }).resolvedOptions();
    if (typeof resolved.maximumFractionDigits === 'number') {
      return resolved.maximumFractionDigits;
    }
  } catch {
    // Fallback to default 2 if Intl doesn't recognize the code
  }
  return 2;
}

/**
 * Parses a decimal string in major units into BigInt minor units without floating-point drift.
 */
function parseMinorUnits(amountStr: string, decimals: number): bigint {
  const trimmed = amountStr.trim();
  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) {
    throw new Error(`Invalid amount format: "${amountStr}"`);
  }

  const isNegative = trimmed.startsWith('-');
  const clean = isNegative ? trimmed.slice(1) : trimmed;
  const [intPart, fracPart = ''] = clean.split('.');

  if (fracPart.length > decimals) {
    throw new Error(
      `Amount "${amountStr}" has more decimal places than allowed (${decimals})`
    );
  }

  const paddedFrac = fracPart.padEnd(decimals, '0');
  const combined = intPart + paddedFrac;
  const val = BigInt(combined);
  return isNegative ? -val : val;
}

export function splitOrder(order: {
  currency: string;
  lines: { sellerId: string; amount: string }[];
  discount: string;
}): { platformFee: number; payouts: Record<string, number> } {
  const decimals = getMinorUnitDigits(order.currency);
  const totalDiscount = parseMinorUnits(order.discount, decimals);

  if (order.lines.length === 0) {
    return { platformFee: 0, payouts: {} };
  }

  const lineAmounts = order.lines.map((line) =>
    parseMinorUnits(line.amount, decimals)
  );
  const totalAmount = lineAmounts.reduce((acc, val) => acc + val, 0n);

  // Allocate discount across lines using the largest remainder method.
  // Exact share for line i = (lineAmounts[i] * totalDiscount) / totalAmount
  // Floor share = (lineAmounts[i] * totalDiscount) / totalAmount (integer division)
  // Remainder numerator = (lineAmounts[i] * totalDiscount) % totalAmount
  const allocatedDiscounts: bigint[] = new Array(order.lines.length).fill(0n);

  if (totalDiscount > 0n) {
    if (totalAmount === 0n) {
      throw new Error('Cannot allocate a positive discount across lines with zero total amount');
    }

    const remainders: { index: number; rem: bigint }[] = [];
    let distributedDiscount = 0n;

    for (let i = 0; i < lineAmounts.length; i++) {
      const numerator = lineAmounts[i] * totalDiscount;
      const floorShare = numerator / totalAmount;
      const rem = numerator % totalAmount;

      allocatedDiscounts[i] = floorShare;
      distributedDiscount += floorShare;
      remainders.push({ index: i, rem });
    }

    const remainingUnits = Number(totalDiscount - distributedDiscount);

    // Sort by largest remainder descending, breaking ties by earlier line index ascending
    remainders.sort((a, b) => {
      if (b.rem !== a.rem) {
        return b.rem > a.rem ? 1 : -1;
      }
      return a.index - b.index;
    });

    for (let i = 0; i < remainingUnits; i++) {
      allocatedDiscounts[remainders[i].index] += 1n;
    }
  }

  let totalPlatformFee = 0n;
  const payoutsBigInt: Record<string, bigint> = {};

  for (let i = 0; i < order.lines.length; i++) {
    const { sellerId } = order.lines[i];
    const netAmount = lineAmounts[i] - allocatedDiscounts[i];

    // Platform fee = 2.9% of netAmount = (netAmount * 29) / 1000
    // Round half up: floor((netAmount * 29 + 500) / 1000) for non-negative netAmount
    const lineFee =
      netAmount >= 0n
        ? (netAmount * 29n + 500n) / 1000n
        : -((-netAmount * 29n + 500n) / 1000n);

    const sellerLinePayout = netAmount - lineFee;

    totalPlatformFee += lineFee;
    payoutsBigInt[sellerId] = (payoutsBigInt[sellerId] ?? 0n) + sellerLinePayout;
  }

  const payouts: Record<string, number> = {};
  for (const [sellerId, amount] of Object.entries(payoutsBigInt)) {
    payouts[sellerId] = Number(amount);
  }

  return {
    platformFee: Number(totalPlatformFee),
    payouts,
  };
}
