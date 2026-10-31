// Marketplace payout split in integer minor units (ISO 4217).

// ISO 4217 minor units. The table is hard-coded because Intl/CLDR digits differ
// from ISO 4217 for several currencies (e.g. IQD, IRR, LBP, RSD, ALL).
const MINOR_0 = ["BIF", "CLP", "DJF", "GNF", "ISK", "JPY", "KMF", "KRW", "PYG",
  "RWF", "UGX", "UYI", "VND", "VUV", "XAF", "XOF", "XPF"];
const MINOR_3 = ["BHD", "IQD", "JOD", "KWD", "LYD", "OMR", "TND"];
const MINOR_4 = ["CLF", "UYW"];
// ISO lists these funds, metals and testing codes with minor unit "N.A.". They
// have no subdivision, so they are treated as 0 decimals.
const MINOR_NA = ["XAG", "XAU", "XBA", "XBB", "XBC", "XBD", "XDR", "XPD", "XPT",
  "XSU", "XTS", "XUA", "XXX"];
const MINOR_2 = ("AED AFN ALL AMD ANG AOA ARS AUD AWG AZN BAM BBD BDT BGN BMD BND BOB BOV " +
  "BRL BSD BTN BWP BYN BZD CAD CDF CHE CHF CHW CNY COP COU CRC CUC CUP CVE CZK DKK DOP " +
  "DZD EGP ERN ETB EUR FJD FKP GBP GEL GHS GIP GMD GTQ GYD HKD HNL HRK HTG HUF IDR ILS " +
  "INR IRR JMD KES KGS KHR KPW KYD KZT LAK LBP LKR LRD LSL MAD MDL MGA MKD MMK MNT MOP " +
  "MRU MUR MVR MWK MXN MXV MYR MZN NAD NGN NIO NOK NPR NZD PAB PEN PGK PHP PKR PLN QAR " +
  "RON RSD RUB SAR SBD SCR SDG SEK SGD SHP SLE SLL SOS SRD SSP STN SVC SYP SZL THB TJS " +
  "TMT TOP TRY TTD TWD TZS UAH USD USN UYU UZS VED VES WST XCD XCG YER ZAR ZMW ZWG ZWL").split(" ");

const MINOR_UNITS: Record<string, number> = {};
for (const c of MINOR_2) MINOR_UNITS[c] = 2;
for (const c of MINOR_0) MINOR_UNITS[c] = 0;
for (const c of MINOR_NA) MINOR_UNITS[c] = 0;
for (const c of MINOR_3) MINOR_UNITS[c] = 3;
for (const c of MINOR_4) MINOR_UNITS[c] = 4;

function minorUnitsFor(currency: string): number {
  const code = String(currency ?? "").trim().toUpperCase();
  const d = MINOR_UNITS[code];
  if (d === undefined) {
    // Fail loudly: guessing the decimals would silently mis-scale money.
    throw new Error(`Unknown ISO 4217 currency: ${currency}`);
  }
  return d;
}

function toMinor(amount: string, decimals: number, what: string): bigint {
  if (typeof amount !== "string") throw new Error(`${what}: amount must be a string`);
  const s = amount.trim();
  const m = /^(\d+)(?:\.(\d+))?$/.exec(s);
  if (!m) throw new Error(`${what}: invalid amount "${amount}"`);
  const frac = m[2] ?? "";
  if (frac.length > decimals) {
    throw new Error(`${what}: "${amount}" has more than ${decimals} decimal places`);
  }
  return BigInt(m[1] + frac.padEnd(decimals, "0"));
}

function toSafeNumber(v: bigint): number {
  if (v > BigInt(Number.MAX_SAFE_INTEGER) || v < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new Error("Amount exceeds safe integer range");
  }
  return Number(v);
}

export function splitOrder(order: {
  currency: string;
  lines: { sellerId: string; amount: string }[];
  discount: string;
}): { platformFee: number; payouts: Record<string, number> } {
  if (!order || !Array.isArray(order.lines)) throw new Error("Invalid order");
  const decimals = minorUnitsFor(order.currency);

  const amounts = order.lines.map((l, i) => {
    if (!l || typeof l.sellerId !== "string" || l.sellerId === "") {
      throw new Error(`line ${i}: invalid sellerId`);
    }
    return toMinor(l.amount, decimals, `line ${i}`);
  });
  const discount = toMinor(order.discount ?? "0", decimals, "discount");
  const total = amounts.reduce((a, b) => a + b, 0n);

  if (discount > total) throw new Error("Discount exceeds order total");

  // Largest remainder allocation of the discount.
  const alloc: bigint[] = amounts.map(() => 0n);
  if (discount > 0n) {
    // total > 0 is guaranteed here because discount <= total.
    const rems: { i: number; r: bigint }[] = [];
    let allocated = 0n;
    amounts.forEach((a, i) => {
      const num = discount * a;
      alloc[i] = num / total;
      allocated += alloc[i];
      rems.push({ i, r: num % total });
    });
    rems.sort((x, y) => (x.r === y.r ? x.i - y.i : x.r > y.r ? -1 : 1));
    let left = discount - allocated; // always < number of lines
    for (let k = 0; left > 0n; k++, left--) alloc[rems[k].i] += 1n;
  }

  let platformFee = 0n;
  const payouts = new Map<string, bigint>();
  order.lines.forEach((l, i) => {
    const net = amounts[i] - alloc[i]; // >= 0, since alloc <= the exact share <= amount
    const fee = (net * 29n + 500n) / 1000n; // 2.9%, half up (net >= 0)
    platformFee += fee;
    payouts.set(l.sellerId, (payouts.get(l.sellerId) ?? 0n) + (net - fee));
  });

  const out: Record<string, number> = {};
  for (const [k, v] of payouts) out[k] = toSafeNumber(v);
  return { platformFee: toSafeNumber(platformFee), payouts: out };
}
