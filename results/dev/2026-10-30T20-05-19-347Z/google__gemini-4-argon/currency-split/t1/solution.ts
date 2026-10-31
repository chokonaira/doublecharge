const CURRENCY_DECIMALS_OVERRIDE: Record<string, number> = {
  // Zero-decimal ISO 4217 currencies
  BIF: 0, CLP: 0, DJF: 0, GNF: 0, ISK: 0, JPY: 0, KMF: 0, KRW: 0,
  MGA: 0, PYG: 0, RWF: 0, UGX: 0, UYI: 0, VND: 0, VUV: 0, XAF: 0,
  XOF: 0, XPF: 0,
  // Three-decimal ISO 4217 currencies
  BHD: 3, IQD: 3, JOD: 3, KWD: 3, LYD: 3, OMR: 3, TND: 3,
  // Four-decimal ISO 4217 currencies / funds codes
  CLF: 4, UYW: 4,
};

function getMinorUnits(currency: string): number {
  const code = currency.toUpperCase();
  if (code in CURRENCY_DECIMALS_OVERRIDE) {
    return CURRENCY_DECIMALS_OVERRIDE[code];
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
    // Fallback to standard 2 decimals if Intl doesn't recognize the code
  }
  return 2;
}

function toMinorUnits(amountStr: string, decimals: number): bigint {
  const trimmed = amountStr.trim();
  const isNegative = trimmed.startsWith('-');
  const clean = isNegative || trimmed.startsWith('+') ? trimmed.slice(1) : trimmed;

  const parts = clean.split('.');
  const intPart = parts[0] || '0';
  const fracPart = (parts[1] || '').padEnd(decimals, '0').slice(0, decimals);

  const combined = BigInt(intPart + fracPart);
  return isNegative ? -combined : combined;
}

export function splitOrder(order: {
  currency: string;
  lines: { sellerId: string; amount: string }[];
  discount: string;
}): { platformFee: number; payouts: Record<string, number> } {
  const decimals = getMinorUnits(order.currency);
  const discountMinor = toMinorUnits(order.discount, decimals);

  const lineAmounts = order.lines.map((line) => toMinorUnits(line.amount, decimals));
  const totalAmount = lineAmounts.reduce((acc, val) => acc + val, 0n);

  const n = order.lines.length;
  const allocatedDiscounts: bigint[] = new Array(n).fill(0n);

  if (discountMinor > 0n && totalAmount > 0n && n > 0) {
    const remainders: { index: number; rem: bigint }[] = [];
    let sumAllocated = 0n;

    for (let i = 0; i < n; i++) {
      const numerator = discountMinor * lineAmounts[i];
      const floorShare = numerator / totalAmount;
      const rem = numerator % totalAmount;

      allocatedDiscounts[i] = floorShare;
      sumAllocated += floorShare;
      remainders.push({ index: i, rem });
    }

    const leftover = Number(discountMinor - sumAllocated);

    // Sort by largest remainder descending; break ties by earlier line index ascending
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
  const payoutsBigInt: Record<string, bigint> = {};

  for (let i = 0; i < n; i++) {
    const sellerId = order.lines[i].sellerId;
    const netAmount = lineAmounts[i] - allocatedDiscounts[i];

    // 2.9% = 29 / 1000. Round half up: (netAmount * 29 + 500) / 1000
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
