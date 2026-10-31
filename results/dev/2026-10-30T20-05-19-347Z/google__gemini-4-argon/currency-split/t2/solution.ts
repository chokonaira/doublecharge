export interface OrderLine {
  sellerId: string;
  amount: string;
}

export interface Order {
  currency: string;
  lines: OrderLine[];
  discount: string;
}

export interface SplitResult {
  platformFee: number;
  payouts: Record<string, number>;
}

// Explicit fallback map for ISO 4217 currencies with non-2 decimal places
const NON_TWO_DECIMALS: Record<string, number> = {
  // 0 decimals
  BIF: 0, CLP: 0, DJF: 0, GNF: 0, ISK: 0, JPY: 0, KMF: 0, KRW: 0,
  MGA: 0, PYG: 0, RWF: 0, UGX: 0, UYI: 0, VND: 0, VUV: 0, XAF: 0,
  XOF: 0, XPF: 0,
  // 3 decimals
  BHD: 3, IQD: 3, JOD: 3, KWD: 3, LYD: 3, OMR: 3, TND: 3,
  // 4 decimals
  CLF: 4, UYW: 4,
};

function getCurrencyDecimals(currency: string): number {
  const code = currency.toUpperCase();
  if (Object.prototype.hasOwnProperty.call(NON_TWO_DECIMALS, code)) {
    return NON_TWO_DECIMALS[code];
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
    // Fallback to default 2 if currency is unknown to Intl
  }
  return 2;
}

function parseToMinorUnits(amountStr: string, decimals: number): bigint {
  const trimmed = amountStr.trim();
  const isNegative = trimmed.startsWith('-');
  const clean = isNegative || trimmed.startsWith('+') ? trimmed.slice(1) : trimmed;

  const [wholePart = '0', fracPart = ''] = clean.split('.');
  const paddedFrac = fracPart.padEnd(decimals, '0').slice(0, decimals);

  const combined = wholePart + paddedFrac;
  const val = BigInt(combined || '0');
  return isNegative ? -val : val;
}

export function splitOrder(order: Order): SplitResult {
  const decimals = getCurrencyDecimals(order.currency);
  const discountMinor = parseToMinorUnits(order.discount, decimals);

  const linesMinor = order.lines.map((line, index) => ({
    index,
    sellerId: line.sellerId,
    amount: parseToMinorUnits(line.amount, decimals),
  }));

  if (linesMinor.length === 0) {
    return { platformFee: 0, payouts: {} };
  }

  const totalAmount = linesMinor.reduce((acc, l) => acc + l.amount, 0n);

  const allocations = new Array<bigint>(linesMinor.length).fill(0n);

  if (discountMinor > 0n && totalAmount > 0n) {
    let allocatedSum = 0n;
    const remainders: { index: number; rem: bigint }[] = [];

    for (let i = 0; i < linesMinor.length; i++) {
      const numerator = discountMinor * linesMinor[i].amount;
      const floorShare = numerator / totalAmount;
      const rem = numerator % totalAmount;

      allocations[i] = floorShare;
      allocatedSum += floorShare;
      remainders.push({ index: i, rem });
    }

    const leftover = Number(discountMinor - allocatedSum);

    if (leftover > 0) {
      remainders.sort((a, b) => {
        if (b.rem !== a.rem) {
          return b.rem > a.rem ? 1 : -1;
        }
        return a.index - b.index; // Tie-break: earlier line first
      });

      for (let i = 0; i < leftover; i++) {
        allocations[remainders[i].index] += 1n;
      }
    }
  }

  let totalPlatformFee = 0n;
  const payouts: Record<string, number> = {};

  for (let i = 0; i < linesMinor.length; i++) {
    const line = linesMinor[i];
    const netAmount = line.amount - allocations[i];

    // 2.9% = 29 / 1000. Round half up:floor((net * 29 + 500) / 1000)
    const fee = (netAmount * 29n + 500n) / 1000n;
    const sellerPayout = netAmount - fee;

    totalPlatformFee += fee;
    payouts[line.sellerId] = (payouts[line.sellerId] ?? 0) + Number(sellerPayout);
  }

  return {
    platformFee: Number(totalPlatformFee),
    payouts,
  };
}
