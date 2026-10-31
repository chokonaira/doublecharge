export interface OrderLine {
  sellerId: string;
  amount: string;
}

export interface Order {
  currency: string; // ISO 4217 code
  lines: OrderLine[];
  discount: string;
}

export interface SplitResult {
  platformFee: number;
  payouts: Record<string, number>;
}

/**
 * ISO 4217 currencies with non-2 minor unit exponents.
 * Standard ISO 4217 defaults to 2 decimal places unless listed here.
 * We also fall back to `Intl.NumberFormat` where supported by the runtime.
 */
const CURRENCY_EXPONENT_OVERRIDES: Record<string, number> = {
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

function getCurrencyMinorUnits(currency: string): number {
  const code = currency.trim().toUpperCase();
  if (Object.prototype.hasOwnProperty.call(CURRENCY_EXPONENT_OVERRIDES, code)) {
    return CURRENCY_EXPONENT_OVERRIDES[code];
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
    // Fallback if runtime Intl does not recognize the code
  }
  return 2;
}

/**
 * Parses a decimal string in major units into exact integer minor units (as BigInt)
 * without floating-point precision loss.
 */
function parseToMinorUnits(amountStr: string, decimals: number): bigint {
  const trimmed = amountStr.trim();
  const match = /^([+-])?(\d+)(?:\.(\d+))?$/.exec(trimmed);
  if (!match) {
    throw new Error(`Invalid decimal amount: "${amountStr}"`);
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

export function splitOrder(order: Order): SplitResult {
  const decimals = getCurrencyMinorUnits(order.currency);
  const discountMinor = parseToMinorUnits(order.discount, decimals);

  if (order.lines.length === 0) {
    return { platformFee: 0, payouts: {} };
  }

  const lineAmounts = order.lines.map((line) =>
    parseToMinorUnits(line.amount, decimals)
  );
  const totalAmount = lineAmounts.reduce((sum, a) => sum + a, 0n);

  const allocatedDiscounts: bigint[] = new Array(order.lines.length).fill(0n);

  if (discountMinor > 0n && totalAmount > 0n) {
    // Exact share for line i is: (discountMinor * lineAmounts[i]) / totalAmount
    // Floor is the integer division quotient; fractional remainder numerator is the modulo.
    let allocatedSum = 0n;
    const remainders: { index: number; rem: bigint }[] = [];

    for (let i = 0; i < lineAmounts.length; i++) {
      const numerator = discountMinor * lineAmounts[i];
      const floorShare = numerator / totalAmount;
      const rem = numerator % totalAmount;

      allocatedDiscounts[i] = floorShare;
      allocatedSum += floorShare;
      remainders.push({ index: i, rem });
    }

    const leftover = Number(discountMinor - allocatedSum);

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

  for (let i = 0; i < order.lines.length; i++) {
    const sellerId = order.lines[i].sellerId;
    const netLineAmount = lineAmounts[i] - allocatedDiscounts[i];

    // Platform fee = 2.9% of netLineAmount = (netLineAmount * 29) / 1000
    // Round half up: floor((netLineAmount * 29 + 500) / 1000) for non-negative amounts
    const lineFee =
      netLineAmount >= 0n
        ? (netLineAmount * 29n + 500n) / 1000n
        : -((-netLineAmount * 29n + 500n) / 1000n);

    const sellerLinePayout = netLineAmount - lineFee;

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
